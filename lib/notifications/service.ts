import { sendOrderInvoiceEmail } from "@/lib/email/notifications"
import { sendEmail } from "@/lib/mailer"
import { sendTemplateEmail } from "@/lib/email/send-mail"
import { defaultTemplateVariables } from "@/lib/email/templates"
import { prisma } from "@/lib/db"
import { getSiteUrl } from "@/lib/settings/site-settings"
import { resolveBrandIdentity } from "@/lib/brand-identity"
import { createPanelLog } from "@/lib/panel-log"
import type { ChannelResult, NotificationData, NotificationResult, SendNotificationInput } from "@/lib/notifications/types"
import { maskWhatsAppPhone } from "@/lib/whatsapp/format"
import { sendWhatsAppMessage } from "@/lib/whatsapp/queue"
import { canSendWhatsAppToCustomer, isMarketingCategory, normalizeNotificationCategory } from "@/lib/whatsapp/preferences"
import { canonicalWhatsAppTemplateKey, WHATSAPP_TEMPLATE_KEYS } from "@/lib/whatsapp/template-registry"
import { markOutboundEventDelivery, reserveOutboundEventDelivery } from "@/lib/outbound-event-delivery"
import { markNotificationDelivery, reserveNotificationDelivery } from "@/lib/notifications/ledger"
import { paymentFlowLog } from "@/lib/payment-flow-log"

const ORDER_EMAIL_TEMPLATES = new Set([
  "order_created",
  "order_pending_payment",
  "order_paid",
  "payment_success",
  "invoice_created",
  "invoice_paid",
  "renewal_invoice",
  "payment_failed",
])

const ORDER_WHATSAPP_TEMPLATES = new Set([
  WHATSAPP_TEMPLATE_KEYS.PAYMENT_SUCCESS,
  WHATSAPP_TEMPLATE_KEYS.PROVISIONING_UPDATE,
  WHATSAPP_TEMPLATE_KEYS.VPS_DEPLOYED,
  WHATSAPP_TEMPLATE_KEYS.VPS_REINSTALL_STARTED,
  WHATSAPP_TEMPLATE_KEYS.VPS_REINSTALL_COMPLETED,
  WHATSAPP_TEMPLATE_KEYS.SERVICE_SUSPENDED,
  WHATSAPP_TEMPLATE_KEYS.SERVICE_OPERATION_FAILED,
  WHATSAPP_TEMPLATE_KEYS.RENEWAL_REMINDER,
  WHATSAPP_TEMPLATE_KEYS.ADDITIONAL_IP_ACTIVATED,
  WHATSAPP_TEMPLATE_KEYS.BANDWIDTH_ADDON_ACTIVATED,
  WHATSAPP_TEMPLATE_KEYS.SNAPSHOT_ADDON_ACTIVATED,
  WHATSAPP_TEMPLATE_KEYS.BACKUP_ADDON_ACTIVATED,
])

function safeError(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error || "Unexpected error")
}

function dataText(data: NotificationData | undefined, key: string, fallback = "") {
  const raw = data?.[key as keyof NotificationData]
  if (raw === null || raw === undefined) return fallback
  return String(raw)
}

function firstText(...items: Array<string | null | undefined>) {
  return items.map((item) => String(item || "").trim()).find(Boolean) || ""
}

function channelStatus(results: ChannelResult[]) {
  const sent = results.filter((result) => result.ok).length
  if (sent === results.length && results.length > 0) return "success" as const
  if (sent > 0) return "partial_success" as const
  return "failed" as const
}

function normalizeEmailResult(result: any): ChannelResult {
  if (result?.success) {
    return { ok: true, status: "sent", messageId: result.messageId || null }
  }
  return {
    ok: false,
    status: result?.status === "skipped" ? "skipped" : "failed",
    error: result?.message || result?.error || "Email send failed",
    code: result?.code,
  }
}

