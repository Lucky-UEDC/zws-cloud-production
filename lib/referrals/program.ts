/**
 * Referral programme configuration.
 *
 * The commission percentage, the hold window and the minimum qualifying order
 * amount live in `referral_programs` so an operator can change the rule without
 * a deploy. `referral_commissions.rate_percent` stores the rate that was
 * actually applied to a transaction, so changing the rule never rewrites
 * history.
 */

import { prisma } from "@/lib/db"
import { normalizeReferralSearch } from "@/lib/referrals/filters"

export const DEFAULT_REFERRAL_PROGRAM = {
  id: "default",
  name: "Default",
  isActive: true,
  commissionPercent: 10,
  holdDays: 30,
  minimumOrderAmount: 0,
  allowSelfReferral: false,
} as const

export type ReferralProgramRule = {
  id: string
  name: string
  isActive: boolean
  commissionPercent: number
  holdDays: number
  minimumOrderAmount: number
  allowSelfReferral: boolean
}

function clampPercent(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_REFERRAL_PROGRAM.commissionPercent
  return Math.min(100, Math.max(0, Number(parsed.toFixed(2))))
}

function clampMoney(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_REFERRAL_PROGRAM.minimumOrderAmount
  return Number(parsed.toFixed(2))
}

export function normalizeReferralProgramRule(input: Partial<ReferralProgramRule> | null | undefined): ReferralProgramRule {
  return {
    id: String(input?.id || DEFAULT_REFERRAL_PROGRAM.id),
    name: String(input?.name || DEFAULT_REFERRAL_PROGRAM.name).slice(0, 120),
    isActive: input?.isActive === undefined ? DEFAULT_REFERRAL_PROGRAM.isActive : Boolean(input.isActive),
    commissionPercent: clampPercent(input?.commissionPercent),
    holdDays: Math.min(365, Math.max(0, Math.trunc(Number(input?.holdDays ?? DEFAULT_REFERRAL_PROGRAM.holdDays)) || 0)),
    minimumOrderAmount: clampMoney(input?.minimumOrderAmount),
    allowSelfReferral: input?.allowSelfReferral === undefined
      ? DEFAULT_REFERRAL_PROGRAM.allowSelfReferral
      : Boolean(input.allowSelfReferral),
  }
}

let cachedRule: { value: ReferralProgramRule; expiresAt: number } | null = null
const CACHE_TTL_MS = 30_000

/**
 * Returns the live rule, or the shipped default when no programme row exists
 * yet. Callers must handle `isActive === false`: a disabled programme earns
 * nothing but referral attribution still records, so history stays intact.
 */
export async function getReferralProgramRule(): Promise<ReferralProgramRule> {
  const now = Date.now()
  if (cachedRule && cachedRule.expiresAt > now) return cachedRule.value

  let rule: ReferralProgramRule = DEFAULT_REFERRAL_PROGRAM
  try {
    const row = await prisma.referralProgram.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
    })
    if (row) {
      rule = normalizeReferralProgramRule({
        id: row.id,
        name: row.name,
        isActive: row.isActive,
        commissionPercent: Number(row.commissionPercent),
        holdDays: row.holdDays,
        minimumOrderAmount: Number(row.minimumOrderAmount),
        allowSelfReferral: row.allowSelfReferral,
      })
    }
  } catch (error) {
    console.error("[REFERRALS] program_rule_load_failed", error instanceof Error ? error.message : String(error))
  }

  cachedRule = { value: rule, expiresAt: now + CACHE_TTL_MS }
  return rule
}

export function clearReferralProgramCache() {
  cachedRule = null
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

export function sanitizeReferralCodeInput(value: unknown): string {
  return normalizeReferralSearch(value).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16)
}

/**
 * Codes exclude 0/O/1/I/L because they are read aloud and typed by hand off
 * printed material; a referral code that cannot survive being retyped is a
 * lost attribution.
 */
export function generateReferralCode(length = 8): string {
  let out = ""
  for (let index = 0; index < length; index += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return out
}

export function referralCodeCandidates(length = 8): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  let guard = 0
  while (out.length < 5 && guard < 50) {
    guard += 1
    const code = generateReferralCode(length)
    if (seen.has(code)) continue
    seen.add(code)
    out.push(code)
  }
  return out
}