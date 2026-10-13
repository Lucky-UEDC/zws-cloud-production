import crypto from "node:crypto"
import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { prisma } from "@/lib/db"
import { extractClientIp, getRequestContext } from "@/lib/request-context"
import { SESSION_COOKIE_NAMES } from "@/lib/auth/session-cookies"
import { hashSessionId } from "@/lib/auth/session-store"
import { deviceFingerprint } from "@/lib/auth/mfa/device"
import { applyTemporaryBlock, recordRiskSignal, TEMPORARY_BLOCK_MS, temporaryBlockMessage } from "@/lib/security/risk"
import { riskContributionFor, type PayloadDetection } from "@/lib/security/input"

export type SecurityContext = {
  ip: string
  route: string
  method: string
  userAgent: string
  country: string | null
  asn: string | null
  deviceFingerprint: string | null
  sessionIdHash: string | null
}

export function securityJson(code: string, message: string, status = 400, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ success: false, ok: false, code, error: message, message, ...extra }, { status })
}

export function requestIdFor(ctx: SecurityContext): string {
  return (ctx as SecurityContext & { requestId?: string }).requestId || crypto.randomUUID()
}

/** Redacts anything credential-shaped before it can reach a log row. */
const SECRET_KEYS = /^(?:password|pass|pwd|token|secret|authorization|cookie|session|api[_-]?key|signature|otp|cvv|card)/i

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]"
  if (value === null || value === undefined) return value
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value
  if (typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, depth + 1))
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redactSecrets(entry, depth + 1)
    }
    return out
  }
  return undefined
}

export async function getSecurityContext(request: NextRequest | Request): Promise<SecurityContext> {
  const req = request as NextRequest
  const route = "nextUrl" in req ? req.nextUrl.pathname : new URL(request.url).pathname
  const userAgent = request.headers.get("user-agent") || ""
  const context = await getRequestContext(request).catch(() => null)
  const fallbackIp = extractClientIp(request)
  const rawSession = "cookies" in req
    ? req.cookies.get(SESSION_COOKIE_NAMES.client)?.value || req.cookies.get(SESSION_COOKIE_NAMES.admin)?.value || null
    : null
  const fp = context ? deviceFingerprint({
    ip: context.ip,
    city: context.city,
    region: context.region,
    country: context.country,
    timezone: context.timezone,
    asn: context.asn,
    provider: context.provider,
    proxy: context.proxy,
    vpn: context.vpn,
    tor: context.tor,
    relay: context.relay,
    browser: context.browser,
    browserVersion: context.browserVersion,
    os: context.os,
    osVersion: context.osVersion,
    deviceType: context.deviceType,
    platform: context.platform,
    cpuArchitecture: context.cpuArchitecture,
    userAgent: context.userAgent,
  }) : null

  return {
    ip: context?.ip || fallbackIp,
    route,
    method: request.method,
    userAgent,
    country: context?.country || null,
    asn: context?.asn || null,
    deviceFingerprint: fp,
    sessionIdHash: rawSession ? hashSessionId(rawSession) : null,
  }
}

export function activeBlockWhere(now = new Date()) {
  return {
    unblockedAt: null,
    OR: [
      { permanent: true },
      { blockedUntil: { gt: now } },
    ],
  }
}

export async function getActiveSecurityBlocks(ctx: SecurityContext) {
  const [ipBlock, deviceBlock] = await Promise.all([
    ctx.ip && ctx.ip !== "unknown"
      ? (prisma as any).blockedIp.findFirst({ where: { ip: ctx.ip, ...activeBlockWhere() } }).catch(() => null)
      : Promise.resolve(null),
    ctx.deviceFingerprint
      ? (prisma as any).blockedDevice.findFirst({ where: { deviceFingerprint: ctx.deviceFingerprint, ...activeBlockWhere() } }).catch(() => null)
      : Promise.resolve(null),
  ])
  return { ipBlock, deviceBlock }
}

