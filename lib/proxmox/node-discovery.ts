/**
 * Discover every Proxmox node an API token can see, and say honestly what works
 * on each one.
 *
 * ## Why discovery is not `nodes[0]`
 *
 * The panel used to be configured one-node-at-a-time with the node name typed in
 * by hand, and its diagnostics ran every probe against that one hard-coded name.
 * On a multi-node cluster that produced two distinct lies: a node that exists but
 * was never registered was invisible, and a node whose status call was denied was
 * indistinguishable from a node that does not exist.
 *
 * `GET /api2/json/nodes` is `{"user":"all"}` — it is open to any authenticated
 * caller and returns the names Proxmox itself uses. That is the list of record,
 * and every node on it is reported here.
 *
 * ## The four states, and why there are four
 *
 * `online` and `offline` describe the node. `inaccessible` describes *this token*
 * — the node is listed and may well be running, but this token cannot read its
 * status. Collapsing the last two into "not found" is what sent an administrator
 * looking for a node that was there all along, so a node that is visible but
 * whose checks failed is retained with the failing check attached, never dropped.
 *
 * ## Permission-limited visibility
 *
 * `/nodes` is unfiltered, but `/nodes/{node}/qemu` filters itself: it returns only
 * the VMs the caller holds `VM.Audit` on. A token can therefore legitimately see
 * three nodes and zero VMs, and that is reported as "no VMs visible to this
 * token" rather than as "this node has no VMs".
 */

import { assessStorageCapabilities, diskFormatsFromVmConfigs, type StorageCapability } from "@/lib/proxmox/storage-capabilities"
import { explainDenial, type PermissionDenial, type ProxmoxFeatureKey } from "@/lib/proxmox/permission-requirements"

/**
 * The minimum client surface discovery needs.
 *
 * Narrow on purpose: a test supplies known answers for exactly these calls and
 * nothing else, which is what makes a mixed online/offline/denied fleet provable
 * rather than asserted.
 */
export type DiscoveryClient = {
  getNodes(): Promise<Array<{ node?: string; status?: string; type?: string; online?: number | boolean }>>
  getNodeStats(node: string): Promise<any>
  getVMs(node: string): Promise<any[]>
  getStorages(node: string): Promise<any[]>
  /**
   * Per-VM configuration, used to read the real disk formats off each storage.
   *
   * Optional, and the reason it is optional matters: without it the detector can
   * still say that LVM-thin or ZFS snapshots natively, but it cannot tell
   * whether a file-backed storage holds qcow2 or raw disks, and will say so
   * rather than guess.
   */
  getVMConfigs?(node: string, vmids: number[]): Promise<Array<Record<string, any>>>
  /**
   * Mints a console ticket to test whether `VM.Console` is granted.
   *
   * Optional because a console ticket is per-VM and needs a real target: without
   * a running guest there is nothing to probe and the answer is "not measured",
   * not "unsupported".
   */
  probeConsole?(node: string, vmid: number, kind: "vncproxy" | "termproxy"): Promise<{ ok: boolean; denied: boolean; message: string }>
  /** The permission advice for a denied call. Optional so a narrow mock works. */
  explain?(path: string, method: string, httpStatus: number, message?: string | null, params?: { node?: string | null; vmid?: number | string | null }): PermissionDenial | null
}

export type NodeAvailability = "online" | "offline" | "inaccessible"

/**
 * The result of one capability probe.
 *
 * `unmeasured` is kept distinct from `unsupported` throughout: a capability that
 * was never probed says nothing about the node, and a dashboard that renders the
 * two the same way is lying to whoever has to act on it.
 */
export type ProbeOutcome = {
  state: "verified" | "denied" | "failed" | "unmeasured"
  message: string
  /** The endpoint that was called, when one was. */
  endpoint: string | null
  status: number | null
}

export type NodeDiscoveryCheck = {
  name: string
  ok: boolean
  /** The endpoint this check actually called. */
  endpoint: string
  /** HTTP status, when the call got far enough to have one. */
  status: number | null
  message: string
  /** Set when the check failed on permissions rather than on reachability. */
  denial: PermissionDenial | null
  durationMs: number
}

