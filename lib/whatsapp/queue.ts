import { Queue, type JobsOptions } from "bullmq"
import type { ChannelResult } from "@/lib/notifications/types"
import {
  classifyWhatsAppError,
  createWhatsAppMessageLifecycle,
  maskWhatsAppPhone,
  normalizeWhatsAppNumber,
  redactWhatsAppPayload,
  transitionWhatsAppMessage,
  writeWhatsAppLog,
  writeWhatsAppQueueLog,
} from "@/lib/whatsapp/diagnostics"
import {
  resolveAndRenderWhatsAppTemplate,
  type WhatsAppTemplateVariables,
} from "@/lib/whatsapp/templates"
import { WHATSAPP_TEMPLATE_KEYS } from "@/lib/whatsapp/template-registry"
import { normalizeProviderJob, type WhatsAppProviderName } from "@/lib/whatsapp/provider"
import { normalizeOtpError, WhatsAppOtpError } from "@/lib/whatsapp/otp-errors"
import { paymentFlowLog } from "@/lib/payment-flow-log"
import { sendEmergencyDeliveryFailureAlert } from "@/lib/admin-emergency-alert"

export const WHATSAPP_SEND_QUEUE = "whatsapp-send"
export const WHATSAPP_CAMPAIGN_QUEUE = "whatsapp-campaign"
export const WHATSAPP_MEDIA_QUEUE = "whatsapp-media"
export const WHATSAPP_AUTH_QUEUE = "whatsapp-auth"
export const WHATSAPP_OTP_QUEUE = "whatsapp-otp"
export const WHATSAPP_LOGIN_ALERT_QUEUE = "whatsapp-login-alert"

export type WhatsAppSendJob = {
  to: string
  provider?: WhatsAppProviderName
  message?: string
  filePath?: string
  caption?: string | null
  messageType?: "text" | "document" | "image" | "audio" | "video" | "sticker"
  mediaAssetId?: string | null
  campaignMessageId?: string | null
  recipientId?: string | null
  buttons?: Array<{ type: string; label: string; value?: string | null }>
  variables?: WhatsAppTemplateVariables
  customerId?: string | null
  orderId?: string | null
  invoiceId?: string | null
  ticketId?: string | null
  campaignId?: string | null
  campaignLogId?: string | null
  templateKey?: string | null
  templateName?: string | null
  templateVersionId?: string | null
  templateLanguage?: string | null
  category?: string | null
  skipRegistrationCheck?: boolean
  messageLogId?: string | null
  metadata?: Record<string, unknown>
}

export type SendWhatsAppMessageInput = Omit<WhatsAppSendJob, "message" | "caption" | "templateName" | "templateLanguage"> & {
  templateKey: string
  variables?: WhatsAppTemplateVariables
  fallbackKey?: string | null
  language?: string | null
  rawMessageText?: string | null
  captionText?: string | null
}

export type WhatsAppCampaignJob = {
  campaignId: string
  retryFailedOnly?: boolean
}

export type WhatsAppOtpJob = {
  customerId: string
  phoneVerificationId?: string | null
  phone: string
  otp: string
  minutes: number
  variables?: WhatsAppTemplateVariables
  templateKey?: string | null
  templateName?: string | null
  templateVersionId?: string | null
  templateLanguage?: string | null
  generatedAt?: string
  expiresAt?: string
  messageLogId?: string | null
  metadata?: Record<string, unknown>
}

type RedisConnectionOptions = {
  host: string
  port: number
  username?: string
  password?: string
  db?: number
  maxRetriesPerRequest: null
}

let sendQueue: Queue<WhatsAppSendJob> | null = null
let campaignQueue: Queue<WhatsAppCampaignJob> | null = null
let mediaQueue: Queue<WhatsAppSendJob> | null = null
let authQueue: Queue<WhatsAppOtpJob> | null = null
let otpQueue: Queue<WhatsAppOtpJob> | null = null
let loginAlertQueue: Queue<WhatsAppSendJob> | null = null

export function getWhatsAppRedisConnection(): RedisConnectionOptions | null {
  const raw = String(process.env.REDIS_URL || "").trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    return {
      host: url.hostname,
      port: Number(url.port || 6379),
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      db: url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined,
      maxRetriesPerRequest: null,
    }
  } catch {
    return null
  }
}

