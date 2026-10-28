import "dotenv/config"
import { Job, Worker } from "bullmq"
import { prisma } from "@/lib/db"
import {
  classifyWhatsAppError,
  normalizeWhatsAppNumber,
  safeErrorMessage,
  safeStackTrace,
  syncWhatsAppCampaignCounters,
  transitionWhatsAppMessage,
  writeWhatsAppErrorLog,
  writeWhatsAppLog,
  writeWhatsAppQueueLog,
} from "@/lib/whatsapp/diagnostics"
import { runScheduledWhatsAppAutomations } from "@/lib/whatsapp/automation"
import { processWhatsAppCampaign, syncCampaignCounters } from "@/lib/whatsapp/campaigns"
import { resolveBrandIdentity } from "@/lib/brand-identity"
import {
  getWhatsAppRedisConnection,
  WHATSAPP_AUTH_QUEUE,
  WHATSAPP_CAMPAIGN_QUEUE,
  WHATSAPP_LOGIN_ALERT_QUEUE,
  WHATSAPP_MEDIA_QUEUE,
  WHATSAPP_OTP_QUEUE,
  WHATSAPP_SEND_QUEUE,
  type WhatsAppOtpJob,
  type WhatsAppSendJob,
} from "@/lib/whatsapp/queue"
import { sendWhatsAppMedia, sendWhatsAppText } from "@/lib/whatsapp/send"
import { resolveAndRenderWhatsAppTemplate, validateWhatsAppRequiredTemplates } from "@/lib/whatsapp/templates"
import { WHATSAPP_TEMPLATE_KEYS } from "@/lib/whatsapp/template-registry"
import { getEvolutionStatus } from "@/lib/whatsapp/evolution"
import { paymentFlowError, paymentFlowLog } from "@/lib/payment-flow-log"
import { sendEmergencyDeliveryFailureAlert } from "@/lib/admin-emergency-alert"

process.env.ZWS_WHATSAPP_WORKER = "true"
process.env.WHATSAPP_RUNTIME_OWNER ||= "worker"

const connection = getWhatsAppRedisConnection()
if (!connection) {
  console.error("[whatsapp-worker] REDIS_URL is required for WhatsApp queues")
  process.exit(1)
}
const redisConnection = connection

let workers: Worker<any>[] = []
let healthTimer: ReturnType<typeof setInterval> | null = null
let automationTimer: ReturnType<typeof setInterval> | null = null

function completionStatus(result: { status?: string | null }) {
  const status = String(result.status || "")
  if (["whatsapp_server_ack", "whatsapp_device_ack", "delivered", "read", "played"].includes(status)) return status
  return "whatsapp_server_ack"
}

function completionTimestamps(status: string) {
  const now = new Date()
  return {
    ...(status === "read" || status === "played" ? { readAt: now, deliveredAt: now } : {}),
    ...(status === "whatsapp_device_ack" || status === "delivered" ? { deliveredAt: now } : {}),
    ...(status === "whatsapp_server_ack" ? { sentAt: now } : {}),
  }
}

async function bootLog(message: string, metadata?: Record<string, unknown>) {
  console.info(message, metadata || "")
  await writeWhatsAppLog({ event: message.replace(/^\[BOOT\]\s*/, "boot.").toLowerCase().replace(/\s+/g, "_"), status: "starting", metadata }).catch(() => null)
}

async function markJobProcessing(job: Job<WhatsAppSendJob>, queueName: string) {
  const data = job.data
  let normalized: ReturnType<typeof normalizeWhatsAppNumber> | null = null
  try {
    normalized = normalizeWhatsAppNumber(data.to)
  } catch {
    // The send path will classify and persist the normalized failure.
  }
  await Promise.allSettled([
    transitionWhatsAppMessage({
      messageLogId: data.messageLogId || null,
      campaignLogId: data.campaignLogId || null,
      campaignId: data.campaignId || null,
      status: "processing",
      queueName,
      queueJobId: job.id || null,
      retryCount: job.attemptsMade,
      metadata: { attemptsMade: job.attemptsMade },
    }),
    writeWhatsAppQueueLog({
      queueName,
      queueJobId: job.id || null,
      event: "job.processing",
      status: "processing",
      customerId: data.customerId || null,
      campaignId: data.campaignId || null,
      campaignLogId: data.campaignLogId || null,
      messageLogId: data.messageLogId || null,
      phoneHash: normalized?.phoneHash || null,
      maskedPhone: normalized?.maskedPhone || null,
      attempt: job.attemptsMade + 1,
      latencyMs: job.processedOn && job.timestamp ? job.processedOn - job.timestamp : null,
    }),
  ])
}

