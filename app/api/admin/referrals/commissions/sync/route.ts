import type { NextRequest } from "next/server"
import { loadAdminReferralContext } from "@/lib/referrals/admin-http"
import { badRequest, loadAdminIdentity, ok, serverError, unauthorized } from "@/lib/referrals/http"
import { syncAndReverse } from "@/lib/referrals/sync"
import { requireSameOriginOrCsrf } from "@/lib/auth/guards"
import { requireSensitiveAdminMfa } from "@/lib/admin-sensitive-action"
import { writeAuditLog } from "@/lib/audit-log"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Materialises the commission ledger from authoritative invoices and reverses
 * pending rows whose transaction stopped qualifying.
 *
 * Reporting does not depend on this having run - it falls back to computing
 * commission live - but running it turns "pending" into a durable, payable row
 * that can then be marked paid or reversed by an operator. Because it creates
 * money-bearing rows, it is gated like any other write.
 */
export async function POST(request: NextRequest) {
  const origin = await requireSameOriginOrCsrf(request)
  if (!origin.ok) return origin.response

  const stepUp = await requireSensitiveAdminMfa(request)
  if (!stepUp.ok) return stepUp.response

  const adminEmail = String(stepUp.session.email || "")
  if (!adminEmail) return unauthorized("Administrator authorization required")

  const loaded = await loadAdminReferralContext(request)
  if (!loaded.ok) return loaded.response
  const { context } = loaded

  const body = (await request.json().catch(() => ({}))) as { scope?: string }
  const scopeName = String(body.scope || "all").toLowerCase()
  if (!["all", "window"].includes(scopeName)) return badRequest("Unsupported sync scope")

  try {
    const result = await syncAndReverse({
      start: scopeName === "window" ? context.window.start : null,
      end: scopeName === "window" ? context.window.end : null,
      referrerCustomerId: context.filters.referrerCustomerId || null,
      limit: 5000,
    })

    await writeAuditLog({
      action: "referral_commission_sync",
      actorEmail: adminEmail,
      metadata: {
        scope: scopeName,
        created: result.synced.created,
        updated: result.synced.updated,
        reversed: result.reversed,
        scanned: result.synced.scanned,
      },
    }).catch(() => null)

    return ok({ result })
  } catch (error) {
    console.error("[ADMIN_REFERRALS_COMMISSION_SYNC]", error)
    return serverError()
  }
}