async function sendEmailChannel(input: SendNotificationInput): Promise<ChannelResult> {
  const email = String(input.user.email || "").trim()
  if (!email) return { ok: false, status: "skipped", error: "User email is missing" }

  const data = input.data || {}
  const metadata = { channel: "email", notificationType: input.type, ...(data.metadata || {}) }

  if (input.type === "order") {
    const templateKey = String(data.templateKey || "order_created")
    if (ORDER_EMAIL_TEMPLATES.has(templateKey) && data.orderId) {
      const result = await sendOrderInvoiceEmail({
        templateKey,
        orderId: data.orderId,
        invoiceId: data.invoiceId,
        paymentUrl: data.paymentUrl,
        metadata,
      })
      return normalizeEmailResult(result)
    }
  }

  const templateKey = String(
    data.templateKey ||
      (input.type === "otp" ? "email_verification" : input.type === "login" ? "login_alert" : "")
  )

  if (templateKey) {
    const variables = await defaultTemplateVariables({
      userName: input.user.name || "there",
      email,
      ...data,
    })
    const result = await sendTemplateEmail({
      templateKey,
      to: email,
      variables,
      customerId: input.user.id || null,
      orderId: data.orderId || null,
      invoiceId: data.invoiceId || null,
      metadata,
    })
    return normalizeEmailResult(result)
  }

  if (!data.subject || !data.text) {
    return { ok: false, status: "skipped", error: "General email requires subject and text" }
  }

  const result = await sendEmail({
    to: email,
    subject: String(data.subject),
    text: String(data.text),
    html: typeof data.html === "string" ? data.html : undefined,
    customerId: input.user.id || null,
    orderId: data.orderId || null,
    invoiceId: data.invoiceId || null,
    metadata,
  })
  return normalizeEmailResult(result)
}

async function sendWhatsAppChannel(input: SendNotificationInput): Promise<ChannelResult> {
  const phone = String(input.user.phone || "").trim()
  if (!phone) return { ok: false, status: "skipped", error: "User phone is missing" }

  const category = normalizeNotificationCategory(input.data?.metadata?.category || input.type)
  const marketing = isMarketingCategory(category) || input.type === "marketing"
  const allowed = await canSendWhatsAppToCustomer({
    customerId: input.user.id || null,
    category,
    marketing,
  })
  if (!allowed) return { ok: false, status: "skipped", error: "WhatsApp preference or verification does not allow this message" }

  const templateKey = canonicalWhatsAppTemplateKey(String(input.data?.templateKey || (input.type === "login" ? WHATSAPP_TEMPLATE_KEYS.LOGIN_ALERT : WHATSAPP_TEMPLATE_KEYS.SYSTEM_FALLBACK)))
  if (input.type === "order" && !ORDER_WHATSAPP_TEMPLATES.has(templateKey as any)) {
    return { ok: false, status: "skipped", error: "WhatsApp service update is not an allowed customer event" }
  }

  const brandName = await resolveBrandIdentity(
    input.data?.brandName == null ? null : String(input.data.brandName),
  )
  const vpsInstanceId = String(input.data?.metadata?.vpsInstanceId || input.data?.vpsInstanceId || "")
  const logicalStatus = String(
    input.data?.metadata?.eventStatus ||
      input.data?.metadata?.source ||
      input.data?.deployment_stage ||
      input.data?.payment_status ||
      input.data?.status ||
      templateKey
  )
  const reserved = input.type === "order" && ORDER_WHATSAPP_TEMPLATES.has(templateKey as any)
    ? await reserveOutboundEventDelivery({
        channel: "whatsapp",
        eventType: logicalStatus,
        templateKey,
        customerId: input.user.id || null,
        orderId: input.data?.orderId || null,
        vpsInstanceId: vpsInstanceId || null,
        invoiceId: input.data?.invoiceId || null,
        cycleKey: String(input.data?.metadata?.cycleKey || input.data?.metadata?.reminderType || ""),
        metadata: { notificationType: input.type, templateKey, ...(input.data?.metadata || {}) },
      })
    : null
  if (reserved && !reserved.reserved) {
    return { ok: false, status: "skipped", error: "Duplicate WhatsApp status already sent" }
  }

  const sent = await sendWhatsAppMessage({
    to: phone,
    customerId: input.user.id || null,
    orderId: input.data?.orderId || null,
    invoiceId: input.data?.invoiceId || null,
    skipRegistrationCheck: Boolean(input.data?.skipRegistrationCheck),
    templateKey,
    variables: {
      name: input.user.name || "there",
      userName: input.user.name || "there",
      first_name: input.user.name || "there",
      company_name: brandName,
      brandName,
      message_text: String(input.data?.message || input.data?.text || `Your ${brandName} update is ready.`),
      customer_name: input.user.name || "there",
      order_id: firstText(dataText(input.data, "orderNumber"), dataText(input.data, "orderId"), dataText(input.data, "invoiceNumber")),
      server_name: firstText(dataText(input.data, "serviceName"), dataText(input.data, "service_name"), dataText(input.data, "hostname"), "your server"),
      deployment_stage: firstText(dataText(input.data, "deployment_stage"), dataText(input.data, "payment_status"), dataText(input.data, "status"), "Deployment started"),
      ip_address: firstText(dataText(input.data, "ip_address"), dataText(input.data, "server_ip"), dataText(input.data, "primaryIp")),
      dashboard_url: firstText(dataText(input.data, "dashboard_url"), dataText(input.data, "dashboardUrl"), await getSiteUrl().then((url) => `${url.replace(/\/$/, "")}/client-area`).catch(() => "")),
      ...(input.data || {}),
    },
    category,
    metadata: {
      notificationType: input.type,
      templateKey,
      channel: "whatsapp",
      ...(input.data?.metadata || {}),
    },
  })
  if (reserved?.dedupeKey) {
    await markOutboundEventDelivery({
      dedupeKey: reserved.dedupeKey,
      status: sent.status || "queued",
      providerMessageId: sent.messageId || null,
      metadata: { templateKey, sentAt: new Date().toISOString(), ...(input.data?.metadata || {}) },
    })
  }

  return { ok: true, status: sent.status, messageId: sent.messageId, toMasked: sent.toMasked }
}

