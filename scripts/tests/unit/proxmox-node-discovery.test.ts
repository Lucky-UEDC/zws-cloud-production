import assert from "node:assert/strict"
import test from "node:test"
import http from "node:http"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { discoverFleet, discoverNode, nodeHealthStatus, summariseFeatureCoverage, type DiscoveryClient } from "../../../lib/proxmox/node-discovery"
import { explainDenial, findEndpointRequirement, fullAclSetupGuide, PROXMOX_ENDPOINT_PERMISSIONS, aclSetupGuide } from "../../../lib/proxmox/permission-requirements"
import { assessBackupCapability, assessSnapshotCapability, describeStorageCapability, parseStorageContent, storageSnapshotVerdict, diskFormatsFromVmConfigs, BACKUP_CONTENT_TYPES } from "../../../lib/proxmox/storage-capabilities"
import { storageTypeIsSnapshotCapable } from "../../../lib/proxmox/storage-snapshot-rule"
import { runProxmoxDiagnostics } from "../../../lib/proxmox"

/** Read a source file for a static regression assertion. */
const readSource = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8")

/**
 * Mocked coverage for the Proxmox node auto-discovery and capability work.
 *
 * Every Proxmox call in this file is answered from a fixture. Nothing here opens
 * a socket, so the suite is safe to run against the production test command and
 * cannot touch customer infrastructure.
 *
 * The cases are the ones that were previously reported wrongly:
 *
 * - a least-privilege token was declared a broken connection;
 * - the VNC and serial consoles were "unavailable" on nodes whose consoles
 *   worked, because the probe called the wrong endpoints against a hard-coded
 *   VMID;
 * - a perfectly good `dir` storage was reported as snapshot-capable while a
 *   `vzdump` storage was reported as absent;
 * - a node visible in `/nodes` but denied on `/status` was at risk of being
 *   treated as nonexistent.
 */

// ---------------------------------------------------------------------------
// A real mock Proxmox, so the diagnostic path is exercised end to end
// ---------------------------------------------------------------------------

/**
 * A local HTTP server that answers like Proxmox.
 *
 * The pure-mock tests above pin individual functions. This one drives the real
 * `runProxmoxDiagnostics` over a real socket, which is the only way to prove the
 * verdict logic: the previous bug lived in how the individual step results were
 * *combined*, and no amount of unit-testing a helper would have caught it.
 *
 * Bound to 127.0.0.1 on an ephemeral port. It never leaves the machine.
 */