export type DiscoveredStorage = StorageCapability

export type DiscoveredNode = {
  /** The name Proxmox reports. Never synthesised, never defaulted. */
  node: string
  availability: NodeAvailability
  /** Proxmox's own `status` field from `/nodes`, when it gave one. */
  reportedStatus: string | null
  onlineFlag: boolean | null
  /** Proxmox's node type, when reported. */
  type: string | null
  /** CPU, memory and uptime, when `Sys.Audit` allowed the status call. */
  telemetry: {
    cpuCores: number | null
    cpuUsagePercent: number | null
    memoryTotalBytes: number | null
    memoryUsedBytes: number | null
    memoryUsagePercent: number | null
    storageTotalBytes: number | null
    storageUsedBytes: number | null
    uptimeSeconds: number | null
  }
  vms: {
    total: number
    running: number
    stopped: number
    /** Proxmox filters this list by the caller's own VM.Audit grants. */
    visibleToToken: boolean
    /**
     * Guest-agent coverage from Proxmox's own per-VM `agent` flag.
     *
     * `null` when no VM was readable, which is different from zero coverage: a
     * token that cannot see VMs has not established that their guests lack an
     * agent.
     */
    guestAgent: {
      reporting: number
      total: number
      coveragePercent: number | null
      /** A flag is a hint, not proof. Nothing here claims an agent responds. */
      caveat: string
    } | null
  }
  console: {
    /** The VM the console was probed against, if any. */
    probeVmid: number | null
    vnc: ProbeOutcome
    serial: ProbeOutcome
  }
  storage: {
    inspected: DiscoveredStorage[]
    snapshotSupported: boolean
    backupSupported: boolean
    snapshotDetail: string
    backupDetail: string
    snapshotRemediation: string | null
    backupRemediation: string | null
  }
  checks: NodeDiscoveryCheck[]
  /** Permission failures encountered while probing this node. */
  denials: PermissionDenial[]
}

export type DiscoveryReport = {
  /** Every node `/nodes` returned. */
  nodes: DiscoveredNode[]
  counts: {
    discovered: number
    online: number
    offline: number
    inaccessible: number
  }
  /** What the token is allowed to see, in one sentence. */
  visibilityNote: string
  /** Cluster-level checks, and the permission advice for any that failed. */
  cluster: {
    nodeListOk: boolean
    statusOk: boolean
    resourcesOk: boolean
    denials: PermissionDenial[]
  }
}

function asNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function percent(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null
  return Math.round((used / total) * 1000) / 10
}

function boolOrNull(value: unknown): boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  const text = String(value).toLowerCase().trim()
  if (text === "true" || text === "1") return true
  if (text === "false" || text === "0") return false
  return null
}

type FailureShape = { httpStatus: number | null; message: string; permissionDenied: boolean; notFound: boolean; unreachable: boolean }