async function handleSendFailure(job: Job<WhatsAppSendJob>, queueName: string, error: unknown) {
  const data = job.data
  const classification = classifyWhatsAppError(error)
  const attemptsLimit = Math.max(1, Number(job.opts.attempts || process.env.WHATSAPP_QUEUE_ATTEMPTS || 3))
  // Inside the processor, attemptsMade counts prior failures. This is the
  // current attempt number, so the alert fires only after the configured final try.
  const attemptNumber = job.attemptsMade + 1
  const willRetry = classification.retryable && attemptNumber < attemptsLimit
  if (!classification.retryable) job.discard()

  await Promise.allSettled([
    transitionWhatsAppMessage({
      messageLogId: data.messageLogId || null,
      campaignLogId: data.campaignLogId || null,
      campaignId: data.campaignId || null,
      status: willRetry ? "retrying" : classification.retryable ? "failed" : "abandoned",
      failureReason: classification.failureReason,
      errorMessage: safeErrorMessage(error),
      stackTrace: safeStackTrace(error),
      queueName,
      queueJobId: job.id || null,
      retryCount: attemptNumber,
      metadata: { errorCode: classification.errorCode, retryable: classification.retryable, willRetry, attemptsLimit, attemptNumber },
    }),
    writeWhatsAppQueueLog({
      queueName,
      queueJobId: job.id || null,
      event: willRetry ? "job.retrying" : "job.failed",
      status: willRetry ? "retrying" : classification.retryable ? "failed" : "abandoned",
      customerId: data.customerId || null,
      campaignId: data.campaignId || null,
      campaignLogId: data.campaignLogId || null,
      messageLogId: data.messageLogId || null,
      attempt: attemptNumber,
      failureReason: classification.failureReason,
      metadata: { errorCode: classification.errorCode, retryable: classification.retryable, willRetry, attemptNumber, attemptsLimit },
    }),
    writeWhatsAppErrorLog({
      error,
      queueName,
      queueJobId: job.id || null,
      customerId: data.customerId || null,
      campaignId: data.campaignId || null,
      campaignLogId: data.campaignLogId || null,
      messageLogId: data.messageLogId || null,
      metadata: { willRetry, attemptsLimit, attemptNumber },
    }),
    data.recipientId
      ? (prisma as any).whatsAppCampaignRecipient.update({
          where: { id: data.recipientId },
          data: {
            status: willRetry ? "retrying" : classification.retryable ? "failed" : "abandoned",
            failedAt: new Date(),
            metadata: { ...(data.metadata || {}), failureReason: classification.failureReason },
          },
        })
      : Promise.resolve(null),
    data.recipientId
      ? (prisma as any).whatsAppCampaignEvent.create({
          data: {
            campaignId: data.campaignId || null,
            campaignMessageId: data.campaignMessageId || null,
            recipientId: data.recipientId,
            customerId: data.customerId || null,
            mediaAssetId: data.mediaAssetId || null,
            eventType: willRetry ? "retrying" : "failed",
            status: willRetry ? "retrying" : "failed",
            provider: data.provider || "evolution",
            messageLogId: data.messageLogId || null,
            campaignLogId: data.campaignLogId || null,
            metadata: { failureReason: classification.failureReason, willRetry },
          },
        })
      : Promise.resolve(null),
  ])

  if (data.campaignId) await syncCampaignCounters(data.campaignId).catch(() => null)

  // Never send alerts for intermediate attempts. The alert itself marks its
  // WhatsApp job to prevent recursive alerts if the provider is still broken.
  if (!willRetry && data.metadata?.suppressEmergencyAlert !== true) {
    await sendEmergencyDeliveryFailureAlert({
      queueName,
      jobId: job.id == null ? null : String(job.id),
      attemptCount: attemptNumber,
      errorCode: classification.errorCode,
      failureReason: classification.failureReason,
      errorMessage: safeErrorMessage(error),
    }).catch((alertError) => {
      console.error("[whatsapp-worker] terminal failure admin alert could not be dispatched", {
        queueName,
        jobId: job.id || null,
        error: safeErrorMessage(alertError),
      })
    })
  }
}

