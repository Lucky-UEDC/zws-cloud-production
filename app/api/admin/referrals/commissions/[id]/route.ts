import type { NextRequest } from "next/server"
import { prisma } from "@/lib/db"
import { requireSameOriginOrCsrf } from "@/lib/auth/guards"
import { requireSensitiveAdminMfa } from "@/lib/admin-sensitive-action"
import { badRequest, notFound, ok, serverError, unauthorized } from "@/lib/referrals/http"
import { roundMoney } from "@/lib/referrals/commission"
import { writeAuditLog } from "@/lib/audit-log"
import { createPanelLog } from "@/lib/panel-log"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const ACTIONS = new Set(["pay", "reverse", "restore"])

/**
 * Marks a commission paid, reversed, or restored.
 *
 * The ledger row is the source of truth here, and only a pending row can move:
 * a paid row cannot be silently paid twice, and a reversed row has to be
 * explicitly restored before it can be paid. Money movements themselves are not
 * performed by this endpoint - it records the decision an operator already made
 * out of band, which is what makes the audit trail honest.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const commissionId = String(id || "").trim()
  if (!commissionId) return notFound("Commission not found")

  const origin = await requireSameOriginOrCsrf(request)
  if (!origin.ok) return origin.response

  const stepUp = await requireSensitiveAdminMfa(request)
  if (!stepUp.ok) return stepUp.response

  const adminEmail = String(stepUp.session.email || "")
  if (!adminEmail) return unauthorized("Administrator authorization required")

  const body = (await request.json().catch(() => ({}))) as { action?: string; reason?: string }
  const action = String(body.action || "").toLowerCase()
  if (!ACTIONS.has(action)) return badRequest("Unsupported commission action")

  const reason = String(body.reason || "").trim().slice(0, 500)

  try {
    const commission = await prisma.referralCommission.findUnique({
      where: { id: commissionId },
      select: {
        id: true,
        status: true,
        amount: true,
        orderId: true,
        referralId: true,
        referrerCustomerId: true,
        paidAt: true,
        reversedAt: true,
        reversalReason: true,
      },
    })
    if (!commission) return notFound("Commission not found")

    if (action === "pay") {
      if (commission.status === "paid") return badRequest("Commission is already paid")
      if (commission.status !== "pending") {
        return badRequest(`Commission must be pending before it can be paid (currently ${commission.status})`)
      }
      if (roundMoney(commission.amount) <= 0) return badRequest("Commission amount is zero and cannot be paid")

      const updated = await prisma.referralCommission.update({
        where: { id: commission.id },
        data: {
          status: "paid",
          paidAt: new Date(),
          paidBy: adminEmail,
          notes: reason || commission.reversalReason,
        },
      })
      await auditAndLog(adminEmail, "referral_commission_paid", commission.id, commission.orderId, {
        amount: roundMoney(commission.amount),
        reason,
      })
      return ok({ commission: { id: updated.id, status: updated.status, paidAt: updated.paidAt } })
    }

    if (action === "reverse") {
      if (commission.status === "reversed") return badRequest("Commission is already reversed")
      if (!reason) return badRequest("A reason is required when reversing a commission")
      const updated = await prisma.referralCommission.update({
        where: { id: commission.id },
        data: {
          status: "reversed",
          reversedAt: new Date(),
          reversalReason: reason,
        },
      })
      await auditAndLog(adminEmail, "referral_commission_reversed", commission.id, commission.orderId, {
        amount: roundMoney(commission.amount),
        reason,
      })
      return ok({ commission: { id: updated.id, status: updated.status, reversedAt: updated.reversedAt } })
    }

    if (commission.status !== "reversed") return badRequest("Only a reversed commission can be restored")
    const updated = await prisma.referralCommission.update({
      where: { id: commission.id },
      data: { status: "pending", reversedAt: null, reversalReason: null, paidAt: null, paidBy: null },
    })
    await auditAndLog(adminEmail, "referral_commission_restored", commission.id, commission.orderId, { reason })
    return ok({ commission: { id: updated.id, status: updated.status } })
  } catch (error) {
    console.error("[ADMIN_REFERRAL_COMMISSION_ACTION]", error)
    return serverError("Unable to update the commission")
  }
}

async function auditAndLog(
  adminEmail: string,
  action: string,
  commissionId: string,
  orderId: string,
  metadata: Record<string, unknown>,
) {
  await Promise.allSettled([
    writeAuditLog({ action, actorEmail: adminEmail, targetType: "referral_commission", targetId: commissionId, metadata: { orderId, ...metadata } }),
    createPanelLog({
      category: "Referral",
      message: action,
      actorType: "admin",
      actorEmail: adminEmail,
      metadata: { commissionId, orderId, ...metadata },
    }),
  ])
}