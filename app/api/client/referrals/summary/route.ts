import type { NextRequest } from "next/server"
import { loadClientReferralContext, ok, serverError, unauthorized } from "@/lib/referrals/http"
import { clientSummary } from "@/lib/referrals/service"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const loaded = await loadClientReferralContext(request)
  if (!loaded.ok) return loaded.response
  const { context } = loaded

  if (!context.scope.account) {
    return unauthorized("Referral account is not available for this user")
  }

  try {
    return ok({
      account: {
        code: context.scope.account.code,
        status: context.scope.account.status,
        createdAt: context.scope.account.createdAt.toISOString(),
      },
      referralLink: context.scope.referralLink,
      program: {
        commissionPercent: context.scope.program.commissionPercent,
        holdDays: context.scope.program.holdDays,
        minimumOrderAmount: context.scope.program.minimumOrderAmount,
        isActive: context.scope.program.isActive,
      },
      window: {
        range: context.window.range,
        start: context.window.start ? context.window.start.toISOString() : null,
        end: context.window.end ? context.window.end.toISOString() : null,
      },
      summary: clientSummary(context.dataset),
    })
  } catch (error) {
    console.error("[CLIENT_REFERRALS_SUMMARY]", error)
    return serverError()
  }
}