export function getWhatsAppQueue(name: typeof WHATSAPP_SEND_QUEUE): Queue<WhatsAppSendJob> | null
export function getWhatsAppQueue(name: typeof WHATSAPP_MEDIA_QUEUE): Queue<WhatsAppSendJob> | null
export function getWhatsAppQueue(name: typeof WHATSAPP_AUTH_QUEUE): Queue<WhatsAppOtpJob> | null
export function getWhatsAppQueue(name: typeof WHATSAPP_CAMPAIGN_QUEUE): Queue<WhatsAppCampaignJob> | null
export function getWhatsAppQueue(name: typeof WHATSAPP_OTP_QUEUE): Queue<WhatsAppOtpJob> | null
export function getWhatsAppQueue(name: typeof WHATSAPP_LOGIN_ALERT_QUEUE): Queue<WhatsAppSendJob> | null
export function getWhatsAppQueue(name: string) {
  const connection = getWhatsAppRedisConnection()
  if (!connection) return null

  if (name === WHATSAPP_SEND_QUEUE) {
    sendQueue ||= new Queue<WhatsAppSendJob>(WHATSAPP_SEND_QUEUE, { connection })
    return sendQueue
  }
  if (name === WHATSAPP_MEDIA_QUEUE) {
    mediaQueue ||= new Queue<WhatsAppSendJob>(WHATSAPP_MEDIA_QUEUE, { connection })
    return mediaQueue
  }
  if (name === WHATSAPP_AUTH_QUEUE) {
    authQueue ||= new Queue<WhatsAppOtpJob>(WHATSAPP_AUTH_QUEUE, { connection })
    return authQueue
  }
  if (name === WHATSAPP_CAMPAIGN_QUEUE) {
    campaignQueue ||= new Queue<WhatsAppCampaignJob>(WHATSAPP_CAMPAIGN_QUEUE, { connection })
    return campaignQueue
  }
  if (name === WHATSAPP_OTP_QUEUE) {
    otpQueue ||= new Queue<WhatsAppOtpJob>(WHATSAPP_OTP_QUEUE, { connection })
    return otpQueue
  }
  if (name === WHATSAPP_LOGIN_ALERT_QUEUE) {
    loginAlertQueue ||= new Queue<WhatsAppSendJob>(WHATSAPP_LOGIN_ALERT_QUEUE, { connection })
    return loginAlertQueue
  }
  return null
}

export async function closeWhatsAppQueues() {
  const queues = [sendQueue, campaignQueue, mediaQueue, authQueue, otpQueue, loginAlertQueue].filter(Boolean) as Array<Queue<any>>
  await Promise.all(queues.map((queue) => queue.close().catch(() => undefined)))
  sendQueue = null
  campaignQueue = null
  mediaQueue = null
  authQueue = null
  otpQueue = null
  loginAlertQueue = null
}

async function createLifecycleBestEffort(input: Parameters<typeof createWhatsAppMessageLifecycle>[0]) {
  try {
    return await createWhatsAppMessageLifecycle(input)
  } catch (error) {
    const normalized = normalizeWhatsAppNumber(input.to)
    await writeWhatsAppLog({
      level: "error",
      event: "message.lifecycle_create_failed",
      status: "degraded",
      queueName: input.queueName || null,
      customerId: input.customerId || null,
      campaignId: input.campaignId || null,
      campaignLogId: input.campaignLogId || null,
      phoneHash: normalized.phoneHash,
      maskedPhone: normalized.maskedPhone,
      failureReason: classifyWhatsAppError(error).failureReason,
      metadata: { error: error instanceof Error ? error.message : String(error), source: input.metadata?.source || "lifecycle" },
    }).catch(() => null)
    return { row: null, normalized }
  }
}

