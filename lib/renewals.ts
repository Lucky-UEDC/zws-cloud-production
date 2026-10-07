import { prisma } from "@/lib/db"
import { sendEmail } from "@/lib/mailer"
import { sendNotification } from "@/lib/notifications/service"
import { invoicePdfAttachment } from "@/lib/email/invoice-attachments"
import { WHATSAPP_TEMPLATE_KEYS } from "@/lib/whatsapp/template-registry"
import { sendWhatsAppMessage } from "@/lib/whatsapp/queue"
import { createProxmoxClient, PROXMOX_LONG_TIMEOUT_MS } from "@/lib/proxmox"
import { markNotificationDelivery, reserveNotificationDelivery } from "@/lib/notifications/ledger"
import { renewalEmail } from "@/lib/email-templates"
import { freeVpsIp } from "@/lib/ip-pool"
import { createAuditLog } from "@/lib/audit-log"
import { createPanelLog } from "@/lib/panel-log"
import { getSiteUrl } from "@/lib/settings/site-settings"
import { resolveBrandIdentity } from "@/lib/brand-identity"
import { renderInvoicePdf } from "@/lib/invoices"
import { calculateInvoiceTotals, invoiceTaxWriteFields } from "@/lib/invoices/tax"
import { restoreBandwidthThrottle } from "@/lib/bandwidth-enforcement"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

export const VPS_LIFECYCLE_STATES = [
  "ACTIVE",
  "RENEWAL_DUE",
  "OVERDUE",
  "SUSPENDED",
  "PENALTY",
  "PENDING_TERMINATION",
  "TERMINATED",
  "DELETED",
] as const

export type VpsLifecycleState = (typeof VPS_LIFECYCLE_STATES)[number]
export type ReminderLevel = "3d" | "2d" | "1d" | "due_day"
export type WarningSeverity = "INFO" | "WARNING" | "URGENT" | "CRITICAL" | "TERMINATION"

export const REMINDER_THRESHOLDS: Array<{ level: ReminderLevel; msBeforeDue: number; severity: WarningSeverity }> = [
  { level: "3d", msBeforeDue: 3 * 24 * 60 * 60 * 1000, severity: "WARNING" },
  { level: "2d", msBeforeDue: 2 * 24 * 60 * 60 * 1000, severity: "WARNING" },
  { level: "1d", msBeforeDue: 24 * 60 * 60 * 1000, severity: "URGENT" },
  { level: "due_day", msBeforeDue: 0, severity: "CRITICAL" },
]

function notificationEventForReminder(reminderType: string) {
  if (reminderType === "due_day") return "renewal_due_day"
  return `renewal_${reminderType}`
}

function scheduledReminderOccurrence(dueAt: Date, reminderType: string) {
  const daysBefore = reminderType === "3d" ? 3 : reminderType === "2d" ? 2 : reminderType === "1d" ? 1 : 0
  return addDays(dueAt, -daysBefore)
}

function money(value: unknown) {
  const n = Number(value || 0)
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0
}

export function addMonths(date: Date, months: number) {
  const next = new Date(date)
  const originalDay = next.getDate()
  next.setDate(1)
  next.setMonth(next.getMonth() + months)
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
  next.setDate(Math.min(originalDay, lastDay))
  return next
}

export function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function addMs(date: Date, ms: number) {
  return new Date(date.getTime() + ms)
}

function validDate(value: unknown): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

function asObj(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {}
}

function lifecycleMeta(vps: any) {
  return asObj(vps.lifecycleMetadata)
}

export function lifecycleDates(input: {
  createdAt?: Date | string | null
  orderCreatedAt?: Date | string | null
  termMonths?: number | null
  renewalDueAt?: Date | string | null
  graceDays?: number | null
  penaltyWindowDays?: number | null
  terminationWindowDays?: number | null
  retentionDays?: number | null
  suspendedAt?: Date | string | null
}) {
  const orderCreatedAt = validDate(input.createdAt) || validDate(input.orderCreatedAt)
  const termMonths = Math.max(1, Number(input.termMonths ?? 1) || 1)
  const due = validDate(input.renewalDueAt) || (orderCreatedAt ? addMonths(orderCreatedAt, termMonths) : null)
  const graceDays = Math.max(0, Number(input.graceDays ?? 2) || 0)
  const penaltyWindowDays = Math.max(0, Number(input.penaltyWindowDays ?? 1) || 0)
  const terminationWindowDays = Math.max(0, Number(input.terminationWindowDays ?? 7) || 0)
  const retentionDays = Math.max(1, Number(input.retentionDays ?? 7) || 7)
  const suspendAt = due ? addDays(due, graceDays) : null
  const penaltyAt = suspendAt ? addDays(suspendAt, penaltyWindowDays) : null
  const terminationAt = penaltyAt ? addDays(penaltyAt, terminationWindowDays) : null
  const deletionAt = terminationAt ? addDays(terminationAt, retentionDays) : null
  return {
    orderCreatedAt,
    termMonths,
    renewalDueAt: due,
    nextRenewalAt: due,
    suspendAt,
    penaltyAt,
    terminationAt,
    deletionAt,
    gracePeriodEnds: suspendAt,
    serviceSuspensionDate: suspendAt,
    penaltyActivation: penaltyAt,
    permanentDeletionDate: deletionAt,
    dataRetentionWindowDays: retentionDays,
  }
}

export function orderAnchoredLifecycleDates(input: {
  orderCreatedAt: Date | string
  termMonths?: number | null
  graceDays?: number | null
  penaltyWindowDays?: number | null
  terminationWindowDays?: number | null
  retentionDays?: number | null
}) {
  return lifecycleDates(input)
}

export function resolveImportedRenewalDueAt(input: {
  existingExpiryDate?: unknown
  customRenewalDate?: unknown
  prepaidRemainingDays?: unknown
  existingRenewalDate?: unknown
  allowDefaultMonthly?: boolean
  now?: Date
}) {
  const explicit = validDate(input.existingExpiryDate) || validDate(input.customRenewalDate)
  if (explicit) return { renewalDueAt: explicit, source: validDate(input.existingExpiryDate) ? "existingExpiryDate" : "customRenewalDate" }
  const prepaid = Number(input.prepaidRemainingDays)
  if (Number.isFinite(prepaid) && prepaid >= 0) return { renewalDueAt: addDays(input.now || new Date(), prepaid), source: "prepaidRemainingDays" }
  const existing = validDate(input.existingRenewalDate)
  if (existing) return { renewalDueAt: existing, source: "existingRenewalDate" }
  if (input.allowDefaultMonthly) return { renewalDueAt: addMonths(input.now || new Date(), 1), source: "defaultMonthly" }
  return { renewalDueAt: null, source: "unset" }
}

