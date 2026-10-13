import type { NextRequest } from "next/server"
import { badRequest, loadClientReferralContext, ok, serverError, unauthorized } from "@/lib/referrals/http"
import { dailyReport, monthlyReport, serviceReport } from "@/lib/referrals/service"
import { clientSummary } from "@/lib/referrals/service"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const GROUPS = new Set(["month", "day", "service"])

/** Monthly, daily and service-wise referral performance for the referrer. */
export async function GET(request: NextRequest) {
  const loaded = await loadClientReferralContext(request)
  if (!loaded.ok) return loaded.response
  const { context } = loaded
  if (!context.scope.account) return unauthorized("Referral account is not available for this user")

  const group = String(request.nextUrl.searchParams.get("group") || "month").toLowerCase()
  if (!GROUPS.has(group)) return badRequest("Unsupported report group")

  try {
    const payload: Record<string, unknown> = {
      group,
      window: {
        range: context.window.range,
        start: context.window.start ? context.window.start.toISOString() : null,
        end: context.window.end ? context.window.end.toISOString() : null,
      },
      summary: clientSummary(context.dataset),
    }

    if (group === "month") payload.monthly = monthlyReport(context.dataset)
    if (group === "day") payload.daily = dailyReport(context.dataset)
    if (group === "service") payload.services = serviceReport(context.dataset)

    return ok(payload)
  } catch (error) {
    console.error("[CLIENT_REFERRALS_REPORTS]", error)
    return serverError()
  }
}