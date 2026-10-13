import { NextRequest, NextResponse } from "next/server"
import { requireAdminFullAuth, requireSameOriginOrCsrf } from "@/lib/auth/guards"
import { requireSensitiveAdminMfa } from "@/lib/admin-sensitive-action"
import { canAccessAdminApi } from "@/lib/admin-rbac"
import { prisma } from "@/lib/db"
import { writeAuditLog } from "@/lib/audit-log"

/**
 * Releases a block early.
 *
 * Releasing a temporary hold also clears the accumulated risk for that
 * identity, otherwise the next request would re-trip the threshold and the
 * customer would be blocked again immediately - which is exactly the "IP ban
 * cannot be escaped and nobody can tell why" failure mode.
 *
 * The `reviewStatus` written here is what lets an operator distinguish a
 * confirmed attack from a false positive later.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminFullAuth(request)
  if (!auth.ok) return auth.response
  if (!canAccessAdminApi(auth.session.role)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const origin = await requireSameOriginOrCsrf(request)
  if (!origin.ok) return origin.response

  const stepUp = await requireSensitiveAdminMfa(request)
  if (!stepUp.ok) return stepUp.response

  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as { reviewStatus?: string; reason?: string }
  const reviewStatus = String(body.reviewStatus || "reviewed")
  const reason = String(body.reason || "").slice(0, 500)

  const now = new Date()
  const [ipResult, deviceResult] = await Promise.all([
    (prisma as any).blockedIp.updateMany({
      where: { id, unblockedAt: null },
      data: { unblockedAt: now, unblockedBy: auth.session.email, reviewStatus },
    }).catch(() => ({ count: 0 })),
    (prisma as any).blockedDevice.updateMany({
      where: { id, unblockedAt: null },
      data: { unblockedAt: now, unblockedBy: auth.session.email, reviewStatus },
    }).catch(() => ({ count: 0 })),
  ])
  if (!ipResult.count && !deviceResult.count) return NextResponse.json({ error: "Block not found" }, { status: 404 })

  // Clear the risk that produced the hold so the customer is not re-blocked.
  const block = await (prisma as any).blockedIp.findUnique({
    where: { id },
    select: { ip: true, deviceFingerprint: true, sessionIdHash: true },
  }).catch(() => null)
  const identities = new Set<string>()
  if (block?.ip) identities.add(`ip:${block.ip}`)
  if (block?.deviceFingerprint) identities.add(`device:${block.deviceFingerprint}`)
  if (block?.sessionIdHash) identities.add(`session:${block.sessionIdHash}`)
  if (identities.size) {
    await (prisma as any).securityRiskState.updateMany({
      where: { identityKey: { in: Array.from(identities) } },
      data: { score: 0, signalCount: 0, blockedUntil: null },
    }).catch(() => null)
  }

  await writeAuditLog({
    action: "security_block_released",
    adminId: auth.session.userId,
    actorEmail: auth.session.email,
    targetType: "blocked_ip",
    targetId: id,
    newValue: { reviewStatus, reason, ip: block?.ip || null },
  }).catch(() => null)

  return NextResponse.json({
    success: true,
    reviewStatus,
    riskCleared: identities.size > 0,
    message: "Block released and risk score reset. The identity can connect normally now.",
  })
}