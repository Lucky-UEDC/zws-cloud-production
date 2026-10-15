import { NextRequest, NextResponse } from "next/server"
import { getAdminFromCookies } from "@/lib/server-auth"
import { canAccessAdminApi } from "@/lib/admin-rbac"
import { createPanelLog } from "@/lib/panel-log"
import { createProxmoxClient, PROXMOX_INVENTORY_TIMEOUT_MS } from "@/lib/proxmox"
import { decryptSecretValue, isEncryptedSecret } from "@/lib/secret-crypto"
import { discoverFleet, nodeHealthStatus, summariseFeatureCoverage, type DiscoveredNode } from "@/lib/proxmox/node-discovery"
import { fullAclSetupGuide } from "@/lib/proxmox/permission-requirements"
import { validateProxmoxHost, assertProxmoxTransportAllowed } from "@/lib/proxmox/host-validation"
import { NO_CACHE_HEADERS, boolValue, textValue } from "../helpers"

/**
 * Discover every Proxmox node an API token can see, with a truthful health and
 * capability report for each.
 *
 * ## Why this exists
 *
 * The panel used to be told about one node at a time, with its name typed in by
 * hand, and every diagnostic probe was aimed at that one name. On a cluster that
 * produced two wrong answers: nodes nobody registered were invisible, and a node
 * whose status call was refused looked the same as a node that did not exist.
 *
 * This route takes a host and a token — or, with `?nodeId=`, the credentials
 * already stored for a registered node — and returns everything the cluster will
 * disclose, with each node classified as online, offline or inaccessible and
 * every denied check explained.
 *
 * Read-only. It calls only GET endpoints plus the two probe calls needed to test
 * console permission, which are POSTs that mint a short-lived ticket and change
 * nothing. It does not write to Proxmox, does not modify an ACL, and does not
 * register a node.
 */

export const dynamic = "force-dynamic"
export const revalidate = 0

type ResolveResult =
  | { ok: true; host: string; tokenId: string; tokenSecret: string; allowInsecureTls: boolean; nodeId: string | null }
  | { ok: false; status: number; error: string; code: string }

/**
 * Resolve the credentials to probe with.
 *
 * An administrator may pass a host and token directly (the wizard's
 * pre-flight, before anything is saved), or a `nodeId` to reuse what is already
 * stored. The token secret is decrypted here and never leaves the server.
 */
async function resolveCredentials(request: NextRequest): Promise<ResolveResult> {
  const params = request.nextUrl.searchParams
  const nodeId = textValue(params.get("nodeId"))
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {}
  const source: Record<string, unknown> = { ...body }

  if (nodeId) {
    const { prisma } = await import("@/lib/db")
    const node = await prisma.proxmoxNode.findUnique({ where: { id: nodeId } })
    if (!node) return { ok: false, status: 404, error: "Node not found", code: "NODE_NOT_FOUND" }
    return {
      ok: true,
      host: node.host,
      tokenId: node.tokenId,
      tokenSecret: isEncryptedSecret(node.tokenSecret) ? decryptSecretValue(node.tokenSecret) : node.tokenSecret,
      allowInsecureTls: node.allowInsecureTls,
      nodeId: node.id,
    }
  }

  const host = textValue(source.host)
  const tokenId = textValue(source.tokenId)
  const tokenSecret = textValue(source.tokenSecret)
  const missing = [host && "host", tokenId && "tokenId", tokenSecret && "tokenSecret"].filter((entry) => !entry)
  if (missing.length) {
    return {
      ok: false,
      status: 400,
      error: `Missing required fields: ${missing.join(", ")}. Pass them in the request body, or a nodeId to reuse stored credentials.`,
      code: "INVALID_REQUEST",
    }
  }

  const validation = validateProxmoxHost(host)
  if (!validation.ok) return { ok: false, status: 400, error: validation.reason, code: validation.code }

  const allowInsecureTls = boolValue(source.allowInsecureTls)
  const transport = assertProxmoxTransportAllowed(validation, allowInsecureTls)
  if (!transport.allowed) return { ok: false, status: 400, error: transport.reason, code: "INSECURE_TRANSPORT" }

  return {
    ok: true,
    host: validation.host,
    tokenId,
    tokenSecret: isEncryptedSecret(tokenSecret) ? decryptSecretValue(tokenSecret) : tokenSecret,
    allowInsecureTls,
    nodeId: null,
  }
}

