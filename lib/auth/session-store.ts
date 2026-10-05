import crypto from "node:crypto"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/db"
import { createPanelLog } from "@/lib/panel-log"
import { normalizeStaffRole, type StaffRole } from "@/lib/roles"
import { getRedisClient } from "@/lib/redis"
import { SESSION_COOKIE_NAMES } from "@/lib/auth/session-cookies"
import { revokeTrackedSessionByHash } from "@/lib/auth/mfa/session-tracking"
import { extractClientIp } from "@/lib/request-context"

export type SessionRole = StaffRole | "client"
export type SessionAssuranceLevel = "UNAUTHENTICATED" | "PASSWORD_VERIFIED" | "MFA_VERIFIED" | "FULLY_AUTHENTICATED"

export type StoredSession = {
  sessionId: string
  userId: string
  role: SessionRole
  email: string
  assuranceLevel: SessionAssuranceLevel
  mfaVerifiedAt?: string | null
  deviceFingerprint?: string | null
  createdAt: string
  lastSeenAt: string
  ipHash?: string | null
  userAgentHash?: string | null
}

export type ResolvedSession = StoredSession & {
  displayName?: string | null
  name?: string | null
  status?: string | null
  emailVerifiedAt?: string | null
}

export type SessionResolutionResult =
  | { status: "valid"; session: ResolvedSession; source: "redis" | "db"; expiresAt: Date; expiresInSeconds: number }
  | { status: "invalid"; reason: "missing_token" | "missing_db_session" | "revoked" | "expired" | "wrong_role" | "user_disabled" | "malformed_session" }
  | { status: "unavailable"; reason: "database_unavailable" | "session_store_unavailable"; message: string }

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
const DEFAULT_SESSION_TTL_SECONDS = SESSION_TTL_SECONDS
const SESSION_EVENT_LOG_WINDOW_MS = 60_000
const recentSessionEventLogs = new Map<string, number>()

function nowIso() {
  return new Date().toISOString()
}

export function getSessionTtlSeconds(sessionMinutes?: number | null) {
  const envTtl = Number(process.env.SESSION_TTL_SECONDS || "")
  const requestedTtl = Number.isFinite(envTtl) && envTtl > 0 ? Math.floor(envTtl) : DEFAULT_SESSION_TTL_SECONDS
  return Math.min(requestedTtl, SESSION_TTL_SECONDS)
}

function secondsUntilExpiry(createdAt: string | Date, ttlSeconds: number) {
  const createdMs = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime()
  if (!Number.isFinite(createdMs)) return 0
  return Math.max(0, Math.floor((createdMs + ttlSeconds * 1000 - Date.now()) / 1000))
}

export function hashSessionId(sessionId: string) {
  return crypto.createHash("sha256").update(sessionId).digest("hex")
}

function hashOptional(value?: string | null) {
  const text = String(value || "").trim()
  return text ? crypto.createHash("sha256").update(text).digest("hex") : null
}

function redisKey(sessionId: string) {
  return `session:${sessionId}`
}

function sessionHashPrefix(sessionId: string) {
  return hashSessionId(sessionId).slice(0, 12)
}

function dbSessionExpiresAt(createdAt: string | Date, ttlSeconds: number) {
  const createdMs = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime()
  return new Date(createdMs + ttlSeconds * 1000)
}

async function authLog(message: string, metadata: Record<string, unknown> = {}, level: "info" | "warn" | "error" = "info") {
  await createPanelLog({
    category: "Auth",
    level,
    message,
    actorType: "system",
    metadata,
  }).catch(() => null)
}

async function authLogOnce(message: string, sessionId: string, expected?: "admin" | "client", metadata: Record<string, unknown> = {}, level: "info" | "warn" | "error" = "info") {
  const hash = hashSessionId(sessionId)
  const key = `${message}:${expected || "any"}:${hash}`
  const now = Date.now()
  const previous = recentSessionEventLogs.get(key) || 0
  if (now - previous < SESSION_EVENT_LOG_WINDOW_MS) return
  recentSessionEventLogs.set(key, now)
  if (recentSessionEventLogs.size > 1000) {
    for (const [entryKey, timestamp] of recentSessionEventLogs.entries()) {
      if (now - timestamp > SESSION_EVENT_LOG_WINDOW_MS) recentSessionEventLogs.delete(entryKey)
    }
  }
  await authLog(message, { expected: expected || null, sessionHashPrefix: hash.slice(0, 12), ...metadata }, level)
}