function defaultJobOptions(options?: JobsOptions, reliableMessage = false): JobsOptions {
  // Customer-facing outbound messages get four total attempts, with a five-minute
  // pause between retryable failures. OTP/auth and campaign queues keep their
  // explicitly separate retry profile to avoid delaying time-sensitive codes.
  const defaultAttempts = reliableMessage ? 4 : 3
  const requestedAttempts = Number(options?.attempts ?? (reliableMessage
    ? process.env.WHATSAPP_MESSAGE_ATTEMPTS ?? defaultAttempts
    : process.env.WHATSAPP_QUEUE_ATTEMPTS ?? defaultAttempts))
  const maxAttempts = reliableMessage ? 4 : 3
  const configuredDelay = Number(reliableMessage
    ? process.env.WHATSAPP_MESSAGE_RETRY_DELAY_MS || 5 * 60_000
    : process.env.WHATSAPP_QUEUE_BACKOFF_MS || 20_000)
  const fallbackDelay = reliableMessage ? 5 * 60_000 : 20_000
  const retryDelayMs = Number.isFinite(configuredDelay) && configuredDelay > 0 ? configuredDelay : fallbackDelay
  return {
    ...options,
    attempts: Math.max(1, Math.min(maxAttempts, Number.isFinite(requestedAttempts) ? requestedAttempts : defaultAttempts)),
    backoff: reliableMessage
      ? { type: "fixed", delay: retryDelayMs }
      : options?.backoff || { type: "exponential", delay: retryDelayMs },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 1000 },
  }
}

function safeBullMqJobId(parts: Array<string | number | null | undefined>) {
  return parts
    .map((part) => String(part || "none").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "none")
    .join("_")
}

export async function enqueueWhatsAppMessage(input: WhatsAppSendJob, options?: JobsOptions): Promise<ChannelResult> {
  const normalizedInput = normalizeProviderJob(input)
  const queueName = normalizedInput.messageType && normalizedInput.messageType !== "text" ? WHATSAPP_MEDIA_QUEUE : WHATSAPP_SEND_QUEUE
  const queue = getWhatsAppQueue(queueName as typeof WHATSAPP_SEND_QUEUE) as Queue<WhatsAppSendJob> | null
  const normalized = normalizeWhatsAppNumber(normalizedInput.to)
  if (!queue) {
    await writeWhatsAppLog({
      level: "error",
      event: "queue.unavailable",
      status: "failed",
      queueName,
      phoneHash: normalized.phoneHash,
      maskedPhone: normalized.maskedPhone,
      failureReason: "redis_unavailable",
      metadata: { source: normalizedInput.metadata?.source || "enqueue_message" },
    })
    if (normalizedInput.metadata?.suppressEmergencyAlert !== true) {
      await sendEmergencyDeliveryFailureAlert({
        queueName,
        jobId: String(normalizedInput.metadata?.dedupeKey || normalizedInput.metadata?.notificationKey || "redis-unavailable"),
        attemptCount: 1,
        errorCode: "REDIS_QUEUE_UNAVAILABLE",
        failureReason: "redis_unavailable",
        errorMessage: "Redis queue is unavailable; the outgoing message could not be accepted for retry.",
      }).catch((alertError) => {
        console.error("[whatsapp-queue] admin alert failed while queue unavailable", {
          queueName,
          error: alertError instanceof Error ? alertError.message : String(alertError),
        })
      })
    }
    return { ok: false, status: "failed", error: "Redis queue is not configured", toMasked: normalized.maskedPhone }
  }

  const lifecycle = normalizedInput.messageLogId
    ? null
    : await createLifecycleBestEffort({
      to: normalizedInput.to,
      messageType: normalizedInput.messageType || "text",
      category: normalizedInput.category || "transactional",
      templateKey: normalizedInput.templateKey || null,
      templateName: normalizedInput.templateName || null,
      templateVersionId: normalizedInput.templateVersionId || null,
      templateLanguage: normalizedInput.templateLanguage || null,
      queueName,
      customerId: normalizedInput.customerId || null,
      orderId: normalizedInput.orderId || null,
      invoiceId: normalizedInput.invoiceId || null,
      ticketId: normalizedInput.ticketId || null,
      campaignId: normalizedInput.campaignId || null,
      campaignLogId: normalizedInput.campaignLogId || null,
      metadata: { ...(normalizedInput.metadata || {}), queuedBy: "enqueueWhatsAppMessage" },
      })
  const messageLogId = normalizedInput.messageLogId || lifecycle?.row?.id || null
  const businessDedupeKey = String(normalizedInput.metadata?.dedupeKey || normalizedInput.metadata?.notificationKey || "").trim()
  const jobOptions = defaultJobOptions({
    ...options,
    ...(businessDedupeKey && !options?.jobId ? { jobId: safeBullMqJobId([queueName, businessDedupeKey]) } : {}),
  }, true)
  let job: Awaited<ReturnType<typeof queue.add>>
  try {
    job = await queue.add(queueName, { ...normalizedInput, messageLogId }, jobOptions)
  } catch (error) {
    const classification = classifyWhatsAppError(error)
    await transitionWhatsAppMessage({
      messageLogId,
      queueName,
      queueJobId: null,
      status: "failed",
      failureReason: classification.failureReason,
      errorMessage: "WhatsApp message could not be accepted by the delivery queue.",
      metadata: { errorCode: classification.errorCode, source: "queue.add" },
    }).catch(() => null)
    await writeWhatsAppQueueLog({
      queueName,
      event: "job.enqueue_failed",
      status: "failed",
      customerId: normalizedInput.customerId || null,
      campaignId: normalizedInput.campaignId || null,
      messageLogId,
      phoneHash: normalized.phoneHash,
      maskedPhone: normalized.maskedPhone,
      attempt: 1,
      failureReason: classification.failureReason,
      metadata: { errorCode: classification.errorCode, source: "queue.add" },
    }).catch(() => null)
    if (normalizedInput.metadata?.suppressEmergencyAlert !== true) {
      await sendEmergencyDeliveryFailureAlert({
        queueName,
        jobId: String(messageLogId || businessDedupeKey || "queue-add-failed"),
        attemptCount: 1,
        errorCode: "WHATSAPP_QUEUE_ENQUEUE_FAILED",
        failureReason: classification.failureReason,
        errorMessage: error instanceof Error ? error.message : String(error),
      }).catch((alertError) => {
        console.error("[whatsapp-queue] admin alert failed after queue.add error", {
          queueName,
          error: alertError instanceof Error ? alertError.message : String(alertError),
        })
      })
    }
    return { ok: false, status: "failed", error: "WhatsApp message could not be queued", toMasked: normalized.maskedPhone }
  }
  paymentFlowLog("WhatsApp sent", {
    orderId: normalizedInput.orderId || null,
    invoiceId: normalizedInput.invoiceId || null,
    customerId: normalizedInput.customerId || null,
    templateKey: normalizedInput.templateKey || null,
    queueName,
    queueJobId: job.id || null,
    status: "queued",
  })
  await writeWhatsAppQueueLog({
    queueName,
    queueJobId: job.id || null,
    event: "job.enqueued",
    status: "queued",
    customerId: normalizedInput.customerId || null,
    campaignId: normalizedInput.campaignId || null,
    campaignLogId: normalizedInput.campaignLogId || null,
    messageLogId,
    phoneHash: normalized.phoneHash,
    maskedPhone: normalized.maskedPhone,
    payload: {
      ...normalizedInput,
      otp: undefined,
      message: normalizedInput.message ? "[message-redacted]" : undefined,
      caption: normalizedInput.caption ? "[caption-redacted]" : undefined,
      variables: normalizedInput.variables ? redactWhatsAppPayload(normalizedInput.variables) : undefined,
    },
    metadata: { delay: options?.delay || 0 },
  })
  return {
    ok: true,
    status: "queued",
    messageId: messageLogId || job.id || null,
    toMasked: normalized.maskedPhone,
  }
}