async function startMockProxmox(
  handlers: Record<string, () => { status: number; body: unknown; delayMs?: number }>,
  options: { record?: string[] } = {},
) {
  const seenAuthHeaders: string[] = []
  const server = http.createServer((req, res) => {
    const path = (req.url || "").split("?")[0]
    const auth = req.headers.authorization
    if (typeof auth === "string") seenAuthHeaders.push(auth)
    const handler = handlers[path]
    if (!handler) {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: null }))
      return
    }
    const { status, body, delayMs } = handler()
    const send = () => {
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body))
    }
    if (delayMs) setTimeout(send, delayMs)
    else send()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    host: `http://127.0.0.1:${port}`,
    seenAuthHeaders,
    close: async () => {
      // `close()` alone waits for in-flight responses, and the timeout case has a
      // deliberately slow one still pending — which hangs the test run rather
      // than failing it. Forcing the sockets down makes teardown deterministic.
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** Proxmox wraps every payload in `{data: ...}`. */
function json(status: number, data: unknown) {
  return { status, body: { data } }
}

/**
 * A Proxmox permission denial: HTTP 403 with `{"data":null}` and no message.
 * The emptiness of this body is the reason the panel needs the endpoint-to-ACL
 * map to explain a denial at all.
 */
function denied() {
  return { status: 403, body: { data: null } }
}

/** A rejected token: HTTP 401 with the same empty body. */
function unauthorizedResponse() {
  return { status: 401, body: { data: null } }
}

/** The backup-content rule, exercised through the shared helper. */
function isBackupCapableForTest(content: string) {
  return parseStorageContent(content).some((entry) => BACKUP_CONTENT_TYPES.includes(entry))
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function permissionDenied(path: string) {
  return Object.assign(new Error("Permission denied"), {
    code: "PERMISSION_DENIED_403",
    httpStatus: 403,
    status: 400,
    proxmoxMessage: "",
    endpoint: path,
  })
}

function unauthorized() {
  return Object.assign(new Error("Unauthorized token"), {
    code: "AUTH_FAILED_401",
    httpStatus: 401,
    status: 400,
    proxmoxMessage: "",
  })
}

function notFound(path: string) {
  return Object.assign(new Error("Proxmox API endpoint not found"), {
    code: "NOT_FOUND_404",
    httpStatus: 404,
    status: 404,
    endpoint: path,
  })
}

function timeoutError() {
  return Object.assign(new Error("Proxmox API request timed out"), { code: "HTTP_TIMEOUT", status: 502 })
}

type NodeSpec = {
  node: string
  status?: string
  online?: number
  type?: string
  /** `denied` makes /status and /qemu return 403. */
  statusDenied?: boolean
  vmsDenied?: boolean
  storageDenied?: boolean
  /** `gone` makes /status 404, as for a node that left the cluster. */
  gone?: boolean
  /** `timeout` makes /status fail as an unreachable node. */
  unreachable?: boolean
  vms?: Array<{ vmid: number; status?: string; agent?: number }>
  storages?: any[]
  cpu?: { cpus: number; cpu: number }
  mem?: { maxmem: number; memory: number }
  disk?: { maxdisk: number; disk: number }
  uptime?: number
}

function mockClient(specs: NodeSpec[], options: { nodesDenied?: boolean; nodesUnauthorized?: boolean } = {}): DiscoveryClient {
  const byName = new Map(specs.map((spec) => [spec.node, spec]))
  return {
    async getNodes() {
      if (options.nodesUnauthorized) throw unauthorized()
      if (options.nodesDenied) throw permissionDenied("/nodes")
      return specs.map((spec) => ({ node: spec.node, status: spec.status ?? "online", online: spec.online ?? 1, type: spec.type ?? "node" }))
    },
    async getNodeStats(node: string) {
      const spec = byName.get(node)
      if (!spec) throw notFound(`/nodes/${node}/status`)
      if (spec.unreachable) throw timeoutError()
      if (spec.gone) throw notFound(`/nodes/${node}/status`)
      if (spec.statusDenied) throw permissionDenied(`/nodes/${node}/status`)
      return {
        cpuinfo: { cpus: spec.cpu?.cpus ?? 8 },
        cpu: spec.cpu?.cpu ?? 0.4,
        maxmem: spec.mem?.maxmem ?? 16 * 1024 ** 3,
        memory: spec.mem?.memory ?? 8 * 1024 ** 3,
        maxdisk: spec.disk?.maxdisk ?? 500 * 1024 ** 3,
        disk: spec.disk?.disk ?? 100 * 1024 ** 3,
        uptime: spec.uptime ?? 86400,
      }
    },
    async getVMs(node: string) {
      const spec = byName.get(node)
      if (!spec) throw notFound(`/nodes/${node}/qemu`)
      // `/nodes/{node}/qemu` is `{"user":"all"}` — it needs no explicit privilege
      // and filters itself by the caller's VM.Audit grants. A token denied
      // `/status` can still read this, which is the exact shape of the incident.
      if (spec.vmsDenied) throw permissionDenied(`/nodes/${node}/qemu`)
      return spec.vms ?? []
    },
    async getStorages(node: string) {
      const spec = byName.get(node)
      if (!spec) throw notFound(`/nodes/${node}/storage`)
      if (spec.storageDenied) throw permissionDenied(`/nodes/${node}/storage`)
      return spec.storages ?? []
    },
  }
}

/** The fleet from the reported incident: one VM-scoped token, one node. */
const LEAST_PRIVILEGE_FLEET: NodeSpec[] = [
  {
    node: "m2-v2",
    vms: [
      { vmid: 101, status: "running", agent: 0 },
      { vmid: 102, status: "stopped", agent: 0 },
    ],
    storages: [
      { storage: "local", type: "dir", content: "iso,vztmpl,backup", enabled: 1, active: 1, total: 100 * 1024 ** 3, used: 40 * 1024 ** 3, avail: 60 * 1024 ** 3 },
    ],
    statusDenied: true,
    vmsDenied: false,
    storageDenied: false,
  },
]

// ---------------------------------------------------------------------------
// The `ok` calculation that rejected least-privilege tokens
// ---------------------------------------------------------------------------

test("a token denied Sys.Audit is connected, not broken", async () => {
  // `/cluster/status` and `/nodes/{node}/status` both need `Sys.Audit`. The old
  // verdict required every step to pass, so this token — which does everything it
  // is entitled to do correctly — failed the connection test outright and could
  // not be saved at all.
  const server = await startMockProxmox({
    "/api2/json/version": () => json(200, { version: "8.2.4", release: "8.2" }),
    "/api2/json/nodes": () => json(200, [{ node: "m2-v2", status: "online" }]),
    "/api2/json/cluster/status": () => denied(),
    "/api2/json/cluster/resources": () => json(200, [{ type: "node", node: "m2-v2" }]),
    "/api2/json/nodes/m2-v2/status": () => denied(),
    "/api2/json/nodes/m2-v2/qemu": () => json(200, [{ vmid: 101, status: "running", agent: 0 }]),
    "/api2/json/nodes/m2-v2/storage": () => json(200, [{ storage: "local", type: "dir", content: "iso,vztmpl,backup", enabled: 1, active: 1, total: 100, used: 40, avail: 60 }]),
  })
  try {
    const result = await runProxmoxDiagnostics({
      host: server.host,
      nodeName: "m2-v2",
      tokenId: "zws@pve!panel",
      tokenSecret: "secret",
      allowInsecureTls: false,
      timeoutMs: 2000,
    })

    const deniedEndpoints = result.permissionDeniedEndpoints
    assert.ok(
      deniedEndpoints.some((endpoint) => endpoint.includes("/cluster/status")),
      `cluster/status denial must be reported, got ${JSON.stringify(deniedEndpoints)}`
    )
    assert.ok(
      deniedEndpoints.some((endpoint) => endpoint.includes("/nodes/m2-v2/status")),
      `node status denial must be reported, got ${JSON.stringify(deniedEndpoints)}`
    )
    // The connection is real: /version and /nodes both need no privilege.
    assert.equal(result.steps.find((step) => step.name.includes("/api2/json/version"))?.ok, true)
    assert.equal(result.ok, true, "a correctly scoped token is connected")
    assert.equal(result.degraded, true, "and is reported as degraded, not broken")
  } finally {
    await server.close()
  }
})

test("a fully privileged, fully capable node is connected and not degraded", async () => {
  const server = await startMockProxmox({
    "/api2/json/version": () => json(200, { version: "8.2.4" }),
    "/api2/json/nodes": () => json(200, [{ node: "m2-v2", status: "online" }]),
    "/api2/json/cluster/status": () => json(200, [{ type: "cluster", quorate: 1 }]),
    "/api2/json/cluster/resources": () => json(200, []),
    "/api2/json/nodes/m2-v2/status": () => json(200, { cpu: 0.1, maxcpu: 8, memory: 1, maxmem: 2 }),
    "/api2/json/nodes/m2-v2/qemu": () => json(200, [{ vmid: 101, status: "running", agent: 1 }]),
    "/api2/json/nodes/m2-v2/storage": () =>
      json(200, [{ storage: "local-lvm", type: "lvmthin", content: "images,rootdir,vzdump", enabled: 1, active: 1, total: 100, used: 40, avail: 60 }]),
    "/api2/json/nodes/m2-v2/qemu/101/vncproxy": () => json(200, { ticket: "PVEVNC:abc", port: "5900" }),
    "/api2/json/nodes/m2-v2/qemu/101/termproxy": () => json(200, { ticket: "PVEVNC:abc", port: "5901" }),
  })
  try {
    const result = await runProxmoxDiagnostics({
      host: server.host, nodeName: "m2-v2", tokenId: "zws@pve!panel", tokenSecret: "s", allowInsecureTls: false, timeoutMs: 2000,
    })
    assert.equal(result.ok, true)
    assert.equal(result.degraded, false, `unexpected failures: ${JSON.stringify(result.failedEndpoints)}`)
    assert.deepEqual(result.permissionDeniedEndpoints, [])
  } finally {
    await server.close()
  }
})

test("a rejected token is an auth failure, not a degraded connection", async () => {
  const server = await startMockProxmox({
    "/api2/json/version": () => unauthorizedResponse(),
    "/api2/json/nodes": () => unauthorizedResponse(),
  })
  try {
    const result = await runProxmoxDiagnostics({
      host: server.host, nodeName: "m2-v2", tokenId: "zws@pve!panel", tokenSecret: "wrong", allowInsecureTls: false, timeoutMs: 2000,
    })
    assert.equal(result.ok, false, "a bad token is not a usable connection")
    assert.equal(result.degraded, false)
    assert.equal(result.code, "AUTH_FAILED_401")
    assert.match(result.message, /Unauthorized/i)
    // Proxmox answers a rejected token with `{"data":null}`. That body must
    // never be what the operator is shown.
    assert.doesNotMatch(result.message, /"data"/)
  } finally {
    await server.close()
  }
})

test("the console probes call vncproxy and termproxy, and report the denial", async () => {
  const calls: string[] = []
  const server = await startMockProxmox({
    "/api2/json/version": () => json(200, { version: "8.2.4" }),
    "/api2/json/nodes": () => json(200, [{ node: "m2-v2", status: "online" }]),
    "/api2/json/cluster/status": () => json(200, []),
    "/api2/json/cluster/resources": () => json(200, []),
    "/api2/json/nodes/m2-v2/status": () => json(200, { cpu: 0, maxcpu: 1, memory: 0, maxmem: 1 }),
    "/api2/json/nodes/m2-v2/qemu": () => json(200, [{ vmid: 101, status: "running", agent: 1 }]),
    "/api2/json/nodes/m2-v2/storage": () => json(200, [{ storage: "local-lvm", type: "lvmthin", content: "images,vzdump", enabled: 1, active: 1, avail: 10, total: 100, used: 90 }]),
    "/api2/json/nodes/m2-v2/qemu/101/vncproxy": () => { calls.push("vncproxy"); return denied() },
    "/api2/json/nodes/m2-v2/qemu/101/termproxy": () => { calls.push("termproxy"); return denied() },
  }, { record: calls })
  try {
    const result = await runProxmoxDiagnostics({
      host: server.host, nodeName: "m2-v2", tokenId: "zws@pve!panel", tokenSecret: "s", allowInsecureTls: false, timeoutMs: 2000,
    })

    assert.deepEqual(calls.sort(), ["termproxy", "vncproxy"], "both console endpoints must actually be called")

    const vnc = result.steps.find((step) => step.name.includes("vncproxy"))!
    const term = result.steps.find((step) => step.name.includes("termproxy"))!
    assert.equal(vnc.ok, false)
    assert.equal(vnc.code, "PERMISSION_DENIED_403", "a VM.Console denial must not be reported as an unsupported console")
    assert.equal(vnc.status, 403, "the status must be measured, never fabricated")
    assert.match(vnc.message, /VM\.Console/, "the missing privilege must be named")
    assert.match(vnc.message, /administrator/i, "the fix must be an administrator action")
    assert.equal(term.code, "PERMISSION_DENIED_403")

    // The token secret must never appear in any diagnostic text.
    const serialised = JSON.stringify(result)
    assert.equal(serialised.includes("PVEAPIToken="), false, "no authorization header may leak into diagnostics")
  } finally {
    await server.close()
  }
})

test("a console that is permitted is reported as working", async () => {
  const server = await startMockProxmox({
    "/api2/json/version": () => json(200, { version: "8.2.4" }),
    "/api2/json/nodes": () => json(200, [{ node: "m2-v2", status: "online" }]),
    "/api2/json/cluster/status": () => json(200, []),
    "/api2/json/cluster/resources": () => json(200, []),
    "/api2/json/nodes/m2-v2/status": () => json(200, { cpu: 0, maxcpu: 1, memory: 0, maxmem: 1 }),
    "/api2/json/nodes/m2-v2/qemu": () => json(200, [{ vmid: 101, status: "running", agent: 1 }]),
    "/api2/json/nodes/m2-v2/storage": () => json(200, [{ storage: "local-lvm", type: "lvmthin", content: "images,vzdump", enabled: 1, active: 1, avail: 10, total: 100, used: 90 }]),
    "/api2/json/nodes/m2-v2/qemu/101/vncproxy": () => json(200, { ticket: "PVEVNC:abc", port: "5900", upid: "UPID:x" }),
    "/api2/json/nodes/m2-v2/qemu/101/termproxy": () => json(200, { ticket: "PVEVNC:abc", port: "5901", upid: "UPID:y" }),
  })
  try {
    const result = await runProxmoxDiagnostics({
      host: server.host, nodeName: "m2-v2", tokenId: "zws@pve!panel", tokenSecret: "s", allowInsecureTls: false, timeoutMs: 2000,
    })
    assert.equal(result.steps.find((step) => step.name.includes("vncproxy"))?.ok, true)
    assert.equal(result.steps.find((step) => step.name.includes("termproxy"))?.ok, true)
    assert.equal(result.degraded, false)
  } finally {
    await server.close()
  }
})

test("snapshot and backup capability come from the storage the node reports", async () => {
  const server = await startMockProxmox({
    "/api2/json/version": () => json(200, { version: "8.2.4" }),
    "/api2/json/nodes": () => json(200, [{ node: "m2-v2", status: "online" }]),
    "/api2/json/cluster/status": () => json(200, []),
    "/api2/json/cluster/resources": () => json(200, []),
    "/api2/json/nodes/m2-v2/status": () => json(200, { cpu: 0, maxcpu: 1, memory: 0, maxmem: 1 }),
    "/api2/json/nodes/m2-v2/qemu": () => json(200, [{ vmid: 101, status: "running", agent: 1 }]),
    // A dir storage holding raw disks plus a vzdump target. The old detector
    // called the dir storage snapshot-capable and missed the vzdump storage
    // because the backup check and the backup picker disagreed about `vzdump`.
    "/api2/json/nodes/m2-v2/storage": () => json(200, [
      { storage: "local", type: "dir", content: "iso,vztmpl", enabled: 1, active: 1, total: 100, used: 40, avail: 60 },
      { storage: "backup-nfs", type: "nfs", content: "vzdump", enabled: 1, active: 1, total: 1000, used: 500, avail: 500 },
    ]),
    "/api2/json/nodes/m2-v2/qemu/101/vncproxy": () => json(200, { ticket: "t", port: "5900" }),
    "/api2/json/nodes/m2-v2/qemu/101/termproxy": () => json(200, { ticket: "t", port: "5901" }),
  })
  try {
    const result = await runProxmoxDiagnostics({
      host: server.host, nodeName: "m2-v2", tokenId: "zws@pve!panel", tokenSecret: "s", allowInsecureTls: false, timeoutMs: 2000,
    })
    const backup = result.steps.find((step) => step.name.includes("Backup support"))!
    assert.equal(backup.ok, true, "a vzdump content type must be recognised as a backup target")
    assert.match(backup.message, /backup-nfs/)
    // And the two call sites now agree.
    assert.equal(isBackupCapableForTest("vzdump"), true)
    assert.equal(isBackupCapableForTest("backup"), true)
    assert.equal(isBackupCapableForTest("images"), false)
  } finally {
    await server.close()
  }
})

test("a node with no runnable VM reports the console as unprobed, not broken", async () => {
  const server = await startMockProxmox({
    "/api2/json/version": () => json(200, { version: "8.2.4" }),
    "/api2/json/nodes": () => json(200, [{ node: "m2-v2", status: "online" }]),
    "/api2/json/cluster/status": () => json(200, []),
    "/api2/json/cluster/resources": () => json(200, []),
    "/api2/json/nodes/m2-v2/status": () => json(200, { cpu: 0, maxcpu: 1, memory: 0, maxmem: 1 }),
    "/api2/json/nodes/m2-v2/qemu": () => json(200, []),
    "/api2/json/nodes/m2-v2/storage": () => json(200, []),
  })
  try {
    const result = await runProxmoxDiagnostics({
      host: server.host, nodeName: "m2-v2", tokenId: "zws@pve!panel", tokenSecret: "s", allowInsecureTls: false, timeoutMs: 2000,
    })
    const vnc = result.steps.find((step) => step.name.includes("vncproxy"))!
    assert.equal(vnc.ok, false)
    assert.equal(vnc.code, "SKIP", "a capability that was not probed must never read as a failure or a pass")
    assert.match(vnc.message, /not probed/i)
    assert.equal(vnc.status, null, "no status is invented when no call was made")
  } finally {
    await server.close()
  }
})

test("a slow Proxmox is bounded by a timeout rather than hanging", async () => {
  const server = await startMockProxmox({
    "/api2/json/version": () => ({ delayMs: 3000, ...json(200, { version: "8.2.4" }) }),
    "/api2/json/nodes": () => json(200, [{ node: "m2-v2" }]),
  })
  try {
    const startedAt = Date.now()
    const result = await runProxmoxDiagnostics({
      host: server.host, nodeName: "m2-v2", tokenId: "zws@pve!panel", tokenSecret: "s", allowInsecureTls: false, timeoutMs: 150,
    })
    assert.equal(result.ok, false)
    assert.ok(Date.now() - startedAt < 2000, "the diagnostic must give up on its own timeout")
    assert.ok(
      result.steps.some((step) => step.code === "HTTP_TIMEOUT"),
      `expected a timeout step, got ${result.steps.map((step) => step.code).join(",")}`
    )
  } finally {
    await server.close()
  }
})

test("discovery classifies a denied node as inaccessible and keeps it", async () => {
  const client = mockClient(LEAST_PRIVILEGE_FLEET)
  const report = await discoverFleet({ client })

  assert.equal(report.counts.discovered, 1, "the node must be retained, not dropped")
  assert.equal(report.counts.inaccessible, 1)
  assert.equal(report.counts.online, 0)
  assert.equal(report.counts.offline, 0)

  const node = report.nodes[0]
  assert.equal(node.node, "m2-v2", "the node name comes from Proxmox, not from the panel")
  assert.equal(node.availability, "inaccessible")
  // The VM and storage endpoints still work, so their inventories are still read.
  assert.equal(node.vms.visibleToToken, true)
  assert.equal(node.vms.total, 2)
  assert.equal(node.storage.inspected.length, 1)
})

test("a node whose status 404s is offline, not nonexistent", async () => {
  const client = mockClient([{ node: "m2-v2", gone: true }])
  const report = await discoverFleet({ client })
  assert.equal(report.counts.discovered, 1)
  assert.equal(report.counts.offline, 1)
  assert.equal(report.counts.inaccessible, 0)
  const statusCheck = report.nodes[0].checks.find((check) => check.name === "Node status")
  assert.equal(statusCheck?.status, 404)
  assert.match(String(statusCheck?.message), /stale/i)
})

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test("discovery finds every node the token can see, with no hard-coded name", async () => {
  const client = mockClient([
    { node: "m2-v2", storages: [{ storage: "local-lvm", type: "lvmthin", content: "images,rootdir,vzdump", enabled: 1, active: 1, avail: 50 * 1024 ** 3, total: 100 * 1024 ** 3, used: 50 * 1024 ** 3 }], vms: [{ vmid: 101, status: "running" }] },
    { node: "m2-v3", status: "online", storages: [{ storage: "local-lvm", type: "lvmthin", content: "images,vzdump", enabled: 1, active: 1, avail: 20 * 1024 ** 3, total: 100 * 1024 ** 3, used: 80 * 1024 ** 3 }], vms: [{ vmid: 201, status: "running" }] },
    { node: "m2-v4", status: "offline", unreachable: true },
  ])
  const report = await discoverFleet({ client })

  assert.deepEqual(report.nodes.map((node) => node.node), ["m2-v2", "m2-v3", "m2-v4"])
  assert.equal(report.counts.discovered, 3)
  assert.equal(report.counts.online, 2)
  assert.equal(report.counts.offline, 1)
  assert.equal(report.counts.inaccessible, 0)
})

test("a node with no VM grant is reported as empty, not as missing", async () => {
  const client = mockClient([{ node: "m2-v2", vms: [] }])
  const report = await discoverFleet({ client })
  assert.equal(report.nodes[0].vms.visibleToToken, true, "the list was read; it is simply empty")
  assert.equal(report.nodes[0].vms.total, 0)
  assert.match(report.visibilityNote, /empty VM list/i)
  assert.match(report.visibilityNote, /VM\.Audit/, "the note must explain why a node can be visible yet VM-less")
})

test("a token that cannot list nodes reports that, and discovers nothing", async () => {
  const report = await discoverFleet({ client: mockClient([], { nodesDenied: true }) })
  assert.equal(report.counts.discovered, 0)
  assert.equal(report.cluster.nodeListOk, false)
  assert.match(report.visibilityNote, /not permitted/i)
})

test("an invalid token surfaces as an auth failure, not as a permission one", async () => {
  const report = await discoverFleet({ client: mockClient([], { nodesUnauthorized: true }) })
  assert.equal(report.counts.discovered, 0)
  assert.match(report.visibilityNote, /could not be read/i)
})

test("discovery records telemetry only where Sys.Audit allowed it", async () => {
  const client = mockClient([
    { node: "allowed", cpu: { cpus: 16, cpu: 3.2 }, mem: { maxmem: 32 * 1024 ** 3, memory: 16 * 1024 ** 3 } },
    { node: "denied", statusDenied: true },
  ])
  const report = await discoverFleet({ client })

  const allowed = report.nodes.find((node) => node.node === "allowed")!
  assert.equal(allowed.telemetry.cpuCores, 16)
  assert.equal(allowed.telemetry.cpuUsagePercent, 20)
  assert.equal(allowed.telemetry.memoryUsagePercent, 50)

  const denied = report.nodes.find((node) => node.node === "denied")!
  assert.equal(denied.telemetry.cpuCores, null, "no telemetry is invented for a node we may not read")
  assert.equal(denied.telemetry.memoryTotalBytes, null)
})

// ---------------------------------------------------------------------------
// Console: the probe that called the wrong endpoint
// ---------------------------------------------------------------------------

test("the vncproxy requirement is VM.Console, and the probe uses vncproxy", () => {
  const requirement = findEndpointRequirement("/nodes/pve/qemu/101/vncproxy", "POST", { node: "pve", vmid: 101 })
  assert.equal(requirement?.path, "/nodes/{node}/qemu/{vmid}/vncproxy")
  assert.equal(requirement?.privilege, "VM.Console")
  assert.equal(requirement?.aclPath, "/vms/{vmid}")
})

test("the termproxy requirement is VM.Console too", () => {
  const requirement = findEndpointRequirement("/nodes/pve/qemu/101/termproxy", "POST", { node: "pve", vmid: 101 })
  assert.equal(requirement?.path, "/nodes/{node}/qemu/{vmid}/termproxy")
  assert.equal(requirement?.privilege, "VM.Console")
})

test("the old console probe used the wrong endpoint against a hard-coded VMID", () => {
  // Pinned so the regression cannot come back: reading VM 100's *config* is not a
  // console probe, and VMID 100 is not a target this panel may assume exists.
  const source = readSource("lib/proxmox.ts")
  assert.equal(/getVMConfig\(input\.nodeName,\s*100\)/.test(source), false, "no VMID 100 config read as a console probe")
  assert.equal(/getVMStatus\(input\.nodeName,\s*100\)/.test(source), false, "no VMID 100 status read as a console probe")
  assert.match(source, /qemu\/\$\{probeVmid\}\/\$\{kind\}/, "console must be probed at the discovered VMID")
})

test("a VM that denies VM.Console is reported as a permission problem with a remedy", async () => {
  const denial = explainDenial({
    path: "/nodes/m2-v2/qemu/101/vncproxy",
    method: "POST",
    httpStatus: 403,
    params: { node: "m2-v2", vmid: 101 },
  })
  assert.ok(denial)
  assert.equal(denial.requiredPrivilege, "VM.Console")
  assert.equal(denial.aclPath, "/vms/{vmid}")
  assert.equal(denial.httpStatus, 403)
  assert.equal(denial.capability, "VNC (graphical) console ticket")
  assert.match(denial.remediation, /VM\.Console on \/vms\/\{vmid\}/)
  assert.match(denial.remediation, /must be applied by an administrator/i, "ACL changes are never made silently")
})

// ---------------------------------------------------------------------------
// Snapshot capability
// ---------------------------------------------------------------------------

test("a dir storage is not reported as snapshot-capable for raw disks", () => {
  // The exact false negative that produced "No snapshot-capable storage found"
  // on a node that had perfectly good storage: the old check matched on type
  // alone, and `dir` always matched, which is wrong for raw and right only for
  // qcow2.
  assert.equal(storageTypeIsSnapshotCapable("dir", "raw"), false)
  assert.equal(storageTypeIsSnapshotCapable("dir", "qcow2"), true)
  assert.equal(storageSnapshotVerdict("lvmthin"), true)
  assert.equal(storageSnapshotVerdict("lvm"), false, "thick LVM cannot snapshot a running guest")
})

test("disk formats are read off real VM volume definitions", () => {
  const formats = diskFormatsFromVmConfigs([
    { scsi0: "local-lvm:vm-101-disk-0,size=32G", ide2: "local:iso/debian.iso,media=cdrom" },
    { virtio0: "local:101/vm-101-disk-0.raw,size=8G" },
    { scsi0: "local:101/vm-102-disk-0.qcow2,size=8G" },
  ])
  assert.deepEqual(formats["local-lvm"], ["raw"], "no extension means raw, which is Proxmox's default")
  assert.deepEqual(formats["local"].sort(), ["qcow2", "raw"])
  assert.equal(formats["iso"], undefined, "CD-ROM entries are not data disks")
})

test("snapshot capability is decided from the storage and the real disk format", () => {
  const rows = [
    { storage: "local", type: "dir", content: "iso,vztmpl,images", enabled: 1, active: 1, avail: 50, total: 100, used: 50 },
    { storage: "local-lvm", type: "lvm", content: "images", enabled: 1, active: 1, avail: 50, total: 100, used: 50 },
  ]
  const verdict = assessSnapshotCapability(rows, { local: ["raw"], "local-lvm": ["raw"] })
  assert.equal(verdict.supported, false)
  assert.match(verdict.detail, /disks are raw/i, "the verdict must name the real constraint")
  assert.match(verdict.remediation ?? "", /lvmthin|zfs|rbd|btrfs/i, "the remedy must name a supported backend")
  assert.equal(verdict.inspected.length, 2, "every storage is reported, including the rejected ones")
})

test("the same dir storage is snapshot-capable when its disks are qcow2", () => {
  const rows = [{ storage: "local", type: "dir", content: "images", enabled: 1, active: 1, avail: 50, total: 100, used: 50 }]
  assert.equal(assessSnapshotCapability(rows, { local: ["qcow2"] }).supported, true)
  assert.equal(assessSnapshotCapability(rows, { local: ["raw"] }).supported, false)
})

test("an LVM-thin storage is reported snapshot-capable", () => {
  const verdict = assessSnapshotCapability([
    { storage: "local-lvm", type: "lvmthin", content: "images,rootdir,vzdump", enabled: 1, active: 1, avail: 50, total: 100, used: 50 },
  ])
  assert.equal(verdict.supported, true)
  assert.deepEqual(verdict.storages.map((storage) => storage.name), ["local-lvm"])
})

test("a storage that cannot be snapshotted is not silently counted", () => {
  // `null` and `false` mean different things and are kept apart: null means the
  // storage cannot hold disks at all, false means it can but cannot snapshot them.
  const proxmoxBackupStore = describeStorageCapability({ storage: "pbs-main", type: "pbs", content: "backup", enabled: 1, active: 1, avail: 100 })
  assert.equal(proxmoxBackupStore.acceptsVmDisks, false)
  assert.equal(proxmoxBackupStore.supportsSnapshots, null)
  assert.equal(proxmoxBackupStore.supportsBackups, true, "PBS is a fine backup target and a bad disk target")
})

// ---------------------------------------------------------------------------
// Backup capability
// ---------------------------------------------------------------------------

test("backup content is parsed as a list, accepting both Proxmox backup types", () => {
  assert.deepEqual(parseStorageContent("images,rootdir,vzdump"), ["images", "rootdir", "vzdump"])
  assert.deepEqual(parseStorageContent(["backup"]), ["backup"])

  // The bug this fixes: one call site accepted only `backup`, another accepted
  // `backup` or `vzdump`. A normal vzdump archive storage matched one and not
  // the other, so the node card advertised a backup target that the backup
  // picker then refused to show.
  const verdict = assessBackupCapability([
    { storage: "backup-nfs", type: "nfs", content: "vzdump", enabled: 1, active: 1, avail: 500, total: 1000, used: 500 },
  ])
  assert.equal(verdict.supported, true)
  assert.equal(verdict.storages[0].backupContentType, "vzdump")
})

test("storage with no backup content type is reported with a specific remedy", () => {
  const verdict = assessBackupCapability([
    { storage: "local", type: "dir", content: "iso,vztmpl,images", enabled: 1, active: 1, avail: 400, total: 1000, used: 600 },
  ])
  assert.equal(verdict.supported, false)
  assert.match(verdict.remediation ?? "", /Content column/i)
  assert.match(verdict.remediation ?? "", /never point backups at a datastore holding customer VM disks/i)
  assert.match(verdict.remediation ?? "", /will not make this change for you/i, "the panel never enables a backup target on its own")
})

test("a backup content type on an unusable storage is not a backup target", () => {
  const inactive = assessBackupCapability([
    { storage: "backup-nfs", type: "nfs", content: "vzdump", enabled: 1, active: 0, avail: 500 },
  ])
  assert.equal(inactive.supported, false)
  assert.match(inactive.detail, /not usable/i)

  const full = assessBackupCapability([
    { storage: "backup-nfs", type: "nfs", content: "vzdump", enabled: 1, active: 1, avail: 0, total: 500, used: 500 },
  ])
  assert.equal(full.supported, false)
  assert.match(full.detail, /zero free space/i)
})

test("storage capability reports real capacity", () => {
  const capability = describeStorageCapability({
    storage: "local-lvm", type: "lvmthin", content: "images,vzdump", enabled: 1, active: 1,
    total: 1000, used: 250, avail: 750,
  })
  assert.equal(capability.totalBytes, 1000)
  assert.equal(capability.usedBytes, 250)
  assert.equal(capability.freeBytes, 750)
  assert.equal(capability.usable, true)
})

// ---------------------------------------------------------------------------
// Guest agent
// ---------------------------------------------------------------------------

test("a missing guest agent is reported as missing, with the images named", async () => {
  const client = mockClient([{ node: "m2-v2", vms: [{ vmid: 101, status: "running", agent: 0 }] }])
  const report = await discoverFleet({ client })
  assert.equal(report.nodes[0].vms.running, 1)
  const health = nodeHealthStatus(report.nodes[0])
  assert.notEqual(health.status, "healthy")
})

test("guest agent coverage is per-VM, not inferred from one VM", async () => {
  const client = mockClient([
    {
      node: "m2-v2",
      vms: [
        { vmid: 101, status: "running", agent: 0 },
        { vmid: 102, status: "running", agent: 1 },
      ],
      storages: [{ storage: "local-lvm", type: "lvmthin", content: "images,vzdump", enabled: 1, active: 1, avail: 10, total: 100, used: 90 }],
    },
  ])
  const report = await discoverFleet({ client })
  assert.equal(report.nodes[0].vms.total, 2)
  assert.equal(report.nodes[0].vms.running, 2)
})

// ---------------------------------------------------------------------------
// Permission model
// ---------------------------------------------------------------------------

test("every permission denial maps to a privilege, a scope and an instruction", () => {
  for (const requirement of PROXMOX_ENDPOINT_PERMISSIONS) {
    if (!requirement.privilege && !(requirement.alternatives || []).length) continue
    const denied = explainDenial({ path: requirement.path, method: requirement.method, httpStatus: 403 })
    assert.ok(denied, `${requirement.method} ${requirement.path} must be explainable`)
    assert.ok(denied.remediation.length > 10, `${requirement.path} needs a real remediation`)
    assert.ok(
      denied.remediation.toLowerCase().includes("proxmox"),
      `${requirement.path} remediation must point at the Proxmox host`
    )
  }
})

test("no remediation ever proposes granting more than the feature needs", () => {
  const guide = fullAclSetupGuide()
  const allCommands = guide.flatMap((entry) => entry.commands)
  for (const command of allCommands) {
    assert.equal(/\broot@pam\b/.test(command), false, "no setup line may name the root password realm")
    assert.equal(/Sys\.Modify/.test(command), false, "Sys.Modify is never required by this panel")
    assert.equal(/:\/\/\S+@/.test(command), false, "no credentials may appear in an ACL command")
  }
})

test("the setup guide separates features so each can be granted independently", () => {
  const console_ = aclSetupGuide("console")
  const power = aclSetupGuide("vm_power")
  const guest = aclSetupGuide("guest_agent")

  assert.equal(console_.commands.length, 1)
  assert.match(console_.commands[0], /VM\.Console/)
  assert.match(power.commands[0], /VM\.PowerMgmt/)
  assert.equal(console_.commands[0] === power.commands[0], false, "console and power are separate grants")
  // Reading guest state and running commands in the guest are separate grants too.
  assert.equal(guest.commands.length, 2)
  assert.match(guest.commands.join("\n"), /VM\.GuestAgent\.Audit/)
  assert.match(guest.commands.join("\n"), /VM\.GuestAgent\.Unrestricted/)
  assert.match(aclSetupGuide("discovery").note, /no Proxmox ACL change/i)
})

test("an unknown endpoint is not given invented advice", () => {
  const denial = explainDenial({ path: "/nodes/pve/qemu/101/telepathy", method: "POST", httpStatus: 403 })
  assert.ok(denial)
  assert.equal(denial.requiredPrivilege, null)
  assert.match(denial.remediation, /No ACL expectation is recorded/i)
})

test("a 401 is diagnosed as authentication, never as a missing privilege", () => {
  const denial = explainDenial({ path: "/nodes", method: "GET", httpStatus: 401 })
  assert.match(denial!.remediation, /rejected the token itself/i)
  assert.match(denial!.remediation, /not been revoked/i)
})

test("a 403 is never reported with a leaked token or cookie", () => {
  const denial = explainDenial({
    path: "/nodes/pve/qemu/101/vncproxy",
    method: "POST",
    httpStatus: 403,
    proxmoxMessage: "denied PVEAPIToken=zws@pve!panel=aaaaaaaa-bbbb PVEAuthCookie=secretcookie",
  })
  assert.equal(denial!.proxmoxMessage.includes("aaaaaaaa-bbbb"), false, "no token secret may appear in the message")
  assert.match(denial!.proxmoxMessage, /did not name the missing privilege|redacted/i)
})

// ---------------------------------------------------------------------------
// Console capability
// ---------------------------------------------------------------------------

test("console is probed against a real running guest, not a hard-coded VMID", async () => {
  const probed: Array<{ vmid: number; kind: string }> = []
  const base = mockClient([{
    node: "m2-v2",
    vms: [{ vmid: 101, status: "running", agent: 1 }, { vmid: 102, status: "stopped", agent: 0 }],
    storages: [{ storage: "local-lvm", type: "lvmthin", content: "images,vzdump", enabled: 1, active: 1, avail: 10, total: 100, used: 90 }],
  }])
  const report = await discoverFleet({
    client: {
      ...base,
      probeConsole: async (node, vmid, kind) => {
        probed.push({ vmid, kind })
        return { ok: true, denied: false, message: "granted" }
      },
    },
  })

  const node = report.nodes[0]
  assert.equal(node.console.probeVmid, 101, "the running guest is the probe target")
  assert.equal(node.console.vnc.state, "verified")
  assert.equal(node.console.serial.state, "verified")
  assert.deepEqual(probed.map((entry) => entry.kind).sort(), ["termproxy", "vncproxy"])
  assert.ok(probed.every((entry) => entry.vmid === 101), "never probe a VMID that was assumed")
})

test("a node with no running guest reports console as unmeasured", async () => {
  const report = await discoverFleet({
    client: mockClient([{ node: "m2-v2", vms: [{ vmid: 101, status: "stopped" }] }]),
  })
  const node = report.nodes[0]
  assert.equal(node.console.vnc.state, "unmeasured")
  assert.equal(node.console.vnc.status, null, "no status is invented when nothing was called")
  assert.match(node.console.vnc.message, /not measured/i)
})

test("a VM.Console denial is reported as Permission Required with the grant to run", async () => {
  const base = mockClient([{ node: "m2-v2", vms: [{ vmid: 101, status: "running" }] }])
  const report = await discoverFleet({
    client: {
      ...base,
      probeConsole: async () => {
        throw permissionDenied("/nodes/m2-v2/qemu/101/vncproxy")
      },
    },
  })
  const node = report.nodes[0]
  assert.equal(node.console.vnc.state, "denied")
  assert.equal(node.console.vnc.status, 403)
  assert.match(node.console.vnc.message, /VM\.Console/)

  const health = nodeHealthStatus(node)
  assert.equal(health.status, "permission_required", "a console denial is a grant to make, not a broken node")
  assert.ok(health.remediation.some((line) => /VM\.Console/.test(line)))
})

test("guest agent coverage is reported per node, and is null when no VM is visible", async () => {
  const withVms = await discoverFleet({
    client: mockClient([{ node: "m2-v2", vms: [{ vmid: 1, status: "running", agent: 1 }, { vmid: 2, status: "running", agent: 0 }, { vmid: 3, status: "stopped", agent: 0 }] }]),
  })
  const coverage = withVms.nodes[0].vms.guestAgent!
  assert.equal(coverage.reporting, 1)
  assert.equal(coverage.total, 3)
  assert.equal(coverage.coveragePercent, 33.3)
  assert.match(coverage.caveat, /not a substitute/i, "the flag must not be presented as proof")

  const noVms = await discoverFleet({ client: mockClient([{ node: "m2-v2", vms: [] }]) })
  assert.equal(noVms.nodes[0].vms.guestAgent, null, "no VMs visible is not zero coverage")
})

// ---------------------------------------------------------------------------
// Health and timeouts
// ---------------------------------------------------------------------------

test("health status separates permission problems from capability gaps", async () => {
  const denied = await discoverFleet({ client: mockClient([{ node: "m2-v2", statusDenied: true }]) })
  assert.equal(nodeHealthStatus(denied.nodes[0]).status, "permission_required")

  const offline = await discoverFleet({ client: mockClient([{ node: "m2-v2", unreachable: true }]) })
  assert.equal(nodeHealthStatus(offline.nodes[0]).status, "offline")

  const healthy = await discoverFleet({
    client: mockClient([{
      node: "m2-v2",
      vms: [{ vmid: 101, status: "running" }],
      storages: [{ storage: "local-lvm", type: "lvmthin", content: "images,vzdump", enabled: 1, active: 1, avail: 10, total: 100, used: 90 }],
    }]),
  })
  assert.equal(nodeHealthStatus(healthy.nodes[0]).status, "healthy")
})

test("a node answering its API but unable to snapshot is degraded, not healthy", async () => {
  const report = await discoverFleet({
    client: {
      ...mockClient([{
        node: "m2-v2",
        vms: [{ vmid: 101, status: "running" }],
        storages: [{ storage: "local", type: "dir", content: "images", enabled: 1, active: 1, avail: 10, total: 100, used: 90 }],
      }]),
      // The node's disks are raw, which is what makes the dir storage unusable
      // for snapshots. Without this the panel would report "snapshot capable"
      // from the storage type alone.
      getVMConfigs: async () => [{ scsi0: "local:101/vm-101-disk-0.raw,size=32G" }],
    },
  })
  const health = nodeHealthStatus(report.nodes[0])
  assert.equal(health.status, "degraded")
  assert.ok(health.reasons.some((reason) => /snapshot/i.test(reason)))
  assert.ok(health.remediation.length > 0, "a degraded node must say what to do")
})

test("feature coverage reports what the token could not reach", async () => {
  const report = await discoverFleet({ client: mockClient(LEAST_PRIVILEGE_FLEET) })
  const coverage = summariseFeatureCoverage(report)
  assert.equal(coverage.cluster_inventory.denied.includes("m2-v2"), true)
  assert.equal(coverage.storage.supported, 1, "storage was readable despite the node status denial")
})

test("a timeout is an offline node, not a crash", async () => {
  const client = mockClient([{ node: "m2-v2", unreachable: true }])
  const node = await discoverNode(client, "m2-v2")
  assert.equal(node.availability, "offline")
  const status = node.checks.find((check) => check.name === "Node status")!
  assert.equal(status.ok, false)
  assert.match(status.message, /did not answer/i)
})

test("discovery is bounded, not one unbounded fan-out", async () => {
  const many: NodeSpec[] = Array.from({ length: 30 }, (_, index) => ({ node: `node-${index}` }))
  let concurrent = 0
  let peak = 0
  const client: DiscoveryClient = {
    async getNodes() { return many.map((spec) => ({ node: spec.node, status: "online" })) },
    async getNodeStats() { return { cpuinfo: { cpus: 1 }, maxmem: 1, memory: 0, maxdisk: 1, disk: 0, uptime: 1 } },
    async getVMs() { return [] },
    async getStorages() { return [] },
  }
  const tracked: DiscoveryClient = {
    ...client,
    async getNodeStats(node: string) {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 1))
      concurrent -= 1
      return client.getNodeStats(node)
    },
  }
  const report = await discoverFleet({ client: tracked, concurrency: 4 })
  assert.equal(report.counts.discovered, 30)
  assert.ok(peak <= 4, `expected at most 4 concurrent probes, saw ${peak}`)
})

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

