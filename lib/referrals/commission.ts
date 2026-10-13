/**
 * Commission arithmetic and the materialised commission ledger.
 *
 * Two rules matter and are enforced here rather than in a view or the UI:
 *
 *  1. A commission exists only for a *qualifying transaction* - a paid service
 *     invoice whose order still passes the shared `activeBillableOrderWhere`
 *     gate used by lib/revenue-analytics. Cancelled, refunded, deleted and
 *     failed orders never produce commission.
 *  2. One commission row per order. Renewals are written by lib/renewals.ts as
 *     their own `orderType = "renewal"` order, so each renewal period earns its
 *     own commission instead of being folded into the first purchase.
 */

import { prisma } from "@/lib/db"
import { activeBillableOrderWhere, paidServiceInvoiceWhere } from "@/lib/revenue-analytics"

/** Half-up to 2dp, matching how the rest of the billing code rounds money. */
export function roundMoney(value: unknown): number {
  const parsed = Number(value || 0)
  if (!Number.isFinite(parsed)) return 0
  return Number((Math.round((parsed + Number.EPSILON) * 100) / 100).toFixed(2))
}

export function computeCommissionAmount(baseAmount: unknown, ratePercent: unknown): number {
  const base = Number(baseAmount || 0)
  const rate = Number(ratePercent || 0)
  if (!Number.isFinite(base) || !Number.isFinite(rate) || base <= 0 || rate <= 0) return 0
  return roundMoney((base * rate) / 100)
}

/**
 * The commission base: product amount after discount, BEFORE GST.
 *
 * Invoices in this system satisfy `totalAmount = subtotal - discount + tax`,
 * so the eligible amount is simply the total less the tax the customer paid.
 * Both forms are derived from authoritative invoice columns - no rate is
 * assumed and no amount is reconstructed from a percentage.
 *
 * Worked example, which is the policy's worked example:
 *
 *   product price before GST   1000.00
 *   GST                         180.00
 *   customer pays              1180.00
 *   eligible base              1000.00   <- commission is 10% of this = 100.00
 *
 * Not 118.00, which is what a percentage of the amount paid would have paid.
 */
export function eligibleBaseFromInvoiceParts(
  subtotal: unknown,
  discountAmount: unknown,
  taxAmount: unknown,
  totalAmount: unknown,
): number {
  const subtotalValue = Number(subtotal || 0)
  const discountValue = Number(discountAmount || 0)
  const taxValue = Number(taxAmount || 0)
  const totalValue = Number(totalAmount || 0)

  if (Number.isFinite(subtotalValue) && subtotalValue > 0) {
    return roundMoney(Math.max(0, subtotalValue - Math.max(0, discountValue)))
  }

  // No subtotal recorded (a legacy or hand-written invoice). Derive it from the
  // identity total = base + tax rather than assuming the total is the base.
  if (Number.isFinite(totalValue) && totalValue > 0) {
    return roundMoney(Math.max(0, totalValue - Math.max(0, taxValue)))
  }

  return 0
}

/**
 * Whether an order/transaction is commissionable under the current rule.
 * Kept pure so tests can pin the cancelled/refunded/renewal cases without a
 * database.
 */
export function isQualifyingCommissionInput(input: {
  orderStatus?: string | null
  orderProvisioningStatus?: string | null
  orderDeletedAt?: Date | null
  orderIsActive?: boolean | null
  invoiceStatus?: string | null
  invoiceType?: string | null
  invoiceDeletedAt?: Date | null
  amount?: number | null
  /** Pre-GST eligible amount; the minimum-order gate applies to this. */
  eligibleBaseAmount?: number | null
  minimumOrderAmount?: number
  programActive?: boolean
}) {
  const status = String(input.orderStatus || "").toLowerCase()
  const provisioningStatus = String(input.orderProvisioningStatus || "").toLowerCase()
  const invoiceStatus = String(input.invoiceStatus || "").toLowerCase()
  const invoiceType = String(input.invoiceType || "").toLowerCase()

  if (input.orderDeletedAt) return false
  if (input.orderIsActive === false) return false
  if (["paid", "active", "completed", "payment_verified"].includes(status)) {
    // still allowed, fall through
  } else {
    return false
  }
  if (["deleted", "cancelled", "canceled", "archived", "failed", "expired", "payment_failed"].includes(status)) return false
  if (["deleted", "cancelled", "canceled", "archived", "failed", "provisioning_failed", "failed_deleted", "payment_failed"].includes(provisioningStatus)) return false
  if (invoiceStatus !== "paid") return false
  if (invoiceType !== "service") return false
  if (input.invoiceDeletedAt) return false
  if (input.programActive === false) return false
  const amount = Number(input.amount || 0)
  if (!Number.isFinite(amount) || amount <= 0) return false
  // The minimum-order gate is applied to the pre-GST eligible amount, so a
  // customer cannot clear the threshold by adding tax to a small order.
  const eligibleBase = input.eligibleBaseAmount === undefined || input.eligibleBaseAmount === null
    ? amount
    : Number(input.eligibleBaseAmount)
  if (!Number.isFinite(eligibleBase) || eligibleBase <= 0) return false
  if (eligibleBase < Number(input.minimumOrderAmount || 0)) return false
  return true
}

