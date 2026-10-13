/**
 * Shared plumbing for the referral HTTP routes.
 *
 * Two invariants live here so neither the client routes nor the admin routes
 * can forget them:
 *
 *  - a client request is scoped by the session, never by a query parameter
 *  - an admin request must clear the existing RBAC gate for the platform
 */

import { NextResponse, type NextRequest } from "next/server"
import { getClientFromRequest, getAdminFromRequest } from "@/lib/server-auth"
import { canAccessAdminApi } from "@/lib/admin-rbac"
import { NO_CACHE_HEADERS } from "@/lib/http-cache"
import { resolveReferralWindow, normalizeReferralStatus, type ReferralWindow } from "@/lib/referrals/filters"
import {
  buildReferralDataset,
  clientCommissionList,
  clientCustomerList,
  clientOrderList,
  fetchReferralSources,
  getClientReferralScope,
  referralFiltersFromParams,
  type ReferralDataset,
  type ReferralFilters,
} from "@/lib/referrals/service"
import { validateSecurityField } from "@/lib/security/input"

export const NO_STORE = NO_CACHE_HEADERS

export function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ success: false, error: message }, { status: 401, headers: NO_STORE })
}

export function forbidden(message = "You do not have access to this data") {
  return NextResponse.json({ success: false, error: message }, { status: 403, headers: NO_STORE })
}

export function badRequest(message: string) {
  return NextResponse.json({ success: false, error: message }, { status: 400, headers: NO_STORE })
}

/**
 * Used for both "does not exist" and "not yours". Returning the same status
 * for both keeps an attacker from using the endpoint to discover which
 * referral ids are real.
 */
export function notFound(message = "Referral not found") {
  return NextResponse.json({ success: false, error: message }, { status: 404, headers: NO_STORE })
}

export function serverError(message = "Unable to load referral data") {
  return NextResponse.json({ success: false, error: message }, { status: 500, headers: NO_STORE })
}

export function ok<T extends Record<string, unknown>>(payload: T, status = 200) {
  return NextResponse.json({ success: true, ...payload }, { status, headers: NO_STORE })
}

/** Search terms go through the same payload detector the admin lists use. */
export function safeSearch(value: string): { ok: true; value: string } | { ok: false; message: string } {
  const result = validateSecurityField(value, "search", "Search")
  if (!result.ok) return { ok: false, message: result.error || "Invalid search query" }
  return { ok: true, value: result.value }
}

export type ClientReferralContext = {
  customerId: string
  filters: ReferralFilters
  window: ReferralWindow
  dataset: ReferralDataset
  scope: Awaited<ReturnType<typeof getClientReferralScope>>
}

/**
 * Resolves the caller's own referral dataset. There is no branch here that
 * could widen the scope: the only referrer id used is the one derived from the
 * session's customer id.
 */
export async function loadClientReferralContext(
  request: NextRequest,
): Promise<{ ok: true; context: ClientReferralContext } | { ok: false; response: NextResponse }> {
  const session = await getClientFromRequest(request)
  const customerId = String(session?.sub || "")
  if (!customerId) return { ok: false, response: unauthorized() }

  const search = safeSearch(request.nextUrl.searchParams.get("search") || request.nextUrl.searchParams.get("q") || "")
  if (!search.ok) return { ok: false, response: badRequest(search.message) }

  const filters = referralFiltersFromParams(request.nextUrl.searchParams)
  filters.search = search.value
  const window = resolveReferralWindow({ range: filters.range, start: filters.start, end: filters.end })

  const scope = await getClientReferralScope(customerId)
  const sources = scope.account
    ? await fetchReferralSources({ referrerAccountId: scope.account.accountId })
    : { sources: [], total: 0, truncated: false }

  const dataset = await buildReferralDataset({
    sources: sources.sources,
    window,
    maskEmails: true,
    truncated: sources.truncated,
    referralTotal: sources.total,
  })

  return { ok: true, context: { customerId, filters, window, dataset, scope } }
}

export function applyClientCustomerFilters(context: ClientReferralContext) {
  return clientCustomerList({
    dataset: context.dataset,
    filters: context.filters,
    status: normalizeReferralStatus(context.filters.status),
    search: context.filters.search,
  })
}

export function applyClientOrderFilters(context: ClientReferralContext) {
  return clientOrderList({ dataset: context.dataset, filters: context.filters, search: context.filters.search })
}

export function applyClientCommissionFilters(context: ClientReferralContext) {
  return clientCommissionList({
    dataset: context.dataset,
    filters: context.filters,
    search: context.filters.search,
    referrerCustomerId: context.customerId,
  })
}

export async function loadAdminIdentity(request: NextRequest): Promise<{ sub?: string; email: string; role?: string } | null> {
  const admin = await getAdminFromRequest(request)
  if (!admin?.email || !canAccessAdminApi(admin.role)) return null
  return { sub: admin.sub, email: admin.email, role: admin.role }
}
