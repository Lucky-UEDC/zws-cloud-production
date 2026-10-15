import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db"
import { canAccessAdminApi } from "@/lib/admin-rbac"
import { PROXMOX_VALIDATION_TIMEOUT_MS, runProxmoxDiagnostics } from "@/lib/proxmox/client"
import { getAdminFromCookies } from "@/lib/server-auth"

export const dynamic = "force-dynamic"
export const revalidate = 0

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
}

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function boolValue(value: unknown) {
  return value === true || value === "true" || value === "on"
}

function safeProxmoxErrorMessage(value: unknown) {
  return String(value || "Proxmox diagnostic failed")
    .replace(/PVEAPIToken=[^\s"'<>]+/gi, "PVEAPIToken=[redacted]")
    .replace(/PVEAuthCookie=[^;\s"'<>]+/gi, "PVEAuthCookie=[redacted]")
    .replace(/(tokenSecret|secret)["':=\s]+[^"',\s}]+/gi, "$1=[redacted]")
}

function resolvedIpFromSteps(steps: Array<{ name?: string; address?: string | null; addresses?: string[] }>) {
  const dns = steps.find((step) => step.name === "DNS resolve host")
  return dns?.address || dns?.addresses?.[0] || null
}

export async function POST(request: NextRequest) {
  const admin = await getAdminFromCookies()
  if (!admin?.email || !canAccessAdminApi(admin.role)) {
    return NextResponse.json({ ok: false, success: false, error: "Unauthorized" }, { status: 401, headers: NO_CACHE_HEADERS })
  }

  const body = await request.json().catch(() => ({}))
  const id = textValue(body.id)
  const existing = id ? await prisma.proxmoxNode.findUnique({ where: { id } }) : null
  if (id && !existing) {
    return NextResponse.json({ ok: false, success: false, error: "Node not found", code: "NODE_NOT_FOUND", steps: [] }, { status: 404, headers: NO_CACHE_HEADERS })
  }

  const host = textValue(body.host) || existing?.host || ""
  const nodeName = textValue(body.nodeName) || existing?.nodeName || ""
  const tokenId = textValue(body.tokenId) || existing?.tokenId || ""
  const tokenSecret = textValue(body.tokenSecret) || existing?.tokenSecret || ""
  const allowInsecureTls = body.allowInsecureTls === undefined && existing ? existing.allowInsecureTls : boolValue(body.allowInsecureTls)

  const missing = []
  if (!host) missing.push("host")
  if (!nodeName) missing.push("nodeName")
  if (!tokenId) missing.push("tokenId")
  if (!tokenSecret) missing.push("tokenSecret")
  if (missing.length) {
    return NextResponse.json(
      { ok: false, success: false, error: `Missing required fields: ${missing.join(", ")}`, code: "UNKNOWN_ERROR", steps: [] },
      { status: 400, headers: NO_CACHE_HEADERS },
    )
  }

  try {
    const diagnostic = await runProxmoxDiagnostics({ host, nodeName, tokenId, tokenSecret, allowInsecureTls, timeoutMs: PROXMOX_VALIDATION_TIMEOUT_MS })
    // `diagnostic.ok` means the API is reachable and the token authenticated.
    // `diagnostic.degraded` means that held, but at least one check was refused
    // for want of permission — a correctly scoped token, not a broken one. Both
    // are a 200: the wizard must be able to save the node, and the denied
    // endpoints come back with it so the admin can see what to grant.
    return NextResponse.json(
      {
        ok: diagnostic.ok,
        success: diagnostic.ok,
        degraded: diagnostic.degraded,
        permissionDeniedEndpoints: diagnostic.permissionDeniedEndpoints,
        failedEndpoints: diagnostic.failedEndpoints,
        unmeasuredEndpoints: diagnostic.unmeasuredEndpoints,
        code: diagnostic.code,
        message: diagnostic.message,
        error: diagnostic.ok ? null : diagnostic.message,
        host: diagnostic.host,
        nodeName: diagnostic.nodeName,
        resolvedIp: resolvedIpFromSteps(diagnostic.steps),
        nodes: diagnostic.nodes,
        matchedNode: diagnostic.matchedNode,
        steps: diagnostic.steps,
      },
      { status: diagnostic.ok ? 200 : 400, headers: NO_CACHE_HEADERS },
    )
  } catch (error: any) {
    const message = safeProxmoxErrorMessage(error?.message)
    return NextResponse.json(
      {
        ok: false,
        success: false,
        code: error?.code || "UNKNOWN_ERROR",
        error: message,
        message,
        steps: error?.steps || error?.diagnostic?.steps || [],
      },
      { status: error?.status || 500, headers: NO_CACHE_HEADERS },
    )
  }
}