function renewalInvoiceNumber(vpsId: string, date = new Date()) {
  return `REN-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}-${vpsId.slice(-8).toUpperCase()}`
}

function formatInr(value: unknown) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(money(value))
}

function formatDueDate(value: Date) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  }).format(value)
}

function invoiceLinks(appUrl: string, invoiceId: string) {
  const base = appUrl.replace(/\/+$/, "")
  return {
    invoiceUrl: `${base}/client-area/invoices/${invoiceId}`,
    clientInvoiceUrl: `${base}/client-area/billing/invoices/${invoiceId}`,
    paymentUrl: `${base}/client-area/invoices/${invoiceId}`,
    pdfUrl: `${base}/api/client/invoices/${invoiceId}/pdf`,
  }
}

export type RenewalMessageData = {
  customerName: string
  hostname: string
  planName: string
  amount: number
  amountLabel: string
  invoiceNumber: string
  invoiceId: string
  dueDate: Date
  dueDateLabel: string
  paymentUrl: string
  invoiceUrl: string
  pdfUrl: string
  supportLine: string
  paid: boolean
  paidAt?: Date | null
  transactionId?: string | null
}

function missingReason(data: Partial<RenewalMessageData>) {
  if (!data.customerName) return "Renewal message skipped because customer name is missing"
  if (!data.hostname) return "Renewal message skipped because VPS hostname is missing"
  if (!data.planName) return "Renewal message skipped because plan name is missing"
  if (!data.invoiceNumber) return "Renewal message skipped because invoice number is missing"
  if (!data.invoiceId) return "Renewal message skipped because invoice id is missing"
  if (!data.amount || data.amount <= 0) return "Renewal message skipped because invoice amount is missing"
  if (!data.dueDate) return "Renewal message skipped because due date is missing"
  if (!data.paymentUrl) return "Renewal message skipped because payment URL is missing"
  if (!data.invoiceUrl) return "Renewal message skipped because invoice URL is missing"
  if (!data.pdfUrl) return "Renewal message skipped because PDF URL is missing"
  return null
}

export async function resolveRenewalMessageData(input: { vps: any; invoice: any }): Promise<{ data?: RenewalMessageData; error?: string }> {
  const appUrl = await getSiteUrl()
  const brandName = await resolveBrandIdentity()
  const invoice = input.invoice
  const vps = input.vps
  const links = invoiceLinks(appUrl, invoice?.id || "")
  const latestPayment = Array.isArray(invoice?.payments) ? invoice.payments[0] : null
  const latestAttempt = Array.isArray(invoice?.paymentAttempts) ? invoice.paymentAttempts[0] : null
  const paid = String(invoice?.status || "").toLowerCase() === "paid"
  const dueDate = validDate(invoice?.dueDate) || validDate(vps?.renewalDueAt) || validDate(vps?.nextRenewalAt) || null
  const amount = money(invoice?.totalAmount)
  const data: Partial<RenewalMessageData> = {
    customerName: String(vps?.customer?.name || invoice?.customer?.name || "there").trim(),
    hostname: String(vps?.name || asObj(invoice?.metadata).hostname || "").trim(),
    planName: String(vps?.product?.name || asObj(invoice?.metadata).plan || "VPS").trim(),
    amount,
    amountLabel: formatInr(amount),
    invoiceNumber: String(invoice?.invoiceNumber || "").trim(),
    invoiceId: String(invoice?.id || "").trim(),
    dueDate: dueDate || undefined,
    dueDateLabel: dueDate ? formatDueDate(dueDate) : "",
    paymentUrl: links.paymentUrl,
    invoiceUrl: links.invoiceUrl,
    pdfUrl: links.pdfUrl,
    supportLine: brandName,
    paid,
    paidAt: validDate(invoice?.paidAt) || validDate(latestPayment?.completedAt) || null,
    transactionId: invoice?.paymentTransactionId || latestPayment?.gatewayPaymentId || latestPayment?.gatewayOrderId || latestAttempt?.gatewayPaymentId || latestAttempt?.gatewayOrderId || null,
  }
  const error = missingReason(data)
  return error ? { error } : { data: data as RenewalMessageData }
}

export function renderRenewalWhatsAppMessage(data: RenewalMessageData) {
  const paidLines = data.paid
    ? [
        "This invoice is already paid.",
        "",
        data.paidAt ? `Paid on:\n${formatDueDate(data.paidAt)}` : "",
        data.transactionId ? `Transaction ID:\n${data.transactionId}` : "",
        "",
      ].filter(Boolean).join("\n")
    : ""
  return [
    `Hi ${data.customerName.split(/\s+/)[0] || data.customerName},`,
    "",
    paidLines || "Your VPS renewal is coming up.",
    "",
    "Service:",
    data.hostname,
    "",
    "Plan:",
    data.planName,
    "",
    "Invoice:",
    data.invoiceNumber,
    "",
    "Amount due:",
    data.amountLabel,
    "",
    "Due date:",
    data.dueDateLabel,
    "",
    "Pay securely:",
    data.paymentUrl,
    "",
    "View invoice:",
    data.invoiceUrl,
    "",
    "Download PDF:",
    data.pdfUrl,
    "",
    "If you already paid, open the invoice link to view payment status.",
    "",
    data.supportLine,
  ].join("\n")
}

async function writeReminder(input: {
  serviceId: string
  invoiceId: string
  reminderType: string
  channel: string
  status: string
  providerMessageId?: string | null
  error?: string | null
  metadata?: Record<string, unknown>
}) {
  return (prisma as any).serviceReminder.upsert({
    where: {
      serviceId_invoiceId_reminderType_channel: {
        serviceId: input.serviceId,
        invoiceId: input.invoiceId,
        reminderType: input.reminderType,
        channel: input.channel,
      },
    },
    update: {
      sentAt: new Date(),
      status: input.status,
      providerMessageId: input.providerMessageId || null,
      error: input.error || null,
      metadata: input.metadata || {},
    },
    create: {
      serviceId: input.serviceId,
      invoiceId: input.invoiceId,
      reminderType: input.reminderType,
      channel: input.channel,
      status: input.status,
      providerMessageId: input.providerMessageId || null,
      error: input.error || null,
      metadata: input.metadata || {},
    },
  })
}