function classifyFailure(error: any): FailureShape {
  const httpStatus = asNumber(error?.httpStatus) ?? asNumber(error?.status)
  const message = String(error?.message || "unknown error")
  const code = String(error?.code || "")
  return {
    httpStatus: httpStatus && httpStatus >= 100 && httpStatus < 600 ? httpStatus : null,
    message,
    permissionDenied: code === "PERMISSION_DENIED_403" || httpStatus === 403,
    notFound: code === "NOT_FOUND_404" || code === "NODE_NOT_FOUND" || httpStatus === 404,
    unreachable: /timed out|refused|ECONN|ENOTFOUND|EAI_AGAIN|network|unreachable|DNS|TLS|handshake/i.test(`${code} ${message}`),
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T; durationMs: number } | { ok: false; error: any; durationMs: number }> {
  const startedAt = Date.now()
  try {
    const value = await fn()
    return { ok: true, value, durationMs: Date.now() - startedAt }
  } catch (error) {
    return { ok: false, error, durationMs: Date.now() - startedAt }
  }
}

/**
 * Probe one discovered node.
 *
 * Every check is retained whether it passed or failed. A node that is visible but
 * denied is returned with its denial attached — never dropped, never called
 * nonexistent.
 */
export async function discoverNode(client: DiscoveryClient, nodeName: string): Promise<DiscoveredNode> {
  const node = String(nodeName || "").trim()
  const checks: NodeDiscoveryCheck[] = []
  const denials: PermissionDenial[] = []

  const explain = (path: string, method: string, status: number, message?: string | null, params?: { node?: string; vmid?: number | string }) => {
    const denial = client.explain
      ? client.explain(path, method, status, message, { node, ...params })
      : explainDenial({ path, method, httpStatus: status, proxmoxMessage: message, params: { node, ...params } })
    if (denial) denials.push(denial)
    return denial
  }

  // -- node status -----------------------------------------------------------
  // `Sys.Audit` on the node path. A denial here means this token cannot see
  // telemetry for this node; it says nothing about whether the node is up.
  const statusResult = await timed(() => client.getNodeStats(node))
  let availability: NodeAvailability
  const telemetry: DiscoveredNode["telemetry"] = {
    cpuCores: null,
    cpuUsagePercent: null,
    memoryTotalBytes: null,
    memoryUsedBytes: null,
    memoryUsagePercent: null,
    storageTotalBytes: null,
    storageUsedBytes: null,
    uptimeSeconds: null,
  }

  if (statusResult.ok) {
    availability = "online"
    const stats = statusResult.value || {}
    const maxCpu = asNumber(stats.cpuinfo?.cpus) ?? asNumber(stats.maxcpu)
    const usedCpu = asNumber(stats.cpu)
    const maxMem = asNumber(stats.maxmem)
    const usedMem = asNumber(stats.memory)
    const maxDisk = asNumber(stats.maxdisk)
    const usedDisk = asNumber(stats.disk)
    telemetry.cpuCores = maxCpu
    telemetry.cpuUsagePercent = maxCpu && maxCpu > 0 && usedCpu !== null ? percent(usedCpu, maxCpu) : null
    telemetry.memoryTotalBytes = maxMem
    telemetry.memoryUsedBytes = usedMem
    telemetry.memoryUsagePercent = percent(usedMem, maxMem)
    telemetry.storageTotalBytes = maxDisk
    telemetry.storageUsedBytes = usedDisk
    telemetry.uptimeSeconds = asNumber(stats.uptime)
    checks.push({
      name: "Node status",
      ok: true,
      endpoint: `/nodes/${node}/status`,
      status: 200,
      message: `Node ${node} answered its status endpoint`,
      denial: null,
      durationMs: statusResult.durationMs,
    })
  } else {
    const failure = classifyFailure(statusResult.error)
    if (failure.permissionDenied) {
      // Retained deliberately: the node came back from /nodes, so it exists as
      // far as this cluster is concerned. Calling it "not found" would be a lie.
      availability = "inaccessible"
      const denial = explain(`/nodes/${node}/status`, "GET", 403, failure.message)
      checks.push({
        name: "Node status",
        ok: false,
        endpoint: `/nodes/${node}/status`,
        status: 403,
        message: `Node ${node} is listed by the cluster but this API token is not permitted to read its status. The node still exists.`,
        denial,
        durationMs: statusResult.durationMs,
      })
    } else if (failure.notFound) {
      availability = "offline"
      checks.push({
        name: "Node status",
        ok: false,
        endpoint: `/nodes/${node}/status`,
        status: 404,
        message: `Proxmox listed ${node} but returned 404 for its status. This usually means the node has left the cluster and the listing is stale.`,
        denial: null,
        durationMs: statusResult.durationMs,
      })
    } else {
      availability = "offline"
      checks.push({
        name: "Node status",
        ok: false,
        endpoint: `/nodes/${node}/status`,
        status: failure.httpStatus,
        message: `Node ${node} did not answer: ${failure.message}`,
        denial: null,
        durationMs: statusResult.durationMs,
      })
    }
  }

  // -- VM inventory ----------------------------------------------------------
  const vmResult = await timed(() => client.getVMs(node))
  let vms: DiscoveredNode["vms"] = { total: 0, running: 0, stopped: 0, visibleToToken: false, guestAgent: null }
  let vmIds: number[] = []
  let runningVmid: number | null = null
  if (vmResult.ok) {
    const rows = Array.isArray(vmResult.value) ? vmResult.value : []
    vmIds = rows.map((vm: any) => Number(vm?.vmid)).filter((vmid: number) => Number.isInteger(vmid) && vmid > 0)
    const reporting = rows.filter((vm: any) => Number(vm?.agent) === 1).length
    const running = rows.find((vm: any) => String(vm?.status || "") === "running" && Number(vm?.vmid) > 0)
    runningVmid = running ? Number(running.vmid) : null
    vms = {
      total: rows.length,
      running: rows.filter((vm: any) => String(vm?.status || "") === "running").length,
      stopped: rows.filter((vm: any) => String(vm?.status || "") === "stopped").length,
      visibleToToken: true,
      guestAgent: rows.length
        ? {
            reporting,
            total: rows.length,
            coveragePercent: Math.round((reporting / rows.length) * 1000) / 10,
            caveat:
              "Proxmox's own agent flag. It reports the channel responding, which is a strong hint that an agent is installed and answering. It is not a substitute for querying the guest directly, which needs VM.GuestAgent.Audit.",
          }
        : null,
    }
    checks.push({
      name: "VM inventory",
      ok: true,
      endpoint: `/nodes/${node}/qemu`,
      status: 200,
      message: rows.length
        ? `${rows.length} VM(s) visible to this token (${vms.running} running)`
        : "No VMs are visible to this token on this node",
      denial: null,
      durationMs: vmResult.durationMs,
    })
  } else {
    const failure = classifyFailure(vmResult.error)
    const denial = failure.permissionDenied ? explain(`/nodes/${node}/qemu`, "GET", 403, failure.message) : null
    vms = { total: 0, running: 0, stopped: 0, visibleToToken: false, guestAgent: null }
    checks.push({
      name: "VM inventory",
      ok: false,
      endpoint: `/nodes/${node}/qemu`,
      status: failure.httpStatus,
      message: failure.permissionDenied
        ? `This API token cannot list VMs on ${node}.`
        : `VM inventory for ${node} could not be read: ${failure.message}`,
      denial,
      durationMs: vmResult.durationMs,
    })
  }

  // -- storage ---------------------------------------------------------------
  const storageResult = await timed(() => client.getStorages(node))
  let storage: DiscoveredNode["storage"]
  if (storageResult.ok) {
    const rows = Array.isArray(storageResult.value) ? storageResult.value : []

    // Read the disk formats the VMs on this node really use. Without this a
    // file-backed storage looks snapshot-capable purely because it exists, which
    // is how "snapshot capable" used to be answered from the storage type alone.
    let disksByStorage: Record<string, string[]> = {}
    if (typeof client.getVMConfigs === "function" && vmIds.length) {
      const configs = await timed(() => client.getVMConfigs!(node, vmIds))
      if (configs.ok && Array.isArray(configs.value)) {
        disksByStorage = diskFormatsFromVmConfigs(configs.value)
      }
    }

    const assessed = assessStorageCapabilities(rows, disksByStorage)
    storage = {
      inspected: assessed.storages,
      snapshotSupported: assessed.snapshot.supported,
      backupSupported: assessed.backup.supported,
      snapshotDetail: assessed.snapshot.detail,
      backupDetail: assessed.backup.detail,
      snapshotRemediation: assessed.snapshot.remediation,
      backupRemediation: assessed.backup.remediation,
    }
    checks.push({
      name: "Storage inventory",
      ok: true,
      endpoint: `/nodes/${node}/storage`,
      status: 200,
      message: `${rows.length} storage entr${rows.length === 1 ? "y" : "ies"} inspected`,
      denial: null,
      durationMs: storageResult.durationMs,
    })
  } else {
    const failure = classifyFailure(storageResult.error)
    const denial = failure.permissionDenied ? explain(`/nodes/${node}/storage`, "GET", 403, failure.message) : null
    storage = {
      inspected: [],
      snapshotSupported: false,
      backupSupported: false,
      snapshotDetail: `Storage for ${node} could not be read: ${failure.message}`,
      backupDetail: `Storage for ${node} could not be read: ${failure.message}`,
      snapshotRemediation: null,
      backupRemediation: null,
    }
    checks.push({
      name: "Storage inventory",
      ok: false,
      endpoint: `/nodes/${node}/storage`,
      status: failure.httpStatus,
      message: `Storage for ${node} could not be read: ${failure.message}`,
      denial,
      durationMs: storageResult.durationMs,
    })
  }

  // -- console -----------------------------------------------------------------
  //
  // Console capability is per-VM and needs a real target, so it is probed
  // against a running guest with the two endpoints the browser console actually
  // uses. Probing VM 100, or reading a VM's config and calling that a console
  // test, produced "VNC not available" on nodes whose console worked.
  const probeVmid = runningVmid
  const probeConsole = async (kind: "vncproxy" | "termproxy", label: string): Promise<ProbeOutcome> => {
    if (!probeVmid) {
      return {
        state: "unmeasured",
        message: `Not measured: console access is per-VM and this node has no running guest to open a ${kind} session against.`,
        endpoint: null,
        status: null,
      }
    }
    if (typeof client.probeConsole !== "function") {
      return { state: "unmeasured", message: "Not measured: this client cannot mint a console ticket.", endpoint: null, status: null }
    }
    const endpoint = `/nodes/${encodeURIComponent(node)}/qemu/${probeVmid}/${kind}`
    const outcome = await timed(() => client.probeConsole!(node, probeVmid, kind))
    if (!outcome.ok) {
      const failure = classifyFailure(outcome.error)
      const denial = failure.permissionDenied ? explain(endpoint, "POST", 403, failure.message, { vmid: probeVmid }) : null
      return {
        state: denial ? "denied" : "failed",
        message: denial
          ? `VM ${probeVmid} ${label}: this token is not permitted to open a ${kind} session. ${denial.remediation}`
          : `VM ${probeVmid} ${label}: ${failure.message}`,
        endpoint,
        status: failure.httpStatus,
      }
    }
    if (outcome.value.denied) {
      const denial = explain(endpoint, "POST", 403, outcome.value.message, { vmid: probeVmid })
      return {
        state: "denied",
        message: `VM ${probeVmid} ${label}: this token is not permitted to open a ${kind} session. ${denial?.remediation ?? "Grant VM.Console on /vms/" + probeVmid + "."}`,
        endpoint,
        status: 403,
      }
    }
    return {
      state: "verified",
      message: `VM ${probeVmid} ${label}: the ${kind} request was accepted, so this token holds VM.Console on it.`,
      endpoint,
      status: 200,
    }
  }

  const consoleCapability = {
    probeVmid,
    vnc: await probeConsole("vncproxy", "VNC console"),
    serial: await probeConsole("termproxy", "serial console"),
  }

  return {
    node,
    availability,
    reportedStatus: null,
    onlineFlag: null,
    type: null,
    telemetry,
    vms,
    console: consoleCapability,
    storage,
    checks,
    denials,
  }
}

export type DiscoverFleetOptions = {
  client: DiscoveryClient
  /** Probe nodes concurrently, but never without a bound. */
  concurrency?: number
  /**
   * Optional cluster-level checks, run once for the whole fleet rather than
   * per node. Both of these need `Sys.Audit`; neither is required to manage VMs.
   */
  clusterChecks?: {
    status: () => Promise<any>
    resources: () => Promise<any>
  }
}

/**
 * Discover the whole fleet.
 *
 * `/nodes` failing is the only condition that stops discovery: without it there
 * is genuinely nothing to enumerate. Everything else is reported per node and
 * does not abort the sweep.
 */
export async function discoverFleet(options: DiscoverFleetOptions): Promise<DiscoveryReport> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16))
  const listResult = await timed(() => options.client.getNodes())

  if (!listResult.ok) {
    const failure = classifyFailure(listResult.error)
    const denial = failure.permissionDenied
      ? explainDenial({ path: "/nodes", method: "GET", httpStatus: 403, proxmoxMessage: failure.message })
      : null
    const message = failure.permissionDenied
      ? "This API token is not permitted to list the cluster's nodes."
      : `The node list could not be read: ${failure.message}`
    return {
      nodes: [],
      counts: { discovered: 0, online: 0, offline: 0, inaccessible: 0 },
      visibilityNote: `${message} Nothing can be discovered until this succeeds.`,
      cluster: { nodeListOk: false, statusOk: false, resourcesOk: false, denials: denial ? [denial] : [] },
    }
  }

  const listed = (Array.isArray(listResult.value) ? listResult.value : [])
    .map((row: any) => String(row?.node || "").trim())
    .filter(Boolean)

  const nodes: DiscoveredNode[] = []
  for (let index = 0; index < listed.length; index += concurrency) {
    const batch = listed.slice(index, index + concurrency)
    const discovered = await Promise.all(batch.map((nodeName) => discoverNode(options.client, nodeName)))
    nodes.push(...discovered)
  }

  // Keep Proxmox's own reported status on each record.
  for (const node of nodes) {
    const row = (Array.isArray(listResult.value) ? listResult.value : []).find((entry: any) => String(entry?.node || "") === node.node)
    if (row) {
      node.reportedStatus = row.status !== undefined && row.status !== null ? String(row.status) : null
      node.onlineFlag = boolOrNull(row.online)
      node.type = row.type ? String(row.type) : null
    }
  }

  const counts = {
    discovered: nodes.length,
    online: nodes.filter((node) => node.availability === "online").length,
    offline: nodes.filter((node) => node.availability === "offline").length,
    inaccessible: nodes.filter((node) => node.availability === "inaccessible").length,
  }

  const visibilityParts: string[] = []
  if (counts.discovered) visibilityParts.push(`${counts.discovered} node(s) visible to this API token`)
  else visibilityParts.push("No nodes are visible to this API token")

  const emptyVmNodes = nodes.filter((node) => node.vms.visibleToToken && node.vms.total === 0)
  if (emptyVmNodes.length) {
    visibilityParts.push(
      `${emptyVmNodes.map((node) => node.node).join(", ")} returned an empty VM list, which is normal when the token holds no VM.Audit grant on that node`
    )
  }

  const clusterDenials: PermissionDenial[] = []
  let statusOk = false
  let resourcesOk = false
  if (options.clusterChecks) {
    const statusResult = await timed(() => options.clusterChecks!.status())
    if (statusResult.ok) {
      statusOk = true
    } else {
      const failure = classifyFailure(statusResult.error)
      if (failure.permissionDenied) {
        const denial = explainDenial({ path: "/cluster/status", method: "GET", httpStatus: 403, proxmoxMessage: failure.message })
        if (denial) clusterDenials.push(denial)
      }
    }
    const resourcesResult = await timed(() => options.clusterChecks!.resources())
    resourcesOk = resourcesResult.ok
  }

  if (clusterDenials.length) {
    visibilityParts.push(
      "cluster-wide telemetry is unavailable because this token lacks the privilege it requires; per-node inventory is unaffected"
    )
  }

  return {
    nodes,
    counts,
    visibilityNote: `${visibilityParts.join("; ")}.`,
    cluster: { nodeListOk: true, statusOk, resourcesOk, denials: clusterDenials },
  }
}

