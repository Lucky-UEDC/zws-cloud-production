import nodemailer from "nodemailer"
// nodemailer 10 removed lib/ and re-exports the mail types from the package
// root; the old deep "nodemailer/lib/mailer" path no longer resolves.
import type { Attachment } from "nodemailer"
import { createPanelLog } from "@/lib/panel-log"
import { getEmailConfig, publicToLegacySmtp, type EmailConfigResolved } from "@/lib/email/config"
import { recordEmailLog } from "@/lib/email/log"
import { alertAdminEmailDeliveryFailure } from "@/lib/admin-email-failure-alert"

export type SmtpErrorCode =
  | "SMTP_CONNECTION_TIMEOUT"
  | "SMTP_TLS_FAILED"
  | "SMTP_AUTH_FAILED"
  | "SMTP_RECIPIENT_INVALID"
  | "SMTP_FROM_REJECTED"
  | "SMTP_PROVIDER_REJECTED"
  | "MAIL_DISABLED"
  | "SMTP_NOT_CONFIGURED"
  | "UNKNOWN_SMTP_ERROR"

export class SafeSmtpError extends Error {
  code: SmtpErrorCode
  statusCode: number

  constructor(code: SmtpErrorCode, message: string, statusCode = 400) {
    super(message)
    this.name = "SafeSmtpError"
    this.code = code
    this.statusCode = statusCode
  }
}

export type SendMailInput = {
  type?: "support" | "billing" | "noreply" | "accounts" | "admin"
  to: string | string[]
  subject: string
  text: string
  html?: string
  replyTo?: string
  logMessage?: string
  templateKey?: string | null
  throwOnError?: boolean
  metadata?: Record<string, unknown>
  attachments?: Attachment[]
  customerId?: string | null
  orderId?: string | null
  invoiceId?: string | null
  vpsInstanceId?: string | null
  paymentId?: string | null
}

function normalizeEmail(value: string) {
  return String(value || "").trim().toLowerCase()
}

function isValidEmail(value: string) {
  return /^\S+@\S+\.\S+$/.test(value)
}

function safeMailLogSettings(config: EmailConfigResolved | null) {
  return {
    provider: "smtp",
    host: config?.smtpHost || null,
    port: config?.smtpPort || null,
    secure: config?.smtpSecure || false,
    fromAddress: config?.fromEmail || null,
  }
}

export async function getSmtpConfig() {
  return publicToLegacySmtp(await getEmailConfig())
}

export function buildSmtpTransport(config: EmailConfigResolved | Awaited<ReturnType<typeof getSmtpConfig>>) {
  const legacy = "smtpHost" in config ? config : null
  const host = String(legacy?.smtpHost || (config as any).host || "").trim()
  const port = Number(legacy?.smtpPort || (config as any).port || 0)
  const secure = Boolean(legacy?.smtpSecure ?? ((config as any).encryption === "ssl_tls" || port === 465))
  const requireTLS = !secure && port === 587
  const user = String(legacy?.smtpUser || (config as any).username || "").trim()
  const pass = String(legacy?.smtpPass || (config as any).password || "")

  return nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS,
    auth: { user, pass },
    tls: {
      servername: host,
      rejectUnauthorized: true,
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  })
}

export function validateSmtpConfig(config: EmailConfigResolved | null) {
  if (!config?.enabled) {
    throw new SafeSmtpError("MAIL_DISABLED", "Mail sending is disabled in Email settings.", 400)
  }
  if (!config.smtpHost || !config.smtpUser || !config.smtpPass) {
    throw new SafeSmtpError("SMTP_NOT_CONFIGURED", "SMTP is not configured. Go to Admin Panel -> Email -> SMTP Settings.", 400)
  }
  if (!isValidEmail(normalizeEmail(config.smtpUser))) {
    throw new SafeSmtpError("SMTP_AUTH_FAILED", "SMTP username must be the full mailbox email address.", 400)
  }
  if (!isValidEmail(normalizeEmail(config.fromEmail))) {
    throw new SafeSmtpError("SMTP_FROM_REJECTED", "From Email must be a valid email address.", 400)
  }
  if (config.replyTo && !isValidEmail(normalizeEmail(config.replyTo))) {
    throw new SafeSmtpError("SMTP_RECIPIENT_INVALID", "Reply-To Email must be a valid email address.", 400)
  }
}