async function reminderSent(serviceId: string, invoiceId: string, reminderType: string, channel?: string) {
  const row = await (prisma as any).serviceReminder.findFirst({
    where: {
      serviceId,
      invoiceId,
      reminderType,
      ...(channel ? { channel } : {}),
      status: { in: ["sent", "queued", "partial_success", "success"] },
    },
    select: { id: true },
  }).catch(() => null)
  return Boolean(row)
}

export async function sendRenewalInvoiceCommunications(input: { vps: any; invoice: any; reminderType: string }) {
  const resolved = await resolveRenewalMessageData(input)
  const invoiceId = input.invoice?.id
  const serviceId = input.vps?.id
  if (!resolved.data) {
    await createPanelLog({
      category: "BILLING",
      level: "warn",
      message: resolved.error || "Renewal message skipped because required data is missing",
      customerId: input.vps?.customerId || input.invoice?.customerId || null,
      orderId: input.vps?.orderId || input.invoice?.orderId || null,
      vpsInstanceId: serviceId || null,
      metadata: { invoiceId, reminderType: input.reminderType },
    }).catch(() => null)
    if (serviceId && invoiceId) {
      await writeReminder({ serviceId, invoiceId, reminderType: input.reminderType, channel: "system", status: "skipped", error: resolved.error }).catch(() => null)
    }
    return { ok: false, error: resolved.error }
  }
  const data = resolved.data
  if (!serviceId) return { ok: false, error: "Renewal message skipped because service id is missing" }
  const message = renderRenewalWhatsAppMessage(data)
  const attachments = await invoicePdfAttachment(data.invoiceId, {
    customerId: input.vps?.customerId || input.invoice?.customerId || null,
    orderId: input.vps?.orderId || input.invoice?.orderId || null,
    templateKey: "renewal_invoice",
  })

  const emailSubject = `Renewal invoice for ${data.hostname} — ${data.amountLabel} due on ${data.dueDateLabel}`
  const emailResult = input.vps?.customer?.email
    ? await sendEmail({
        type: "billing",
        to: input.vps.customer.email,
        subject: emailSubject,
        text: message,
        html: `<pre style="font-family:Inter,Arial,sans-serif;white-space:pre-wrap">${message.replace(/[<>&]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[char] || char))}</pre>`,
        attachments,
        logMessage: "renewal_invoice_email_sent",
        customerId: input.vps.customerId,
        orderId: input.vps.orderId || null,
        invoiceId: data.invoiceId,
        vpsInstanceId: serviceId,
        metadata: { reminderType: input.reminderType, paymentUrl: data.paymentUrl, invoiceUrl: data.invoiceUrl },
      }).catch((error) => ({ success: false, error: error instanceof Error ? error.message : String(error) }))
    : { success: false, error: "Customer email missing" }
  await writeReminder({
    serviceId,
    invoiceId: data.invoiceId,
    reminderType: input.reminderType,
    channel: "email",
    status: (emailResult as any)?.success ? "sent" : "failed",
    providerMessageId: (emailResult as any)?.messageId || null,
    error: (emailResult as any)?.success ? null : String((emailResult as any)?.error || "Email send failed"),
  }).catch(() => null)

  let whatsappFilePath: string | undefined
  if (attachments?.[0]?.content) {
    try {
      const { invoice, buffer } = await renderInvoicePdf(data.invoiceId)
      whatsappFilePath = join(tmpdir(), `zws-invoice-${invoice.invoiceNumber}-${Date.now()}.pdf`)
      await writeFile(whatsappFilePath, buffer)
    } catch {
      whatsappFilePath = undefined
    }
  }
  const whatsappMessage = whatsappFilePath ? message : `${message}\n\nInvoice PDF:\n${data.pdfUrl}`
  const notificationReservation = input.vps?.customerId && data.invoiceId
    ? await reserveNotificationDelivery({
        customerId: input.vps.customerId,
        orderId: input.vps.orderId || input.invoice?.orderId || null,
        serviceId,
        invoiceId: data.invoiceId,
        templateId: WHATSAPP_TEMPLATE_KEYS.SYSTEM_FALLBACK,
        notificationType: notificationEventForReminder(input.reminderType),
        channel: "whatsapp",
        event: notificationEventForReminder(input.reminderType),
        scheduledFor: scheduledReminderOccurrence(data.dueDate, input.reminderType),
        metadata: {
          source: "renewal_invoice",
          reminderType: input.reminderType,
          vpsInstanceId: serviceId,
          orderId: input.vps.orderId || null,
        },
      }).catch((error) => ({ reserved: false, reason: error instanceof Error ? error.message : String(error), row: null, duplicatePrevented: false }))
    : { reserved: false, reason: "missing_customer_or_invoice", row: null, duplicatePrevented: false }
  if (!notificationReservation.reserved) {
    await writeReminder({
      serviceId,
      invoiceId: data.invoiceId,
      reminderType: input.reminderType,
      channel: "whatsapp",
      status: "skipped",
      error: String(notificationReservation.reason || "notification_not_reserved"),
      metadata: { duplicatePrevented: notificationReservation.duplicatePrevented },
    }).catch(() => null)
    return { ok: Boolean((emailResult as any)?.success), email: emailResult, whatsapp: { ok: false, status: "skipped", error: notificationReservation.reason } }
  }
  const waResult = input.vps?.customer?.phone
    ? await sendWhatsAppMessage({
        to: input.vps.customer.phone,
        customerId: input.vps.customerId,
        orderId: input.vps.orderId || null,
        invoiceId: data.invoiceId,
        templateKey: WHATSAPP_TEMPLATE_KEYS.SYSTEM_FALLBACK,
        rawMessageText: whatsappMessage,
        variables: { message_text: whatsappMessage },
        messageType: whatsappFilePath ? "document" : "text",
        filePath: whatsappFilePath,
        category: "billing",
        metadata: {
          source: "renewal_invoice",
          reminderType: input.reminderType,
          attachedPdf: Boolean(whatsappFilePath),
          notificationId: notificationReservation.row?.notificationId || null,
        },
      }).catch((error) => ({ ok: false, status: "failed", error: error instanceof Error ? error.message : String(error) }))
    : { ok: false, status: "skipped", error: "Customer phone missing" }
  await markNotificationDelivery({
    notificationId: notificationReservation.row?.notificationId || null,
    status: (waResult as any)?.status || ((waResult as any)?.ok ? "pending" : "failed"),
    deliveryId: (waResult as any)?.messageId || null,
    metadata: {
      source: "renewal_invoice",
      reminderType: input.reminderType,
      queuedAt: new Date().toISOString(),
      result: waResult,
    },
  }).catch(() => null)
  await writeReminder({
    serviceId,
    invoiceId: data.invoiceId,
    reminderType: input.reminderType,
    channel: "whatsapp",
    status: (waResult as any)?.status || ((waResult as any)?.ok ? "queued" : "failed"),
    providerMessageId: (waResult as any)?.messageId || null,
    error: (waResult as any)?.ok ? null : String((waResult as any)?.error || "WhatsApp send failed"),
  }).catch(() => null)

  return { ok: Boolean((emailResult as any)?.success || (waResult as any)?.ok), email: emailResult, whatsapp: waResult }
}

