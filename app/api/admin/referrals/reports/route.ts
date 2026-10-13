import type { NextRequest } from "next/server"
import { loadAdminReferralContext } from "@/lib/referrals/admin-http"
import { badRequest, ok, serverError } from "@/lib/referrals/http"
import {
  dailyReport,
  monthlyReport,
  referralStatusBreakdown,
  serviceReport,
  topReferrers,
  topReferredCustomers,
} from "@/lib/referrals/service"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const GROUPS = new Set(["month", "day", "service", "top_referrers", "top_customers"])

/** Grouped referral reporting for the admin reports tab. */
export async function GET(request: NextRequest) {
  const loaded = await loadAdminReferralContext(request)
  if (!loaded.ok) return loaded.response
  const { context } = loaded

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
    }

    if (group === "month") payload.monthly = monthlyReport(context.dataset)
    if (group === "day") payload.daily = dailyReport(context.dataset)
    if (group === "service") payload.services = serviceReport(context.dataset)
    if (group === "top_referrers") payload.referrers = topReferrers(context.dataset, 10)
    if (group === "top_customers") {
      payload.customers = topReferredCustomers(context.dataset, 10)
      payload.statusBreakdown = await referralStatusBreakdown(context.dataset)
    }

    return ok({ ...payload, truncated: context.dataset.truncated })
  } catch (error) {
    console.error("[ADMIN_REFERRALS_REPORTS]", error)
    return serverError()
  }
}