/**
 * The five fleet statuses the dashboard distinguishes.
 *
 * They are kept separate on purpose. API connectivity is not operational
 * readiness: a node can answer its API perfectly and still be unable to take a
 * snapshot, run a console, or report telemetry to this token.
 */
export type NodeHealthStatus = "healthy" | "degraded" | "permission_required" | "unsupported" | "offline"

export const NODE_HEALTH_STATUS_LABELS: Record<NodeHealthStatus, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  permission_required: "Permission Required",
  unsupported: "Unsupported",
  offline: "Offline",
}

/** Derive one node's health status from its discovery record. */
export function nodeHealthStatus(node: DiscoveredNode): { status: NodeHealthStatus; reasons: string[]; remediation: string[] } {
  const reasons: string[] = []
  const remediation: string[] = []

  if (node.availability === "offline") {
    return { status: "offline", reasons: [`Node ${node.node} is not answering.`], remediation: [] }
  }

  const denied = node.denials.length > 0
  if (denied) {
    for (const denial of node.denials) {
      reasons.push(`${denial.capability} is not permitted: ${denial.requiredPrivilege ?? denial.alternatives.join(" or ")} on ${denial.aclPath ?? "/"}`)
      remediation.push(denial.remediation)
    }
    return { status: "permission_required", reasons, remediation }
  }

  if (node.availability === "inaccessible") {
    reasons.push(`Node ${node.node} is listed by the cluster but this token cannot read its status.`)
    return { status: "permission_required", reasons, remediation }
  }

  // Console permissions are a first-class capability here: a token that can list
  // and control VMs but cannot open a console is "Permission Required", not
  // "Degraded", because the fix is a specific grant rather than a broken node.
  const consoleDenied = [node.console.vnc, node.console.serial].filter((outcome) => outcome.state === "denied")
  if (consoleDenied.length) {
    for (const outcome of consoleDenied) {
      reasons.push(outcome.message)
      remediation.push(
        "Grant VM.Console on the affected VM's path in the Proxmox ACL. This is a separate privilege from VM.PowerMgmt and does not imply it."
      )
    }
    return { status: "permission_required", reasons, remediation }
  }

  if (node.storage.snapshotSupported === false) {
    reasons.push(`Snapshots unavailable. ${node.storage.snapshotDetail}`)
    if (node.storage.snapshotRemediation) remediation.push(node.storage.snapshotRemediation)
  }
  if (node.storage.backupSupported === false) {
    reasons.push(`Backups unavailable. ${node.storage.backupDetail}`)
    if (node.storage.backupRemediation) remediation.push(node.storage.backupRemediation)
  }
  if (node.vms.visibleToToken && node.vms.total === 0) {
    reasons.push("No VMs are visible to this API token on this node.")
  }
  const consoleUnmeasured = [node.console.vnc, node.console.serial].filter((outcome) => outcome.state === "unmeasured")
  if (consoleUnmeasured.length && !node.console.probeVmid) {
    reasons.push("Console access was not measured: this node has no running guest to open a console session against.")
  }

  if (reasons.length) return { status: "degraded", reasons, remediation }
  return { status: "healthy", reasons: [], remediation: [] }
}