export function calculateRenewalAmount(vps: any) {
  const base = money(vps.renewalAmount || vps.product?.price1m || vps.order?.unitPrice || vps.order?.subtotal || 0)
  const upgrade = money(vps.upgradeAmount || 0)
  return { baseAmount: base, upgradeAmount: upgrade, totalAmount: money(base + upgrade) }
}

async function recurringAddonRenewalLines(vps: any, renewalDueAt: Date) {
  const addons = await (prisma as any).vmAddon.findMany({
    where: { vpsInstanceId: vps.id, addonType: "ip", status: "active" },
    orderBy: { activatedAt: "asc" },
  }).catch(() => [])
  if (!addons.length) return { lines: [] as any[], subtotal: 0 }
  const purchaseIds = addons.map((addon: any) => addon.purchaseId).filter(Boolean)
  const planIds = addons.map((addon: any) => addon.addonPlanId).filter(Boolean)
  const [purchases, plans]: [any[], any[]] = await Promise.all([
    purchaseIds.length ? (prisma as any).vmAddonPurchase.findMany({ where: { id: { in: purchaseIds } } }).catch(() => []) : [],
    planIds.length ? (prisma as any).vmAddonPlan.findMany({ where: { id: { in: planIds } } }).catch(() => []) : [],
  ])
  const purchaseById = new Map<string, any>(purchases.map((row: any) => [row.id, row]))
  const planById = new Map<string, any>(plans.map((row: any) => [row.id, row]))
  const lines = addons.map((addon: any) => {
    const purchase = addon.purchaseId ? purchaseById.get(addon.purchaseId) : null
    const plan = addon.addonPlanId ? planById.get(addon.addonPlanId) : null
    const metadata = asObj(addon.metadata)
    const price = money(purchase?.amount ?? plan?.basePrice ?? 0)
    const purchaseMetadata = asObj(purchase?.metadata)
    const ipAddress = metadata.ipAddress || metadata.assignedIp || metadata.reservation?.ipAddress || purchaseMetadata.reservation?.ipAddress || "Additional IPv4"
    return {
      type: "additional_ipv4",
      addonId: addon.id,
      addonPlanId: addon.addonPlanId || null,
      purchaseId: addon.purchaseId || null,
      description: `Additional IPv4 - ${ipAddress}`,
      quantity: 1,
      unitPrice: price,
      total: price,
      vmid: vps.vmid,
      hostname: vps.name,
      ipAddress,
      renewalDueAt,
      permanent: true,
      removable: false,
    }
  }).filter((line: any) => line.unitPrice > 0)
  return {
    lines,
    subtotal: money(lines.reduce((sum: number, line: any) => sum + Number(line.total || 0), 0)),
  }
}

async function unpaidRenewalInvoice(vps: any) {
  return prisma.invoice.findFirst({
    where: {
      customerId: vps.customerId,
      deletedAt: null,
      status: { in: ["draft", "sent", "pending", "overdue"] },
      metadata: { path: ["vpsInstanceId"], equals: vps.id },
    },
    orderBy: { createdAt: "desc" },
  })
}