export async function sendNotification(input: SendNotificationInput): Promise<NotificationResult> {
  const channels = input.channels?.length ? input.channels : (["email", "whatsapp"] as const)
  const uniqueChannels: Array<"email" | "whatsapp"> = Array.from(new Set(channels))
  const channelResults: NotificationResult["channels"] = {}

  const settled = await Promise.allSettled(uniqueChannels.map(async (channel) => ({
    channel,
    result: channel === "email" ? await sendEmailChannel(input) : await sendWhatsAppChannel(input),
  })))

  await Promise.all(settled.map(async (entry, index) => {
    const channel = uniqueChannels[index]
    if (entry.status === "fulfilled") {
      channelResults[entry.value.channel] = entry.value.result
      return
    }
    const error = entry.reason
      channelResults[channel] = {
        ok: false,
        status: "failed",
        error: safeError(error),
        ...(channel === "whatsapp" && input.user.phone ? { toMasked: maskWhatsAppPhone(input.user.phone) } : {}),
      }
      await createPanelLog({
        category: "Email",
        level: "warn",
        message: `${channel}_notification_failed`,
        customerId: input.user.id || null,
        orderId: input.data?.orderId || null,
        metadata: {
          channel,
          notificationType: input.type,
          error: safeError(error),
          ...(input.data?.metadata || {}),
        },
      }).catch(() => null)
  }))

  const status = channelStatus(Object.values(channelResults))
  if (channelResults.email) {
    paymentFlowLog("Email sent", {
      orderId: input.data?.orderId || null,
      invoiceId: input.data?.invoiceId || null,
      templateKey: input.data?.templateKey || null,
      status: channelResults.email.status,
      ok: channelResults.email.ok,
      messageId: channelResults.email.messageId || null,
      error: channelResults.email.error || null,
    })
  }
  if (channelResults.whatsapp) {
    paymentFlowLog("WhatsApp sent", {
      orderId: input.data?.orderId || null,
      invoiceId: input.data?.invoiceId || null,
      templateKey: input.data?.templateKey || null,
      status: channelResults.whatsapp.status,
      ok: channelResults.whatsapp.ok,
      messageId: channelResults.whatsapp.messageId || null,
      error: channelResults.whatsapp.error || null,
    })
  }
  return {
    ok: status !== "failed",
    status,
    type: input.type,
    channels: channelResults,
  }
}

function money(value: unknown) {
  const n = Number(value || 0)
  return Number.isFinite(n) ? n.toFixed(2) : "0.00"
}

