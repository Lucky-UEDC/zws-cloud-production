import { NextRequest, NextResponse } from "next/server"
import { getAdminFromCookies } from "@/lib/server-auth"
import { changePrimaryIp, switchIpPool } from "@/lib/vm-network-orchestrator"
import { blockWhenEnterpriseNetworkingDisabled } from "@/app/api/admin/vms/[id]/network/_enterprise-gate"
import { canAccessAdminApi } from "@/lib/admin-rbac"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await getAdminFromCookies()
  if (!admin?.email || !canAccessAdminApi(admin.role)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }
  const blocked = await blockWhenEnterpriseNetworkingDisabled()
  if (blocked) return blocked

  try {
    const body = await request.json().catch(() => ({}))
    const { id } = await params
    const forceOverride = body.forceOverride === true
    const manualIp = String(body.manualIp || "").trim()
    const selectedIp = String(body.selectedTargetIp || body.targetIp || body.ipAddress || "").trim()
    const resolvedTargetIp = manualIp || selectedIp
    const result = resolvedTargetIp
      ? await changePrimaryIp({
          vpsId: id,
          actorEmail: String(admin.email),
          actorRole: String(admin.role || ""),
          targetIp: resolvedTargetIp,
          poolId: body.poolId ? String(body.poolId) : null,
          manualGateway: body.manualGateway ? String(body.manualGateway) : null,
          manualCidr: body.manualCidr ?? null,
          manualDns: body.manualDns ? String(body.manualDns) : null,
          // DNS is only applied when explicitly requested; an IP change is
          // IPv4 + prefix + gateway only.
          applyDns: body.applyDns === true,
          preserveOldIp: body.preserveOldIp === true,
          forceOverride,
          reason: body.reason ? String(body.reason) : null,
          dryRun: body.dryRun === true,
          confirmRisky: body.confirmRisky === true,
          idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : null,
        })
      : await switchIpPool({
          vpsId: id,
          actorEmail: String(admin.email),
          actorRole: String(admin.role || ""),
          targetPoolId: String(body.poolId || "").trim(),
          requestedIp: null,
          manualGateway: body.manualGateway ? String(body.manualGateway) : null,
          manualCidr: body.manualCidr ?? null,
          manualDns: body.manualDns ? String(body.manualDns) : null,
          preserveOldIp: body.preserveOldIp === true,
          forceOverride,
          reason: body.reason ? String(body.reason) : null,
          dryRun: body.dryRun === true,
          confirmRisky: body.confirmRisky === true,
          idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : null,
        })
    return NextResponse.json(
      { success: Boolean(result?.success), error: result?.success ? null : result?.error || null, result },
      { status: result?.requiresConfirmation ? 409 : 200 },
    )
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || "Failed to change primary IP" }, { status: 400 })
  }
}