export async function createRenewalInvoice(vps: any) {
  const existing = await unpaidRenewalInvoice(vps)
  if (existing) return existing

  const amounts = calculateRenewalAmount(vps)
  const issueDate = new Date()
  const renewalDueAt = validDate(vps.renewalDueAt) || validDate(vps.nextRenewalAt) || issueDate
  const recurringAddons = await recurringAddonRenewalLines(vps, renewalDueAt)
  const renewalSubtotal = money(amounts.totalAmount + recurringAddons.subtotal)
  const totals = calculateInvoiceTotals({ subtotal: renewalSubtotal, gstPercent: 18 })
  const invoice = await prisma.$transaction(async (tx) => {
    const concurrent = await tx.invoice.findFirst({
      where: {
        customerId: vps.customerId,
        deletedAt: null,
        status: { in: ["draft", "sent", "pending", "overdue"] },
        metadata: { path: ["vpsInstanceId"], equals: vps.id },
      },
      orderBy: { createdAt: "desc" },
    })
    if (concurrent) return concurrent
    const renewalOrder = await tx.order.create({
      data: {
        orderNumber: `RENEW-${vps.id.slice(-8).toUpperCase()}-${renewalDueAt.getTime()}`,
        customerId: vps.customerId,
        productId: vps.productId || null,
        orderType: "renewal",
        termMonths: Number(vps.billingTermMonths || 1),
        unitPrice: totals.subtotal,
        quantity: 1,
        subtotal: totals.subtotal,
        taxAmount: totals.gstAmount,
        discountAmount: 0,
        totalAmount: totals.totalAmount,
        originalAmount: totals.totalAmount,
        finalAmount: totals.totalAmount,
        payableAmount: totals.totalAmount,
        currency: vps.order?.currency || "INR",
        status: "pending_payment",
        hostname: vps.name,
        metadata: {
          kind: "renewal",
          vpsInstanceId: vps.id,
          sourceOrderId: vps.orderId,
          renewalPeriodStart: renewalDueAt,
        },
      },
    })
    const created = await tx.invoice.create({
      data: {
      invoiceNumber: renewalInvoiceNumber(vps.id, renewalDueAt),
      orderId: renewalOrder.id,
      customerId: vps.customerId,
      issueDate,
      dueDate: renewalDueAt,
      subtotal: totals.subtotal,
      ...invoiceTaxWriteFields({ taxRate: totals.gstPercent, taxAmount: totals.gstAmount }),
      discountAmount: 0,
      totalAmount: totals.totalAmount,
      currency: vps.order?.currency || "INR",
      status: "pending",
      type: "service",
      lineItems: [
        {
          type: "renewal",
          description: `VPS renewal - ${vps.name}`,
          quantity: 1,
          unitPrice: amounts.totalAmount,
          total: amounts.totalAmount,
          vmid: vps.vmid,
          hostname: vps.name,
          plan: vps.product?.name || "VPS",
          baseAmount: amounts.baseAmount,
          upgradeAmount: amounts.upgradeAmount,
        },
        ...recurringAddons.lines,
      ],
      metadata: {
        invoiceType: "proforma",
        billingPurpose: "renewal",
        vpsInstanceId: vps.id,
        hostname: vps.name,
        vmid: vps.vmid,
        plan: vps.product?.name || "VPS",
        baseCost: amounts.baseAmount,
        upgradeCost: amounts.upgradeAmount,
        recurringAddonCost: recurringAddons.subtotal,
        recurringAddons: recurringAddons.lines.map((line: any) => ({ addonId: line.addonId, type: line.type, total: line.total, ipAddress: line.ipAddress })),
        totalRenewalAmount: totals.totalAmount,
        renewalPeriodStart: renewalDueAt,
        billingCycle: vps.billingCycle || "monthly",
      },
      },
    })
    await tx.vpsInstance.update({ where: { id: vps.id }, data: { renewalInvoiceGeneratedAt: new Date() } })
    return created
  }, { isolationLevel: "Serializable" })
  return invoice
}

export async function sendRenewalReminder(vps: any, days: 3 | 2 | 1 | 0) {
  const to = vps.customer?.email
  if (!to) return { success: false, message: "Customer email missing" }
  const amount = money(vps.renewalAmount || calculateRenewalAmount(vps).totalAmount)
  const appUrl = await getSiteUrl()
  const dueAt = validDate(vps.renewalDueAt) || validDate(vps.nextRenewalAt) || new Date()
  const email = await renewalEmail({
    name: vps.customer?.name,
    vpsName: vps.name,
    amount,
    dueDate: dueAt,
    days,
    url: `${appUrl}/client-area/billing`,
  })
  return sendEmail({
    type: "billing",
    to,
    subject: email.subject,
    text: email.text,
    html: email.html,
    logMessage: "renewal reminder sent",
    customerId: vps.customerId,
    vpsInstanceId: vps.id,
  })
}

async function sendLifecycleNotification(input: {
  vps: any
  event: string
  severity: WarningSeverity
  message: string
  invoiceId?: string | null
  penalty?: number | null
  hoursLeft?: number | null
}) {
  const { vps } = input
  const dueAt = validDate(vps.renewalDueAt) || validDate(vps.nextRenewalAt)
  const amount = money(vps.renewalAmount || calculateRenewalAmount(vps).totalAmount)
  const user = {
    id: vps.customerId,
    email: vps.customer?.email || null,
    phone: vps.customer?.phone || null,
    name: vps.customer?.name || null,
  }
  const suspensionReservation = input.event === "service_suspended"
    ? await reserveNotificationDelivery({
        customerId: vps.customerId,
        orderId: vps.orderId || null,
        serviceId: vps.id,
        invoiceId: input.invoiceId || null,
        templateId: WHATSAPP_TEMPLATE_KEYS.SERVICE_SUSPENDED,
        notificationType: "service_suspended",
        channel: "multi",
        event: "service_suspended",
        scheduledFor: validDate(vps.suspendedAt) || new Date(),
        metadata: { source: "renewal_suspension", vpsInstanceId: vps.id },
      }).catch(() => ({ reserved: false, reason: "ledger_unavailable", row: null as any, duplicatePrevented: false }))
    : null
  if (suspensionReservation && !suspensionReservation.reserved) {
    return { ok: true, status: "skipped", type: "invoice", channels: {}, reason: suspensionReservation.reason }
  }
  const result = await sendNotification({
    type: "invoice",
    channels: input.event === "service_suspended" ? ["email", "whatsapp"] : ["email"],
    user,
    data: {
      templateKey: input.event === "service_suspended" ? "service_suspended" : "renewal_invoice",
      customer_name: user.name || "there",
      userName: user.name || "there",
      vm_name: vps.name,
      serviceName: vps.name,
      due_date: dueAt ? dueAt.toISOString() : "",
      amount: amount.toFixed(2),
      penalty: money(input.penalty).toFixed(2),
      hours_left: input.hoursLeft === null || input.hoursLeft === undefined ? "" : String(input.hoursLeft),
      message: input.message,
      text: input.message,
      invoiceId: input.invoiceId || null,
      orderId: vps.orderId || null,
      metadata: {
        category: "billing",
        lifecycleEvent: input.event,
        severity: input.severity,
        vpsInstanceId: vps.id,
      },
    },
  } as any).catch((error) => ({ ok: false, status: "failed" as const, type: "invoice", channels: {}, error }))

  if (suspensionReservation?.row?.notificationId) {
    const whatsapp = (result as any)?.channels?.whatsapp
    await markNotificationDelivery({
      notificationId: suspensionReservation.row.notificationId,
      status: whatsapp?.status || ((result as any)?.ok ? "pending" : "failed"),
      deliveryId: whatsapp?.messageId || null,
      metadata: { source: "renewal_suspension", resultStatus: (result as any)?.status || null },
    }).catch(() => null)
  }

  await createPanelLog({
    level: result.ok ? "info" : "warn",
    category: "BILLING",
    message: "vps_lifecycle_notification",
    actorType: "system",
    customerId: vps.customerId,
    orderId: vps.orderId,
    vpsInstanceId: vps.id,
    vmid: vps.vmid,
    metadata: { event: input.event, severity: input.severity, result },
  }).catch(() => null)
  return result
}

