/**
 * Commission ledger synchronisation.
 *
 * Reports never depend on this having run - they fall back to computing the
 * commission live from the programme rate - but materialising the ledger is
 * what makes "paid" and "reversed" durable, auditable states rather than a
 * derived guess.
 *
 * The reconciler is idempotent and only ever writes rows that correspond to a
 * real qualifying transaction:
 *   create  - a paid service invoice on a referred customer's billable order
 *   update  - a row that is still pending whose base amount or rate drifted
 *   reverse - a row whose transaction stopped qualifying (cancelled, refunded,
 *             deleted) so the money stops counting as payable
 */

import { prisma } from "@/lib/db"
import {
  computeCommissionAmount,
  holdUntilFor,
  loadQualifyingInvoices,
  roundMoney,
  selectFirstQualifyingPurchases,
  type QualifyingInvoiceRow,
} from "@/lib/referrals/commission"
import { getReferralProgramRule } from "@/lib/referrals/program"

export type SyncResult = {
  scanned: number
  created: number
  updated: number
  reversed: number
  skipped: number
  errors: string[]
}

export type SyncScope = {
  start?: Date | null
  end?: Date | null
  /** Narrow to one referrer; admin can leave it unset to reconcile everything. */
  referralId?: string | null
  referrerAccountId?: string | null
  referrerCustomerId?: string | null
  limit?: number
}

async function qualifyingCustomersInScope(scope: SyncScope): Promise<string[]> {
  const where: Record<string, any> = {}
  if (scope.referralId) where.id = scope.referralId
  if (scope.referrerAccountId) where.referrerAccountId = scope.referrerAccountId
  if (scope.referrerCustomerId) where.referrerCustomerId = scope.referrerCustomerId
  const rows = await prisma.referral.findMany({
    where,
    select: { referredCustomerId: true },
    orderBy: { registeredAt: "desc" },
    take: Math.max(1, Math.min(5000, scope.limit || 5000)),
  })
  return Array.from(new Set(rows.map((row) => row.referredCustomerId)))
}

async function referralMapFor(customerIds: string[]) {
  const rows = await prisma.referral.findMany({
    where: { referredCustomerId: { in: customerIds } },
    select: {
      id: true,
      referrerAccountId: true,
      referrerCustomerId: true,
      referredCustomerId: true,
    },
  })
  return new Map(rows.map((row) => [row.referredCustomerId, row]))
}

