/**
 * Risk scoring and temporary mitigation.
 *
 * The rule this module exists to enforce:
 *
 *   one suspicious request  -> recorded, scored, NO block
 *   repeated signals       -> temporary block, always exactly 30 minutes
 *   nothing from this path -> a permanent ban, ever
 *
 * A permanent ban is a human decision made in the admin UI, never an automatic
 * consequence of a heuristic. That distinction is the whole fix for customers
 * being banned over a flaky connection or an unlucky word choice.
 *
 * State lives in the database so the decision survives a restart and is
 * consistent across workers; blocks carry an absolute `blockedUntil`, so they
 * expire without needing a sweeper to have run.
 */

import { prisma } from "@/lib/db"
import type { SecurityContext } from "@/lib/security/abuse"

/** Temporary mitigation window. Fixed, not configurable, so it cannot drift. */
export const TEMPORARY_BLOCK_MINUTES = 30
export const TEMPORARY_BLOCK_MS = TEMPORARY_BLOCK_MINUTES * 60 * 1000

/** Risk is scored over a sliding window; older signals decay out of it. */
export const RISK_WINDOW_MS = 60 * 60 * 1000

/**
 * Score at which a temporary block is applied.
 *
 * Deliberately high, and well above what `MAX_SINGLE_REQUEST_RISK` can add in
 * one go, so several independent requests are needed. Below it, repeated
 * signals raise a "challenge" rather than a block: enough to serve a captcha
 * or slow the caller down, not enough to cut a customer off.
 */
export const TEMPORARY_BLOCK_THRESHOLD = 300

export const MAX_TEMPORARY_BLOCKS_PER_IP_PER_DAY = 3

export type RiskDecision = {
  action: "allow" | "record" | "challenge" | "temporary_block"
  score: number
  threshold: number
  signals: number
  blockedUntil: Date | null
  reason: string
}

/**
 * Accumulates risk for one identity and decides what - if anything - to do.
 *
 * `identity` should be the most specific thing available. Using the session
 * when there is one, and the IP otherwise, keeps one customer on a shared NAT
 * from accumulating another customer's score.
 */
export async function recordRiskSignal(input: {
  ctx: SecurityContext
  identityKey: string
  eventType: string
  score: number
  customerId?: string | null
  requestId?: string | null
}): Promise<RiskDecision> {
  const score = Math.max(0, Math.min(500, Math.trunc(Number(input.score) || 0)))
  if (!score) {
    return { action: "allow", score: 0, threshold: TEMPORARY_BLOCK_THRESHOLD, signals: 0, blockedUntil: null, reason: "no_signal" }
  }

  const now = new Date()
  const windowStart = new Date(now.getTime() - RISK_WINDOW_MS)
  const identityKey = input.identityKey || `ip:${input.ctx.ip || "unknown"}`

  const state = await (prisma as any).securityRiskState.findFirst({
    where: { identityKey },
  }).catch(() => null)

  const previousScore = Number(state?.score || 0)
  const previousSignals = Number(state?.signalCount || 0)
  const windowScore = now.getTime() - new Date(state?.windowStartedAt || 0).getTime() > RISK_WINDOW_MS ? 0 : previousScore
  const windowSignals = now.getTime() - new Date(state?.windowStartedAt || 0).getTime() > RISK_WINDOW_MS ? 0 : previousSignals

  const nextScore = Math.min(1000, windowScore + score)
  const nextSignals = windowSignals + 1

  // A host that is already temporarily blocked stays blocked; we do not extend
  // the window on every new request, otherwise a persistent poller would hold
  // the IP indefinitely.
  const activeBlock = state?.blockedUntil ? new Date(state.blockedUntil) : null
  const alreadyBlocked = Boolean(activeBlock && activeBlock.getTime() > now.getTime())

  const data = {
    identityKey,
    score: activeBlock ? windowScore : nextScore,
    signalCount: activeBlock ? windowSignals : nextSignals,
    lastEventType: input.eventType,
    lastIp: input.ctx.ip || null,
    lastRoute: input.ctx.route || null,
    lastMethod: input.ctx.method || null,
    lastCustomerId: input.customerId || state?.lastCustomerId || null,
    lastSessionIdHash: input.ctx.sessionIdHash || null,
    lastRequestId: input.requestId || null,
    blockedUntil: alreadyBlocked ? state.blockedUntil : null,
    windowStartedAt: windowSignals === 0 && windowScore === 0 ? now : state?.windowStartedAt || now,
    updatedAt: now,
  }

  await (prisma as any).securityRiskState.upsert({
    where: { identityKey },
    create: { ...data, identityKey },
    update: data,
  }).catch((error: unknown) => {
    console.error("[SECURITY] risk_state_persist_failed", error instanceof Error ? error.message : String(error))
  })

  if (alreadyBlocked) {
    return {
      action: "temporary_block",
      score: windowScore,
      threshold: TEMPORARY_BLOCK_THRESHOLD,
      signals: windowSignals,
      blockedUntil: state.blockedUntil,
      reason: "already_temporarily_blocked",
    }
  }

  if (nextScore < TEMPORARY_BLOCK_THRESHOLD) {
    return {
      action: nextSignals >= 3 ? "challenge" : "record",
      score: nextScore,
      threshold: TEMPORARY_BLOCK_THRESHOLD,
      signals: nextSignals,
      blockedUntil: null,
      reason: "below_threshold",
    }
  }

  return {
    action: "temporary_block",
    score: nextScore,
    threshold: TEMPORARY_BLOCK_THRESHOLD,
    signals: nextSignals,
    blockedUntil: now,
    reason: "threshold_reached",
  }
}

