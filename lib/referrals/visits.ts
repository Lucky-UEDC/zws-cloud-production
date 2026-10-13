/**
 * Referral link visit tracking.
 *
 * The distinction this module exists to protect:
 *
 *   visit      - someone opened `/register?ref=CODE`
 *   signup     - a real customer account was created from that visit
 *   conversion - that customer made their first qualifying VPS purchase
 *
 * A click is worth nothing financially. It is recorded so the funnel can be
 * reported, and it must never create a customer or a commission.
 *
 * Attribution is first-touch and lives in a first-party httpOnly cookie. A
 * later link cannot silently overwrite it, because the cookie is only written
 * when there isn't already a valid one.
 */

import crypto from "node:crypto"
import { prisma } from "@/lib/db"
import { sanitizeReferralCodeInput } from "@/lib/referrals/program"
import { findReferralAccountByCode } from "@/lib/referrals/attribution"
import { startOfDayInAppTimezone } from "@/lib/referrals/filters"

export const REFERRAL_ATTRIBUTION_COOKIE = "zws_ref"
export const REFERRAL_ATTRIBUTION_DAYS = 30

export type Attribution = {
  code: string
  capturedAt: string
  visitorId: string
}

/** Stable per-browser id. Random, not derived from anything about the person. */
export function newVisitorId(): string {
  return crypto.randomBytes(16).toString("hex")
}

/** Visitor ids and IPs are hashed before they are stored. */
export function hashVisitor(value: string): string {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 32)
}

export function parseAttribution(raw: string | null | undefined): Attribution | null {
  const value = String(raw || "").trim()
  if (!value) return null
  const [code, capturedAt, visitorId] = value.split(".")
  const normalized = sanitizeReferralCodeInput(code)
  if (!normalized || !visitorId) return null
  const at = Number(capturedAt)
  if (!Number.isFinite(at) || at <= 0) return null
  // An attribution older than the window is ignored, so a stale cookie on a
  // shared machine cannot resurrect a months-old referral.
  if (Date.now() - at > REFERRAL_ATTRIBUTION_DAYS * 86_400_000) return null
  return { code: normalized, capturedAt: new Date(at).toISOString(), visitorId }
}

export function serializeAttribution(code: string, visitorId: string): string {
  return `${sanitizeReferralCodeInput(code)}.${Date.now()}.${visitorId}`
}

export type RecordVisitInput = {
  code: string
  visitorId: string
  landingPath?: string
  referrerHeader?: string | null
  userAgent?: string | null
  ip?: string | null
  country?: string | null
  /** The account being created, so a logged-in referrer's own click is refused. */
  viewerCustomerId?: string | null
}

export type RecordVisitResult = {
  status: "recorded" | "deduplicated" | "invalid_code" | "self_referral" | "rate_limited"
  visitId: string | null
  code: string
  referrerAccountId: string | null
  /** True when the caller should (re)write the attribution cookie. */
  setAttribution: boolean
}

/**
 * At most this many distinct visitors are recorded from one referral code
 * within a rolling hour. A bot hammering a link gets counted as a handful of
 * visits rather than thousands, and legitimate shared-network visitors are not
 * affected because they are deduplicated per visitor.
 */
const MAX_VISITS_PER_CODE_PER_HOUR = 60

/**
 * Records one visit, collapsing repeat opens within the same day.
 *
 * Dedupe is per (code, visitor, day): a customer refreshing the page, a browser
 * retrying a failed request, or a link-preview bot all collapse into the first
 * row instead of inflating the count.
 */
export async function recordReferralVisit(input: RecordVisitInput): Promise<RecordVisitResult> {
  const code = sanitizeReferralCodeInput(input.code)
  if (!code) return { status: "invalid_code", visitId: null, code: "", referrerAccountId: null, setAttribution: false }

  const referrer = await findReferralAccountByCode(code)
  if (!referrer) return { status: "invalid_code", visitId: null, code, referrerAccountId: null, setAttribution: false }

  // A referrer clicking their own link is not a referral.
  if (input.viewerCustomerId && input.viewerCustomerId === referrer.customerId) {
    return { status: "self_referral", visitId: null, code, referrerAccountId: referrer.accountId, setAttribution: false }
  }

  const visitorId = hashVisitor(input.visitorId)
  const visitDay = startOfDayInAppTimezone(new Date())
  const landingPath = String(input.landingPath || "/register").slice(0, 200)

  // Cheap click-spam guard, checked before writing so it costs nothing extra.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const recent = await (prisma as any).referralVisit.count({
    where: { referralCode: code, visitedAt: { gte: hourAgo } },
  }).catch(() => 0)
  if (Number(recent) >= MAX_VISITS_PER_CODE_PER_HOUR) {
    return { status: "rate_limited", visitId: null, code, referrerAccountId: referrer.accountId, setAttribution: false }
  }

  try {
    const created = await (prisma as any).referralVisit.create({
      data: {
        referralCode: code,
        referrerAccountId: referrer.accountId,
        visitorId,
        landingPath,
        referrerHeader: input.referrerHeader ? String(input.referrerHeader).slice(0, 300) : null,
        userAgentHash: input.userAgent ? hashVisitor(String(input.userAgent)) : null,
        ipHash: input.ip && input.ip !== "unknown" ? hashVisitor(input.ip) : null,
        country: input.country || null,
        visitDay,
      },
      select: { id: true },
    })
    return { status: "recorded", visitId: created.id, code, referrerAccountId: referrer.accountId, setAttribution: true }
  } catch (error: any) {
    if (error?.code === "P2002") {
      // Already counted today. Not an error: this is the normal path for a
      // refresh, a retry, or a repeated open of the same link.
      const existing = await (prisma as any).referralVisit.findFirst({
        where: { referralCode: code, visitorId, visitDay },
        select: { id: true },
      })
      return { status: "deduplicated", visitId: existing?.id || null, code, referrerAccountId: referrer.accountId, setAttribution: true }
    }
    throw error
  }
}

