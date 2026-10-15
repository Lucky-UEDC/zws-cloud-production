import { NextResponse } from "next/server"
import { normalizeProxmoxHost, PROXMOX_VALIDATION_TIMEOUT_MS, ProxmoxError, runProxmoxDiagnostics, type ProxmoxDiagnosticStep } from "@/lib/proxmox/client"
import { decryptSecretValue, isEncryptedSecret } from "@/lib/secret-crypto"

export const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
}

export type ProxmoxNodePayload = {
  name?: unknown
  host?: unknown
  nodeName?: unknown
  tokenId?: unknown
  tokenSecret?: unknown
  location?: unknown
  allowInsecureTls?: unknown
}

export function nodeResponse(node: any) {
  return {
    // The cached capability verdict, so the node list can say "Ready" or say why
    // not without re-measuring every node on every page load.
    guestCapabilities: summariseCachedCapabilities(node?.guestCapabilities),
    id: node.id,
    name: node.name,
    host: node.host,
    nodeName: node.nodeName,
    isActive: node.isActive,
    schedulingEnabled: node.schedulingEnabled !== false,
    drainReason: node.drainReason || null,
    drainedAt: node.drainedAt || null,
    location: node.location,
    status: node.status,
    lastCheckedAt: node.lastCheckedAt,
    allowInsecureTls: node.allowInsecureTls,
    resolvedIp: node.resolvedIp || null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    hasTokenId: Boolean(node.tokenId),
    hasTokenSecret: Boolean(node.tokenSecret),
    templatesCount: Number(node?.templatesCount ?? node?._count?.templates ?? 0),
  }
}

/**
 * A one-line capability verdict from a cached row.
 *
 * Returns `pending` when nothing has been measured, which is deliberately not
 * the same as ready: a node whose guest capabilities have never been checked is
 * not known to be usable.
 */
function summariseCachedCapabilities(row: any) {
  const status = String(row?.status || "pending")
  const checks = Array.isArray(row?.checks) ? row.checks : []
  return {
    status,
    pass: checks.filter((entry: any) => entry?.state === "pass").length,
    fail: checks.filter((entry: any) => entry?.state === "fail").length,
    skip: checks.filter((entry: any) => entry?.state === "skip").length,
    total: checks.length,
    lastCheckedAt: row?.lastCheckedAt || null,
    lastSuccessAt: row?.lastSuccessAt || null,
    // A report older than half an hour is a claim nobody verified in this
    // session, so the UI shows it as stale rather than as current.
    stale: row?.lastCheckedAt ? Date.now() - new Date(row.lastCheckedAt).getTime() > 30 * 60 * 1000 : true,
    lastError: row?.lastError || null,
  }
}

export function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

export function boolValue(value: unknown) {
  return value === true || value === "true" || value === "on"
}

function stepByName(steps: ProxmoxDiagnosticStep[], pattern: RegExp) {
  return steps.find((step) => pattern.test(step.name))
}

export function diagnosticSummary(steps: ProxmoxDiagnosticStep[] = [], ok = false) {
  const dns = stepByName(steps, /DNS/i)
  const tcp = stepByName(steps, /TCP/i)
  const tls = stepByName(steps, /TLS/i)
  const api = steps.find((step) => step.endpoint === "/api2/json/cluster/resources") || steps.find((step) => /HTTPS GET/i.test(step.name))
  const authFailure = steps.find((step) => step.code === "AUTH_FAILED_401" || step.code === "PERMISSION_DENIED_403")
  const certFailure = steps.find((step) => step.code === "TLS_CERT_ERROR" || step.code === "TLS_HANDSHAKE_ERROR")
  return {
    online: ok,
    syncStatus: ok ? "connected" : "failed",
    dnsLatencyMs: dns?.durationMs ?? null,
    tcpLatencyMs: tcp?.durationMs ?? null,
    tlsLatencyMs: tls?.durationMs ?? null,
    apiLatencyMs: api?.durationMs ?? null,
    websocketLatencyMs: null,
    tokenValidity: authFailure ? "invalid" : ok ? "valid" : "unknown",
    certificateValidity: certFailure ? "invalid" : tls?.ok ? "valid" : "unknown",
    lastSuccessfulRequestAt: ok ? new Date().toISOString() : null,
  }
}

