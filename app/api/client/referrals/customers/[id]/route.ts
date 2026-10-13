import type { NextRequest } from "next/server"
import { getClientFromRequest } from "@/lib/server-auth"
import { prisma } from "@/lib/db"
import { buildPaginationMeta, normalizePagination, normalizeReferralSearch, resolveReferralWindow } from "@/lib/referrals/filters"
import { buildReferralDataset, fetchReferralSources, getClientReferralScope } from "@/lib/referrals/service"
import { maskEmailForReferrer } from "@/lib/referrals/reporting"
import { notFound, ok, serverError, unauthorized } from "@/lib/referrals/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Detail for one referred customer: profile, live service state, and the full
 * qualifying order history.
 *
 * IDOR protection: the caller never proves ownership by knowing an id, they
 * prove it with their session. Ownership is checked in a single query that
 * requires BOTH this session's referral account and the requested customer,
 * so a guessed id belonging to another referrer matches nothing and returns
 * 404 rather than somebody's data.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getClientFromRequest(request)
  const customerId = String(session?.sub || "")
  if (!customerId) return unauthorized()

  const { id } = await params
  const referredCustomerId = String(id || "").trim()
  if (!referredCustomerId) return notFound()

  try {
    const scope = await getClientReferralScope(customerId)
    if (!scope.account) return unauthorized("Referral account is not available for this user")

    const owned = await prisma.referral.findFirst({
      where: { referredCustomerId, referrerAccountId: scope.account.accountId },
      select: { id: true },
    })
    if (!owned) return notFound()

    const window = resolveReferralWindow({ range: "all" })
    const sources = await fetchReferralSources({
      referrerAccountId: scope.account.accountId,
      referredCustomerId,
      limit: 1,
    })
    const dataset = await buildReferralDataset({
      sources: sources.sources,
      window,
      maskEmails: true,
      truncated: false,
      referralTotal: sources.total,
    })

    const customer = dataset.customers[0]
    if (!customer) return notFound()

    const search = normalizeReferralSearch(request.nextUrl.searchParams.get("search") || "").toLowerCase()
    const page = normalizePagination({
      page: request.nextUrl.searchParams.get("page"),
      pageSize: request.nextUrl.searchParams.get("pageSize"),
    })

    const orders = dataset.transactions
      .filter((row) => (search
        ? [row.orderNumber, row.orderId, row.invoiceNumber, row.productName, row.serviceName || ""]
          .some((value) => String(value || "").toLowerCase().includes(search))
        : true))
      .sort((a, b) => new Date(b.purchaseDate).getTime() - new Date(a.purchaseDate).getTime())

    return ok({
      customer: { ...customer, email: maskEmailForReferrer(customer.email) },
      orders: orders.slice(page.skip, page.skip + page.take),
      pagination: buildPaginationMeta({ page: page.page, pageSize: page.pageSize, total: orders.length }),
    })
  } catch (error) {
    console.error("[CLIENT_REFERRAL_CUSTOMER_DETAIL]", error)
    return serverError()
  }
}