export async function sendOrderInvoiceNotification(input: {
  templateKey: string
  orderId?: string | null
  invoiceId?: string | null
  paymentUrl?: string | null
  resend?: boolean
  metadata?: Record<string, unknown>
}) {
  const invoice = input.invoiceId
    ? await prisma.invoice.findUnique({ where: { id: input.invoiceId }, include: { customer: true, order: { include: { customer: true, product: true, offer: true } } } }).catch(() => null)
    : null
  const order = input.orderId
    ? await prisma.order.findUnique({
        where: { id: input.orderId },
        include: { customer: true, product: true, offer: true, invoices: true },
      }).catch(() => null)
    : invoice?.order || null

  const customer = order?.customer || invoice?.customer
  if (!customer?.email && !customer?.phone) return null

  const resolvedInvoice = invoice || (order as any)?.invoices || null
  const event = String(input.metadata?.event || input.metadata?.eventType || input.templateKey || "order_invoice_notification")
  const allowResend = input.resend === true || input.metadata?.resend === true || input.metadata?.explicitResend === true
  const reservation = !allowResend && customer?.id && resolvedInvoice?.id
    ? await reserveNotificationDelivery({
      customerId: customer.id,
      orderId: order?.id || input.orderId || null,
      invoiceId: resolvedInvoice.id,
      templateId: input.templateKey,
      notificationType: event,
        channel: "multi",
        event,
        metadata: { source: input.metadata?.source || "send_order_invoice_notification", orderId: order?.id || input.orderId || null },
      })
    : null
  if (reservation && !reservation.reserved) {
    return {
      ok: true,
      status: "success" as const,
      type: "order",
      channels: {
        email: { ok: false, status: "skipped" as const, error: reservation.reason || "duplicate_notification" },
        whatsapp: { ok: false, status: "skipped" as const, error: reservation.reason || "duplicate_notification" },
      },
    }
  }
  const siteUrl = await getSiteUrl()
  const paymentUrl = input.paymentUrl || (resolvedInvoice?.id ? `/client-area/billing/invoices/${resolvedInvoice.id}` : "/client-area/billing")
  const absolutePaymentUrl = paymentUrl.startsWith("http") ? paymentUrl : `${siteUrl}${paymentUrl}`

  const result = await sendNotification({
    type: "order",
    channels: ["email", "whatsapp"],
    user: {
      id: customer?.id || null,
      email: customer?.email || null,
      phone: customer?.phone || null,
      name: customer?.name || null,
    },
    data: {
      templateKey: input.templateKey,
      orderId: order?.id || input.orderId || null,
      orderNumber: order?.orderNumber || resolvedInvoice?.invoiceNumber || input.orderId || null,
      order_id: order?.orderNumber || resolvedInvoice?.invoiceNumber || input.orderId || null,
      invoiceId: resolvedInvoice?.id || input.invoiceId || null,
      invoiceNumber: resolvedInvoice?.invoiceNumber || "",
      invoice_id: resolvedInvoice?.invoiceNumber || "",
      invoice_due: resolvedInvoice?.dueDate ? new Date(resolvedInvoice.dueDate).toLocaleDateString("en-IN") : "",
      invoice_total: money(resolvedInvoice?.totalAmount ?? order?.payableAmount ?? order?.finalAmount ?? order?.totalAmount),
      payment_link: absolutePaymentUrl,
      paymentUrl: absolutePaymentUrl,
      dashboard_url: `${siteUrl.replace(/\/$/, "")}/client-area`,
      userName: customer?.name || "there",
      customer_name: customer?.name || "there",
      email: customer?.email || "",
      amount: money(resolvedInvoice?.totalAmount ?? order?.payableAmount ?? order?.finalAmount ?? order?.totalAmount),
      currency: order?.currency || resolvedInvoice?.currency || "INR",
      productName: order?.offer?.name || order?.product?.name || "Cloud Compute Instance",
      serviceName: order?.hostname || order?.serviceId || order?.orderNumber || resolvedInvoice?.invoiceNumber || "Cloud service",
      status: input.templateKey.replace(/_/g, " "),
      metadata: input.metadata,
    } satisfies NotificationData,
  })
  if (reservation?.row?.notificationId) {
    await markNotificationDelivery({
      notificationId: reservation.row.notificationId,
      status: result.status,
      metadata: {
        ...(reservation.row.metadata || {}),
        resultStatus: result.status,
        channelStatuses: Object.fromEntries(Object.entries(result.channels || {}).map(([channel, value]) => [channel, value?.status || null])),
      },
    })
  }
  return result
}
