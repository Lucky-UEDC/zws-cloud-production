/**
 * First-purchase commission award.
 *
 * This is the single place a referral commission is created. Everything else
 * - the reconciliation worker, an admin action, a payment webhook - goes
 * through here, so there is exactly one code path that can award money and one
 * set of rules it has to satisfy.
 *
 * The policy, in one place:
 *
 *   referral link opened          0
 *   account registered            0
 *   order created, unpaid         0
 *   payment failed or cancelled   0
 *   first qualifying VPS invoice  10% of the product amount before GST
 *   renewal or any later purchase 0
 *
 * "First" is decided by the earliest qualifying invoice for the referred
 * customer, so a replayed webhook that arrives later does not create a second
 * commission, and neither does a second worker.
 */

import { prisma } from "@/lib/db"
import {
  computeCommissionAmount,
  holdUntilFor,
  loadQualifyingInvoices,
  roundMoney,
  selectFirstQualifyingPurchases,
} from "@/lib/referrals/commission"
import { getReferralProgramRule } from "@/lib/referrals/program"
import { markVisitConverted } from "@/lib/referrals/visits"

export type AwardResult =
  | { status: "created"; commissionId: string; amount: number; baseAmount: number; gstAmount: number; ratePercent: number }
  | { status: "existing"; commissionId: string; amount: number; baseAmount: number; gstAmount: number; ratePercent: number }
  | { status: "not_qualified"; reason: string }
  | { status: "no_referral" }
  | { status: "program_inactive" }

/**
 * Awards the first-purchase commission for a referred customer, if one is due.
 *
 * Concurrency: the `referral_commissions (referral_id, kind)` unique index is
 * what actually guarantees a single award. The insert is attempted inside a
 * transaction and a unique-violation is treated as "someone else already
 * awarded it", not as a failure. That holds whether the callers are two
 * workers, a webhook and a worker, or the same webhook delivered twice.
 */
export async function awardFirstPurchaseCommission(input: {
  referredCustomerId: string
  /** Restricts the search to one invoice; defaults to the customer's earliest. */
  invoiceId?: string | null
}): Promise<AwardResult> {
  const referredCustomerId = String(input.referredCustomerId || "").trim()
  if (!referredCustomerId) return { status: "not_qualified", reason: "missing_customer" }

  const rule = await getReferralProgramRule()
  if (!rule.isActive) return { status: "program_inactive" }

  const referral = await prisma.referral.findUnique({
    where: { referredCustomerId },
    select: { id: true, referrerAccountId: true, referrerCustomerId: true, referredCustomerId: true, code: true },
  })
  if (!referral) return { status: "no_referral" }

  // Only paid, service, billable invoices count, and only the earliest one.
  const invoices = await loadQualifyingInvoices({ customerIds: [referredCustomerId] })
  const candidates = selectFirstQualifyingPurchases(invoices)
  const first = input.invoiceId
    ? candidates.find((row) => row.invoiceId === input.invoiceId) || candidates[0]
    : candidates[0]
  if (!first) return { status: "not_qualified", reason: "no_qualifying_invoice" }

  const baseAmount = roundMoney(first.eligibleBaseAmount)
  if (baseAmount <= 0) return { status: "not_qualified", reason: "no_eligible_base" }
  if (baseAmount < rule.minimumOrderAmount) return { status: "not_qualified", reason: "below_minimum_order_amount" }

  const amount = computeCommissionAmount(baseAmount, rule.commissionPercent)
  const gstAmount = roundMoney(first.taxAmount)
  const earnedAt = first.paidAt || first.createdAt

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Re-check inside the transaction. Two workers can both pass the check
      // above; only one can pass this one once the other has committed.
      const winner = await tx.referralCommission.findFirst({
        where: { referralId: referral.id, kind: "initial" },
        select: { id: true, amount: true, baseAmount: true, ratePercent: true, gstAmount: true },
      })
      if (winner) return { row: winner, isNew: false }

      const row = await tx.referralCommission.create({
        data: {
          referralId: referral.id,
          orderId: first.orderId,
          invoiceId: first.invoiceId,
          referrerAccountId: referral.referrerAccountId,
          referrerCustomerId: referral.referrerCustomerId,
          referredCustomerId: referral.referredCustomerId,
          productId: first.productId,
          serviceId: first.serviceId,
          kind: "initial",
          eligibleBaseAmount: baseAmount,
          gstAmount,
          totalPaidAmount: roundMoney(first.amount),
          baseAmount,
          // The rate actually applied is stored, so a later programme change
          // does not rewrite this historical commission.
          ratePercent: rule.commissionPercent,
          amount,
          currency: first.currency || "INR",
          status: "pending",
          earnedAt,
          holdUntil: holdUntilFor(earnedAt, rule.holdDays),
          metadata: {
            invoiceNumber: first.invoiceNumber,
            orderNumber: first.orderNumber,
            basis: "eligible_product_amount_before_gst",
            awardedVia: "awardFirstPurchaseCommission",
          },
        },
        select: { id: true, amount: true, baseAmount: true, ratePercent: true, gstAmount: true },
      })
      return { row, isNew: true }
    })

    // A paid qualifying purchase is what makes a referral "converted". Marked
    // here, after the award, so a signup alone can never read as a conversion.
    await markVisitConverted({ customerId: referredCustomerId, code: referral.code }).catch(() => 0)

    return {
      status: created.isNew ? "created" : "existing",
      commissionId: created.row.id,
      amount: roundMoney(created.row.amount),
      baseAmount: roundMoney(created.row.baseAmount),
      gstAmount: roundMoney(created.row.gstAmount ?? gstAmount),
      ratePercent: Number(created.row.ratePercent),
    }
  } catch (error: any) {
    // Lost the race at the database level. The winner's row is the answer.
    if (error?.code === "P2002") {
      const winner = await prisma.referralCommission.findFirst({
        where: { referralId: referral.id, kind: "initial" },
        select: { id: true, amount: true, baseAmount: true, ratePercent: true, gstAmount: true },
      })
      if (winner) {
        return {
          status: "existing",
          commissionId: winner.id,
          amount: roundMoney(winner.amount),
          baseAmount: roundMoney(winner.baseAmount),
          gstAmount: roundMoney(winner.gstAmount ?? gstAmount),
          ratePercent: Number(winner.ratePercent),
        }
      }
    }
    throw error
  }
}