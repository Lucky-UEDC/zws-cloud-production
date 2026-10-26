import crypto from "node:crypto"
import { getAdminNotificationSettings } from "@/lib/admin-notifications"
import { createPanelLog } from "@/lib/panel-log"
import { getRedisClient } from "@/lib/redis"

const ALERT_DEDUPE_SECONDS = 6 * 60 * 60
const localClaims = new Map<string, number>()

async function claimAlert(key: string) {
  const now = Date.now()
  for (const [knownKey, expiresAt] of localClaims) {
    if (expiresAt <= now) localClaims.delete(knownKey)
  }

  const redis = getRedisClient()
  if (redis) {
    try {
      await redis.connect().catch(() => undefined)
      const result = await redis.set(`admin-email-failure-alert:${key}`, "1", "EX", ALERT_DEDUPE_SECONDS, "NX")
      if (result === null) return false
      if (result === "OK") return true
    } catch {
      // Do not drop the alert if Redis is the failing dependency.
    }
  }

  const expiry = localClaims.get(key)
  if (expiry && expiry > now) return false
  localClaims.set(key, now + ALERT_DEDUPE_SECONDS * 1000)
  return true
}

/**
 * SMTP failures cannot be reported through the same SMTP channel. Notify the
 * configured admin WhatsApp/operations contacts instead. Never include the
 * recipient address or email body, which can contain customer or billing data.
 */
export async function alertAdminEmailDeliveryFailure(input: {
  notificationType?: string | null
  templateKey?: string | null
  logMessage?: string | null
  errorCode: string
}) {
  const type = String(input.notificationType || "unknown").slice(0, 60)
  const template = String(input.templateKey || input.logMessage || "untemplated").slice(0, 100)
  const errorCode = String(input.errorCode || "SMTP_UNKNOWN").slice(0, 80)
  const key = crypto.createHash("sha256").update(`${type}:${template}:${errorCode}`).digest("hex").slice(0, 40)
  if (!(await claimAlert(key))) return { sent: false, deduplicated: true }

  const settings = await getAdminNotificationSettings().catch(() => null)
  await createPanelLog({
    category: "Notification",
    level: "error",
    message: "outbound_email_delivery_failed",
    metadata: { notificationType: type, templateKey: template, errorCode, dedupeKey: key },
  }).catch(() => null)

  if (!settings || settings.enabled === false) {
    await createPanelLog({
      category: "Notification",
      level: "error",
      message: "email_failure_alert_not_sent",
      metadata: { notificationType: type, templateKey: template, errorCode, reason: settings ? "admin_notifications_disabled" : "settings_unavailable" },
    }).catch(() => null)
    return { sent: false, reason: "notifications_disabled_or_unavailable" }
  }

  const destinations = Array.from(new Set([
    settings.notificationNumber,
    ...settings.operationsNumbers,
  ].map((value) => String(value || "").trim()).filter(Boolean)))
  if (!destinations.length) {
    await createPanelLog({
      category: "Notification",
      level: "error",
      message: "email_failure_alert_not_sent",
      metadata: { notificationType: type, templateKey: template, errorCode, reason: "no_whatsapp_destination" },
    }).catch(() => null)
    return { sent: false, reason: "no_whatsapp_destination" }
  }

  const queueModule = await import("@/lib/whatsapp/queue")
  const message = [
    "ZWS CLOUD — EMAIL DELIVERY ALERT",
    "An outbound email could not be delivered.",
    `Notification type: ${type}`,
    `Template/event: ${template}`,
    `Error code: ${errorCode}`,
    "The recipient address and email content are intentionally omitted.",
    "Action: check SMTP credentials, provider status and email delivery logs.",
  ].join("\n")

  const results = await Promise.allSettled(destinations.map((to) => queueModule.sendWhatsAppMessage({
    to,
    provider: settings.provider,
    skipRegistrationCheck: true,
    templateKey: "system_fallback",
    variables: { message_text: message },
    category: "transactional",
    metadata: {
      source: "admin_email_failure_alert",
      notificationType: type,
      templateKey: template,
      errorCode,
      dedupeKey: key,
      suppressEmergencyAlert: true,
      suppressEmailFailureAlert: true,
    },
  }, {
    attempts: 4,
    backoff: { type: "fixed", delay: Number(process.env.WHATSAPP_MESSAGE_RETRY_DELAY_MS || 5 * 60_000) },
    jobId: `admin_email_failure_${key}_${crypto.createHash("sha256").update(to).digest("hex").slice(0, 8)}`,
  })))

  const accepted = results.filter((result) => result.status === "fulfilled" && result.value.ok).length
  await createPanelLog({
    category: "Notification",
    level: accepted === destinations.length ? "info" : accepted > 0 ? "warn" : "error",
    message: accepted > 0 ? "email_failure_alert_dispatched" : "email_failure_alert_dispatch_failed",
    metadata: { notificationType: type, templateKey: template, errorCode, channelsAttempted: destinations.length, channelsAccepted: accepted },
  }).catch(() => null)
  return { sent: accepted > 0, accepted, attempted: destinations.length }
}