export async function sendWhatsAppMessage(input: SendWhatsAppMessageInput, options?: JobsOptions): Promise<ChannelResult> {
  const variables = {
    ...(input.variables || {}),
    ...(input.rawMessageText ? { message_text: input.rawMessageText, campaign_message: input.rawMessageText } : {}),
  }
  const rendered = await resolveAndRenderWhatsAppTemplate({
    key: input.templateKey,
    variables,
    language: input.language,
    templateVersionId: input.templateVersionId || null,
    fallbackKey: input.fallbackKey || WHATSAPP_TEMPLATE_KEYS.SYSTEM_FALLBACK,
  })
  if (!rendered) {
    const normalized = normalizeWhatsAppNumber(input.to)
    await writeWhatsAppLog({
      level: "error",
      event: "template.resolve_failed",
      status: "failed",
      phoneHash: normalized.phoneHash,
      maskedPhone: normalized.maskedPhone,
      customerId: input.customerId || null,
      failureReason: "template_missing",
      metadata: { templateKey: input.templateKey, fallbackKey: input.fallbackKey || WHATSAPP_TEMPLATE_KEYS.SYSTEM_FALLBACK },
    }).catch(() => null)
    if (input.metadata?.suppressEmergencyAlert !== true) {
      await sendEmergencyDeliveryFailureAlert({
        queueName: WHATSAPP_SEND_QUEUE,
        jobId: `template:${input.templateKey || "unknown"}`,
        attemptCount: 1,
        errorCode: "WHATSAPP_TEMPLATE_MISSING",
        failureReason: "template_missing",
        errorMessage: "The outbound notification template could not be resolved; the message was not queued.",
      }).catch(() => null)
    }
    return { ok: false, status: "failed", error: `WhatsApp template not found: ${input.templateKey}`, toMasked: normalized.maskedPhone }
  }

  return enqueueWhatsAppMessage({
    ...input,
    variables,
    message: rendered.message,
    caption: rendered.message,
    templateKey: rendered.templateKey,
    templateName: rendered.templateName,
    templateVersionId: rendered.templateVersionId,
    templateLanguage: rendered.language,
    category: input.category || rendered.category,
    metadata: {
      ...(input.metadata || {}),
      templateId: rendered.templateId,
      templateVersion: rendered.templateVersion,
      templateCacheHit: rendered.cacheHit,
      fallbackReason: rendered.fallbackReason,
      renderDurationMs: rendered.renderDurationMs,
      requestedTemplateKey: input.templateKey,
    },
  }, options)
}

