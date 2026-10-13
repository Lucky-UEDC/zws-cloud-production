import type { NextRequest } from "next/server"
import { badRequest, loadAdminIdentity, safeSearch, unauthorized } from "@/lib/referrals/http"
import { resolveReferralWindow } from "@/lib/referrals/filters"
import { buildReferralDataset, fetchReferralSources, referralFiltersFromParams } from "@/lib/referrals/service"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export type AdminReferralContext = {
  admin: { sub?: string | null; email: string; role?: string | null }
  filters: ReturnType<typeof referralFiltersFromParams>
  window: ReturnType<typeof resolveReferralWindow>
  dataset: Awaited<ReturnType<typeof buildReferralDataset>>
  search: string
}

export type AdminReferralContextResult =
  | { ok: true; context: AdminReferralContext }
  | { ok: false; response: Response }

/**
 * Admin dataset builder.
 *
 * Same queries as the client side, unscoped and with unmasked customer contact
 * details, because an authorised operator is allowed to see who their referrers
 * brought in. The caller is gated by the platform's existing admin RBAC
 * (`canAccessAdminApi`) before a single row is read.
 */
export async function loadAdminReferralContext(request: NextRequest): Promise<AdminReferralContextResult> {
  const admin = await loadAdminIdentity(request)
  if (!admin) return { ok: false, response: unauthorized("Administrator authorization required") }

  const search = safeSearch(request.nextUrl.searchParams.get("search") || request.nextUrl.searchParams.get("q") || "")
  if (!search.ok) return { ok: false, response: badRequest(search.message) }

  const filters = referralFiltersFromParams(request.nextUrl.searchParams)
  filters.search = search.value
  const window = resolveReferralWindow({ range: filters.range, start: filters.start, end: filters.end })

  const sources = await fetchReferralSources({
    referrerCustomerId: filters.referrerCustomerId || null,
    referredCustomerId: filters.referredCustomerId || null,
  })
  const dataset = await buildReferralDataset({
    sources: sources.sources,
    window,
    maskEmails: false,
    truncated: sources.truncated,
    referralTotal: sources.total,
    productId: filters.productId,
    commissionStatus: filters.commissionStatus,
  })

  return {
    ok: true,
    context: {
      admin: { sub: admin.sub || null, email: admin.email, role: admin.role || null },
      filters,
      window,
      dataset,
      search: search.value,
    },
  }
}