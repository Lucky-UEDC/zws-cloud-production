import type { NextRequest } from "next/server"
import { prisma } from "@/lib/db"
import { requireSameOriginOrCsrf } from "@/lib/auth/guards"
import { requireSensitiveAdminMfa } from "@/lib/admin-sensitive-action"
import { badRequest, loadAdminIdentity, notFound, ok, serverError } from "@/lib/referrals/http"
import { ensureReferralAccount } from "@/lib/referrals/attribution"
import { sanitizeReferralCodeInput } from "@/lib/referrals/program"
import { writeAuditLog } from "@/lib/audit-log"
import { validateSecurityField } from "@/lib/security/input"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Admin attribution: records (or corrects) a real referrer -> referred
 * customer relationship.
 *
 * This creates a genuine row backed by two real customers; it does not invent
 * one. First-touch is enforced by the unique index on referred_customer_id, so
 * re-pointing an existing referral is refused rather than silently moving
 * revenue between referrers.
 */
export async function POST(request: NextRequest) {
  const admin = await loadAdminIdentity(request)
  if (!admin) return ok({ success: false }, 401)

  const origin = await requireSameOriginOrCsrf(request)
  if (!origin.ok) return origin.response

  const stepUp = await requireSensitiveAdminMfa(request)
  if (!stepUp.ok) return stepUp.response

  const body = (await request.json().catch(() => ({}))) as {
    action?: string
    referralCode?: string
    referredCustomerId?: string
    referrerCustomerId?: string
    referralId?: string
    status?: string
    notes?: string
  }

  const action = String(body.action || "create").toLowerCase()

  try {
    if (action === "create") {
      const code = sanitizeReferralCodeInput(body.referralCode)
      if (!code) return badRequest("A valid referral code is required")
      const referredCustomerId = String(body.referredCustomerId || "").trim()
      if (!referredCustomerId) return badRequest("A referred customer is required")

      const referrer = await prisma.referralAccount.findUnique({ where: { code } })
      if (!referrer) return badRequest("No referrer owns that referral code")
      if (referrer.customerId === referredCustomerId) return badRequest("A customer cannot refer themselves")

      const referred = await prisma.customer.findUnique({ where: { id: referredCustomerId }, select: { id: true } })
      if (!referred) return notFound("Referred customer not found")

      const existing = await prisma.referral.findUnique({ where: { referredCustomerId } })
      if (existing) {
        return badRequest(`This customer is already attributed to referrer ${existing.code}`)
      }

      const created = await prisma.referral.create({
        data: {
          referrerAccountId: referrer.id,
          referrerCustomerId: referrer.customerId,
          referredCustomerId,
          code: referrer.code,
          source: "admin",
          status: "registered",
          notes: String(body.notes || "").slice(0, 500) || null,
          metadata: { attributedBy: admin.email },
        },
      })
      await writeAuditLog({
        action: "referral_attribution_created",
        adminId: admin.sub || null,
        actorEmail: admin.email,
        targetType: "referral",
        targetId: created.id,
        metadata: { code, referredCustomerId, referrerCustomerId: referrer.customerId },
      })
      return ok({ referral: created }, 201)
    }

    if (action === "status" || action === "notes") {
      const referralId = String(body.referralId || "").trim()
      if (!referralId) return badRequest("A referral id is required")
      const referral = await prisma.referral.findUnique({ where: { id: referralId }, select: { id: true } })
      if (!referral) return notFound("Referral not found")

      const data: Record<string, unknown> = {}
      if (action === "status") {
        const status = String(body.status || "").toLowerCase()
        if (!["registered", "active", "inactive", "blocked"].includes(status)) return badRequest("Unsupported referral status")
        data.status = status
      } else {
        const notes = validateSecurityField(body.notes || "", "metadata", "Notes")
        if (!notes.ok) return badRequest(notes.error || "Invalid notes")
        data.notes = notes.value.slice(0, 500) || null
      }

      const updated = await prisma.referral.update({ where: { id: referral.id }, data: data as any })
      await writeAuditLog({
        action: `referral_${action}_updated`,
        adminId: admin.sub || null,
        actorEmail: admin.email,
        targetType: "referral",
        targetId: updated.id,
        newValue: data,
      })
      return ok({ referral: updated })
    }

    if (action === "enable_referrer") {
      const customerId = String(body.referrerCustomerId || "").trim()
      if (!customerId) return badRequest("A referrer customer id is required")
      const account = await ensureReferralAccount(customerId)
      if (!account) return serverError("Unable to create the referral account")
      const updated = await prisma.referralAccount.update({
        where: { id: account.accountId },
        data: { status: "active" },
      })
      await writeAuditLog({
        action: "referral_account_enabled",
        adminId: admin.sub || null,
        actorEmail: admin.email,
        targetType: "referral_account",
        targetId: updated.id,
        metadata: { customerId },
      })
      return ok({ referrer: updated })
    }

    if (action === "disable_referrer") {
      const customerId = String(body.referrerCustomerId || "").trim()
      if (!customerId) return badRequest("A referrer customer id is required")
      const account = await prisma.referralAccount.findUnique({ where: { customerId }, select: { id: true } })
      if (!account) return notFound("Referral account not found")
      const updated = await prisma.referralAccount.update({
        where: { id: account.id },
        data: { status: "disabled" },
      })
      await writeAuditLog({
        action: "referral_account_disabled",
        adminId: admin.sub || null,
        actorEmail: admin.email,
        targetType: "referral_account",
        targetId: updated.id,
        metadata: { customerId },
      })
      return ok({ referrer: updated })
    }

    return badRequest("Unsupported attribution action")
  } catch (error) {
    console.error("[ADMIN_REFERRAL_ATTRIBUTION]", error)
    return serverError("Unable to update referral attribution")
  }
}