export async function assertNotBlocked(ctx: SecurityContext) {
  const { ipBlock, deviceBlock } = await getActiveSecurityBlocks(ctx)
  if (deviceBlock) {
    await logSecurityEvent(ctx, "device_security_signal_logged", "warn", "logged", {
      deviceBlockId: deviceBlock.id || null,
      reason: deviceBlock.reason || "blocked_device",
    })
  }
  if (ipBlock) {
    const until = ipBlock.blockedUntil ? new Date(ipBlock.blockedUntil) : null
    const remaining = until ? until.getTime() - Date.now() : TEMPORARY_BLOCK_MS
    await logSecurityEvent(ctx, "temporary_block_enforced", "warn", "denied", {
      ipBlockId: ipBlock.id || null,
      reason: ipBlock.reason || "temporary_ip_block",
      blockedUntil: until ? until.toISOString() : null,
      remainingMinutes: Math.max(1, Math.ceil(remaining / 60_000)),
    })
    return {
      ok: false as const,
      response: securityJson(
        "temporary_security_block",
        temporaryBlockMessage(remaining),
        403,
        {
          reason: ipBlock.reason || "temporary_security_block",
          ruleTriggered: ipBlock.attackType || "risk_threshold",
          blockedUntil: until ? until.toISOString() : null,
          remainingMinutes: Math.max(1, Math.ceil(remaining / 60_000)),
          retryAfterMinutes: TEMPORARY_BLOCK_MS / 60_000,
        },
      ),
    }
  }
  return { ok: true as const }
}

export async function logSecurityEvent(
  ctx: SecurityContext,
  eventType: string,
  severity: "info" | "warn" | "error" = "info",
  actionTaken?: string | null,
  metadata: Record<string, unknown> = {},
) {
  await (prisma as any).securityEvent.create({
    data: {
      eventType,
      severity,
      route: ctx.route,
      method: ctx.method,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      country: ctx.country,
      asn: ctx.asn,
      deviceFingerprint: ctx.deviceFingerprint,
      sessionIdHash: ctx.sessionIdHash,
      actionTaken: actionTaken || null,
      requestId: requestIdFor(ctx),
      riskScore: Number((metadata as any)?.riskScore || 0) || null,
      expiresAt: (metadata as any)?.blockedUntil || null,
      metadata: redactSecrets(metadata) as any,
    },
  }).catch(() => null)
}

export async function logAttack(ctx: SecurityContext, detection: PayloadDetection, field?: string | null, actionTaken = "rejected") {
  const attackType = detection.attackTypes[0] || "malicious_payload"
  await (prisma as any).attackLog.create({
    data: {
      attackType,
      route: ctx.route,
      method: ctx.method,
      field: field || null,
      payloadHash: detection.hash,
      // Only the hash and a short sample are stored. The payload itself can
      // contain whatever a customer typed, including their own credentials.
      payloadSample: detection.sample.slice(0, 200),
      normalizedSample: detection.normalized.slice(0, 200),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      country: ctx.country,
      asn: ctx.asn,
      deviceFingerprint: ctx.deviceFingerprint,
      sessionIdHash: ctx.sessionIdHash,
      actionTaken,
      metadata: redactSecrets({ attackTypes: detection.attackTypes, tier: detection.tier, score: detection.score }) as any,
    },
  }).catch(() => null)
  await logSecurityEvent(ctx, `attack_${attackType}`, "error", actionTaken, { field, attackTypes: detection.attackTypes, tier: detection.tier })
}

export async function logSuspiciousRequest(
  ctx: SecurityContext,
  reason: string,
  severity: "info" | "warn" | "error" = "warn",
  actionTaken?: string | null,
  metadata: Record<string, unknown> = {},
  identifier?: string | null,
) {
  await (prisma as any).suspiciousRequest.create({
    data: {
      reason,
      severity,
      route: ctx.route,
      method: ctx.method,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      country: ctx.country,
      asn: ctx.asn,
      deviceFingerprint: ctx.deviceFingerprint,
      sessionIdHash: ctx.sessionIdHash,
      identifier: identifier || null,
      actionTaken: actionTaken || null,
      metadata: redactSecrets(metadata) as any,
    },
  }).catch(() => null)
  await logSecurityEvent(ctx, `suspicious_${reason}`, severity, actionTaken || "logged", metadata)
}