/**
 * Under the first-purchase policy a referred customer earns exactly one
 * initial commission. Renewals and any later VPS purchase earn nothing.
 *
 * This picks, per referred customer, the single earliest qualifying invoice.
 * Selection is by payment time rather than by row order, so it does not depend
 * on how the database happened to return the rows.
 */
export function selectFirstQualifyingPurchases<T extends QualifyingInvoiceRow>(rows: T[]): T[] {
  const firstByCustomer = new Map<string, T>()
  for (const row of rows) {
    // A renewal order is never the "first purchase" under this policy.
    if (commissionKindForOrderType(row.orderType) !== "initial") continue
    const current = firstByCustomer.get(row.customerId)
    if (!current) {
      firstByCustomer.set(row.customerId, row)
      continue
    }
    const candidateAt = (row.paidAt || row.createdAt).getTime()
    const currentAt = (current.paidAt || current.createdAt).getTime()
    if (candidateAt < currentAt) firstByCustomer.set(row.customerId, row)
  }
  return Array.from(firstByCustomer.values())
}

export type CommissionTotals = {
  earned: number
  pending: number
  paid: number
  reversed: number
  count: number
}

export function emptyCommissionTotals(): CommissionTotals {
  return { earned: 0, pending: 0, paid: 0, reversed: 0, count: 0 }
}

/**
 * `earned` is gross commission (pending + paid). `reversed` is tracked
 * separately and is NOT subtracted from `earned`, so a report can always answer
 * "how much was generated" and "how much was clawed back" independently.
 */
export function sumCommissionTotals(rows: Array<{ amount?: unknown; status?: string | null }>): CommissionTotals {
  const totals = emptyCommissionTotals()
  for (const row of rows) {
    const amount = Number(row.amount || 0)
    if (!Number.isFinite(amount)) continue
    const status = String(row.status || "pending").toLowerCase()
    if (status === "pending") {
      totals.pending += amount
      totals.earned += amount
    } else if (status === "paid") {
      totals.paid += amount
      totals.earned += amount
    } else if (status === "reversed" || status === "cancelled") {
      totals.reversed += amount
    } else {
      continue
    }
    totals.count += 1
  }
  totals.pending = roundMoney(totals.pending)
  totals.paid = roundMoney(totals.paid)
  totals.earned = roundMoney(totals.earned)
  totals.reversed = roundMoney(totals.reversed)
  return totals
}

export type QualifyingInvoiceRow = {
  invoiceId: string
  invoiceNumber: string
  orderId: string
  orderNumber: string
  orderType: string | null
  orderStatus: string | null
  orderProvisioningStatus: string | null
  orderDeletedAt: Date | null
  orderIsActive: boolean | null
  customerId: string
  productId: string | null
  serviceId: string | null
  productName: string | null
  productSlug: string | null
  /** What the customer actually paid, GST included. Display only. */
  amount: number
  /** GST charged on this invoice. Shown separately, never used for commission. */
  taxAmount: number
  /**
   * The commission base: product amount after discount, BEFORE GST.
   *
   * Invoices satisfy `totalAmount = subtotal - discountAmount + taxAmount`, so
   * this is what remains once the tax the customer paid is removed. Taking a
   * percentage of `amount` instead would pay commission on tax the referrer
   * never received.
   */
  eligibleBaseAmount: number
  currency: string | null
  paidAt: Date | null
  createdAt: Date
  serviceActivatedAt: Date | null
  serviceRenewalDueAt: Date | null
  serviceNextRenewalAt: Date | null
  serviceBillingTermMonths: number | null
  serviceStatus: string | null
  serviceName: string | null
}

