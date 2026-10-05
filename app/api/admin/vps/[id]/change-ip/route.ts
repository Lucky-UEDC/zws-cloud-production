import { NextRequest, NextResponse } from "next/server"
import { getAdminFromCookies } from "@/lib/server-auth"
import { changePrimaryIp } from "@/lib/vm-network-orchestrator"
import { canAccessAdminApi } from "@/lib/admin-rbac"

const DEPRECATED_HEADERS = {
  "X-ZWS-Deprecated": "true",
  "X-ZWS-Replacement": "/api/admin/vms/:id/network/change-primary-ip",
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await getAdminFromCookies()
  if (!admin?.email || !canAccessAdminApi(admin.role)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401, headers: DEPRECATED_HEADERS })
  }

  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const ipAddress = String(body?.ipAddress || body?.targetIp || "").trim()
    if (!ipAddress) return NextResponse.json({ success: false, error: "ipAddress is required" }, { status: 400, headers: DEPRECATED_HEADERS })

    const result = await changePrimaryIp({
      vpsId: id,
      actorEmail: String(admin.email),
      targetIp: ipAddress,
      poolId: body?.poolId ? String(body.poolId) : null,
      // DNS is only applied when explicitly requested.
      applyDns: body?.applyDns === true,
      preserveOldIp: body?.preserveOldIp === true,
      reason: body?.reason ? String(body.reason) : "legacy_vps_change_ip_route",
      dryRun: body?.dryRun === true,
      confirmRisky: body?.confirmRisky === true,
      idempotencyKey: body?.idempotencyKey ? String(body.idempotencyKey) : null,
    })

    return NextResponse.json({
      success: Boolean(result?.success),
      result,
      deprecated: { route: "/api/admin/vps/[id]/change-ip", replacement: "/api/admin/vms/[id]/network/change-primary-ip" },
    }, { status: result?.requiresConfirmation ? 409 : 200, headers: DEPRECATED_HEADERS })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || "Failed to change IP" }, { status: 400, headers: DEPRECATED_HEADERS })
  }
}
