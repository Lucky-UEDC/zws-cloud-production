import { NextResponse, type NextRequest } from "next/server"
import { prisma } from "@/lib/db"
import { getClientFromRequest } from "@/lib/server-auth"
import { getRequestContext } from "@/lib/request-context"
import { sanitizeReferralCodeInput } from "@/lib/referrals/program"
import {
  REFERRAL_ATTRIBUTION_COOKIE,
  REFERRAL_ATTRIBUTION_DAYS,
  newVisitorId,
  parseAttribution,
  recordReferralVisit,
  serializeAttribution,
} from "@/lib/referrals/visits"
import { requireSameOriginOrCsrf } from "@/lib/auth/guards"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Records that a referral link was opened.
 *
 * Reached by GET so a link can be opened in any browser and by any preview
 * bot without side effects beyond one counted visit. It is deliberately
 * unauthenticated - the visitor has no account yet - but it accepts nothing
 * from the caller except a referral code it validates itself:
 *
 *   - the code must resolve to a real, active referral account
 *   - the visitor identity is generated here, not taken from the request
 *   - no customer id is accepted, so a caller cannot claim a visit belongs to
 *     somebody else's account
 *   - a referrer clicking their own link is refused
 *
 * The attribution cookie is only written when there is not already a valid
 * first-touch attribution, so opening a second link cannot reassign revenue.
 */
export async function GET(request: NextRequest) {
  const rawCode = request.nextUrl.searchParams.get("ref") || request.nextUrl.searchParams.get("referral") || ""
  const code = sanitizeReferralCodeInput(rawCode)

  if (!code) {
    return NextResponse.json({ success: false, error: "Invalid referral code" }, { status: 400 })
  }

  const context = await getRequestContext(request)
  const cookies = request.cookies
  const existing = parseAttribution(cookies.get(REFERRAL_ATTRIBUTION_COOKIE)?.value)

  // First-touch wins: a later link never overwrites a valid attribution.
  const visitorId = existing?.visitorId || newVisitorId()
  const keepExisting = Boolean(existing)

  const viewer = await getClientFromRequest(request).catch(() => null)

  try {
    const result = await recordReferralVisit({
      code,
      visitorId,
      landingPath: "/register",
      referrerHeader: request.headers.get("referer")?.slice(0, 300) || null,
      userAgent: request.headers.get("user-agent"),
      ip: context.ip,
      country: context.country,
      viewerCustomerId: viewer?.sub ? String(viewer.sub) : null,
    })

    const response = NextResponse.json({
      success: result.status === "recorded",
      status: result.status,
      // The visitor never learns who owns the code beyond the fact that it is
      // valid, and never learns anything about that account.
      valid: result.status === "recorded" || result.status === "deduplicated",
    })

    if (!keepExisting && (result.status === "recorded" || result.status === "deduplicated")) {
      response.cookies.set(REFERRAL_ATTRIBUTION_COOKIE, serializeAttribution(code, visitorId), {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: REFERRAL_ATTRIBUTION_DAYS * 86_400,
      })
    }

    return response
  } catch (error) {
    console.error("[REFERRAL_VISIT]", error)
    return NextResponse.json({ success: false, error: "Unable to record referral visit" }, { status: 500 })
  }
}

/**
 * Reports the current first-touch attribution for this browser.
 *
 * Used by the registration form so it can show the referrer it is signing up
 * through. Returns the code only after the server confirms the account still
 * exists and is active, so a revoked referral cannot be shown as valid.
 */
export async function POST(request: NextRequest) {
  const csrf = await requireSameOriginOrCsrf(request)
  if (!csrf.ok) return csrf.response

  const attribution = parseAttribution(request.cookies.get(REFERRAL_ATTRIBUTION_COOKIE)?.value)
  if (!attribution) return NextResponse.json({ success: true, attributed: false })

  const account = await prisma.referralAccount
    .findUnique({ where: { code: attribution.code }, select: { status: true, customerId: true } })
    .catch(() => null)

  const viewer = await getClientFromRequest(request).catch(() => null)
  const selfReferral = Boolean(viewer?.sub && account && String(viewer.sub) === account.customerId)

  return NextResponse.json({
    success: true,
    attributed: Boolean(account && account.status === "active" && !selfReferral),
    code: account && account.status === "active" && !selfReferral ? attribution.code : null,
    capturedAt: attribution.capturedAt,
  })
}