/**
 * Links a visitor's visit to the account they created, so a visit becomes a
 * registration.
 *
 * Only this visitor's own most recent unconverted visit for this code is
 * linked, and it is linked once. An existing attribution is never re-pointed
 * at a different customer.
 *
 * This sets `registeredAt`, not `convertedAt`: a signup is a registration, and
 * the purchase conversion is marked separately when a commission is actually
 * awarded.
 */
export async function attributeSignupToVisit(input: {
  customerId: string
  code: string
  visitorId: string | null
}): Promise<{ visitId: string | null; code: string | null; alreadyLinked: boolean }> {
  const code = sanitizeReferralCodeInput(input.code || "")
  if (!code || !input.visitorId) return { visitId: null, code: code || null, alreadyLinked: true }

  const visit = await (prisma as any).referralVisit.findFirst({
    where: {
      referralCode: code,
      visitorId: hashVisitor(input.visitorId),
      registeredAt: null,
    },
    orderBy: { visitedAt: "desc" },
    select: { id: true },
  }).catch(() => null)

  if (!visit) {
    // Either already registered from this browser, or never visited. Both mean
    // there is nothing new to link - never a second link.
    const existing = await (prisma as any).referralVisit.findFirst({
      where: { referralCode: code, visitorId: hashVisitor(input.visitorId), registeredAt: { not: null } },
      orderBy: { visitedAt: "desc" },
      select: { id: true },
    }).catch(() => null)
    return { visitId: existing?.id || null, code, alreadyLinked: true }
  }

  await (prisma as any).referralVisit.update({
    where: { id: visit.id },
    data: { registeredAt: new Date(), customerId: input.customerId },
  }).catch(() => null)

  return { visitId: visit.id, code, alreadyLinked: false }
}

/**
 * Marks the referral visit behind a referred customer as having converted,
 * once a qualifying purchase has actually been paid.
 *
 * Deliberately idempotent and guarded on `convertedAt: null`, so a replayed
 * webhook or a second worker cannot inflate a conversion count.
 */
export async function markVisitConverted(input: {
  customerId: string
  code: string
}): Promise<number> {
  const code = sanitizeReferralCodeInput(input.code || "")
  if (!code || !input.customerId) return 0
  const result = await (prisma as any).referralVisit.updateMany({
    where: { referralCode: code, customerId: input.customerId, convertedAt: null },
    data: { convertedAt: new Date() },
  }).catch(() => ({ count: 0 }))
  return Number(result.count || 0)
}

export type VisitSummary = {
  /** Unique visitors that opened the link. */
  visits: number
  /** Real accounts created from a tracked visit. */
  registeredAccounts: number
  /** Of those, the ones that went on to buy a VPS. */
  convertedCustomers: number
}

/**
 * Funnel counts for a set of referral codes. Clicks, signups and conversions
 * are counted separately and never derived from each other, so a click can
 * never inflate the registered or converted numbers.
 */
export async function summarizeVisits(codes: string[], options: { start?: Date | null; end?: Date | null } = {}): Promise<Map<string, VisitSummary>> {
  const unique = Array.from(new Set(codes.filter(Boolean)))
  const out = new Map<string, VisitSummary>()
  if (!unique.length) return out
  for (const code of unique) out.set(code, { visits: 0, registeredAccounts: 0, convertedCustomers: 0 })

  const rows = await (prisma as any).referralVisit.findMany({
    where: {
      referralCode: { in: unique },
      ...(options.start || options.end
        ? { visitedAt: { ...(options.start ? { gte: options.start } : {}), ...(options.end ? { lte: options.end } : {}) } }
        : {}),
    },
    select: { referralCode: true, registeredAt: true, convertedAt: true, customerId: true },
    take: 100_000,
  }).catch(() => [])

  for (const row of rows as any[]) {
    const entry = out.get(row.referralCode)
    if (!entry) continue
    entry.visits += 1
    // A visit counts as a registration only once an account is really attached,
    // and as a conversion only once that account has actually paid.
    if (row.registeredAt && row.customerId) entry.registeredAccounts += 1
    if (row.convertedAt) entry.convertedCustomers += 1
  }
  return out
}