export function validateSmtpSettings(settings: Awaited<ReturnType<typeof getSmtpConfig>>) {
  const config: EmailConfigResolved = {
    id: "settings",
    smtpHost: settings.host,
    smtpPort: settings.port,
    smtpSecure: settings.encryption === "ssl_tls" || settings.port === 465,
    smtpUser: settings.username,
    smtpPass: settings.password,
    fromName: settings.mailFromName,
    fromEmail: settings.mailFromAddress,
    replyTo: settings.replyTo,
    enabled: settings.enabled,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  return validateSmtpConfig(config)
}

export function classifySmtpError(error: any): SafeSmtpError {
  if (error instanceof SafeSmtpError) return error
  const command = String(error?.command || "").toUpperCase()
  const code = String(error?.code || "").toUpperCase()
  const response = String(error?.response || error?.message || "")
  const lowered = response.toLowerCase()

  if (code.includes("ETIMEDOUT") || code.includes("ESOCKET") && lowered.includes("timeout")) {
    return new SafeSmtpError("SMTP_CONNECTION_TIMEOUT", "Could not connect to SMTP server. Check host, port, firewall, and provider settings.", 400)
  }
  if (code.includes("EAUTH") || command === "AUTH" || lowered.includes("authentication") || lowered.includes("unauthorized") || /\b535\b/.test(response)) {
    return new SafeSmtpError("SMTP_AUTH_FAILED", "SMTP authentication failed. Check the mailbox address and mailbox password.", 400)
  }
  if (code.includes("ETLS") || code.includes("ESOCKET") || lowered.includes("tls") || lowered.includes("ssl") || lowered.includes("certificate")) {
    return new SafeSmtpError("SMTP_TLS_FAILED", "SMTP TLS failed. Try SSL/TLS 465 or STARTTLS 587.", 400)
  }
  if (command === "RCPT" || lowered.includes("recipient")) {
    return new SafeSmtpError("SMTP_RECIPIENT_INVALID", "The SMTP provider rejected the recipient address.", 400)
  }
  if (command === "MAIL" || lowered.includes("sender") || lowered.includes("from address")) {
    return new SafeSmtpError("SMTP_FROM_REJECTED", "The SMTP provider rejected the From address.", 400)
  }
  if (code.startsWith("E")) {
    return new SafeSmtpError("SMTP_PROVIDER_REJECTED", "The SMTP provider rejected the email request.", 400)
  }
  return new SafeSmtpError("UNKNOWN_SMTP_ERROR", "SMTP failed. Check the server logs for safe diagnostic details.", 400)
}

export async function sendEmail(input: SendMailInput) {
  const config = await getEmailConfig()
  const recipients = Array.isArray(input.to) ? input.to : [input.to]
  const attachmentCount = input.attachments?.length || 0
  const baseLog = {
    category: "Email" as const,
    actorType: "system",
    customerId: input.customerId || null,
    orderId: input.orderId || null,
    invoiceId: input.invoiceId || null,
    vpsInstanceId: input.vpsInstanceId || null,
    paymentId: input.paymentId || null,
    metadata: {
      to: recipients,
      subject: input.subject,
      type: input.type || "noreply",
      templateKey: input.templateKey || null,
      attachmentCount,
      invoiceId: input.invoiceId || null,
      ...(input.metadata || {}),
    },
  }

  if (!config?.enabled) {
    await createPanelLog({ ...baseLog, level: "warn", message: input.logMessage ? `${input.logMessage} skipped` : "Email skipped", metadata: { ...baseLog.metadata, reason: "mail_disabled" } })
    await recordEmailLog({ templateKey: input.templateKey, recipient: recipients, subject: input.subject, status: "skipped", error: "mail_disabled", customerId: input.customerId, orderId: input.orderId, invoiceId: input.invoiceId, attachmentCount, metadata: baseLog.metadata })
    return { success: false as const, status: "skipped" as const, message: "Mail sending is disabled in Email settings" }
  }

  try {
    validateSmtpConfig(config)
  } catch (error) {
    const safeError = classifySmtpError(error)
    await createPanelLog({ ...baseLog, level: "warn", message: input.logMessage ? `${input.logMessage} skipped` : "Email skipped", metadata: { ...baseLog.metadata, reason: safeError.code } })
    await recordEmailLog({ templateKey: input.templateKey, recipient: recipients, subject: input.subject, status: "skipped", error: safeError.code, customerId: input.customerId, orderId: input.orderId, invoiceId: input.invoiceId, attachmentCount, metadata: baseLog.metadata })
    if (input.metadata?.suppressEmailFailureAlert !== true) {
      await alertAdminEmailDeliveryFailure({ notificationType: input.type, templateKey: input.templateKey, logMessage: input.logMessage, errorCode: safeError.code }).catch(() => null)
    }
    if (input.throwOnError) throw safeError
    return { success: false as const, status: "skipped" as const, message: safeError.message, code: safeError.code }
  }

  const transport = buildSmtpTransport(config)

  try {
    const info = await transport.sendMail({
      from: `${config.fromName} <${config.fromEmail}>`,
      to: recipients.join(","),
      subject: input.subject,
      text: input.text,
      html: input.html,
      replyTo: input.replyTo || config.replyTo || undefined,
      attachments: input.attachments,
    })
    const status = info.rejected?.length ? "failed" : "sent"
    await recordEmailLog({ templateKey: input.templateKey, recipient: recipients, subject: input.subject, status, error: info.rejected?.length ? "recipient_rejected" : null, customerId: input.customerId, orderId: input.orderId, invoiceId: input.invoiceId, attachmentCount, metadata: { ...baseLog.metadata, messageId: info.messageId } })
    await createPanelLog({
      ...baseLog,
      level: info.rejected?.length ? "warn" : "info",
      message: info.rejected?.length ? "mail_recipient_rejected" : input.logMessage || "mail_sent",
      metadata: { ...baseLog.metadata, ...safeMailLogSettings(config), messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, response: info.response },
    })
    if (info.rejected?.length && input.metadata?.suppressEmailFailureAlert !== true) {
      await alertAdminEmailDeliveryFailure({ notificationType: input.type, templateKey: input.templateKey, logMessage: input.logMessage, errorCode: "SMTP_RECIPIENT_REJECTED" }).catch(() => null)
    }
    return {
      success: !info.rejected?.length,
      status,
      message: info.rejected?.length ? "SMTP rejected one or more recipients." : undefined,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
    }
  } catch (error) {
    const safeError = classifySmtpError(error)
    await createPanelLog({
      ...baseLog,
      level: "error",
      message: "mail_failed",
      metadata: { ...baseLog.metadata, ...safeMailLogSettings(config), errorCode: safeError.code, error: safeError.message },
    })
    await recordEmailLog({ templateKey: input.templateKey, recipient: recipients, subject: input.subject, status: "failed", error: safeError.message, customerId: input.customerId, orderId: input.orderId, invoiceId: input.invoiceId, attachmentCount, metadata: { ...baseLog.metadata, code: safeError.code } })
    if (input.metadata?.suppressEmailFailureAlert !== true) {
      await alertAdminEmailDeliveryFailure({ notificationType: input.type, templateKey: input.templateKey, logMessage: input.logMessage, errorCode: safeError.code }).catch(() => null)
    }
    if (input.throwOnError) throw safeError
    return { success: false as const, status: "failed" as const, message: safeError.message, code: safeError.code }
  }
}

export async function verifySmtpConnection() {
  const config = await getEmailConfig()
  validateSmtpConfig(config)
  const transport = buildSmtpTransport(config!)
  try {
    await transport.verify()
  } catch (error) {
    throw classifySmtpError(error)
  }
  return { success: true as const }
}