/**
 * Records a risk signal and applies mitigation ONLY if the accumulated score
 * crosses the threshold.
 *
 * This replaces the old behaviour where any single payload escalated straight
 * to a permanent ban with session revocation.
 */
export async function assessSecurityRisk(input: {
  ctx: SecurityContext
  eventType: string
  score: number
  customerId?: string | null
  reason?: string
  identityKey?: string
}) {
  // Prefer the session as the identity so customers sharing one NAT do not
  // pool their scores; fall back to the IP only when there is no session.
  const identityKey = input.identityKey
    || (input.ctx.sessionIdHash
      ? `session:${input.ctx.sessionIdHash}`
      : input.ctx.deviceFingerprint
        ? `device:${input.ctx.deviceFingerprint}`
        : `ip:${input.ctx.ip || "unknown"}`)

  const decision = await recordRiskSignal({
    ctx: input.ctx,
    identityKey,
    eventType: input.eventType,
    score: input.score,
    customerId: input.customerId,
  })

  if (decision.action !== "temporary_block" || decision.reason !== "threshold_reached") {
    await logSecurityEvent(input.ctx, `risk_${input.eventType}`, decision.action === "challenge" ? "warn" : "info", decision.action, {
      riskScore: decision.score,
      threshold: decision.threshold,
      signalCount: decision.signals,
      identityKey,
      reason: input.reason || decision.reason,
    })
    return decision
  }

  const until = await applyTemporaryBlock({
    ctx: input.ctx,
    identityKey,
    riskScore: decision.score,
    signalCount: decision.signals,
    reason: input.reason || "risk_threshold_reached",
    customerId: input.customerId,
  })

  await logSecurityEvent(input.ctx, "temporary_security_block_applied", "error", "temporary_block", {
    riskScore: decision.score,
    threshold: decision.threshold,
    signalCount: decision.signals,
    identityKey,
    blockedUntil: until.toISOString(),
    reason: input.reason || "risk_threshold_reached",
  })

  return { ...decision, blockedUntil: until }
}

export async function blockSecurityContext(
  ctx: SecurityContext,
  reason = "abuse",
  attackType = reason,
  metadata: Record<string, unknown> = {},
) {
  // Retained for OTP/credential-abuse call sites. These are *repeated* abuse
  // patterns (many attempts against one identity), not single bad payloads, so
  // the same 30-minute temporary hold applies - never a permanent ban.
  return assessSecurityRisk({
    ctx,
    eventType: attackType,
    score: 400,
    reason,
  })
}

export async function blockContext(ctx: SecurityContext, detection: PayloadDetection, reason = "malicious_payload") {
  return assessSecurityRisk({
    ctx,
    eventType: detection.attackTypes[0] || reason,
    score: riskContributionFor(detection),
    reason,
  })
}

/**
 * The rejection path every route already calls.
 *
 * Note what it does NOT do any more: a rejected payload is recorded and scored,
 * and the request is refused, but it no longer bans the IP and no longer
 * revokes the customer's sessions. A single bad string from a real customer on
 * a bad connection must not cost them their account.
 */
export async function rejectDetectedPayload(ctx: SecurityContext, detection: PayloadDetection, field?: string | null) {
  await logAttack(ctx, detection, field, "rejected")
  await assessSecurityRisk({
    ctx,
    eventType: detection.attackTypes[0] || "malicious_payload",
    score: riskContributionFor(detection),
    reason: "payload_rejected",
  })
  return securityJson("payload_rejected", "Request rejected by security validation.", 400, {
    field: field || undefined,
    hint: "Remove any markup or script-like characters and try again.",
  })
}