export async function clearSessionCache(sessionId?: string | null) {
  if (!sessionId) return false
  const redis = await getRedis()
  if (!redis) return false
  try {
    await redis.del(redisKey(sessionId))
    return true
  } catch {
    return false
  }
}

async function getRedis() {
  const redis = getRedisClient()
  if (!redis) return null
  if (redis.status !== "ready") {
    try {
      await redis.connect()
    } catch {
      return null
    }
  }
  return redis
}

async function redisSet(sessionId: string, value: StoredSession, ttlSeconds: number) {
  const redis = await getRedis()
  if (!redis) return false
  await redis.set(redisKey(sessionId), JSON.stringify(value), "EX", ttlSeconds)
  return true
}

export async function issueSession(input: {
  userId: string
  role: SessionRole
  email: string
  sessionMinutes?: number | null
  request?: NextRequest | Request | null
  assuranceLevel?: SessionAssuranceLevel
  mfaVerifiedAt?: Date | string | null
  deviceFingerprint?: string | null
}) {
  const sessionId = crypto.randomBytes(32).toString("base64url")
  const ttlSeconds = getSessionTtlSeconds(input.sessionMinutes)
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000)
  const ip = input.request ? extractClientIp(input.request) : null
  const userAgent = input.request?.headers.get("user-agent") || null
  const mfaVerifiedAt = input.mfaVerifiedAt ? new Date(input.mfaVerifiedAt).toISOString() : null
  const stored: StoredSession = {
    sessionId,
    userId: input.userId,
    role: input.role,
    email: input.email,
    assuranceLevel: input.assuranceLevel || "FULLY_AUTHENTICATED",
    mfaVerifiedAt,
    deviceFingerprint: input.deviceFingerprint || null,
    createdAt: nowIso(),
    lastSeenAt: nowIso(),
    ipHash: hashOptional(ip),
    userAgentHash: hashOptional(userAgent),
  }

  await prisma.session.create({
    data: {
      sessionIdHash: hashSessionId(sessionId),
      userId: input.userId,
      role: input.role,
      email: input.email,
      assuranceLevel: stored.assuranceLevel,
      mfaVerifiedAt: mfaVerifiedAt ? new Date(mfaVerifiedAt) : null,
      deviceFingerprint: stored.deviceFingerprint,
      expiresAt,
      ipHash: stored.ipHash,
      userAgentHash: stored.userAgentHash,
    } as any,
  })

  try {
    await redisSet(sessionId, stored, ttlSeconds)
  } catch (error) {
    await authLog("redis_session_error", { action: "issue", message: error instanceof Error ? error.message : String(error) }, "warn")
  }

  return { sessionId, ttlSeconds, expiresAt }
}

async function enrichSession(base: StoredSession): Promise<ResolvedSession | null> {
  if (base.role === "client") {
    const customer = await prisma.customer.findUnique({
      where: { id: base.userId },
      select: { id: true, email: true, name: true, isActive: true, status: true, emailVerifiedAt: true },
    })
    if (!customer?.isActive || customer.status === "BANNED" || customer.status === "CLOSED") return null
    return {
      ...base,
      email: customer.email || base.email,
      name: customer.name || "Client",
      status: String(customer.status || "ACTIVE"),
      emailVerifiedAt: customer.emailVerifiedAt?.toISOString() || null,
    }
  }

  const admin = await prisma.adminProfile.findUnique({
    where: { id: base.userId },
    select: { id: true, email: true, displayName: true, role: true, isActive: true },
  })
  if (!admin?.isActive) return null
  const role = normalizeStaffRole(admin.role) || "admin"
  return {
    ...base,
    role,
    email: admin.email || base.email,
    displayName: admin.displayName || "Admin",
  }
}

async function enrichSessionForResolution(base: StoredSession): Promise<
  | { status: "valid"; session: ResolvedSession }
  | { status: "invalid"; reason: "user_disabled" }
  | { status: "unavailable"; reason: "database_unavailable"; message: string }
