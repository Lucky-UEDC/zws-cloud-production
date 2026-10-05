import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db"
import { clearSessionCache, hashSessionId, markSessionMfaVerified, resolveSession, type ResolvedSession } from "@/lib/auth/session-store"
import { LEGACY_SESSION_COOKIE_NAMES, SESSION_COOKIE_NAMES } from "@/lib/auth/session-cookies"
import { SESSION_EXPIRED_CODE, SESSION_EXPIRED_MESSAGE, clearAuthCookies } from "@/lib/auth/session-expired-response"
import { extractClientIp } from "@/lib/request-context"
import { writeAuditLog } from "@/lib/audit-log"
import { getRequestDeviceContext, deviceFingerprint } from "@/lib/auth/mfa/device"
import { findTrustedDevice } from "@/lib/auth/mfa/trusted-devices"
import { resolveMfaSubject } from "@/lib/auth/mfa/subjects"

export type FullAuthRole = "admin" | "client"

function sameOrigin(request: NextRequest) {
  const method = request.method.toUpperCase()
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true
  const origin = request.headers.get("origin")
  if (!origin) return false
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host")
  const proto = request.headers.get("x-forwarded-proto") || request.nextUrl.protocol.replace(/:$/, "") || "https"
  if (!host) return false
  try {
    return new URL(origin).origin === `${proto}://${host}`
  } catch {
    return false
  }
}

function isLocalTrustedRequest(request: NextRequest) {
  const host = String(request.headers.get("x-forwarded-host") || request.headers.get("host") || request.nextUrl.host || "").split(":")[0]
  const ip = extractClientIp(request)
  return ["localhost", "127.0.0.1", "::1"].includes(host) || ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip)
}

function unauthorized(code: string, message: string, status: number) {
  const response = NextResponse.json({ success: false, error: message, message, code }, { status })
  if (code === SESSION_EXPIRED_CODE || code === "unauthenticated") clearAuthCookies(response)
  return response
}

async function logDenied(request: NextRequest, session: ResolvedSession | null, code: string) {
  await writeAuditLog({
    action: "AUTH_GUARD_DENIED",
    actorEmail: session?.email || null,
    targetType: "auth_guard",
    metadata: {
      code,
      path: request.nextUrl.pathname,
      method: request.method,
      sessionId: session?.sessionId ? "present" : "missing",
      assuranceLevel: session?.assuranceLevel || null,
    },
    ipAddress: extractClientIp(request),
    userAgent: request.headers.get("user-agent") || null,
  }).catch(() => null)
}

export async function requireSameOriginOrCsrf(request: NextRequest) {
  if (sameOrigin(request)) return { ok: true as const }
  await logDenied(request, null, "BAD_ORIGIN")
  return { ok: false as const, response: unauthorized("bad_origin", "Invalid request origin.", 403) }
}

