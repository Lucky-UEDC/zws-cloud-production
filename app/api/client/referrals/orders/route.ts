import type { NextRequest } from "next/server"
import { applyClientOrderFilters, loadClientReferralContext, ok, serverError, unauthorized } from "@/lib/referrals/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * The referred-customer order history, one row per qualifying transaction.
 *
 * Each row answers, for a single order: which customer, which service, which
 * order id, which date it was bought, which billing month it was paid for,
 * how much, whether the money arrived, whether the service is live, and how
 * much commission that transaction earned.
 */
export async function GET(request: NextRequest) {
  const loaded = await loadClientReferralContext(request)
  if (!loaded.ok) return loaded.response
  const { context } = loaded
  if (!context.scope.account) return unauthorized("Referral account is not available for this user")

  try {
    const page = applyClientOrderFilters(context)
    return ok({ orders: page.rows, pagination: page.pagination, truncated: page.truncated })
  } catch (error) {
    console.error("[CLIENT_REFERRALS_ORDERS]", error)
    return serverError()
  }
}