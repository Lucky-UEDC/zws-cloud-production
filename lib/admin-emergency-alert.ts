import crypto from "node:crypto"
import { getAdminNotificationSettings } from "@/lib/admin-notifications"
import { createPanelLog } from "@/lib/panel-log"
import { getRedisClient } from "@/lib/redis"
import { sendEmail } from "@/lib/mailer"

const ALERT_DEDUPE_SECONDS = 6 * 60 * 60
const localClaims = new Map<string, number>()

function clean(value: unknown, maxLength = 300) {
  return String(value ?? "unknown")
    .replace(/(?:bearer\s+)[a-z0-9._\-+/=]+/gi, "$1[redacted]")
    .replace(/(password|token|secret|api[_-]?key)[\"':=\s]+[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b\d{6}\b/g, "[redacted]")
    .replace(/\b\d{8,15}\b/g, "[number-redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, maxLength)
}

async function claimAlert(key: string) {
  const now = Date.now()
  for (const [knownKey, expiresAt] of localClaims) {
    if (expiresAt <= now) localClaims.delete(knownKey)
  }

  const redis = getRedisClient()
  if (redis) {
    try {
      await redis.connect().catch(() => undefined)
      const result = await redis.set(
        `admin-emergency-alert:${key}`,
        "1",
        "EX",
        ALERT_DEDUPE_SECONDS,
        "NX",
      )
      if (result === null) return false
      if (result === "OK") return true
    } catch {
      // Fall through to the bounded in-process guard. Alerting must not be
      // dropped just because Redis is the service that is currently unhealthy.
    }
  }

  const expiry = localClaims.get(key)
  if (expiry && expiry > now) return false
  localClaims.set(key, now + ALERT_DEDUPE_SECONDS * 1000)
  return true
}

/**
 * Sends one terminal delivery-failure alert through configured admin channels.
 * The original message body, OTP, customer destination and credentials are never
 * included. WhatsApp alert jobs carry a suppression marker to prevent alert loops.
 */
export async function sendEmergencyDeliveryFailureAlert(input: {
  queueName: string
  jobId?: string | null
  attemptCount: number
  errorCode: string
  failureReason?: string | null
  errorMessage?: string | null
}) {
  const identity = `${input.queueName}:${input.jobId || input.errorCode}`
  const key = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 40)
  if (!(await claimAlert(key))) return { sent: false, deduplicated: true }

  const settings = await getAdminNotificationSettings().catch(() => null)
  const metadata = {
    source: "terminal_whatsapp_delivery_failure",
    queueName: clean(input.queueName, 80),
    jobId: clean(input.jobId || "unknown", 100),
    attemptCount: Math.max(1, Math.floor(Number(input.attemptCount) || 1)),
    errorCode: clean(input.errorCode, 100),
    failureReason: clean(input.failureReason || "unknown", 100),
    dedupeKey: key,
  }

  const message = [
    "ZWS CLOUD — EMERGENCY MESSAGE DELIVERY ALERT",
    `Queue: ${metadata.queueName}`,
    `Job: ${metadata.jobId}`,
    `Attempts completed: ${metadata.attemptCount}`,
    `Error code: ${metadata.errorCode}`,
    `Failure: ${metadata.failureReason}`,
    `Details: ${clean(input.errorMessage || "No further provider details available", 220)}`,
    "Action: check WhatsApp/Evolution health and the delivery queue.",
  ].join("\n")

  await createPanelLog({
    category: "Notification",
    level: "error",
    message: "emergency_message_delivery_failure",
    metadata: { ...metadata, deliveryAttempt: "starting" },
  }).catch(() => null)

  if (!settings || settings.enabled === false) {
    await createPanelLog({
      category: "Notification",
      level: "error",
      message: "emergency_message_alert_not_sent",
      metadata: { ...metadata, reason: settings ? "admin_notifications_disabled" : "settings_unavailable" },
    }).catch(() => null)
    return { sent: false, reason: settings ? "admin_notifications_disabled" : "settings_unavailable" }
  }

  const destinations = Array.from(new Set([
    settings.notificationNumber,
    ...settings.operationsNumbers,
  ].map((value) => String(value || "").trim()).filter(Boolean)))
  const tasks: Array<Promise<unknown>> = []

  if (settings.notificationEmail) {
    tasks.push(sendEmail({
      type: "admin",
      to: settings.notificationEmail,
      subject: "[ZWS Cloud] Emergency: message delivery failed",
      text: message,
      logMessage: "emergency_delivery_failure_alert",
      metadata,
      throwOnError: false,
    }).then((result) => {
      if (!result.success) throw new Error(result.message || "Emergency email was not sent")
      return { channel: "email", status: "sent" }
    }))
  }

  for (const to of destinations) {
    // Dynamic import keeps the helper usable from the queue module's own
    // Redis-unavailable path without creating an eager module cycle.
    const queueModule = await import("@/lib/whatsapp/queue")
    tasks.push(queueModule.sendWhatsAppMessage({
      to,
      provider: settings.provider,
      skipRegistrationCheck: true,
      templateKey: "system_fallback",
      variables: { message_text: message },
      category: "transactional",
      metadata: {
        ...metadata,
        source: "emergency_delivery_alert",
        suppressEmergencyAlert: true,
      },
    }, {
      attempts: 4,
      backoff: { type: "fixed", delay: Number(process.env.WHATSAPP_MESSAGE_RETRY_DELAY_MS || 5 * 60_000) },
      jobId: `admin_emergency_${key}_${crypto.createHash("sha256").update(to).digest("hex").slice(0, 8)}`,
    }).then((result) => {
      if (!result.ok) throw new Error(result.error || "Emergency WhatsApp alert could not be queued")
      return { channel: "whatsapp", status: "queued" }
    }))
  }

  if (!tasks.length) {
    await createPanelLog({
      category: "Notification",
      level: "error",
      message: "emergency_message_alert_not_sent",
      metadata: { ...metadata, reason: "no_emergency_destinations_configured" },
    }).catch(() => null)
    return { sent: false, reason: "no_emergency_destinations_configured" }
  }

  const results = await Promise.allSettled(tasks)
  const succeeded = results.filter((result) => result.status === "fulfilled").length
  await createPanelLog({
    category: "Notification",
    level: succeeded === results.length ? "info" : succeeded > 0 ? "warn" : "error",
    message: succeeded > 0 ? "emergency_message_alert_dispatched" : "emergency_message_alert_dispatch_failed",
    metadata: {
      ...metadata,
      channelsAttempted: tasks.length,
      channelsAccepted: succeeded,
      outcomes: results.map((result) => result.status === "fulfilled"
        ? { status: "accepted" }
        : { status: "failed", error: clean(result.reason instanceof Error ? result.reason.message : result.reason, 180) }),
    },
  }).catch(() => null)

  return { sent: succeeded > 0, accepted: succeeded, attempted: results.length }
}
