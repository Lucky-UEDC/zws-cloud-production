import type { NextRequest } from "next/server"
import { loadAdminReferralContext } from "@/lib/referrals/admin-http"
import { ok, serverError } from "@/lib/referrals/http"
import { adminReferralRelations } from "@/lib/referrals/service"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Referrer -> referred customer relationships with dates, services and money. */
export async function GET(request: NextRequest) {
  const loaded = await loadAdminReferralContext(request)
  if (!loaded.ok) return loaded.response
  const { context } = loaded

  try {
    const page = adminReferralRelations({
      dataset: context.dataset,
      filters: context.filters,
      search: context.search,
    })
    return ok({
      referrals: page.rows,
      pagination: page.pagination,
      truncated: page.truncated,
    })
  } catch (error) {
    console.error("[ADMIN_REFERRALS_RELATIONSHIPS]", error)
    return serverError()
  }
}