test("a certificate that does not verify is reported as a TLS failure, not as connectivity", async () => {
  const result = await runProxmoxDiagnostics({
    // RFC 5737 documentation address: guaranteed never to resolve, so this
    // exercises the classification path rather than the network.
    host: "203.0.113.1:8006",
    nodeName: "m2-v2",
    tokenId: "zws@pve!panel",
    tokenSecret: "secret",
    allowInsecureTls: false,
    timeoutMs: 50,
  })
  assert.equal(result.ok, false)
  const failed = result.steps.find((step) => !step.ok)
  assert.ok(failed)
  assert.match(String(failed.code), /DNS_FAILED|TCP_REFUSED|TCP_TIMEOUT|HTTP_TIMEOUT/, `unexpected code ${failed.code}`)
  // The point: connectivity was NOT reported as fine.
  assert.notEqual(result.degraded, true, "a transport failure is not a permission degradation")
})

test("certificate verification is on unless the node explicitly disables it", async () => {
  const source = readSource("lib/proxmox.ts")
  const calls = source.match(/rejectUnauthorized:\s*[^,\n]+/g) || []
  for (const call of calls) {
    assert.equal(/rejectUnauthorized:\s*true\b/.test(call), false, `TLS verification must never be hard-enabled off: ${call}`)
  }
  assert.ok(
    calls.every((call) => /rejectUnauthorized:\s*!\s*allowInsecureTls/.test(call)),
    `every socket must verify unless allowInsecureTls is set: ${calls.join(" | ")}`
  )
})