export async function enqueueWhatsAppCampaign(input: WhatsAppCampaignJob, options?: JobsOptions) {
  const queue = getWhatsAppQueue(WHATSAPP_CAMPAIGN_QUEUE)
  if (!queue) throw new Error("Redis queue is not configured")
  const job = await queue.add(WHATSAPP_CAMPAIGN_QUEUE, input, defaultJobOptions(options))
  await writeWhatsAppQueueLog({
    queueName: WHATSAPP_CAMPAIGN_QUEUE,
    queueJobId: job.id || null,
    event: "campaign.enqueued",
    status: "queued",
    campaignId: input.campaignId,
    payload: input as any,
    metadata: { delay: options?.delay || 0 },
  })
  return job
}

export async function enqueueWhatsAppOtp(input: WhatsAppOtpJob, options?: JobsOptions) {
  const queueName = input.templateKey === WHATSAPP_TEMPLATE_KEYS.AUTH_SIGNUP_OTP ? WHATSAPP_AUTH_QUEUE : WHATSAPP_OTP_QUEUE
  const queue = getWhatsAppQueue(queueName as typeof WHATSAPP_OTP_QUEUE)
  if (!queue) throw new WhatsAppOtpError({ code: "redis_queue_unavailable", stage: "redis_queue", status: 503, retryable: true })
  const normalized = normalizeWhatsAppNumber(input.phone)
  const dedupeWindow = Math.max(60_000, Number(process.env.WHATSAPP_OTP_DEDUPE_WINDOW_MS || 5 * 60_000))
  const purpose = input.templateKey || WHATSAPP_TEMPLATE_KEYS.AUTH_LOGIN_OTP
  const windowBucket = Math.floor(Date.now() / dedupeWindow)
  const jobId = safeBullMqJobId(["otp", queueName, normalized.phoneHash, purpose, input.customerId || "anonymous", input.phoneVerificationId || windowBucket])
  const otpVariables = {
    ...(input.variables || {}),
    otp_code: input.otp,
    otp: input.otp,
    minutes: input.minutes,
  }
  const rendered = await resolveAndRenderWhatsAppTemplate({
    key: input.templateKey || WHATSAPP_TEMPLATE_KEYS.AUTH_LOGIN_OTP,
    variables: otpVariables,
    fallbackKey: input.templateKey || WHATSAPP_TEMPLATE_KEYS.AUTH_LOGIN_OTP,
  })
  if (!rendered) {
    await writeWhatsAppLog({
      level: "error",
      event: "otp.template_missing",
      status: "failed",
      customerId: input.customerId,
      phoneHash: normalized.phoneHash,
      maskedPhone: normalized.maskedPhone,
      failureReason: "template_missing",
      metadata: {
        requestedTemplateKey: input.templateKey || WHATSAPP_TEMPLATE_KEYS.AUTH_LOGIN_OTP,
      },
    })
    throw new WhatsAppOtpError({
      code: "template_missing",
      stage: "template_render",
      message: `Required WhatsApp OTP template missing: ${input.templateKey || WHATSAPP_TEMPLATE_KEYS.AUTH_LOGIN_OTP}`,
      status: 503,
      retryable: false,
    })
  }
  const lifecycle = input.messageLogId
    ? null
    : await createLifecycleBestEffort({
        to: input.phone,
        messageType: "text",
        category: "authentication",
        templateKey: rendered.templateKey,
        templateName: rendered.templateName,
        templateVersionId: rendered.templateVersionId || null,
        templateLanguage: rendered.language,
        queueName,
        customerId: input.customerId,
        metadata: {
          ...(input.metadata || {}),
          source: "phone_otp",
          generatedAt: input.generatedAt || new Date().toISOString(),
          expiresAt: input.expiresAt || null,
          minutes: input.minutes,
          phoneVerificationId: input.phoneVerificationId || null,
        },
      })
  const messageLogId = input.messageLogId || lifecycle?.row?.id || null
  const delay = (options?.delay ?? Number(process.env.WHATSAPP_OTP_RANDOM_DELAY_MAX_MS || 2500))
    ? Math.floor(Math.random() * Number(process.env.WHATSAPP_OTP_RANDOM_DELAY_MAX_MS || 2500))
    : 0
  const job = await queue.add(queueName, {
    ...input,
    templateKey: rendered.templateKey,
    templateName: rendered.templateName,
    templateVersionId: rendered.templateVersionId || null,
    templateLanguage: rendered.language,
    variables: otpVariables,
    messageLogId,
  }, defaultJobOptions({ jobId, ...options, delay })).catch((error) => {
    throw normalizeOtpError(error, "redis_queue")
  })
  await writeWhatsAppQueueLog({
    queueName,
    queueJobId: job.id || null,
    event: "otp.enqueued",
    status: "queued",
    customerId: input.customerId,
    messageLogId,
    phoneHash: normalized.phoneHash,
    maskedPhone: normalized.maskedPhone,
    payload: {
      customerId: input.customerId,
      phoneVerificationId: input.phoneVerificationId || null,
      phone: normalized.maskedPhone,
      otp: "[redacted]",
      minutes: input.minutes,
      generatedAt: input.generatedAt || null,
      expiresAt: input.expiresAt || null,
      messageLogId,
    },
    metadata: { ...(input.metadata || {}), delay },
  })
  return job
}