async function markReminderSent(vps: any, level: ReminderLevel, now: Date) {
  const meta = lifecycleMeta(vps)
  const reminders = asObj(meta.reminders)
  reminders[level] = now.toISOString()
  await prisma.vpsInstance.update({
    where: { id: vps.id },
    data: {
      lastReminderSentAt: now,
      lastReminderLevel: level,
      ...(level === "3d" ? { renewalReminder3SentAt: now } : {}),
      ...(level === "due_day" ? { renewalReminder0SentAt: now } : {}),
      lifecycleMetadata: { ...meta, reminders },
    },
  })
}

function reminderAlreadySent(vps: any, level: ReminderLevel) {
  const reminders = asObj(lifecycleMeta(vps).reminders)
  if (reminders[level]) return true
  if (level === "3d" && vps.renewalReminder3SentAt) return true
  if (level === "due_day" && vps.renewalReminder0SentAt) return true
  return false
}

function nextScheduledReminder(vps: any, due: Date, now: Date): ReminderLevel | null {
  if (now < due) {
    return [...REMINDER_THRESHOLDS]
      .reverse()
      .find((threshold) => now >= addMs(due, -threshold.msBeforeDue) && !reminderAlreadySent(vps, threshold.level))
      ?.level || null
  }
  const dueDaySent = reminderAlreadySent(vps, "due_day")
  if (!dueDaySent) return "due_day"
  return null
}

async function applyPenalty(vps: any, invoice: any, now: Date) {
  if (vps.penaltyAppliedAt) return { applied: false, invoice }
  const percent = Math.max(0, Number(vps.penaltyPercent ?? 10) || 0)
  const base = money(invoice?.totalAmount || calculateRenewalAmount(vps).totalAmount)
  const penalty = money(base * (percent / 100))
  if (penalty <= 0) return { applied: false, invoice }

  const lineItems = Array.isArray(invoice.lineItems) ? invoice.lineItems : []
  const hasLateFee = lineItems.some((item: any) => item?.type === "late_fee")
  if (!hasLateFee) {
    lineItems.push({
      type: "late_fee",
      description: `${percent}% late renewal penalty`,
      quantity: 1,
      unitPrice: penalty,
      total: penalty,
      vmid: vps.vmid,
      hostname: vps.name,
    })
  }
  const amountDelta = hasLateFee ? 0 : penalty
  const nextSubtotal = money(Number(invoice.subtotal || 0) + amountDelta)
  const nextTaxRate = money((invoice as any).gstPercent ?? invoice.taxRate)
  const nextTaxAmount = money(nextSubtotal * (nextTaxRate / 100))
  const updatedInvoice = await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      lineItems,
      subtotal: nextSubtotal,
      ...invoiceTaxWriteFields({ taxRate: nextTaxRate, taxAmount: nextTaxAmount }),
      totalAmount: money(nextSubtotal + nextTaxAmount),
      status: "overdue",
      metadata: { ...asObj(invoice.metadata), penaltyAppliedAt: now.toISOString(), penaltyAmount: penalty, penaltyPercent: percent },
    },
  })
  await prisma.vpsInstance.update({
    where: { id: vps.id },
    data: { status: "PENALTY", penaltyAppliedAt: now, suspensionReason: "unpaid_renewal_penalty" },
  })
  await sendLifecycleNotification({
    vps,
    event: "penalty_notice",
    severity: "CRITICAL",
    invoiceId: invoice.id,
    penalty,
    message: "A late fee has been added to your overdue VM renewal invoice.",
  })
  return { applied: true, invoice: updatedInvoice }
}

export async function suspendOverdueVps(vps: any) {
  if (String(vps.status).toUpperCase() === "SUSPENDED" || String(vps.status).toUpperCase() === "PENDING_TERMINATION") return vps
  const now = new Date()
  const meta = lifecycleMeta(vps)
  let previousOnboot: unknown = meta.previousOnboot
  if (vps.proxmoxNode && vps.vmid) {
    const client = createProxmoxClient(vps.proxmoxNode.host, vps.proxmoxNode.tokenId, vps.proxmoxNode.tokenSecret, {
      allowInsecureTls: vps.proxmoxNode.allowInsecureTls,
      timeoutMs: PROXMOX_LONG_TIMEOUT_MS,
    })
    const [runtime, config] = await Promise.all([
      client.getVMStatus(vps.proxmoxNode.nodeName, vps.vmid).catch(() => null),
      client.getVMConfig(vps.proxmoxNode.nodeName, vps.vmid).catch(() => null),
    ])
    previousOnboot = previousOnboot ?? config?.onboot ?? null
    if (String(runtime?.status || "").toLowerCase() === "running") {
      await client.shutdownVM(vps.proxmoxNode.nodeName, vps.vmid).catch(() => client.stopVM(vps.proxmoxNode.nodeName, vps.vmid).catch(() => undefined))
    }
    await client.updateVMConfig(vps.proxmoxNode.nodeName, vps.vmid, { onboot: 0 }).catch(() => undefined)
  }
  const deletionAt = validDate(vps.deletionAt) ||
    lifecycleDates({
      renewalDueAt: vps.renewalDueAt || vps.nextRenewalAt,
      graceDays: vps.graceDays,
      penaltyWindowDays: vps.penaltyWindowDays,
      terminationWindowDays: vps.terminationWindowDays,
      retentionDays: vps.retentionDays,
    }).deletionAt ||
    addDays(now, Math.max(1, Number(vps.retentionDays ?? 7) || 7))
  const savedOnboot = previousOnboot === undefined || previousOnboot === null ? null : String(previousOnboot)
  const updated = await prisma.vpsInstance.update({
    where: { id: vps.id },
    data: {
      status: "SUSPENDED",
      suspendedAt: now,
      suspensionReason: "unpaid_renewal",
      deletionAt,
      lifecycleMetadata: { ...meta, previousOnboot: savedOnboot, suspendedBy: "renewal_worker", suspendedAt: now.toISOString() },
    },
  })
  await prisma.order.update({ where: { id: vps.orderId }, data: { provisioningStatus: "SUSPENDED" } }).catch(() => undefined)
  await sendLifecycleNotification({
    vps,
    event: "service_suspended",
    severity: "CRITICAL",
    invoiceId: vps.invoiceId || null,
    message: "Your VM has been suspended due to unpaid invoice.",
  })
  await createAuditLog({
    action: "VPS_AUTO_SUSPENDED",
    customerId: vps.customerId,
    targetType: "vps_instance",
    targetId: vps.id,
    oldValue: { status: vps.status, onboot: previousOnboot },
    newValue: { status: "SUSPENDED", deletionAt },
    metadata: { reason: "unpaid_renewal", vmid: vps.vmid },
  }).catch(() => null)
  return updated
}