async function processSendJob(job: Job<WhatsAppSendJob>, queueName: string) {
  const data = job.data
  const brandName = await resolveBrandIdentity()
  await markJobProcessing(job, queueName)
  try {
    const rendered = data.templateKey
      ? await resolveAndRenderWhatsAppTemplate({
          key: data.templateKey,
          variables: data.variables || {},
          language: data.templateLanguage,
          templateVersionId: data.templateVersionId,
          fallbackKey: WHATSAPP_TEMPLATE_KEYS.SYSTEM_FALLBACK,
        })
      : await resolveAndRenderWhatsAppTemplate({
          key: WHATSAPP_TEMPLATE_KEYS.SYSTEM_FALLBACK,
          variables: { company_name: brandName, brandName, ...(data.variables || {}), message_text: data.message || `Your ${brandName} update is ready.` },
          fallbackKey: WHATSAPP_TEMPLATE_KEYS.SYSTEM_FALLBACK,
        })
    if (!rendered) throw new Error(`WhatsApp template render failed for ${data.templateKey || WHATSAPP_TEMPLATE_KEYS.SYSTEM_FALLBACK}.`)
    const renderedMessage = rendered.message
    const result = data.filePath && data.messageType !== "text"
      ? await sendWhatsAppMedia({
          to: data.to,
          filePath: data.filePath,
          caption: data.caption || renderedMessage || null,
          mediaType: data.messageType as any,
          customerId: data.customerId,
          orderId: data.orderId,
          invoiceId: data.invoiceId,
          ticketId: data.ticketId,
          campaignId: data.campaignId,
          campaignLogId: data.campaignLogId,
          templateKey: data.templateKey,
          category: data.category,
          provider: data.provider,
          skipRegistrationCheck: data.skipRegistrationCheck,
          queueName,
          queueJobId: job.id || null,
          messageLogId: data.messageLogId || null,
          metadata: { ...(data.metadata || {}), workerRenderDurationMs: rendered.renderDurationMs, workerCacheHit: rendered.cacheHit },
        })
      : await sendWhatsAppText({
          to: data.to,
          message: renderedMessage,
          customerId: data.customerId,
          orderId: data.orderId,
          invoiceId: data.invoiceId,
          ticketId: data.ticketId,
          campaignId: data.campaignId,
          campaignLogId: data.campaignLogId,
          templateKey: data.templateKey,
          category: data.category,
          provider: data.provider,
          skipRegistrationCheck: data.skipRegistrationCheck,
          queueName,
          queueJobId: job.id || null,
          messageLogId: data.messageLogId || null,
          metadata: { ...(data.metadata || {}), workerRenderDurationMs: rendered.renderDurationMs, workerCacheHit: rendered.cacheHit },
        })

    const finalStatus = completionStatus(result)
    if (data.campaignLogId) {
      await prisma.whatsAppCampaignLog.update({
        where: { id: data.campaignLogId },
        data: {
          status: finalStatus,
          ...completionTimestamps(finalStatus),
          providerMessageId: result.messageId || null,
          whatsappMessageId: result.messageId || null,
          providerResponse: { messageId: result.messageId || null, ack: (result as any).ack || null, deliveryStatus: (result as any).deliveryStatus || finalStatus } as any,
        },
      }).catch(() => null)
    }
    if (data.recipientId) {
      await (prisma as any).whatsAppCampaignRecipient.update({
        where: { id: data.recipientId },
        data: {
          status: finalStatus,
          ...completionTimestamps(finalStatus),
          metadata: { ...(data.metadata || {}), providerMessageId: result.messageId || null, ack: (result as any).ack || null, deliveryStatus: (result as any).deliveryStatus || finalStatus },
        },
      }).catch(() => null)
      await (prisma as any).whatsAppCampaignEvent.create({
        data: {
          campaignId: data.campaignId || null,
          campaignMessageId: data.campaignMessageId || null,
          recipientId: data.recipientId,
          customerId: data.customerId || null,
          mediaAssetId: data.mediaAssetId || null,
          eventType: finalStatus,
          status: finalStatus,
          provider: data.provider || "evolution",
          messageLogId: data.messageLogId || null,
          campaignLogId: data.campaignLogId || null,
          metadata: { providerMessageId: result.messageId || null, ack: (result as any).ack || null, deliveryStatus: (result as any).deliveryStatus || finalStatus },
        },
      }).catch(() => null)
    }
    await writeWhatsAppQueueLog({
      queueName,
      queueJobId: job.id || null,
      event: "job.completed",
      status: finalStatus,
      customerId: data.customerId || null,
      campaignId: data.campaignId || null,
      campaignLogId: data.campaignLogId || null,
      messageLogId: data.messageLogId || null,
      attempt: job.attemptsMade + 1,
      processingMs: job.processedOn ? Date.now() - job.processedOn : null,
      metadata: { providerMessageId: result.messageId || null, ack: (result as any).ack || null, deliveryStatus: (result as any).deliveryStatus || finalStatus },
    })
    paymentFlowLog("WhatsApp sent", {
      orderId: data.orderId || null,
      invoiceId: data.invoiceId || null,
      customerId: data.customerId || null,
      templateKey: data.templateKey || null,
      queueName,
      queueJobId: job.id || null,
      status: finalStatus,
      messageId: result.messageId || null,
    })
    if (data.campaignId) await syncCampaignCounters(data.campaignId).catch(() => null)
    return result
  } catch (error) {
    paymentFlowError("WhatsApp send failed", error, { orderId: data.orderId || null, invoiceId: data.invoiceId || null, customerId: data.customerId || null, templateKey: data.templateKey || null, queueName, queueJobId: job.id || null })
    await handleSendFailure(job, queueName, error)
    throw error
  }
}