export async function getWhatsAppQueueStats() {
  const names = [WHATSAPP_SEND_QUEUE, WHATSAPP_CAMPAIGN_QUEUE, WHATSAPP_MEDIA_QUEUE, WHATSAPP_AUTH_QUEUE, WHATSAPP_OTP_QUEUE, WHATSAPP_LOGIN_ALERT_QUEUE] as const
  const entries = await Promise.all(names.map(async (name) => {
    const queue = getWhatsAppQueue(name as any)
    if (!queue) return [name, { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0, paused: false, prioritized: 0, waitingChildren: 0 }] as const
    const [waiting, active, delayed, completed, failed, paused, prioritized, waitingChildren] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getDelayedCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.isPaused(),
      queue.getPrioritizedCount().catch(() => 0),
      queue.getWaitingChildrenCount().catch(() => 0),
    ])
    return [name, { waiting, active, delayed, completed, failed, paused, prioritized, waitingChildren }] as const
  }))
  return Object.fromEntries(entries)
}

export async function getWhatsAppQueueDiagnostics() {
  const stats = await getWhatsAppQueueStats()
  const queues = await Promise.all(Object.keys(stats).map(async (name) => {
    const queue = getWhatsAppQueue(name as any)
    if (!queue) return { name, configured: false, stats: (stats as any)[name], failedJobs: [], delayedJobs: [] }
    const [failedJobs, delayedJobs, activeJobs, waitingJobs] = await Promise.all([
      queue.getFailed(0, 10).catch(() => []),
      queue.getDelayed(0, 10).catch(() => []),
      queue.getActive(0, 10).catch(() => []),
      queue.getWaiting(0, 10).catch(() => []),
    ])
    return {
      name,
      configured: true,
      stats: (stats as any)[name],
      failedJobs: failedJobs.map((job) => ({
        id: job.id,
        attemptsMade: job.attemptsMade,
        attemptsConfigured: job.opts.attempts || 1,
        ageMs: Date.now() - Number(job.timestamp || Date.now()),
        failedReason: job.failedReason,
        classification: job.failedReason ? classifyWhatsAppError(new Error(job.failedReason)) : null,
        data: redactWhatsAppPayload(job.data || {}),
        timestamp: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
      })),
      delayedJobs: delayedJobs.map((job) => ({ id: job.id, delay: job.delay, ageMs: Date.now() - Number(job.timestamp || Date.now()), timestamp: job.timestamp, data: redactWhatsAppPayload(job.data || {}) })),
      activeJobs: activeJobs.map((job) => ({ id: job.id, attemptsMade: job.attemptsMade, attemptsConfigured: job.opts.attempts || 1, ageMs: Date.now() - Number(job.timestamp || Date.now()), processedOn: job.processedOn, data: redactWhatsAppPayload(job.data || {}) })),
      waitingJobs: waitingJobs.map((job) => ({ id: job.id, attemptsMade: job.attemptsMade, attemptsConfigured: job.opts.attempts || 1, ageMs: Date.now() - Number(job.timestamp || Date.now()), timestamp: job.timestamp, data: redactWhatsAppPayload(job.data || {}) })),
    }
  }))
  return { stats, queues }
}

