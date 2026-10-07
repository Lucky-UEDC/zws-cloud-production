import { prisma } from "@/lib/db"
import { formatCurrency } from "@/lib/currency-format"
import { publicOrigin } from "@/lib/public-url"
import { resolveBrandIdentity } from "@/lib/brand-identity"
import { sendWhatsAppMessage } from "@/lib/whatsapp/queue"
import { WHATSAPP_TEMPLATE_KEYS } from "@/lib/whatsapp/template-registry"
import { markOutboundEventDelivery, reserveOutboundEventDelivery } from "@/lib/outbound-event-delivery"

function money(value: unknown) {
  const n = Number(value || 0)
  return Number.isFinite(n) ? n.toFixed(2) : "0.00"
}

export async function emitWhatsAppAutomationEvent(input: {
  eventType: string
  customerId?: string | null
  data?: Record<string, unknown>
  dedupeKey?: string | null
}) {
  if (!input.customerId) return null
  const customer = await prisma.customer.findUnique({
    where: { id: input.customerId },
    select: { id: true, name: true, phone: true, whatsappOptIn: true, phoneVerified: true },
  })
  if (!customer?.phone || !customer.whatsappOptIn || !customer.phoneVerified) return null

  const rules = await prisma.whatsAppAutomationRule.findMany({
    where: { eventType: input.eventType, enabled: true },
  })
  if (!rules.length) return null
  const brandName = await resolveBrandIdentity()

  return Promise.allSettled(rules.map(async (rule) => {
    const reserved = input.dedupeKey
      ? await reserveOutboundEventDelivery({
          channel: "whatsapp",
          eventType: input.eventType,
          templateKey: rule.templateKey || WHATSAPP_TEMPLATE_KEYS.SYSTEM_FALLBACK,
          customerId: customer.id,
          invoiceId: typeof input.data?.invoiceId === "string" ? input.data.invoiceId : null,
          vpsInstanceId: typeof input.data?.vpsInstanceId === "string" ? input.data.vpsInstanceId : null,
          cycleKey: input.dedupeKey,
          metadata: { automationRuleId: rule.id, eventType: input.eventType },
        })
      : null
    if (reserved && !reserved.reserved) return { ok: false, status: "skipped", error: "duplicate_automation_event" }
    const variables = {
      name: customer.name || "there",
      first_name: (customer.name || "there").split(/\s+/)[0] || "there",
      company_name: brandName,
      brandName,
      dashboard_url: `${publicOrigin()}/client-area`,
      website_url: publicOrigin(),
      ...(input.data || {}),
    }
    const delay = Math.max(0, rule.delayMinutes) * 60_000
    const result = await sendWhatsAppMessage({
      to: customer.phone!,
      customerId: customer.id,
      templateKey: rule.templateKey || WHATSAPP_TEMPLATE_KEYS.SYSTEM_FALLBACK,
      variables: {
        ...variables,
        message_text: String(input.data?.message || `You have a new ${brandName} update.`),
      },
      category: String(input.data?.category || "transactional"),
      metadata: { automationRuleId: rule.id, eventType: input.eventType, dedupeKey: input.dedupeKey || null },
    }, delay ? { delay, jobId: input.dedupeKey ? `${rule.id}:${input.dedupeKey}` : undefined } : undefined)
    if (reserved?.dedupeKey) {
      await markOutboundEventDelivery({
        dedupeKey: reserved.dedupeKey,
        status: result.status || "queued",
        providerMessageId: result.messageId || null,
        metadata: { automationRuleId: rule.id, eventType: input.eventType, queuedAt: new Date().toISOString() },
      })
    }
    return result
  }))
}

export async function runScheduledWhatsAppAutomations() {
  const now = new Date()
  // P0-023: never nag with overdue/suspension messages while a reinstall or provision is in flight.
  const busyVps = await prisma.vpsInstance.findMany({
    where: {
      deletedAt: null,
      status: { in: ["REINSTALLING", "PROVISIONING", "reinstalling", "provisioning"] },
    },
    select: { customerId: true },
  }).catch(() => [] as Array<{ customerId: string }>)
  const busyCustomerIds = new Set(busyVps.map((row) => row.customerId))

  const overdueInvoices = await prisma.invoice.findMany({
    where: {
      deletedAt: null,
      status: { in: ["pending", "sent", "unpaid", "overdue"] },
      dueDate: { lt: new Date(Date.now() - 3 * 24 * 60 * 60_000) },
    },
    include: { customer: true },
    take: 50,
  })

  await Promise.allSettled(overdueInvoices.filter((invoice) => !busyCustomerIds.has(invoice.customerId)).map((invoice) => emitWhatsAppAutomationEvent({
    eventType: "invoice_overdue",
    customerId: invoice.customerId,
    dedupeKey: `invoice_overdue:${invoice.id}:${invoice.dueDate.toISOString().slice(0, 10)}`,
    data: {
      category: "billing",
      invoiceNumber: invoice.invoiceNumber,
      invoiceId: invoice.id,
      amount: money(invoice.totalAmount),
      currency: invoice.currency,
      dueDate: invoice.dueDate.toLocaleDateString("en-IN"),
      message: `Hi ${invoice.customer.name || "there"}, invoice ${invoice.invoiceNumber} for ${formatCurrency(invoice.totalAmount, invoice.currency || "INR")} ${(invoice.currency || "INR").toUpperCase()} is overdue. Please pay to avoid service interruption.`,
    },
  })))

  const suspendedVps = await prisma.vpsInstance.findMany({
    where: { status: "suspended", suspendedAt: { not: null } },
    include: { customer: true },
    take: 50,
  })
  await Promise.allSettled(suspendedVps.filter((vps) => !busyCustomerIds.has(vps.customerId)).map((vps) => emitWhatsAppAutomationEvent({
    eventType: "vps_suspended",
    customerId: vps.customerId,
    dedupeKey: `vps_suspended:${vps.id}:${now.toISOString().slice(0, 10)}`,
    data: {
      category: "provisioning",
      serviceName: vps.name,
      message: `Hi ${vps.customer.name || "there"}, VPS ${vps.name} is suspended. Please check your billing or contact support.`,
    },
  })))

  await prisma.whatsAppAutomationRule.updateMany({
    where: { enabled: true },
    data: { lastRunAt: now },
  }).catch(() => null)
}