async function updatePhoneVerificationDelivery(id: string | null | undefined, status: string, extra: Record<string, unknown> = {}) {
  if (!id) return
  const deliveryStatus = status === "whatsapp_device_ack" ? "delivered" : status
  await (prisma as any).phoneVerification.update({
    where: { id },
    data: {
      deliveryStatus,
      ...(typeof extra.whatsappMessageId === "string" ? { whatsappMessageId: extra.whatsappMessageId } : {}),
    },
  }).catch(() => null)
}

async function processOtpJob(job: Job<WhatsAppOtpJob>, queueName = WHATSAPP_OTP_QUEUE) {
  const data = job.data
  const startedAt = new Date()
  const normalized = normalizeWhatsAppNumber(data.phone)
  await writeWhatsAppQueueLog({
    queueName,
    queueJobId: job.id || null,
    event: "otp.processing",
    status: "processing",
    customerId: data.customerId,
    messageLogId: data.messageLogId || null,
    phoneHash: normalized.phoneHash,
    maskedPhone: normalized.maskedPhone,
    attempt: job.attemptsMade + 1,
    metadata: { generatedAt: data.generatedAt || null, expiresAt: data.expiresAt || null, sendStartTime: startedAt.toISOString() },
  })
  try {
    await updatePhoneVerificationDelivery(data.phoneVerificationId, "sending")
    await writeWhatsAppQueueLog({
      queueName,
      queueJobId: job.id || null,
      event: "otp.sending",
      status: "sending",
      customerId: data.customerId,
      messageLogId: data.messageLogId || null,
      phoneHash: normalized.phoneHash,
      maskedPhone: normalized.maskedPhone,
      attempt: job.attemptsMade + 1,
    })
    const rendered = await resolveAndRenderWhatsAppTemplate({
      key: data.templateKey || WHATSAPP_TEMPLATE_KEYS.AUTH_LOGIN_OTP,
      templateVersionId: data.templateVersionId || null,
      language: data.templateLanguage || null,
      variables: {
        otp_code: data.otp,
        otp: data.otp,
        minutes: data.minutes,
        ...(data.variables || {}),
      },
      fallbackKey: WHATSAPP_TEMPLATE_KEYS.AUTH_LOGIN_OTP,
    })
    if (!rendered) {
      await writeWhatsAppQueueLog({
        queueName,
        queueJobId: job.id || null,
        event: "otp.template_missing",
        status: "failed",
        customerId: data.customerId,
        messageLogId: data.messageLogId || null,
        phoneHash: normalized.phoneHash,
        maskedPhone: normalized.maskedPhone,
        attempt: job.attemptsMade + 1,
        failureReason: "template_missing",
        metadata: { requestedTemplateKey: data.templateKey || WHATSAPP_TEMPLATE_KEYS.AUTH_LOGIN_OTP },
      })
      await updatePhoneVerificationDelivery(data.phoneVerificationId, "failed")
      throw new Error(`Required WhatsApp OTP template missing: ${data.templateKey || WHATSAPP_TEMPLATE_KEYS.AUTH_LOGIN_OTP}`)
    }
    const result = await sendWhatsAppText({
      to: data.phone,
      message: rendered.message,
      customerId: data.customerId,
      templateKey: rendered?.templateKey || data.templateKey || WHATSAPP_TEMPLATE_KEYS.AUTH_LOGIN_OTP,
      category: "authentication",
      queueName,
      queueJobId: job.id || null,
      messageLogId: data.messageLogId || null,
      metadata: {
        ...(data.metadata || {}),
        source: "phone_otp",
        countryCode: (data.variables as any)?.countryCode || (data.metadata as any)?.countryCode || null,
        jid: normalized.jid,
        queueJobId: job.id || null,
        messageLogId: data.messageLogId || null,
        generatedAt: data.generatedAt || null,
        expiresAt: data.expiresAt || null,
        sendStartTime: startedAt.toISOString(),
        sendCompletionTime: new Date().toISOString(),
        workerRenderDurationMs: rendered?.renderDurationMs ?? 0,
        workerCacheHit: rendered?.cacheHit ?? false,
        phoneVerificationId: data.phoneVerificationId || null,
      },
    })
    const finalStatus = completionStatus(result)
    await updatePhoneVerificationDelivery(data.phoneVerificationId, finalStatus, { whatsappMessageId: result.messageId || null })
    await writeWhatsAppQueueLog({
      queueName,
      queueJobId: job.id || null,
      event: `otp.${finalStatus}`,
      status: finalStatus,
      customerId: data.customerId,
      messageLogId: data.messageLogId || null,
      phoneHash: normalized.phoneHash,
      maskedPhone: normalized.maskedPhone,
      attempt: job.attemptsMade + 1,
      processingMs: Date.now() - startedAt.getTime(),
      metadata: { providerMessageId: result.messageId || null, ack: (result as any).ack || null, deliveryStatus: (result as any).deliveryStatus || finalStatus, jid: normalized.jid, sendCompletionTime: new Date().toISOString() },
    })
    return result
  } catch (error) {
    const attempts = Number(job.opts.attempts || 1)
    const willRetry = job.attemptsMade + 1 < attempts
    const classification = classifyWhatsAppError(error)
    const finalStatus = classification.failureReason === "invalid_jid" ? "provider_unavailable" : "failed"
    await updatePhoneVerificationDelivery(data.phoneVerificationId, willRetry ? "retrying" : finalStatus)
    await writeWhatsAppQueueLog({
      queueName,
      queueJobId: job.id || null,
      event: "otp.failed",
      status: "failed",
      customerId: data.customerId,
      messageLogId: data.messageLogId || null,
      phoneHash: normalized.phoneHash,
      maskedPhone: normalized.maskedPhone,
      attempt: job.attemptsMade + 1,
      failureReason: classification.failureReason,
      processingMs: Date.now() - startedAt.getTime(),
      metadata: {
        error: error instanceof Error ? error.message : String(error),
        errorCode: classification.errorCode,
        jid: normalized.jid,
        phoneVerificationId: data.phoneVerificationId || null,
      },
    })
    await handleSendFailure(job as unknown as Job<WhatsAppSendJob>, queueName, error)
    throw error
  }
}

