import type { NextRequest } from "next/server"
import { prisma } from "@/lib/db"
import { requireSameOriginOrCsrf } from "@/lib/auth/guards"
import { requireSensitiveAdminMfa } from "@/lib/admin-sensitive-action"
import { badRequest, loadAdminIdentity, ok, serverError } from "@/lib/referrals/http"
import { clearReferralProgramCache, getReferralProgramRule, normalizeReferralProgramRule } from "@/lib/referrals/program"
import { writeAuditLog } from "@/lib/audit-log"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const admin = await loadAdminIdentity(request)
  if (!admin) return ok({ success: false }, 401)
  const rule = await getReferralProgramRule()
  const row = await prisma.referralProgram.findFirst({ orderBy: { createdAt: "desc" } }).catch(() => null)
  return ok({
    program: { ...rule, configured: Boolean(row) },
  })
}

/**
 * Updates the live commission rule.
 *
 * Existing commission rows keep the rate they were created with, so changing
 * the percentage here never rewrites money that has already been earned.
 */
export async function POST(request: NextRequest) {
  const admin = await loadAdminIdentity(request)
  if (!admin) return ok({ success: false }, 401)

  const origin = await requireSameOriginOrCsrf(request)
  if (!origin.ok) return origin.response

  const stepUp = await requireSensitiveAdminMfa(request)
  if (!stepUp.ok) return stepUp.response

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  if (!("commissionPercent" in body)) return badRequest("commissionPercent is required")

  const next = normalizeReferralProgramRule({
    ...(await getReferralProgramRule()),
    commissionPercent: Number(body.commissionPercent),
    holdDays: body.holdDays === undefined ? undefined : Number(body.holdDays),
    minimumOrderAmount: body.minimumOrderAmount === undefined ? undefined : Number(body.minimumOrderAmount),
    isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
    allowSelfReferral: body.allowSelfReferral === undefined ? undefined : Boolean(body.allowSelfReferral),
    name: body.name === undefined ? undefined : String(body.name),
  })

  try {
    const existing = await prisma.referralProgram.findFirst({ orderBy: { createdAt: "desc" } })
    const saved = existing
      ? await prisma.referralProgram.update({
        where: { id: existing.id },
        data: {
          name: next.name,
          isActive: next.isActive,
          commissionPercent: next.commissionPercent,
          holdDays: next.holdDays,
          minimumOrderAmount: next.minimumOrderAmount,
          allowSelfReferral: next.allowSelfReferral,
        },
      })
      : await prisma.referralProgram.create({
        data: {
          name: next.name,
          isActive: next.isActive,
          commissionPercent: next.commissionPercent,
          holdDays: next.holdDays,
          minimumOrderAmount: next.minimumOrderAmount,
          allowSelfReferral: next.allowSelfReferral,
        },
      })

    clearReferralProgramCache()
    await writeAuditLog({
      action: "referral_program_updated",
      adminId: admin.sub || null,
      actorEmail: admin.email,
      targetType: "referral_program",
      targetId: saved.id,
      newValue: next,
    })
    return ok({ program: saved })
  } catch (error) {
    console.error("[ADMIN_REFERRAL_PROGRAM_UPDATE]", error)
    return serverError("Unable to update the referral programme")
  }
}