/** The features a report could not establish, grouped by why. */
export function summariseFeatureCoverage(report: DiscoveryReport) {
  const out: Record<ProxmoxFeatureKey, { supported: number; total: number; nodes: string[]; denied: string[] }> = {
    discovery: { supported: report.counts.discovered, total: report.counts.discovered, nodes: [], denied: [] },
    cluster_inventory: { supported: 0, total: report.counts.discovered, nodes: [], denied: [] },
    vm_inspection: { supported: 0, total: report.counts.discovered, nodes: [], denied: [] },
    console: { supported: 0, total: report.counts.discovered, nodes: [], denied: [] },
    vm_power: { supported: 0, total: report.counts.discovered, nodes: [], denied: [] },
    vm_config: { supported: 0, total: report.counts.discovered, nodes: [], denied: [] },
    snapshot: { supported: 0, total: report.counts.discovered, nodes: [], denied: [] },
    backup: { supported: 0, total: report.counts.discovered, nodes: [], denied: [] },
    guest_agent: { supported: 0, total: report.counts.discovered, nodes: [], denied: [] },
    storage: { supported: 0, total: report.counts.discovered, nodes: [], denied: [] },
  }
  for (const node of report.nodes) {
    if (node.availability === "online") out.cluster_inventory.supported += 1
    if (node.vms.visibleToToken) out.vm_inspection.supported += 1
    if (node.storage.inspected.length > 0) out.storage.supported += 1
    if (node.storage.snapshotSupported) out.snapshot.supported += 1
    if (node.storage.backupSupported) out.backup.supported += 1
    if (node.console.vnc.state === "verified") out.console.supported += 1
    if (node.vms.guestAgent && node.vms.guestAgent.reporting > 0) out.guest_agent.supported += 1
    for (const denial of node.denials) {
      if (!out[denial.feature].denied.includes(node.node)) out[denial.feature].denied.push(node.node)
    }
  }
  return out
}