function createWorkers() {
  const sendWorker = new Worker<WhatsAppSendJob>(WHATSAPP_SEND_QUEUE, (job) => processSendJob(job, WHATSAPP_SEND_QUEUE), {
    connection: redisConnection,
    concurrency: Number(process.env.WHATSAPP_SEND_CONCURRENCY || 2),
    limiter: {
      max: Number(process.env.WHATSAPP_SEND_RATE_LIMIT_MAX || 30),
      duration: Number(process.env.WHATSAPP_SEND_RATE_LIMIT_DURATION_MS || 60_000),
    },
  })

  const mediaWorker = new Worker<WhatsAppSendJob>(WHATSAPP_MEDIA_QUEUE, (job) => processSendJob(job, WHATSAPP_MEDIA_QUEUE), {
    connection: redisConnection,
    concurrency: Number(process.env.WHATSAPP_MEDIA_CONCURRENCY || 1),
    limiter: {
      max: Number(process.env.WHATSAPP_MEDIA_RATE_LIMIT_MAX || 10),
      duration: Number(process.env.WHATSAPP_MEDIA_RATE_LIMIT_DURATION_MS || 60_000),
    },
  })

  const authWorker = new Worker<WhatsAppOtpJob>(WHATSAPP_AUTH_QUEUE, (job) => processOtpJob(job, WHATSAPP_AUTH_QUEUE), {
    connection: redisConnection,
    concurrency: Number(process.env.WHATSAPP_AUTH_CONCURRENCY || 1),
    limiter: {
      max: Number(process.env.WHATSAPP_AUTH_RATE_LIMIT_MAX || 10),
      duration: Number(process.env.WHATSAPP_AUTH_RATE_LIMIT_DURATION_MS || 60_000),
    },
  })

  const campaignWorker = new Worker<{ campaignId: string; retryFailedOnly?: boolean }>(
    WHATSAPP_CAMPAIGN_QUEUE,
    async (job) => {
      await writeWhatsAppQueueLog({
        queueName: WHATSAPP_CAMPAIGN_QUEUE,
        queueJobId: job.id || null,
        event: "campaign.processing",
        status: "processing",
        campaignId: job.data.campaignId,
        attempt: job.attemptsMade + 1,
      })
      const result = await processWhatsAppCampaign(job.data.campaignId, Boolean(job.data.retryFailedOnly))
      await writeWhatsAppQueueLog({
        queueName: WHATSAPP_CAMPAIGN_QUEUE,
        queueJobId: job.id || null,
        event: "campaign.completed",
        status: "completed",
        campaignId: job.data.campaignId,
        attempt: job.attemptsMade + 1,
        metadata: result as any,
      })
      return result
    },
    {
      connection: redisConnection,
      concurrency: Number(process.env.WHATSAPP_CAMPAIGN_CONCURRENCY || 1),
      limiter: {
        max: Number(process.env.WHATSAPP_CAMPAIGN_RATE_LIMIT_MAX || 20),
        duration: Number(process.env.WHATSAPP_CAMPAIGN_RATE_LIMIT_DURATION_MS || 60 * 60_000),
      },
    },
  )

  const otpWorker = new Worker<WhatsAppOtpJob>(WHATSAPP_OTP_QUEUE, (job) => processOtpJob(job, WHATSAPP_OTP_QUEUE), {
    connection: redisConnection,
    concurrency: Number(process.env.WHATSAPP_OTP_CONCURRENCY || 1),
    limiter: {
      max: Number(process.env.WHATSAPP_OTP_RATE_LIMIT_MAX || 20),
      duration: Number(process.env.WHATSAPP_OTP_RATE_LIMIT_DURATION_MS || 60_000),
    },
  })

  const loginAlertWorker = new Worker<WhatsAppSendJob>(WHATSAPP_LOGIN_ALERT_QUEUE, (job) => processSendJob(job, WHATSAPP_LOGIN_ALERT_QUEUE), {
    connection: redisConnection,
    concurrency: Number(process.env.WHATSAPP_LOGIN_ALERT_CONCURRENCY || 1),
    limiter: {
      max: Number(process.env.WHATSAPP_LOGIN_ALERT_RATE_LIMIT_MAX || 20),
      duration: Number(process.env.WHATSAPP_LOGIN_ALERT_RATE_LIMIT_DURATION_MS || 60_000),
    },
  })

  workers = [sendWorker, mediaWorker, authWorker, campaignWorker, otpWorker, loginAlertWorker]
  for (const worker of workers) {
    worker.on("completed", (job) => console.info("[whatsapp-worker] completed", { queue: worker.name, id: job.id }))
    worker.on("failed", async (job, error) => {
      console.error("[whatsapp-worker] failed", { queue: worker.name, id: job?.id, error: error.message })
      const data = job?.data as Partial<WhatsAppSendJob> | undefined
      if (data?.campaignLogId) {
        await prisma.whatsAppCampaignLog.update({
          where: { id: data.campaignLogId },
          data: {
            status: "failed",
            failedAt: new Date(),
            errorMessage: error.message,
            retryCount: { increment: 1 },
          },
        }).catch(() => null)
      }
      if (data?.campaignId) await syncCampaignCounters(data.campaignId).catch(() => null)
    })
    worker.on("error", (error) => {
      void writeWhatsAppErrorLog({ error, queueName: worker.name, metadata: { event: "worker.error" } })
    })
    worker.on("stalled", (jobId) => {
      void writeWhatsAppQueueLog({ queueName: worker.name, queueJobId: jobId, event: "job.stalled", status: "stalled" })
    })
  }
  return workers
}