export function requiredConnectionFields(payload: ProxmoxNodePayload, requireSecret = true) {
  const missing = []
  if (!textValue(payload.name)) missing.push("name")
  if (!textValue(payload.host)) missing.push("host")
  if (!textValue(payload.nodeName)) missing.push("nodeName")
  if (requireSecret && !textValue(payload.tokenId)) missing.push("tokenId")
  if (requireSecret && !textValue(payload.tokenSecret)) missing.push("tokenSecret")
  return missing
}

export async function testProxmoxConnection(input: {
  host: string
  tokenId: string
  tokenSecret: string
  nodeName: string
  allowInsecureTls: boolean
  adminEmail?: string
  timeoutMs?: number
}) {
  const normalizedHost = normalizeProxmoxHost(input.host)

  // Decrypt token secret if it's encrypted
  const decryptedTokenSecret = isEncryptedSecret(input.tokenSecret)
    ? decryptSecretValue(input.tokenSecret)
    : input.tokenSecret

  const diagnostic = await runProxmoxDiagnostics({
    host: normalizedHost,
    nodeName: input.nodeName,
    tokenId: input.tokenId,
    tokenSecret: decryptedTokenSecret,
    allowInsecureTls: input.allowInsecureTls,
    timeoutMs: input.timeoutMs || PROXMOX_VALIDATION_TIMEOUT_MS,
  })

  // `diagnostic.ok` means the API is reachable and the token authenticated. It
  // no longer means "every check passed": a token that is correctly denied
  // `Sys.Audit` is connected and usable, and treating the denial as a failure is
  // what made the wizard reject a working least-privilege configuration.
  if (diagnostic.ok) {
    return {
      success: true,
      ok: true,
      degraded: diagnostic.degraded,
      permissionDeniedEndpoints: diagnostic.permissionDeniedEndpoints,
      failedEndpoints: diagnostic.failedEndpoints,
      host: normalizedHost,
      nodes: diagnostic.nodes,
      matchedNode: diagnostic.matchedNode,
      steps: diagnostic.steps,
      diagnostics: diagnosticSummary(diagnostic.steps, true),
      resolvedIp: resolvedIpFromDiagnosticSteps(diagnostic.steps),
      message: diagnostic.message,
      code: diagnostic.code,
    }
  }

  const error = new ProxmoxError(502, diagnostic.message, {
    layer: "diagnostic",
    code: diagnostic.code === "OK" ? "UNKNOWN_ERROR" : diagnostic.code,
  })
  ;(error as any).steps = diagnostic.steps
  ;(error as any).diagnostic = diagnostic
  ;(error as any).diagnostics = diagnosticSummary(diagnostic.steps, false)
  throw error
}

export function resolvedIpFromDiagnosticSteps(steps: ProxmoxDiagnosticStep[] = []) {
  const dns = steps.find((step) => step.name === "DNS resolve host")
  return dns?.address || dns?.addresses?.[0] || null
}

export function errorResponse(error: any) {
  const status = error?.status && Number.isInteger(error.status) ? error.status : 500
  const message = String(error?.message || "Unexpected server error")
    .replace(/PVEAPIToken=[^\s"'<>]+/gi, "PVEAPIToken=[redacted]")
    .replace(/PVEAuthCookie=[^;\s"'<>]+/gi, "PVEAuthCookie=[redacted]")
    .replace(/(tokenSecret|secret)["':=\s]+[^"',\s}]+/gi, "$1=[redacted]")
  return NextResponse.json(
    {
      success: false,
      ok: false,
      error: message,
      code: error?.code || "UNKNOWN_ERROR",
      diagnostics: error?.diagnostics || (error?.steps || error?.diagnostic?.steps ? diagnosticSummary(error?.steps || error?.diagnostic?.steps || [], false) : undefined),
      steps: error?.steps || error?.diagnostic?.steps || undefined,
    },
    { status, headers: NO_CACHE_HEADERS }
  )
}