> {
  try {
    const session = await enrichSession(base)
    if (!session) return { status: "invalid", reason: "user_disabled" }
    return { status: "valid", session }
  } catch (error) {
    return {
      status: "unavailable",
      reason: "database_unavailable",
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function resolveSessionResult(sessionId?: string | null, expected?: "admin" | "client"): Promise<SessionResolutionResult> {
  if (!sessionId) return { status: "invalid", reason: "missing_token" }
  const ttlSeconds = getSessionTtlSeconds()

  try {
    const redis = await getRedis()
    if (redis) {
      const raw = await redis.get(redisKey(sessionId))
      if (raw) {
        let parsed: StoredSession
        try {
          parsed = JSON.parse(raw) as StoredSession
        } catch {
          await authLogOnce("session_expired", sessionId, expected, { reason: "malformed_redis_session" }, "warn")
          return { status: "invalid", reason: "malformed_session" }
        }
        parsed.assuranceLevel = parsed.assuranceLevel || "FULLY_AUTHENTICATED"
        const remainingSeconds = secondsUntilExpiry(parsed.createdAt, ttlSeconds)
        if (remainingSeconds <= 0) {
          await revokeSession(sessionId).catch(() => null)
          await authLogOnce("session_expired", sessionId, expected, { reason: "absolute_max_age" }, "warn")
          return { status: "invalid", reason: "expired" }
        }
        if (expected === "admin" && parsed.role === "client") return { status: "invalid", reason: "wrong_role" }
        if (expected === "client" && parsed.role !== "client") return { status: "invalid", reason: "wrong_role" }
        const enriched = await enrichSessionForResolution({ ...parsed, sessionId, lastSeenAt: nowIso() })
        if (enriched.status !== "valid") return enriched
        await redis.expire(redisKey(sessionId), remainingSeconds).catch(() => null)
        await authLogOnce("session_valid", sessionId, expected, { source: "redis", role: enriched.session.role, expiresInSeconds: remainingSeconds })
        // Throttle the lastSeenAt write to once per 60s per session. Every
        // request used to serialize an UPDATE here (single shared DB
        // connection) — the session store is read far more often than it
        // needs to be written.
        const redisSeenMs = parsed?.lastSeenAt ? new Date(parsed.lastSeenAt).getTime() : Number.NaN
        if (!Number.isFinite(redisSeenMs) || Date.now() - redisSeenMs >= 60_000) {
          void prisma.session.updateMany({
            where: { sessionIdHash: hashSessionId(sessionId), revokedAt: null },
            data: { lastSeenAt: new Date() },
          }).catch(() => null)
        }
        return {
          status: "valid",
          session: enriched.session,
          source: "redis",
          expiresAt: dbSessionExpiresAt(parsed.createdAt, ttlSeconds),
          expiresInSeconds: remainingSeconds,
        }
      }
      await authLogOnce("redis_session_miss", sessionId, expected)
    }
  } catch (error) {
    await authLog("redis_session_error", { action: "resolve", message: error instanceof Error ? error.message : String(error) }, "warn")
  }

  const dbSession = await prisma.session.findUnique({ where: { sessionIdHash: hashSessionId(sessionId) } }).catch(async (error) => {
    await authLog("auth_session_store_unavailable", {
      action: "db_resolve",
      sessionHashPrefix: sessionHashPrefix(sessionId),
      message: error instanceof Error ? error.message : String(error),
    }, "warn")
    return "unavailable" as const
  })
  if (dbSession === "unavailable") {
    return { status: "unavailable", reason: "database_unavailable", message: "Session database is temporarily unavailable." }
  }
  if (!dbSession) {
    await authLogOnce("session_expired", sessionId, expected, { reason: "missing_db_session" }, "warn")
    return { status: "invalid", reason: "missing_db_session" }
  }
  if (dbSession.revokedAt) {
    await authLogOnce("session_expired", sessionId, expected, { reason: "revoked" }, "warn")
    return { status: "invalid", reason: "revoked" }
  }
  const remainingSeconds = secondsUntilExpiry(dbSession.createdAt, ttlSeconds)
  if (dbSession.expiresAt.getTime() < Date.now() || remainingSeconds <= 0) {
    await authLogOnce("session_expired", sessionId, expected, { reason: "expired", expiredAt: dbSession.expiresAt.toISOString() }, "warn")
    return { status: "invalid", reason: "expired" }
  }
  if (expected === "admin" && dbSession.role === "client") return { status: "invalid", reason: "wrong_role" }
  if (expected === "client" && dbSession.role !== "client") return { status: "invalid", reason: "wrong_role" }

  const restored: StoredSession = {
    sessionId,
    userId: dbSession.userId,
    role: dbSession.role === "client" ? "client" : normalizeStaffRole(dbSession.role) || "admin",
    email: dbSession.email,
    assuranceLevel: (dbSession as any).assuranceLevel || "FULLY_AUTHENTICATED",
    mfaVerifiedAt: (dbSession as any).mfaVerifiedAt?.toISOString?.() || null,
    deviceFingerprint: (dbSession as any).deviceFingerprint || null,
    createdAt: dbSession.createdAt.toISOString(),
    lastSeenAt: nowIso(),
    ipHash: dbSession.ipHash,
    userAgentHash: dbSession.userAgentHash,
  }
  const enriched = await enrichSessionForResolution(restored)
  if (enriched.status !== "valid") return enriched
  try {
    await redisSet(sessionId, restored, remainingSeconds)
    await authLogOnce("session_restored_from_db", sessionId, expected, { role: restored.role })
  } catch (error) {
    await authLog("redis_session_error", { action: "restore", message: error instanceof Error ? error.message : String(error) }, "warn")
  }
  await authLogOnce("session_valid", sessionId, expected, { source: "db", role: restored.role })
  // Throttle the lastSeenAt write: skip when the DB row was touched less than
  // 60s ago. This avoids an UPDATE on every request (single pooled connection).
  const dbSeenMs = dbSession.lastSeenAt ? dbSession.lastSeenAt.getTime() : Number.NaN
  if (!Number.isFinite(dbSeenMs) || Date.now() - dbSeenMs >= 60_000) {
    await prisma.session.update({ where: { id: dbSession.id }, data: { lastSeenAt: new Date() } }).catch(() => null)
  }
  return {
    status: "valid",
    session: enriched.session,
    source: "db",
    expiresAt: dbSession.expiresAt,
    expiresInSeconds: remainingSeconds,
  }
}

export async function resolveSession(sessionId?: string | null, expected?: "admin" | "client") {
  const result = await resolveSessionResult(sessionId, expected)
  return result.status === "valid" ? result.session : null
}

export async function renewSession(sessionId?: string | null, expected?: "admin" | "client") {
  const result = await resolveSessionResult(sessionId, expected)
  if (result.status !== "valid") return result

  const ttlSeconds = getSessionTtlSeconds()
  const refreshedAt = new Date()
  const expiresAt = new Date(refreshedAt.getTime() + ttlSeconds * 1000)
  const refreshed: StoredSession = {
    sessionId: result.session.sessionId,
    userId: result.session.userId,
    role: result.session.role,
    email: result.session.email,
    assuranceLevel: result.session.assuranceLevel || "FULLY_AUTHENTICATED",
    mfaVerifiedAt: result.session.mfaVerifiedAt || null,
    deviceFingerprint: result.session.deviceFingerprint || null,
    createdAt: refreshedAt.toISOString(),
    lastSeenAt: refreshedAt.toISOString(),
    ipHash: result.session.ipHash || null,
    userAgentHash: result.session.userAgentHash || null,
  }

  const updated = await prisma.session.updateMany({
    where: { sessionIdHash: hashSessionId(sessionId!), revokedAt: null },
    data: {
      expiresAt,
      lastSeenAt: refreshedAt,
      createdAt: refreshedAt,
      role: refreshed.role,
      email: refreshed.email,
      assuranceLevel: refreshed.assuranceLevel,
    } as any,
  }).catch(async (error) => {
    await authLog("auth_session_refresh_failed", {
      sessionHashPrefix: sessionHashPrefix(sessionId!),
      source: "db",
      message: error instanceof Error ? error.message : String(error),
    }, "warn")
    return null
  })

  if (!updated) return { status: "unavailable" as const, reason: "database_unavailable" as const, message: "Session database is temporarily unavailable." }
  if (!updated.count) return { status: "invalid" as const, reason: "missing_db_session" as const }

  try {
    await redisSet(sessionId!, refreshed, ttlSeconds)
  } catch (error) {
    await authLog("auth_session_refresh_failed", {
      sessionHashPrefix: sessionHashPrefix(sessionId!),
      source: "redis",
      message: error instanceof Error ? error.message : String(error),
    }, "warn")
  }

  await authLog("auth_session_refreshed", {
    userId: refreshed.userId,
    role: refreshed.role,
    sessionHashPrefix: sessionHashPrefix(sessionId!),
    expiresAt: expiresAt.toISOString(),
    expiresInSeconds: ttlSeconds,
  })

  return {
    status: "valid" as const,
    session: { ...result.session, ...refreshed },
    source: result.source,
    expiresAt,
    expiresInSeconds: ttlSeconds,
  }
}

export async function revokeSession(sessionId?: string | null) {
  if (!sessionId) return
  const hash = hashSessionId(sessionId)
  await prisma.session.updateMany({ where: { sessionIdHash: hash, revokedAt: null }, data: { revokedAt: new Date() } }).catch((error) => {
    void authLog("logout_error", { layer: "db_revoke", message: error instanceof Error ? error.message : String(error) }, "warn")
  })
  await revokeTrackedSessionByHash(hash)
  try {
    const redis = await getRedis()
    await redis?.del(redisKey(sessionId))
  } catch (error) {
    await authLog("logout_error", { layer: "redis_delete", message: error instanceof Error ? error.message : String(error) }, "warn")
  }
}

export async function markSessionMfaVerified(sessionId?: string | null, verifiedAt: Date = new Date()) {
  if (!sessionId) return false
  const verifiedIso = verifiedAt.toISOString()
  const hash = hashSessionId(sessionId)
  const updated = await prisma.session.updateMany({
    where: { sessionIdHash: hash, revokedAt: null },
    data: {
      assuranceLevel: "FULLY_AUTHENTICATED",
      mfaVerifiedAt: verifiedAt,
      lastSeenAt: verifiedAt,
    },
  }).catch(() => ({ count: 0 }))
  if (!updated.count) return false

  try {
    const redis = await getRedis()
    const raw = await redis?.get(redisKey(sessionId))
    if (redis && raw) {
      const parsed = JSON.parse(raw) as StoredSession
      parsed.assuranceLevel = "FULLY_AUTHENTICATED"
      parsed.mfaVerifiedAt = verifiedIso
      parsed.lastSeenAt = verifiedIso
      const ttlSeconds = getSessionTtlSeconds()
      const remainingSeconds = secondsUntilExpiry(parsed.createdAt, ttlSeconds)
      if (remainingSeconds > 0) await redis.set(redisKey(sessionId), JSON.stringify(parsed), "EX", remainingSeconds)
    }
  } catch (error) {
    await authLog("redis_session_error", { action: "mark_mfa_verified", message: error instanceof Error ? error.message : String(error) }, "warn")
  }
  return true
}

export async function revokeSessionsForUser(userId: string, role?: string | null) {
  const sessions = await prisma.session.findMany({
    where: { userId, ...(role ? { role } : {}), revokedAt: null },
    select: { sessionIdHash: true },
  })
  await prisma.session.updateMany({
    where: { userId, ...(role ? { role } : {}), revokedAt: null },
    data: { revokedAt: new Date() },
  })
  await Promise.all(sessions.map((session) => revokeTrackedSessionByHash(session.sessionIdHash))).catch(() => null)
  try {
    const redis = await getRedis()
    if (redis) {
      const keys = await redis.keys("session:*")
      const revokeKeys: string[] = []
      for (const key of keys) {
        const raw = await redis.get(key).catch(() => null)
        if (!raw) continue
        try {
          const parsed = JSON.parse(raw) as StoredSession
          if (parsed.userId === userId && (!role || parsed.role === role)) revokeKeys.push(key)
        } catch {
          // Ignore malformed cache entries; DB revocation remains authoritative.
        }
      }
      if (revokeKeys.length) await redis.del(...revokeKeys)
    }
  } catch (error) {
    await authLog("redis_session_error", { action: "revoke_user", count: sessions.length, message: error instanceof Error ? error.message : String(error) }, "warn")
  }
}

export async function getSessionDiagnostics() {
  const ttlSeconds = getSessionTtlSeconds()
  const activeDbSessions = await prisma.session.count({
    where: { revokedAt: null, expiresAt: { gt: new Date() } },
  }).catch(() => 0)
  const recentAuthLogs = await prisma.panelLog.findMany({
    where: { category: "Auth" },
    orderBy: { timestamp: "desc" },
    take: 25,
  }).catch(() => [])

  let redisStatus = "not_configured"
  let activeRedisSessions = 0
  let redisLastError: string | null = null
  try {
    const redis = await getRedis()
    if (redis) {
      redisStatus = redis.status
      activeRedisSessions = (await redis.keys("session:*")).length
    }
  } catch (error) {
    redisStatus = "error"
    redisLastError = error instanceof Error ? error.message : String(error)
  }

  return {
    redisStatus,
    redisLastError,
    activeRedisSessions,
    activeDbSessions,
    sessionTtlSeconds: ttlSeconds,
    cookieNames: [SESSION_COOKIE_NAMES.admin, SESSION_COOKIE_NAMES.client],
    recentAuthLogs,
  }
}