async function boot() {
  await bootLog("[BOOT] Starting WhatsApp worker")
  await prisma.$queryRawUnsafe("SELECT 1")
  await bootLog("[BOOT] Database connected")
  await bootLog("[BOOT] Redis connected", { host: redisConnection.host, port: redisConnection.port, db: redisConnection.db || 0 })
  console.info("[TEMPLATES] validating required templates")
  await writeWhatsAppLog({ event: "templates.validation_started", status: "starting" }).catch(() => null)
  const templateValidation = await validateWhatsAppRequiredTemplates({ autoHeal: true })
  for (const row of templateValidation.required) {
    console.info(`[TEMPLATES] ${row.key} ${row.ok ? "OK" : "MISSING"}`)
  }
  if (!templateValidation.ok) {
    throw new Error(`Required WhatsApp templates invalid: ${templateValidation.missing.map((row) => row.key).join(", ")}`)
  }
  console.info("[TEMPLATES] all required templates valid")
  await writeWhatsAppLog({ event: "templates.validation_completed", status: "ok", metadata: { required: templateValidation.required.length } }).catch(() => null)
  const evolution = await getEvolutionStatus().catch((error: any) => ({ connected: false, error: error?.message || String(error) }))
  await bootLog("[BOOT] Evolution API checked", { connected: Boolean((evolution as any).connected), status: (evolution as any).status || "unknown", error: (evolution as any).error || null })
  createWorkers()
  await bootLog("[BOOT] Queue workers online", { queues: workers.map((worker) => worker.name) })

  healthTimer = setInterval(() => {
    void getEvolutionStatus().catch((error) => {
      console.error("[whatsapp-worker] Evolution health check failed", safeErrorMessage(error))
    })
  }, Number(process.env.WHATSAPP_HEALTH_INTERVAL_MS || 15_000))

  automationTimer = setInterval(() => {
    void runScheduledWhatsAppAutomations().catch((error) => {
      console.error("[whatsapp-worker] automation failed", error?.message || error)
    })
  }, Number(process.env.WHATSAPP_AUTOMATION_INTERVAL_MS || 5 * 60_000))
}

void boot().catch((error) => {
  console.error("[whatsapp-worker] boot failed", safeErrorMessage(error))
  void writeWhatsAppErrorLog({ error, metadata: { stage: "worker_boot" } })
  process.exit(1)
})

async function shutdown(signal: string) {
  console.info("[whatsapp-worker] shutting down", { signal })
  if (automationTimer) clearInterval(automationTimer)
  if (healthTimer) clearInterval(healthTimer)
  await writeWhatsAppLog({ event: "worker.shutdown", status: "stopping", metadata: { signal } })
  await Promise.allSettled(workers.map((worker) => worker.close()))
  await prisma.$disconnect().catch(() => null)
  process.exit(0)
}

process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("SIGTERM", () => void shutdown("SIGTERM"))
void writeWhatsAppLog({ event: "worker.started", status: "running" })
console.info("[whatsapp-worker] started")
