import type { NextRequest } from "next/server"
import { applyClientCustomerFilters, loadClientReferralContext, ok, serverError, unauthorized } from "@/lib/referrals/http"
import { sortTransactions } from "@/lib/referrals/reporting"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Referred customers for the signed-in referrer.
 *
 * Emails are masked (see `maskEmailForReferrer`): a referrer needs enough to
 * recognise who signed up, not the full contact record of another customer.
 */
export async function GET(request: NextRequest) {
  const loaded = await loadClientReferralContext(request)
  if (!loaded.ok) return loaded.response
  const { context } = loaded
  if (!context.scope.account) return unauthorized("Referral account is not available for this user")

  try {
    const page = applyClientCustomerFilters(context)

    // One recent qualifying transaction per referred customer, so the customer
    // list can answer "what did they last buy, and in which month".
    const latestByCustomer = new Map<string, ReturnType<typeof sortTransactions>[number]>()
    for (const row of context.dataset.transactions) {
      const current = latestByCustomer.get(row.referredCustomerId)
      if (!current || new Date(row.purchaseDate).getTime() > new Date(current.purchaseDate).getTime()) {
        latestByCustomer.set(row.referredCustomerId, row)
      }
    }

    return ok({
      customers: page.rows.map((row) => ({
        ...row,
        latestTransaction: latestByCustomer.get(row.referredCustomerId) || null,
      })),
      pagination: page.pagination,
      truncated: page.truncated,
    })
  } catch (error) {
    console.error("[CLIENT_REFERRALS_CUSTOMERS]", error)
    return serverError()
  }
}