export async function clearStuckWhatsAppJobs() {
  const names = [WHATSAPP_SEND_QUEUE, WHATSAPP_CAMPAIGN_QUEUE, WHATSAPP_MEDIA_QUEUE, WHATSAPP_AUTH_QUEUE, WHATSAPP_OTP_QUEUE, WHATSAPP_LOGIN_ALERT_QUEUE] as const
  return Promise.all(names.map(async (name) => {
    const queue = getWhatsAppQueue(name as any)
    if (!queue) return { name, cleared: 0 }
    const active = await queue.getActive(0, 100).catch(() => [])
    let cleared = 0
    for (const job of active) {
      const processedOn = Number(job.processedOn || 0)
      if (processedOn && Date.now() - processedOn > Number(process.env.WHATSAPP_STUCK_JOB_MS || 10 * 60_000)) {
        await job.moveToFailed(new Error("Cleared as stuck by admin recovery action"), job.token || "0").catch(() => null)
        cleared += 1
      }
    }
    await writeWhatsAppQueueLog({ queueName: name, event: "admin.clear_stuck_jobs", status: "completed", metadata: { cleared } })
    return { name, cleared }
  }))
}

export async function retryFailedWhatsAppJobs(selectedJobIds: string[] = []) {
  const selected = new Set(selectedJobIds.map(String).filter(Boolean))
  const names = [WHATSAPP_SEND_QUEUE, WHATSAPP_CAMPAIGN_QUEUE, WHATSAPP_MEDIA_QUEUE, WHATSAPP_AUTH_QUEUE, WHATSAPP_OTP_QUEUE, WHATSAPP_LOGIN_ALERT_QUEUE] as const
  return Promise.all(names.map(async (name) => {
    const queue = getWhatsAppQueue(name as any)
    if (!queue) return { name, retried: 0 }
    const failed = await queue.getFailed(0, 100).catch(() => [])
    let retried = 0
    let skipped = 0
    for (const job of failed) {
      const classification = classifyWhatsAppError(new Error(job.failedReason || "WhatsApp delivery failed"))
      const ageMs = Date.now() - Number(job.finishedOn || job.timestamp || Date.now())
      const lifecycleEvent = String((job.data as any)?.metadata?.lifecycleEvent || "").toLowerCase()
      const historicalProvisioning = /provision|deployment|service_(?:activated|suspended)/.test(lifecycleEvent)
      const explicitlySelected = selected.has(String(job.id || ""))
      if ((selected.size > 0 && !explicitlySelected) || (!explicitlySelected && (!classification.retryable || ageMs > 7 * 86400_000 || historicalProvisioning))) {
        skipped += 1
        continue
      }
      await job.retry().then(() => { retried += 1 }).catch(() => null)
    }
    await writeWhatsAppQueueLog({ queueName: name, event: "admin.retry_failed_jobs", status: "completed", metadata: { retried, skipped, selected: selected.size } })
    return { name, retried, skipped }
  }))
}

export async function rebuildWhatsAppQueues() {
  const names = [WHATSAPP_SEND_QUEUE, WHATSAPP_CAMPAIGN_QUEUE, WHATSAPP_MEDIA_QUEUE, WHATSAPP_AUTH_QUEUE, WHATSAPP_OTP_QUEUE, WHATSAPP_LOGIN_ALERT_QUEUE] as const
  return Promise.all(names.map(async (name) => {
    const queue = getWhatsAppQueue(name as any)
    if (!queue) return { name, ok: false }
    await queue.resume().catch(() => null)
    await writeWhatsAppQueueLog({ queueName: name, event: "admin.rebuild_queue", status: "completed" })
    return { name, ok: true }
  }))
}
