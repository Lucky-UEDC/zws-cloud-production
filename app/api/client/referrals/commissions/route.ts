import type { NextRequest } from "next/server"
import { applyClientCommissionFilters, loadClientReferralContext, ok, serverError, unauthorized } from "@/lib/referrals/http"
import { sumCommissionTotals } from "@/lib/referrals/commission"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Commission ledger rows for the signed-in referrer, scoped by session. */
export async function GET(request: NextRequest) {
  const loaded = await loadClientReferralContext(request)
  if (!loaded.ok) return loaded.response
  const { context } = loaded
  if (!context.scope.account) return unauthorized("Referral account is not available for this user")

  try {
    const page = applyClientCommissionFilters(context)
    const lifetimeTotals = sumCommissionTotals(
      context.dataset.transactions.map((row) => ({
        amount: row.commission.amount,
        status: row.commission.materialised ? row.commission.status : "pending",
      })),
    )
    return ok({
      commissions: page.rows.map((row) => ({
        referralId: row.referralId,
        orderId: row.orderId,
        orderNumber: row.orderNumber,
        invoiceNumber: row.invoiceNumber,
        referredCustomerName: row.referredCustomerName,
        serviceName: row.serviceName,
        productName: row.productName,
        purchaseDate: row.purchaseDate,
        billingPeriod: row.billingPeriod,
        baseAmount: row.amount,
        commission: row.commission,
      })),
      pagination: page.pagination,
      totals: lifetimeTotals,
      truncated: page.truncated,
    })
  } catch (error) {
    console.error("[CLIENT_REFERRALS_COMMISSIONS]", error)
    return serverError()
  }
}