export async function requireFullAuth(request: NextRequest, role: FullAuthRole) {
  const token = role === "admin"
    ? request.cookies.get(SESSION_COOKIE_NAMES.admin)?.value || request.cookies.get(LEGACY_SESSION_COOKIE_NAMES.admin)?.value
    : request.cookies.get(SESSION_COOKIE_NAMES.client)?.value || request.cookies.get(LEGACY_SESSION_COOKIE_NAMES.client)?.value
  const session = await resolveSession(token, role)
  if (!session) {
    await logDenied(request, null, "UNAUTHENTICATED")
    return { ok: false as const, response: unauthorized(SESSION_EXPIRED_CODE, SESSION_EXPIRED_MESSAGE, 401) }
  }
  if (session.assuranceLevel !== "FULLY_AUTHENTICATED") {
    await logDenied(request, session, "MFA_REQUIRED")
    return { ok: false as const, response: unauthorized("mfa_required", "MFA verification is required.", 403) }
  }
  if (session.deviceFingerprint) {
    const context = await getRequestDeviceContext(request).catch(() => null)
    if (context && deviceFingerprint(context) !== session.deviceFingerprint) {
      // A fingerprint anchored at login time from an unparsable user-agent
      // ("Unknown browser"/"Unknown OS") cannot carry any real device signal —
      // it can never match a real browser request, so instead of permanently
      // locking out genuine sessions we re-anchor the stored fingerprint to
      // the current context. Sessions anchored from a meaningful user-agent
      // still hard-fail on mismatch (session hijack protection).
      const loginSession = token
        ? await (prisma as any).userLoginSession.findFirst({
            where: { sessionIdHash: hashSessionId(token) },
            select: { browser: true, os: true },
          }).catch(() => null)
        : null
      const loginUnparsable = !loginSession || loginSession.browser === "Unknown browser" || loginSession.os === "Unknown OS"
      if (loginUnparsable && token) {
        const recomputed = deviceFingerprint(context)
        await prisma.session.updateMany({
          where: { sessionIdHash: hashSessionId(token) },
          data: { deviceFingerprint: recomputed },
        }).catch(() => null)
        await (prisma as any).userLoginSession.updateMany({
          where: { sessionIdHash: hashSessionId(token) },
          data: { deviceFingerprint: recomputed },
        }).catch(() => null)
        await clearSessionCache(session.sessionId).catch(() => null)
        console.warn("[AUTH] session_fingerprint_reanchored", { path: request.nextUrl.pathname })
        return { ok: true as const, session: { ...session, deviceFingerprint: recomputed } }
      }
      await logDenied(request, session, "FINGERPRINT_MISMATCH")
      return { ok: false as const, response: unauthorized("session_fingerprint_mismatch", "Session device verification failed. Refresh the session or sign in again.", 401) }
    }
  }
  return { ok: true as const, session }
}

export async function requireRecentMfa(request: NextRequest, role: FullAuthRole, maxAgeMs = 5 * 60_000) {
  const auth = await requireFullAuth(request, role)
  if (!auth.ok) return auth
  if (role === "admin" && isLocalTrustedRequest(request)) return auth
  const token = role === "admin"
    ? request.cookies.get(SESSION_COOKIE_NAMES.admin)?.value || request.cookies.get(LEGACY_SESSION_COOKIE_NAMES.admin)?.value
    : request.cookies.get(SESSION_COOKIE_NAMES.client)?.value || request.cookies.get(LEGACY_SESSION_COOKIE_NAMES.client)?.value
  let verifiedAt = auth.session.mfaVerifiedAt ? new Date(auth.session.mfaVerifiedAt).getTime() : 0

  if (token) {
    const dbSession = await prisma.session.findUnique({
      where: { sessionIdHash: hashSessionId(token) },
      select: { mfaVerifiedAt: true, revokedAt: true },
    }).catch(() => null)
    const dbVerifiedAt = dbSession?.mfaVerifiedAt ? dbSession.mfaVerifiedAt.getTime() : 0
    if (!dbSession?.revokedAt && dbVerifiedAt > verifiedAt) {
      verifiedAt = dbVerifiedAt
      await markSessionMfaVerified(token, dbSession!.mfaVerifiedAt!).catch(() => false)
    }
  }

  if (verifiedAt && Date.now() - verifiedAt <= maxAgeMs) return auth

  const subject = await resolveMfaSubject(role === "admin" ? "admin" : "customer", auth.session.userId).catch(() => null)
  const context = subject ? await getRequestDeviceContext(request).catch(() => null) : null
  if (subject && context) {
    const fingerprint = deviceFingerprint(context)
    const trusted = await findTrustedDevice({
      request,
      subject,
      fingerprint,
      risk: { level: "low", score: 0, reasons: ["recent_mfa_trusted_device"], forceMfa: false },
    }).catch(() => null)
    if (trusted && token) {
      await markSessionMfaVerified(token).catch(() => false)
      return { ok: true as const, session: { ...auth.session, mfaVerifiedAt: new Date().toISOString(), deviceFingerprint: fingerprint } }
    }
  }

  await logDenied(request, auth.session, "RECENT_MFA_REQUIRED")
  return { ok: false as const, response: unauthorized("recent_mfa_required", "Recent MFA verification is required.", 403) }
}

export async function requireAdminFullAuth(request: NextRequest) {
  return requireFullAuth(request, "admin")
}

export async function requireClientFullAuth(request: NextRequest) {
  return requireFullAuth(request, "client")
}