async function markPendingTermination(vps: any, now: Date) {
  if (String(vps.status).toUpperCase() === "PENDING_TERMINATION") return false
  const deletionAt = validDate(vps.deletionAt) ||
    lifecycleDates({
      renewalDueAt: vps.renewalDueAt || vps.nextRenewalAt,
      graceDays: vps.graceDays,
      penaltyWindowDays: vps.penaltyWindowDays,
      terminationWindowDays: vps.terminationWindowDays,
      retentionDays: vps.retentionDays,
    }).deletionAt ||
    addDays(validDate(vps.suspendedAt) || now, Math.max(1, Number(vps.retentionDays ?? 7) || 7))
  await prisma.vpsInstance.update({
    where: { id: vps.id },
    data: { status: "PENDING_TERMINATION", deletionAt },
  })
  await sendLifecycleNotification({
    vps: { ...vps, deletionAt },
    event: "termination_warning",
    severity: "TERMINATION",
    message: `Your VM data is scheduled for deletion on ${deletionAt.toISOString()}. Renew immediately to keep your service.`,
  })
  return true
}

async function terminateVps(vps: any, now: Date) {
  const meta = lifecycleMeta(vps)
  let vmExists = false
  let configOk = false
  if (vps.proxmoxNode && vps.vmid) {
    const client = createProxmoxClient(vps.proxmoxNode.host, vps.proxmoxNode.tokenId, vps.proxmoxNode.tokenSecret, {
      allowInsecureTls: vps.proxmoxNode.allowInsecureTls,
      timeoutMs: PROXMOX_LONG_TIMEOUT_MS,
    })
    const [runtime, config] = await Promise.all([
      client.getVMStatus(vps.proxmoxNode.nodeName, vps.vmid).catch(() => null),
      client.getVMConfig(vps.proxmoxNode.nodeName, vps.vmid).catch(() => null),
    ])
    vmExists = Boolean(runtime || config)
    configOk = Boolean(config)
    if (vmExists) await client.deleteVM(vps.proxmoxNode.nodeName, vps.vmid).catch((error) => {
      throw new Error(`VM delete failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const released = await freeVpsIp(vps.id).catch(() => ({ count: 0 }))
  await prisma.order.update({ where: { id: vps.orderId }, data: { provisioningStatus: "TERMINATED", status: "terminated" } }).catch(() => undefined)
  await prisma.vpsInstance.update({
    where: { id: vps.id },
    data: {
      status: "TERMINATED",
      deletedAt: now,
      lifecycleMetadata: {
        ...meta,
        terminatedAt: now.toISOString(),
        terminationChecks: { vmExists, configOk, backupStatus: "metadata_retained", releasedIps: released.count },
      },
    },
  })
  await sendLifecycleNotification({
    vps,
    event: "final_deletion_notice",
    severity: "TERMINATION",
    message: "Your VM has been terminated after the overdue retention window.",
  })
  await createAuditLog({
    action: "VPS_AUTO_TERMINATED",
    customerId: vps.customerId,
    targetType: "vps_instance",
    targetId: vps.id,
    oldValue: { status: vps.status },
    newValue: { status: "TERMINATED", deletedAt: now },
    metadata: { vmid: vps.vmid, vmExists, configOk, releasedIps: released.count },
  }).catch(() => null)
  return true
}

export async function renewVpsFromPaidInvoice(invoice: any) {
  const metadata = invoice?.metadata || {}
  if (!["renewal", "proforma"].includes(String(metadata.invoiceType || "")) && metadata.billingPurpose !== "renewal") return null
  if (!metadata.vpsInstanceId) return null
  const vps = await prisma.vpsInstance.findUnique({ where: { id: String(metadata.vpsInstanceId) }, include: { proxmoxNode: true } })
  if (!vps) return null
  const months = Math.max(1, Number(vps.billingTermMonths || (vps.billingCycle === "annual" ? 12 : 1)))
  const dueAt = validDate(vps.renewalDueAt) || validDate(vps.nextRenewalAt)
  const baseDate = dueAt && dueAt > new Date() ? dueAt : new Date()
  const nextDue = addMonths(baseDate, months)
  let status = "ACTIVE"
  const meta = lifecycleMeta(vps)
  if (String(vps.status).toUpperCase() === "SUSPENDED" || String(vps.status).toUpperCase() === "PENDING_TERMINATION") {
    if (vps.proxmoxNode) {
      const client = createProxmoxClient(vps.proxmoxNode.host, vps.proxmoxNode.tokenId, vps.proxmoxNode.tokenSecret, {
        allowInsecureTls: vps.proxmoxNode.allowInsecureTls,
        timeoutMs: PROXMOX_LONG_TIMEOUT_MS,
      })
      if (meta.previousOnboot !== undefined && meta.previousOnboot !== null) {
        await client.updateVMConfig(vps.proxmoxNode.nodeName, vps.vmid, { onboot: Number(meta.previousOnboot) ? 1 : 0 }).catch(() => undefined)
      }
      await client.startVM(vps.proxmoxNode.nodeName, vps.vmid).catch(() => undefined)
    }
    status = "ACTIVE"
  }
  const dates = lifecycleDates({
    renewalDueAt: nextDue,
    graceDays: vps.graceDays,
    penaltyWindowDays: vps.penaltyWindowDays,
    terminationWindowDays: vps.terminationWindowDays,
    retentionDays: vps.retentionDays,
  })
  const renewed = await prisma.vpsInstance.update({
    where: { id: vps.id },
    data: {
      status,
      suspendedAt: null,
      suspensionReason: null,
      renewalDueAt: nextDue,
      nextRenewalAt: nextDue,
      suspendAt: dates.suspendAt,
      penaltyAt: dates.penaltyAt,
      terminationAt: dates.terminationAt,
      deletionAt: dates.deletionAt,
      penaltyAppliedAt: null,
      lastReminderSentAt: null,
      lastReminderLevel: null,
      renewalReminder7SentAt: null,
      renewalReminder3SentAt: null,
      renewalReminder0SentAt: null,
      renewalInvoiceGeneratedAt: null,
      lifecycleMetadata: { ...meta, reminders: {}, renewedAt: new Date().toISOString(), lastPaidInvoiceId: invoice.id || null },
    },
  })
  await (prisma as any).vmAddon.updateMany({
    where: { vpsInstanceId: vps.id, addonType: "ip", status: "active" },
    data: { expiresAt: nextDue },
  }).catch(() => null)
  await restoreBandwidthThrottle({ vpsId: vps.id, actor: "renewal_paid_invoice", reason: "billing_cycle_reset" }).catch(() => null)
  return renewed
}

export async function processRenewalsOnce(now = new Date()) {
  const vpsRows = await prisma.vpsInstance.findMany({
    where: {
      deletedAt: null,
      status: { notIn: ["DELETED", "TERMINATED"] },
      OR: [{ renewalDueAt: { not: null } }, { nextRenewalAt: { not: null } }],
    },
    include: { customer: true, product: true, order: true, proxmoxNode: true },
  })
  const result = {
    reminders: 0,
    expiries: 0,
    invoices: 0,
    penalties: 0,
    suspended: 0,
    pendingTerminations: 0,
    terminations: 0,
    releasedIps: 0,
    notificationFailures: 0,
    skippedAutomation: 0,
  }

  for (const vps of vpsRows) {
    const due = validDate(vps.renewalDueAt) || validDate(vps.nextRenewalAt)
    if (!due) continue

    const dates = lifecycleDates({
      renewalDueAt: due,
      graceDays: vps.graceDays,
      penaltyWindowDays: (vps as any).penaltyWindowDays,
      terminationWindowDays: (vps as any).terminationWindowDays,
      retentionDays: vps.retentionDays,
    })
    const patchDates: Record<string, Date> = {}
    if (!vps.renewalDueAt) patchDates.renewalDueAt = due
    if (!vps.nextRenewalAt) patchDates.nextRenewalAt = due
    if (!vps.suspendAt && dates.suspendAt) patchDates.suspendAt = dates.suspendAt
    if (!vps.penaltyAt && dates.penaltyAt) patchDates.penaltyAt = dates.penaltyAt
    if (!(vps as any).terminationAt && dates.terminationAt) patchDates.terminationAt = dates.terminationAt
    if (!vps.deletionAt && dates.deletionAt) patchDates.deletionAt = dates.deletionAt
    if (Object.keys(patchDates).length) await prisma.vpsInstance.update({ where: { id: vps.id }, data: patchDates })

    let invoice = await unpaidRenewalInvoice(vps)

    if (!vps.remindersPausedAt) {
      const dueReminder = nextScheduledReminder(vps, due, now)
      if (dueReminder) {
        if (!invoice) {
          invoice = await createRenewalInvoice(vps)
          result.invoices++
        }
        const alreadyLogged = invoice ? await reminderSent(vps.id, invoice.id, dueReminder) : false
        if (!alreadyLogged) {
          const notification = await sendRenewalInvoiceCommunications({
            vps,
            invoice,
            reminderType: dueReminder,
          })
          if (!notification.ok) result.notificationFailures++
          await markReminderSent(vps, dueReminder, now)
          result.reminders++
        }
        if (String(vps.status).toUpperCase() === "ACTIVE" && dueReminder !== "due_day") {
          await prisma.vpsInstance.update({ where: { id: vps.id }, data: { status: "RENEWAL_DUE" } }).catch(() => undefined)
        }
      }
    }

    if (now >= due) {
      if (!invoice) {
        invoice = await createRenewalInvoice(vps)
        result.invoices++
      }
      if (!["OVERDUE", "PENALTY", "SUSPENDED", "PENDING_TERMINATION"].includes(String(vps.status).toUpperCase())) {
        await prisma.vpsInstance.update({ where: { id: vps.id }, data: { status: "OVERDUE" } })
        await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "overdue" } }).catch(() => undefined)
        result.expiries++
      }
    }

    invoice = invoice || await unpaidRenewalInvoice(vps)
    if (!invoice) continue

    const penaltyAt = validDate(vps.penaltyAt) || dates.penaltyAt
    if (penaltyAt && now >= penaltyAt && !vps.penaltyAppliedAt) {
      await applyPenalty(vps, invoice, now)
      result.penalties++
    }

    const suspendAt = validDate(vps.suspendAt) || dates.suspendAt
    if (suspendAt && now >= suspendAt && !vps.automationPausedAt) {
      if (vps.autoSuspendEnabled) {
        // Never auto-suspend a VM mid-lifecycle-operation (provision/reinstall/migrate/restore). Only
        // suspend once it settles back to a steady state; manual admin suspend is unaffected.
        if (!["SUSPENDED", "PENDING_TERMINATION", "PROVISIONING", "REINSTALLING", "MIGRATING", "RESTORING"].includes(String(vps.status).toUpperCase())) {
          await suspendOverdueVps(vps)
          result.suspended++
        }
      } else {
        result.skippedAutomation++
      }
    }

    const refreshed = await prisma.vpsInstance.findUnique({ where: { id: vps.id }, include: { customer: true, product: true, order: true, proxmoxNode: true } })
    if (!refreshed) continue
    const status = String(refreshed.status).toUpperCase()
    const terminationAt = validDate(refreshed.terminationAt) || dates.terminationAt
    if (status === "SUSPENDED" && terminationAt && now >= terminationAt) {
      const moved = await markPendingTermination(refreshed, now)
      if (moved) result.pendingTerminations++
    }

    const deletionAt = validDate(refreshed.deletionAt)
    if (deletionAt && now >= deletionAt) {
      if (refreshed.autoDeleteEnabled && !refreshed.automationPausedAt) {
        await terminateVps(refreshed, now)
        result.terminations++
      } else {
        result.skippedAutomation++
      }
    }
  }
  return result
}