/** Attach the derived health verdict to each discovered node. */
function withHealth(nodes: DiscoveredNode[]) {
  return nodes.map((node) => {
    const health = nodeHealthStatus(node)
    return {
      ...node,
      health: {
        status: health.status,
        statusLabel: health.status.replace("_", " "),
        reasons: health.reasons,
        remediation: [...new Set(health.remediation)],
      },
    }
  })
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}

async function handle(request: NextRequest) {
  const admin = await getAdminFromCookies()
  if (!admin?.email || !canAccessAdminApi(admin.role)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401, headers: NO_CACHE_HEADERS })
  }

  const credentials = await resolveCredentials(request)
  if (!credentials.ok) {
    return NextResponse.json({ success: false, error: credentials.error, code: credentials.code }, { status: credentials.status, headers: NO_CACHE_HEADERS })
  }

  try {
    const client = createProxmoxClient(credentials.host, credentials.tokenId, credentials.tokenSecret, {
      allowInsecureTls: credentials.allowInsecureTls,
      timeoutMs: PROXMOX_INVENTORY_TIMEOUT_MS,
    })

    const report = await discoverFleet({
      client: {
        getNodes: () => client.getNodes() as any,
        getNodeStats: (node) => client.getNodeStats(node),
        getVMs: (node) => client.getVMs(node),
        getStorages: (node) => client.getStorages(node),
        // Bounded: only the VMs this token can already see, and only their disk
        // definitions, which is what turns "a dir storage exists" into "this dir
        // storage holds raw disks".
        getVMConfigs: async (node, vmIds) => {
          const configs = await Promise.allSettled(vmIds.slice(0, 60).map((vmid) => client.getVMConfig(node, vmid)))
          return configs.filter((entry): entry is PromiseFulfilledResult<any> => entry.status === "fulfilled").map((entry) => entry.value)
        },
        // Mints a ticket and immediately lets it expire. Nothing on the VM is
        // changed, and this is the only way to know whether VM.Console is granted
        // rather than guessing from a config read.
        probeConsole: async (node, vmid, kind) => {
          try {
            await client.requestWithStatus(
              `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/${kind}`,
              "POST",
              kind === "vncproxy" ? { websocket: 1 } : { serial: 0 },
              PROXMOX_INVENTORY_TIMEOUT_MS
            )
            return { ok: true, denied: false, message: "ticket granted" }
          } catch (error: any) {
            const denied = error?.code === "PERMISSION_DENIED_403" || error?.httpStatus === 403
            return {
              ok: false,
              denied,
              message: String(error?.message || "console probe failed").replace(/PVEAPIToken=[^\s"'<>]+/gi, "PVEAPIToken=[redacted]"),
            }
          }
        },
      },
      clusterChecks: {
        status: () => client.getClusterStatus(),
        resources: () => client.getClusterResources(),
      },
    })

    if (report.counts.discovered > 0) {
      await createPanelLog({
        category: "Compute Node",
        message: `Proxmox discovery: ${report.counts.discovered} node(s) — ${report.counts.online} online, ${report.counts.offline} offline, ${report.counts.inaccessible} inaccessible`,
        actorType: "admin",
        actorEmail: String(admin.email),
        metadata: {
          nodeId: credentials.nodeId,
          host: credentials.host,
          ...report.counts,
        },
      })
    }

    return NextResponse.json(
      {
        success: true,
        host: credentials.host,
        counts: report.counts,
        visibilityNote: report.visibilityNote,
        cluster: report.cluster,
        coverage: summariseFeatureCoverage(report),
        nodes: withHealth(report.nodes),
        // The least-privilege grant for each feature, so an administrator can see
        // exactly what to run rather than guessing at `pveacl`.
        aclSetup: fullAclSetupGuide(),
      },
      { headers: NO_CACHE_HEADERS }
    )
  } catch (error: any) {
    await createPanelLog({
      category: "Compute Node",
      level: "error",
      message: "Proxmox discovery failed",
      actorType: "admin",
      actorEmail: String(admin.email),
      metadata: { nodeId: credentials.nodeId, host: credentials.host, error: String(error?.message || "unknown error") },
    })
    return NextResponse.json(
      {
        success: false,
        error: "Discovery could not complete",
        code: String(error?.code || "UNKNOWN_ERROR"),
        // The classified error, not the raw body: Proxmox echoes the offending
        // token into some error bodies.
        detail: String(error?.message || "unknown error").replace(/PVEAPIToken=[^\s"'<>]+/gi, "PVEAPIToken=[redacted]"),
      },
      { status: 502, headers: NO_CACHE_HEADERS }
    )
  }
}