/**
 * Applies the 30-minute block. Deliberately writes `permanent: false` with an
 * absolute `blockedUntil`; the row therefore self-expires and can never turn
 * into a permanent ban through this code path.
 */
export async function applyTemporaryBlock(input: {
  ctx: SecurityContext
  identityKey: string
  riskScore: number
  signalCount: number
  reason: string
  requestId?: string | null
  customerId?: string | null
}): Promise<Date> {
  const until = new Date(Date.now() + TEMPORARY_BLOCK_MS)
  const common = {
    reason: input.reason,
    attackType: "risk_threshold",
    country: input.ctx.country,
    asn: input.ctx.asn,
    userAgent: input.ctx.userAgent,
    deviceFingerprint: input.ctx.deviceFingerprint,
    sessionIdHash: input.ctx.sessionIdHash,
    // The two lines that make this a temporary hold rather than a ban.
    permanent: false,
    blockedUntil: until,
    metadata: {
      route: input.ctx.route,
      method: input.ctx.method,
      riskScore: input.riskScore,
      signalCount: input.signalCount,
      requestId: input.requestId || null,
      customerId: input.customerId || null,
      expiresInMinutes: TEMPORARY_BLOCK_MINUTES,
    },
  }

  if (input.ctx.ip && input.ctx.ip !== "unknown") {
    // Reuse the active row for this IP rather than always inserting one.
    // Creating a new row on every escalation produced several overlapping
    // blocks for the same identity, so clearing the newest left older ones
    // behind and the customer stayed blocked long after 30 minutes.
    const updated = await (prisma as any).blockedIp.updateMany({
      where: { ip: input.ctx.ip, unblockedAt: null },
      data: { permanent: false, blockedUntil: until, reason: input.reason, metadata: common.metadata as any },
    }).catch(() => ({ count: 0 }))

    if (!updated.count) {
      await (prisma as any).blockedIp.create({
        data: { ...common, ip: input.ctx.ip, deviceFingerprint: input.ctx.deviceFingerprint },
      }).catch(() => null)
    }

    // One active row per IP: collapse anything left over from an earlier
    // escalation so expiry really does release the identity.
    await (prisma as any).blockedIp.updateMany({
      where: { ip: input.ctx.ip, unblockedAt: null, NOT: { blockedUntil: until } },
      data: { unblockedAt: until, unblockedBy: "auto:risk_threshold" },
    }).catch(() => null)
  }

  await (prisma as any).securityRiskState.updateMany({
    where: { identityKey: input.identityKey },
    data: { blockedUntil: until },
  }).catch(() => null)

  return until
}

export function temporaryBlockMessage(remainingMs: number) {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000))
  return `Temporary 30-minute security block. This lift is automatic in ${minutes} minute${minutes === 1 ? "" : "s"}.`
}