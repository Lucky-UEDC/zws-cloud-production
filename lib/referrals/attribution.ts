/**
 * Referral attribution.
 *
 * Attribution is first-touch and is enforced by the unique index on
 * `referrals.referred_customer_id`: a customer belongs to exactly one referrer
 * for life, so two referrers can never both claim the same revenue.
 *
 * Nothing here invents relationships. A referral row is only written when a
 * real referred customer is linked to a real referrer, either because the
 * customer signed up with a code or because an administrator recorded the
 * attribution explicitly.
 */

import { prisma } from "@/lib/db"
import { referralCodeCandidates, sanitizeReferralCodeInput } from "@/lib/referrals/program"

export type ReferralIdentity = {
  accountId: string
  customerId: string
  code: string
  status: string
  createdAt: Date
}

/** Returns the referrer's own referral account, creating it on first use. */
export async function ensureReferralAccount(customerId: string): Promise<ReferralIdentity | null> {
  const id = String(customerId || "").trim()
  if (!id) return null

  const existing = await prisma.referralAccount.findUnique({ where: { customerId: id } })
  if (existing) {
    return {
      accountId: existing.id,
      customerId: existing.customerId,
      code: existing.code,
      status: existing.status,
      createdAt: existing.createdAt,
    }
  }

  const candidates = referralCodeCandidates()
  for (const code of candidates) {
    try {
      const created = await prisma.referralAccount.create({
        data: { customerId: id, code, status: "active" },
      })
      return {
        accountId: created.id,
        customerId: created.customerId,
        code: created.code,
        status: created.status,
        createdAt: created.createdAt,
      }
    } catch (error: any) {
      // A unique-code collision means another account took this code; try the
      // next candidate. Anything else is a real failure and must surface.
      if (error?.code === "P2002") continue
      throw error
    }
  }
  return null
}

export async function findReferralAccountByCode(code: string): Promise<ReferralIdentity | null> {
  const normalized = sanitizeReferralCodeInput(code)
  if (!normalized) return null
  const row = await prisma.referralAccount.findUnique({ where: { code: normalized } })
  if (!row || row.status !== "active") return null
  return {
    accountId: row.id,
    customerId: row.customerId,
    code: row.code,
    status: row.status,
    createdAt: row.createdAt,
  }
}

export type CaptureReferralInput = {
  referredCustomerId: string
  code: string
  source?: "link" | "code" | "admin"
  notes?: string | null
  metadata?: Record<string, unknown>
}

export type CaptureReferralResult =
  | { status: "created"; referralId: string; referrerCustomerId: string }
  | { status: "existing"; referralId: string; referrerCustomerId: string }
  | { status: "self_referral" }
  | { status: "invalid_code" }
  | { status: "referrer_disabled" }

/**
 * Links a referred customer to the referrer who owns `code`.
 *
 * Returns `existing` (rather than throwing) when the customer is already
 * attributed, so re-submitting a signup form can never silently reassign
 * revenue from one referrer to another.
 */
export async function captureReferral(input: CaptureReferralInput): Promise<CaptureReferralResult> {
  const referredCustomerId = String(input.referredCustomerId || "").trim()
  if (!referredCustomerId) return { status: "invalid_code" }

  const referrer = await findReferralAccountByCode(input.code)
  if (!referrer) return { status: "invalid_code" }
  // The only self-referral test that means anything: the code's owner must not
  // be the customer being attributed. Possessing a referral account is normal
  // and is not evidence of a self-referral.
  if (referrer.customerId === referredCustomerId) return { status: "self_referral" }

  const existing = await prisma.referral.findUnique({ where: { referredCustomerId } })
  if (existing) {
    return { status: "existing", referralId: existing.id, referrerCustomerId: existing.referrerCustomerId }
  }

  try {
    const created = await prisma.referral.create({
      data: {
        referrerAccountId: referrer.accountId,
        referrerCustomerId: referrer.customerId,
        referredCustomerId,
        code: referrer.code,
        source: input.source || "link",
        status: "registered",
        registeredAt: new Date(),
        notes: input.notes ? String(input.notes).slice(0, 500) : null,
        metadata: (input.metadata || {}) as any,
      },
    })
    return { status: "created", referralId: created.id, referrerCustomerId: created.referrerCustomerId }
  } catch (error: any) {
    // Lost the race against a concurrent signup for the same customer. The
    // unique index is the source of truth, so report the winner.
    if (error?.code === "P2002") {
      const winner = await prisma.referral.findUnique({ where: { referredCustomerId } })
      if (winner) return { status: "existing", referralId: winner.id, referrerCustomerId: winner.referrerCustomerId }
    }
    throw error
  }
}

/** `/register?ref=CODE` and the shareable link a referrer hands out. */
export function buildReferralLink(origin: string, code: string): string {
  const base = String(origin || "").replace(/\/+$/, "")
  const normalized = sanitizeReferralCodeInput(code)
  if (!base || !normalized) return ""
  return `${base}/register?ref=${encodeURIComponent(normalized)}`
}