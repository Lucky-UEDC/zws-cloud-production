import type { NextRequest } from "next/server"
import { loadAdminReferralContext } from "@/lib/referrals/admin-http"
import { ok, serverError } from "@/lib/referrals/http"
import { adminReferrerRows } from "@/lib/referrals/service"
import { prisma } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Every referrer with their referral counts, conversion and earned commission. */
export async function GET(request: NextRequest) {
  const loaded = await loadAdminReferralContext(request)
  if (!loaded.ok) return loaded.response
  const { context } = loaded

  try {
    const page = await adminReferrerRows({ dataset: context.dataset, filters: context.filters, search: context.search })
    const [referrerCount, disabledCount] = await Promise.all([
      prisma.referralAccount.count(),
      prisma.referralAccount.count({ where: { status: { not: "active" } } }),
    ])

    return ok({
      referrers: page.rows,
      pagination: page.pagination,
      totals: {
        referrers: referrerCount,
        disabled: disabledCount,
      },
      truncated: page.truncated,
    })
  } catch (error) {
    console.error("[ADMIN_REFERRALS_REFERRERS]", error)
    return serverError()
  }
}