export async function syncReferralCommissions(scope: SyncScope = {}): Promise<SyncResult> {
  const result: SyncResult = { scanned: 0, created: 0, updated: 0, reversed: 0, skipped: 0, errors: [] }
  const rule = await getReferralProgramRule()
  if (!rule.isActive) {
    // A disabled programme still records that revenue happened; it just earns
    // nothing. Writing zero-value rows would be noise, so nothing is created.
    return result
  }

  const customerIds = await qualifyingCustomersInScope(scope)
  if (!customerIds.length) return result

  const invoices = await loadQualifyingInvoices({ customerIds, start: scope.start ?? null, end: scope.end ?? null })
  if (!invoices.length) return result

  const referrals = await referralMapFor(customerIds)
  result.scanned = invoices.length

  // First-purchase policy: only the earliest qualifying initial order per
  // referred customer is commissionable. Renewals and later purchases are
  // counted as scanned but earn nothing.
  const commissionable = selectFirstQualifyingPurchases(invoices)

  const orderIds = commissionable.map((row) => row.orderId).filter((value): value is string => Boolean(value))
  const existing = orderIds.length
    ? await prisma.referralCommission.findMany({ where: { orderId: { in: orderIds } } })
    : []
  const existingByOrder = new Map(existing.map((row) => [row.orderId, row]))

  for (const invoice of commissionable) {
    const referral = referrals.get(invoice.customerId)
    if (!referral || !invoice.orderId) {
      result.skipped += 1
      continue
    }
    // Commission is a percentage of the product amount before GST.
    const baseAmount = roundMoney(invoice.eligibleBaseAmount)
    if (baseAmount < rule.minimumOrderAmount || baseAmount <= 0) {
      result.skipped += 1
      continue
    }
    const amount = computeCommissionAmount(baseAmount, rule.commissionPercent)
    const earnedAt = invoice.paidAt || invoice.createdAt
    const current = existingByOrder.get(invoice.orderId)

    try {
      if (!current) {
        await prisma.referralCommission.create({
          data: {
            referralId: referral.id,
            orderId: invoice.orderId,
            invoiceId: invoice.invoiceId,
            referrerAccountId: referral.referrerAccountId,
            referrerCustomerId: referral.referrerCustomerId,
            referredCustomerId: referral.referredCustomerId,
            productId: invoice.productId,
            serviceId: invoice.serviceId,
            kind: "initial",
            eligibleBaseAmount: baseAmount,
            gstAmount: roundMoney(invoice.taxAmount),
            totalPaidAmount: roundMoney(invoice.amount),
            baseAmount,
            ratePercent: rule.commissionPercent,
            amount,
            currency: invoice.currency || "INR",
            status: "pending",
            earnedAt,
            holdUntil: holdUntilFor(earnedAt, rule.holdDays),
            metadata: {
              invoiceNumber: invoice.invoiceNumber,
              orderNumber: invoice.orderNumber,
              basis: "eligible_product_amount_before_gst",
              syncedFrom: "referral_commission_sync",
            },
          },
        })
        result.created += 1
        continue
      }

      if (current.status !== "pending") {
        // Paid and reversed rows are historical facts; never rewrite them.
        result.skipped += 1
        continue
      }

      const sameBase = roundMoney(current.baseAmount) === baseAmount
      const sameRate = Number(current.ratePercent) === rule.commissionPercent
      const sameAmount = roundMoney(current.amount) === amount
      if (sameBase && sameRate && sameAmount) {
        result.skipped += 1
        continue
      }

      await prisma.referralCommission.update({
        where: { id: current.id },
        data: {
          invoiceId: invoice.invoiceId,
          productId: invoice.productId,
          serviceId: invoice.serviceId,
          eligibleBaseAmount: baseAmount,
          gstAmount: roundMoney(invoice.taxAmount),
          totalPaidAmount: roundMoney(invoice.amount),
          baseAmount,
          ratePercent: rule.commissionPercent,
          amount,
          earnedAt,
          holdUntil: holdUntilFor(earnedAt, rule.holdDays),
        },
      })
      result.updated += 1
    } catch (error: any) {
      // The unique constraints on (order_id) and (referral_id, kind) are the
      // real guarantee against a duplicate webhook or two workers racing. The
      // loser of that race is skipped, not an error.
      if (error?.code === "P2002") {
        result.skipped += 1
        continue
      }
      result.errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  return result
}

/**
 * Reverses pending commissions whose transaction stopped qualifying.
 *
 * This is what keeps a cancelled or refunded order from leaving a payable
 * commission behind. Rows already marked paid are left alone - clawing back
 * money that was already paid is an operator decision, recorded explicitly
 * through the admin reversal endpoint.
 */
export async function reverseStaleReferralCommissions(scope: SyncScope = {}): Promise<{ reversed: number; checked: number; errors: string[] }> {
  const out = { reversed: 0, checked: 0, errors: [] as string[] }
  const customerIds = await qualifyingCustomersInScope(scope)
  if (!customerIds.length) return out

  const rows = await prisma.referralCommission.findMany({
    where: {
      referredCustomerId: { in: customerIds },
      status: "pending",
      ...(scope.start || scope.end
        ? { earnedAt: { ...(scope.start ? { gte: scope.start } : {}), ...(scope.end ? { lte: scope.end } : {}) } }
        : {}),
    },
    select: { id: true, orderId: true },
    take: 5000,
  })
  if (!rows.length) return out
  out.checked = rows.length

  const invoices = await loadQualifyingInvoices({ customerIds, start: scope.start ?? null, end: scope.end ?? null })
  const qualifyingOrders = new Set(
    (invoices as QualifyingInvoiceRow[]).map((row) => row.orderId).filter((value): value is string => Boolean(value)),
  )

  for (const row of rows) {
    if (qualifyingOrders.has(row.orderId)) continue
    try {
      await prisma.referralCommission.update({
        where: { id: row.id },
        data: {
          status: "reversed",
          reversedAt: new Date(),
          reversalReason: "Transaction no longer qualifies (cancelled, refunded or deleted)",
        },
      })
      out.reversed += 1
    } catch (error) {
      out.errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  return out
}

export async function syncAndReverse(scope: SyncScope = {}) {
  const synced = await syncReferralCommissions(scope)
  const reversed = await reverseStaleReferralCommissions(scope)
  return {
    synced,
    reversed: reversed.reversed,
    reversedChecked: reversed.checked,
    errors: [...synced.errors, ...reversed.errors],
  }
}