import { NextRequest, NextResponse } from "next/server"
import { requireAdminFullAuth } from "@/lib/auth/guards"
import { canAccessAdminApi } from "@/lib/admin-rbac"
import { prisma } from "@/lib/db"
import { TEMPORARY_BLOCK_MINUTES } from "@/lib/security/risk"

/**
 * Blocks listing for the security centre.
 *
 * Distinguishes the two kinds of block, because conflating them is what made
 * the old UI misleading:
 *
 *   temporary - written by the risk engine, always expires, always 30 minutes
 *   permanent - only ever written by an administrator, by hand
 */
export async function GET(request: NextRequest) {
  const auth = await requireAdminFullAuth(request)
  if (!auth.ok) return auth.response
  if (!canAccessAdminApi(auth.session.role)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const activeOnly = request.nextUrl.searchParams.get("active") !== "0"
  const now = new Date()
  const where = activeOnly ? { unblockedAt: null } : {}

  const [ips, devices] = await Promise.all([
    (prisma as any).blockedIp.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 }).catch(() => []),
    (prisma as any).blockedDevice.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 }).catch(() => []),
  ])

  // How many times each blocked identity was seen before it was held.
  const keys = [...new Set([...ips.map((row: any) => row.ip), ...devices.map((row: any) => row.ip)].filter(Boolean))]
  const eventCounts = new Map<string, number>()
  if (keys.length) {
    const grouped = await (prisma as any).securityEvent
      .groupBy({ by: ["ip"], where: { ip: { in: keys } }, _count: { _all: true } })
      .catch(() => [])
    for (const row of grouped || []) eventCounts.set(row.ip, row._count._all)
  }

  const riskStates = await (prisma as any).securityRiskState
    .findMany({ where: keys.length ? { lastIp: { in: keys } } : undefined, take: 200 })
    .catch(() => [])
  const riskByIp = new Map<string, any>((riskStates as Array<any>).map((row: any) => [row.lastIp, row]))

  const describe = (row: any) => {
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {}
    const isTemporary = !row.permanent
    const expiresAt = row.blockedUntil ? new Date(row.blockedUntil) : null
    const remainingMs = expiresAt ? Math.max(0, expiresAt.getTime() - now.getTime()) : 0
    return {
      id: row.id,
      ip: row.ip || null,
      deviceFingerprint: row.deviceFingerprint || null,
      reason: row.reason,
      attackType: row.attackType || null,
      createdAt: row.createdAt,
      kind: row.permanent ? "permanent" : "temporary",
      label: row.permanent ? "Permanent block (set by an administrator)" : `Temporary ${TEMPORARY_BLOCK_MINUTES}-minute security block`,
      blockedUntil: expiresAt ? expiresAt.toISOString() : null,
      remainingMinutes: expiresAt ? Math.ceil(remainingMs / 60_000) : null,
      expired: Boolean(expiresAt && remainingMs <= 0),
      riskScore: row.riskScore ?? riskByIp.get(row.ip)?.score ?? null,
      eventCount: eventCounts.get(row.ip) ?? 0,
      signalCount: riskByIp.get(row.ip)?.signalCount ?? null,
      route: metadata.route || riskByIp.get(row.ip)?.lastRoute || null,
      method: metadata.method || riskByIp.get(row.ip)?.lastMethod || null,
      customerId: metadata.customerId || riskByIp.get(row.ip)?.lastCustomerId || null,
      reviewStatus: row.reviewStatus || (row.unblockedAt ? "reviewed" : "needs_review"),
      unblockedAt: row.unblockedAt,
      unblockedBy: row.unblockedBy,
      country: row.country || null,
    }
  }

  const describedIps = ips.map(describe)
  const describedDevices = devices.map(describe)

  return NextResponse.json({
    ips: describedIps,
    devices: describedDevices,
    summary: {
      activeTemporary: describedIps.filter((row: any) => row.kind === "temporary" && !row.expired).length,
      expiredTemporary: describedIps.filter((row: any) => row.kind === "temporary" && row.expired).length,
      permanent: describedIps.filter((row: any) => row.kind === "permanent").length,
      needsReview: describedIps.filter((row: any) => row.reviewStatus === "needs_review").length,
      temporaryBlockMinutes: TEMPORARY_BLOCK_MINUTES,
    },
  })
}