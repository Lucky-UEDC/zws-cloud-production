import type { NextRequest } from "next/server"
import { loadAdminReferralContext } from "@/lib/referrals/admin-http"
import { ok, serverError } from "@/lib/referrals/http"
import { adminOrderList } from "@/lib/referrals/service"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Every qualifying referred order, with the service, period and commission. */
export async function GET(request: NextRequest) {
  const loaded = await loadAdminReferralContext(request)
  if (!loaded.ok) return loaded.response
  const { context } = loaded

  try {
    const page = adminOrderList({
      dataset: context.dataset,
      filters: context.filters,
      search: context.search,
    })
    return ok({
      orders: page.rows,
      pagination: page.pagination,
      truncated: page.truncated,
    })
  } catch (error) {
    console.error("[ADMIN_REFERRALS_ORDERS]", error)
    return serverError()
  }
}