export const qualifyingInvoiceSelect = {
  id: true,
  invoiceNumber: true,
  orderId: true,
  status: true,
  type: true,
  deletedAt: true,
  subtotal: true,
  discountAmount: true,
  totalAmount: true,
  taxAmount: true,
  currency: true,
  paidAt: true,
  createdAt: true,
  customerId: true,
  order: {
    select: {
      id: true,
      orderNumber: true,
      orderType: true,
      status: true,
      provisioningStatus: true,
      deletedAt: true,
      isActive: true,
      productId: true,
      serviceId: true,
      product: { select: { id: true, name: true, slug: true } },
      vpsInstance: {
        select: {
          id: true,
          name: true,
          status: true,
          activatedAt: true,
          renewalDueAt: true,
          nextRenewalAt: true,
          billingTermMonths: true,
        },
      },
    },
  },
} as const

type RawQualifyingInvoice = {
  id: string
  invoiceNumber: string
  orderId: string | null
  status: string
  type: string
  deletedAt: Date | null
  subtotal: unknown
  discountAmount: unknown
  totalAmount: unknown
  taxAmount: unknown
  currency: string
  paidAt: Date | null
  createdAt: Date
  customerId: string
  order: {
    id: string
    orderNumber: string
    orderType: string | null
    status: string
    provisioningStatus: string
    deletedAt: Date | null
    isActive: boolean
    productId: string | null
    serviceId: string | null
    product: { id: string; name: string; slug: string } | null
    vpsInstance: {
      id: string
      name: string
      status: string
      activatedAt: Date | null
      renewalDueAt: Date | null
      nextRenewalAt: Date | null
      billingTermMonths: number | null
    } | null
  } | null
}

/**
 * Loads the authoritative qualifying transactions for a set of referred
 * customers. Revenue in every report is this number - never the customer's
 * registration date and never a client-side tally.
 */
export async function loadQualifyingInvoices(input: {
  customerIds: string[]
  start?: Date | null
  end?: Date | null
  take?: number
}): Promise<QualifyingInvoiceRow[]> {
  const ids = Array.from(new Set((input.customerIds || []).filter(Boolean)))
  if (!ids.length) return []

  const rows = await prisma.invoice.findMany({
    where: {
      customerId: { in: ids },
      ...paidServiceInvoiceWhere({ start: input.start ?? null, end: input.end ?? null, field: "paidAt" }),
    },
    select: qualifyingInvoiceSelect as any,
    orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
    ...(input.take ? { take: input.take } : {}),
  }) as unknown as RawQualifyingInvoice[]

  return rows.flatMap((row): QualifyingInvoiceRow[] => {
    const order = row.order
    if (!order) return []
    const service = order.vpsInstance || null
    return [{
      invoiceId: row.id,
      invoiceNumber: row.invoiceNumber,
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderType: order.orderType,
      orderStatus: order.status,
      orderProvisioningStatus: order.provisioningStatus,
      orderDeletedAt: order.deletedAt,
      orderIsActive: order.isActive,
      customerId: row.customerId,
      productId: order.productId,
      serviceId: service?.id || order.serviceId || null,
      productName: order.product?.name || null,
      productSlug: order.product?.slug || null,
      amount: Number(row.totalAmount || 0),
      taxAmount: Number(row.taxAmount || 0),
      eligibleBaseAmount: eligibleBaseFromInvoiceParts(row.subtotal, row.discountAmount, row.taxAmount, row.totalAmount),
      currency: row.currency || "INR",
      paidAt: row.paidAt,
      createdAt: row.createdAt,
      serviceActivatedAt: service?.activatedAt || null,
      serviceRenewalDueAt: service?.renewalDueAt || null,
      serviceNextRenewalAt: service?.nextRenewalAt || null,
      serviceBillingTermMonths: service?.billingTermMonths ?? null,
      serviceStatus: service?.status || null,
      serviceName: service?.name || null,
    }]
  })
}

export function commissionKindForOrderType(orderType: string | null | undefined): "initial" | "renewal" {
  const type = String(orderType || "").toLowerCase()
  if (type.includes("renewal") || type.includes("renew")) return "renewal"
  return "initial"
}

export function holdUntilFor(earnedAt: Date, holdDays: number): Date | null {
  const days = Math.max(0, Math.trunc(Number(holdDays) || 0))
  if (!days) return null
  return new Date(earnedAt.getTime() + days * 86_400_000)
}
