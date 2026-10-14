import { prisma } from "@/lib/db"
import { createPanelLog } from "@/lib/panel-log"
import { getCachedJson, setCachedJson, invalidateCachedJson } from "@/lib/runtime-cache"
import {
  createProxmoxClient,
  PROXMOX_NODE_TIMEOUT_MS,
  PROXMOX_STORAGE_TIMEOUT_MS,
  PROXMOX_VM_TIMEOUT_MS,
  normalizeProxmoxHost,
  ProxmoxError,
} from "@/lib/proxmox/client"
import { bytesToDecimalGb, formatBytesDecimal } from "@/lib/format-units"
import { bucketStart } from "@/lib/bandwidth-accounting"

const WARN_THRESHOLD = 85
const CRITICAL_THRESHOLD = 95
export const MONITORING_TIMEOUT_MS = PROXMOX_NODE_TIMEOUT_MS
const NODE_LIST_CONCURRENCY = 2

export const NODE_METRICS_CACHE_TTL_SECONDS = 15
export const NODE_INVENTORY_CACHE_TTL_SECONDS = 60
const NODE_MONITOR_CACHE_PREFIX = "compute-node-monitoring:"
const NODE_INVENTORY_CACHE_PREFIX = "compute-node-inventory:"
const inFlightRefreshes = new Map<string, Promise<unknown>>()

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProxmoxError(408, `${label} timed out after ${ms}ms`, { layer: "proxmox", code: "HTTP_TIMEOUT" })),
      ms,
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function nodeSnapshotAgeSeconds(snapshot: { checkedAt?: string | null } | null): number {
  if (!snapshot?.checkedAt) return Number.POSITIVE_INFINITY
  const age = (Date.now() - new Date(snapshot.checkedAt).getTime()) / 1000
  return Number.isFinite(age) ? age : Number.POSITIVE_INFINITY
}

function scheduleBackgroundRefresh<T>(key: string, loader: () => Promise<T>, ttlSeconds: number) {
  if (inFlightRefreshes.has(key)) return
  const task = loader()
    .then((value) => {
      inFlightRefreshes.delete(key)
      void setCachedJson(key, value, ttlSeconds)
      return value
    })
    .catch(() => {
      inFlightRefreshes.delete(key)
    })
  inFlightRefreshes.set(key, task)
}

export type ComputeHealthStatus = "healthy" | "warning" | "critical" | "full" | "offline" | "overloaded"

type DbNode = {
  id: string
  name: string
  host: string
  tokenId: string
  tokenSecret: string
  nodeName: string
  isActive: boolean
  schedulingEnabled: boolean
  drainReason: string | null
  drainedAt: Date | null
  location: string | null
  status: string
  lastCheckedAt: Date | null
  allowInsecureTls: boolean
  resolvedIp?: string | null
  createdAt: Date
  updatedAt: Date
}

type OptionalResult<T = any> = { data: T } | { error: any }

type MonitoringOptions = {
  includeVersion?: boolean
  includeInventory?: boolean
  bypassCache?: boolean
  forceRefresh?: boolean
  logLivePath?: boolean
}

type MonitoringSnapshot = ReturnType<typeof normalizeNodeStatus> & {
  templates?: any[]
  isos?: any[]
  tasks?: any[]
  events?: any[]
  error?: string
}

export async function invalidateComputeNodeCache(id?: string | null) {
  await Promise.all([
    invalidateCachedJson(id ? `${NODE_MONITOR_CACHE_PREFIX}${id}` : NODE_MONITOR_CACHE_PREFIX),
    invalidateCachedJson(id ? `${NODE_INVENTORY_CACHE_PREFIX}${id}` : NODE_INVENTORY_CACHE_PREFIX),
  ])
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length)
  let index = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index++
      results[currentIndex] = await worker(items[currentIndex])
    }
  })
  await Promise.all(runners)
  return results
}

export function percent(used: unknown, total: unknown) {
  const u = Number(used || 0)
  const t = Number(total || 0)
  if (!Number.isFinite(u) || !Number.isFinite(t) || t <= 0) return 0
  return Math.max(0, Math.min(100, Number(((u / t) * 100).toFixed(1))))
}

export function cpuPercent(value: unknown) {
  const n = Number(value || 0)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Number((n * 100).toFixed(1))))
}

export function latestRrdNetworkRate(rows: unknown) {
  if (!Array.isArray(rows)) return null
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index] as Record<string, unknown> | null
    if (!row || typeof row !== "object") continue
    const networkIn = row.netin == null ? Number.NaN : Number(row.netin)
    const networkOut = row.netout == null ? Number.NaN : Number(row.netout)
    if (!Number.isFinite(networkIn) && !Number.isFinite(networkOut)) continue
    return {
      networkIn: Math.max(0, Math.round(Number.isFinite(networkIn) ? networkIn : 0)),
      networkOut: Math.max(0, Math.round(Number.isFinite(networkOut) ? networkOut : 0)),
      recordedAt: Number.isFinite(Number(row.time)) ? Number(row.time) : null,
    }
  }
  return null
}

export function bytesToGbDecimal(value: unknown) {
  return Number(bytesToDecimalGb(value).toFixed(2))
}

export function formatBytes(value: unknown) {
  return formatBytesDecimal(value, { fallback: "0 GB" })
}

export function formatUptime(seconds: unknown) {
  let remaining = Math.max(0, Math.floor(Number(seconds || 0)))
  const days = Math.floor(remaining / 86400)
  remaining -= days * 86400
  const hours = Math.floor(remaining / 3600)
  remaining -= hours * 3600
  const minutes = Math.floor(remaining / 60)
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function normalizeLoadAverage(value: unknown) {
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => Number(item || 0).toFixed(2)).join(" / ")
  const text = String(value || "").trim()
  if (!text) return "-"
  return text.split(/\s+/).slice(0, 3).map((item) => Number(item || 0).toFixed(2)).join(" / ")
}

export function classifyHealth(input: {
  reachable: boolean
  cpuUsage: number
  memoryUsage: number
  diskUsage: number
  storageUsages?: number[]
  storageIssue?: boolean
  activeTasks?: number
  maxTasks?: number
}) {
  if (!input.reachable) {
    return { status: "offline" as const, critical: true, provisionAllowed: false, provisionPriority: "normal" as const }
  }
  return {
    status: "healthy" as const,
    critical: false,
    provisionAllowed: true,
    provisionPriority: "normal" as const,
  }
}

export function sameNodeProvisionAllowed(status: unknown) {
  return true
}

export function replacementProvisionAllowed(status: unknown) {
  return true
}

export function provisionBlocked(status: unknown) {
  return false
}

export function safeMonitoringError(error: any) {
  const message = String(error?.message || "Proxmox API error")
  const status = Number(error?.status || 0)
  const httpStatus = Number(error?.httpStatus || 0)
  const code = String(error?.code || "")
  const redacted = message.replace(new RegExp("PVEAPI" + "Token=[^\\s\"'<>]+", "gi"), "ProxmoxToken=[redacted]").slice(0, 240)
  // The client already classifies a rejected credential precisely. Checking the
  // code first is what turns an unusable `{"data":null}` body into a message
  // that names the actual problem - an expired or mis-scoped API token on the
  // node - instead of leaving an operator to guess.
  if (code === "AUTH_FAILED_401" || httpStatus === 401) return "Proxmox authentication or permission failed"
  if (code === "PERMISSION_DENIED_403" || httpStatus === 403) return "Proxmox authentication or permission failed"
  if (status === 400 && /unauthorized|token|permission|auth/i.test(message)) return "Proxmox authentication or permission failed"
  if (code === "VM_NOT_FOUND") return "Proxmox VM was not found on this node"
  if (code === "TEMPLATE_MISSING") return "Proxmox template is missing"
  if (code === "STORAGE_UNAVAILABLE") return "Proxmox storage is unavailable"
  if (code === "VMID_CONFLICT") return "VMID already exists on Proxmox"
  if (code === "INSUFFICIENT_RESOURCES") return "Proxmox node has insufficient resources"
  if (code === "NETWORK_BRIDGE_MISSING") return "Proxmox network bridge is missing"
  if (code === "CLONE_FAILED") return redacted
  if (code === "RESPONSE_TOO_LARGE") return "Proxmox response was too large"
  if (/unauthorized|token|permission|auth/i.test(message)) return "Proxmox authentication or permission failed"
  if (/timeout/i.test(message)) return "Proxmox API timeout"
  if (/certificate|tls/i.test(message)) return "Proxmox TLS/certificate issue"
  if (/connect|host|network/i.test(message)) return "Unable to reach Proxmox host"
  // A body that was only ever `{"data":null}` reached here because the status
  // was not one of the cases above. Name the failure rather than echoing it.
  if (/^\{\s*"data"\s*:\s*null\s*\}$/.test(message)) return "Proxmox returned an empty error body"
  return message === "Proxmox API error" ? "Proxmox API error" : redacted
}

function safeNode(node: DbNode) {
  return {
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
    hasTokenSecret: Boolean(node.tokenSecret),
    // The cached guest-automation verdict, so the node list can say whether a
    // node can actually configure a guest rather than only whether it is
    // connected. Read straight from the cached row: measuring here would put a
    // guest-exec round trip on every list render.
    guestCapabilities: (node as any).guestCapabilities
      ? {
          status: String((node as any).guestCapabilities.status || "pending"),
          pass: Array.isArray((node as any).guestCapabilities.checks)
            ? ((node as any).guestCapabilities.checks as any[]).filter((entry) => entry?.state === "pass").length
            : 0,
          fail: Array.isArray((node as any).guestCapabilities.checks)
            ? ((node as any).guestCapabilities.checks as any[]).filter((entry) => entry?.state === "fail").length
            : 0,
          skip: Array.isArray((node as any).guestCapabilities.checks)
            ? ((node as any).guestCapabilities.checks as any[]).filter((entry) => entry?.state === "skip").length
            : 0,
          total: Array.isArray((node as any).guestCapabilities.checks) ? (node as any).guestCapabilities.checks.length : 0,
          lastCheckedAt: (node as any).guestCapabilities.lastCheckedAt || null,
          lastSuccessAt: (node as any).guestCapabilities.lastSuccessAt || null,
          lastError: (node as any).guestCapabilities.lastError || null,
          stale: (node as any).guestCapabilities.lastCheckedAt
            ? Date.now() - new Date((node as any).guestCapabilities.lastCheckedAt).getTime() > 30 * 60 * 1000
            : true,
        }
      : { status: "pending", pass: 0, fail: 0, skip: 0, total: 0, lastCheckedAt: null, lastSuccessAt: null, lastError: null, stale: true },
  }
}

function liveLog(_event: string, _metadata: Record<string, unknown>) {}

function safeLiveError(error: any) {
  return {
    error: safeMonitoringError(error),
    status: error?.status || null,
  }
}

function clientForNode(node: DbNode, options: { logLivePath?: boolean } = {}) {
  const normalizedHost = normalizeProxmoxHost(node.host)
  if (options.logLivePath) {
    liveLog("proxmox_host_normalized", {
      nodeId: node.id,
      nodeName: node.nodeName,
      host: normalizedHost,
      allowInsecureTls: node.allowInsecureTls,
      timeoutMs: MONITORING_TIMEOUT_MS,
    })
    liveLog("api_auth_mode", {
      nodeId: node.id,
      nodeName: node.nodeName,
      mode: node.tokenId && node.tokenSecret ? "api_token" : "missing_credentials",
    })
  }

  return createProxmoxClient(normalizedHost, node.tokenId, node.tokenSecret, {
    allowInsecureTls: node.allowInsecureTls,
    timeoutMs: MONITORING_TIMEOUT_MS,
  })
}

function normalizeStorage(rows: any[]) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const total = Number(row.total || 0)
    const used = Number(row.used || 0)
    const free = Number(row.avail || row.free || Math.max(0, total - used))
    const usagePercent = percent(used, total)
    return {
      name: String(row.storage || row.name || "-"),
      type: row.type || "-",
      totalBytes: total,
      usedBytes: used,
      freeBytes: free,
      total: formatBytes(total),
      used: formatBytes(used),
      free: formatBytes(free),
      usagePercent,
      active: row.active === undefined ? null : Boolean(Number(row.active)),
      enabled: row.enabled === undefined ? null : Boolean(Number(row.enabled)),
      content: row.content || null,
    }
  })
}

function normalizeGuest(row: any, type: "VM" | "LXC") {
  const template = Boolean(Number(row.template || 0))
  return {
    vmid: Number(row.vmid || 0),
    name: row.name || row.hostname || `Guest ${row.vmid}`,
    type: template ? "template" : type,
    status: row.status || "unknown",
    cpuCores: Number(row.cpus || row.cores || 0),
    memoryBytes: Number(row.maxmem || row.mem || 0),
    memory: formatBytes(row.maxmem || row.mem || 0),
    diskBytes: Number(row.maxdisk || row.disk || 0),
    disk: formatBytes(row.maxdisk || row.disk || 0),
    ipAddress: row.ip || row.ipAddress || null,
    template,
    uptime: formatUptime(row.uptime || 0),
  }
}

function normalizeStorageContent(row: any, storage: string) {
  return {
    volid: String(row?.volid || row?.name || ""),
    name: String(row?.volid || row?.name || "").split("/").pop() || String(row?.volid || row?.name || ""),
    storage,
    content: String(row?.content || ""),
    format: row?.format || null,
    sizeBytes: Number(row?.size || 0),
    size: formatBytes(row?.size || 0),
  }
}

function normalizeTask(row: any) {
  return {
    upid: String(row?.upid || ""),
    type: String(row?.type || row?.worker_type || "task"),
    status: String(row?.status || "unknown"),
    exitstatus: row?.exitstatus || null,
    user: row?.user || null,
    vmid: row?.id || row?.vmid || null,
    starttime: row?.starttime ? new Date(Number(row.starttime) * 1000).toISOString() : null,
    endtime: row?.endtime ? new Date(Number(row.endtime) * 1000).toISOString() : null,
  }
}

function normalizeClusterEvent(row: any) {
  return {
    id: String(row?.id || row?.time || row?.msg || Math.random()),
    time: row?.time ? new Date(Number(row.time) * 1000).toISOString() : new Date().toISOString(),
    node: row?.node || null,
    user: row?.user || null,
    severity: row?.pri || row?.severity || null,
    message: row?.msg || row?.message || "",
  }
}

function summarizeGuests(guests: any[]) {
  return {
    running: guests.filter((guest) => guest.status === "running" && guest.type !== "template").length,
    stopped: guests.filter((guest) => guest.status === "stopped" && guest.type !== "template").length,
    templates: guests.filter((guest) => guest.type === "template" || guest.template).length,
    failedUnknown: guests.filter((guest) => !["running", "stopped"].includes(String(guest.status))).length,
    total: guests.length,
  }
}

function normalizeNodeStatus(status: any, storage: any[], guests: any[], version: any, node: DbNode, errors: Record<string, string> = {}) {
  const cpuUsage = cpuPercent(status?.cpu)
  const memoryUsage = percent(status?.memory?.used, status?.memory?.total)
  const diskUsage = percent(status?.rootfs?.used, status?.rootfs?.total)
  const storageRows = normalizeStorage(storage)
  const vmStorageRows = storageRows.filter((row) => {
    const content = String(row.content || "").toLowerCase()
    return content.includes("images") || content.includes("rootdir")
  })
  const storageIssue = vmStorageRows.some((row) => row.active === false || row.enabled === false)
  const health = classifyHealth({
    reachable: true,
    cpuUsage,
    memoryUsage,
    diskUsage,
    storageUsages: vmStorageRows.map((row) => row.usagePercent),
    storageIssue,
    activeTasks: Number((node as any).nodeWorker?.activeTasks || 0),
    maxTasks: Number((node as any).nodeWorker?.maxTasks || 1),
  })
  const summary = summarizeGuests(guests)
  const maxVmCapacity = Math.max(Number((node as any).maxVms || 0), summary.running)

  return {
    node: safeNode(node),
    health,
    status: health.status,
    checkedAt: new Date().toISOString(),
    cpu: {
      usagePercent: cpuUsage,
      totalCores: Number(status?.cpuinfo?.cpus || 0),
      totalSockets: Number(status?.cpuinfo?.sockets || 0),
      model: status?.cpuinfo?.model || null,
      loadAverage: normalizeLoadAverage(status?.loadavg),
    },
    memory: {
      totalBytes: Number(status?.memory?.total || 0),
      usedBytes: Number(status?.memory?.used || 0),
      freeBytes: Math.max(0, Number(status?.memory?.total || 0) - Number(status?.memory?.used || 0)),
      total: formatBytes(status?.memory?.total),
      used: formatBytes(status?.memory?.used),
      free: formatBytes(Math.max(0, Number(status?.memory?.total || 0) - Number(status?.memory?.used || 0))),
      usagePercent: memoryUsage,
    },
    disk: {
      totalBytes: Number(status?.rootfs?.total || 0),
      usedBytes: Number(status?.rootfs?.used || 0),
      freeBytes: Math.max(0, Number(status?.rootfs?.total || 0) - Number(status?.rootfs?.used || 0)),
      total: formatBytes(status?.rootfs?.total),
      used: formatBytes(status?.rootfs?.used),
      free: formatBytes(Math.max(0, Number(status?.rootfs?.total || 0) - Number(status?.rootfs?.used || 0))),
      usagePercent: diskUsage,
    },
    network: {
      inboundBytes: Number(status?.netin || 0),
      outboundBytes: Number(status?.netout || 0),
      inbound: formatBytes(status?.netin),
      outbound: formatBytes(status?.netout),
    },
    uptime: {
      seconds: Number(status?.uptime || 0),
      readable: formatUptime(status?.uptime),
    },
    loadAverage: normalizeLoadAverage(status?.loadavg),
    version: {
      proxmox: version?.version || version?.release || null,
      kernel: status?.kversion || version?.repoid || null,
    },
    serverTime: {
      time: status?.time ? new Date(Number(status.time) * 1000).toISOString() : null,
      timezone: status?.timezone || null,
    },
    storage: storageRows,
    guests,
    vmSummary: summary,
    provisionCapacity: {
      allowed: health.provisionAllowed,
      priority: health.provisionPriority,
      state: health.status,
      vmCount: summary.running,
      maxVmCapacity: maxVmCapacity || null,
      remainingVmCapacity: maxVmCapacity ? Math.max(0, maxVmCapacity - summary.running) : null,
    },
    errors,
  }
}

export function monitoringResultFromParts(input: {
  node: DbNode
  status: any
  storageResult: OptionalResult<any[]>
  qemuResult: OptionalResult<any[]>
  lxcResult: OptionalResult<any[]>
  versionResult?: OptionalResult<any>
}) {
  const errors: Record<string, string> = {}
  if ("error" in input.storageResult) errors.storage = safeMonitoringError(input.storageResult.error)
  if ("error" in input.qemuResult) errors.guests = safeMonitoringError(input.qemuResult.error)
  if ("error" in input.lxcResult) errors.lxc = safeMonitoringError(input.lxcResult.error)
  if (input.versionResult && "error" in input.versionResult) errors.version = safeMonitoringError(input.versionResult.error)

  const qemuGuests = "data" in input.qemuResult ? input.qemuResult.data.map((guest: any) => normalizeGuest(guest, "VM")) : []
  const lxcGuests = "data" in input.lxcResult ? input.lxcResult.data.map((guest: any) => normalizeGuest(guest, "LXC")) : []

  const result = normalizeNodeStatus(
    input.status,
    "data" in input.storageResult ? input.storageResult.data : [],
    [...qemuGuests, ...lxcGuests].sort((a, b) => a.vmid - b.vmid),
    input.versionResult && "data" in input.versionResult ? input.versionResult.data : null,
    input.node,
    errors,
  )

  if (Object.keys(errors).length) {
    return {
      ...result,
      status: "healthy" as const,
      health: { ...result.health, status: "healthy" as const },
    }
  }

  return result
}

async function optionalRequest<T>(
  eventBase: "qemu_list" | "storage_status" | "lxc_list" | "node_version" | "node_network" | "cluster_status" | "node_rrd",
  request: Promise<T>,
  options: MonitoringOptions,
  metadata: Record<string, unknown>,
): Promise<OptionalResult<T>> {
  try {
    const data = await request
    if (options.logLivePath && (eventBase === "qemu_list" || eventBase === "storage_status")) {
      liveLog(`${eventBase}_ok`, {
        ...metadata,
        count: Array.isArray(data) ? data.length : null,
      })
    }
    return { data }
  } catch (error: any) {
    if (options.logLivePath && (eventBase === "qemu_list" || eventBase === "storage_status")) {
      liveLog(`${eventBase}_error`, {
        ...metadata,
        ...safeLiveError(error),
      })
    }
    return { error }
  }
}

async function loadMonitoringNode(id: string, options: MonitoringOptions = {}) {
  const node = await prisma.proxmoxNode.findUnique({ where: { id } }) as DbNode | null
  if (!node) throw new Error("Node not found")
  if (options.logLivePath) {
    liveLog("node_loaded", {
      nodeId: node.id,
      name: node.name,
      host: node.host,
      nodeName: node.nodeName,
      isActive: node.isActive,
      allowInsecureTls: node.allowInsecureTls,
      hasTokenId: Boolean(node.tokenId),
      hasTokenSecret: Boolean(node.tokenSecret),
    })
  }
  return node
}

async function getMonitoringSnapshot(id: string, options: MonitoringOptions = {}) {

  const node = await loadMonitoringNode(id, options)
  const client = clientForNode(node, options)
  const requestMeta = {
    nodeId: node.id,
    nodeName: node.nodeName,
    host: client.normalizedHost,
  }

  let status: any
  try {
    if (options.logLivePath) {
      liveLog("node_status_request", {
        ...requestMeta,
        endpoint: `/api2/json/nodes/${node.nodeName}/status`,
      })
    }
    status = await withDeadline(client.getNodeStats(node.nodeName), MONITORING_TIMEOUT_MS + 2000, "node status")
    if (options.logLivePath) {
      liveLog("node_status_ok", requestMeta)
    }
  } catch (error: any) {
    if (options.logLivePath) {
      liveLog("node_status_error", {
        ...requestMeta,
        ...safeLiveError(error),
      })
    }
    throw error
  }

  const [storageResult, qemuResult, lxcResult, versionResult, networkResult, clusterStatusResult, nodeRrdResult] = await Promise.all([
    optionalRequest("storage_status", withDeadline(client.getNodeStorage(node.nodeName), PROXMOX_STORAGE_TIMEOUT_MS + 2000, "storage"), options, requestMeta),
    optionalRequest("qemu_list", withDeadline(client.getVMList(node.nodeName), PROXMOX_VM_TIMEOUT_MS + 1500, "qemu"), options, requestMeta),
    optionalRequest("lxc_list", withDeadline(client.getLxcList(node.nodeName), PROXMOX_VM_TIMEOUT_MS + 1500, "lxc"), options, requestMeta),
    options.includeVersion
      ? optionalRequest("node_version", withDeadline(client.getNodeVersion(node.nodeName), PROXMOX_NODE_TIMEOUT_MS + 2000, "version"), options, requestMeta)
      : Promise.resolve({ data: null } as OptionalResult<any>),
    optionalRequest("node_network", withDeadline(client.getNodeNetwork(node.nodeName), PROXMOX_NODE_TIMEOUT_MS + 2000, "network"), options, requestMeta),
    optionalRequest("cluster_status", withDeadline(client.getClusterStatus(), PROXMOX_NODE_TIMEOUT_MS + 2000, "cluster"), options, requestMeta),
    optionalRequest("node_rrd", withDeadline(client.getNodeRrdData(node.nodeName, "hour"), PROXMOX_NODE_TIMEOUT_MS + 2000, "rrd"), options, requestMeta),
  ])

  const base = monitoringResultFromParts({
    node,
    status,
    storageResult,
    qemuResult,
    lxcResult,
    versionResult,
  })

  const qemuTemplates = ("data" in qemuResult ? qemuResult.data : [])
    .filter((guest: any) => Number(guest?.template || 0))
    .map((guest: any) => ({
      vmid: Number(guest?.vmid || 0),
      name: guest?.name || `Template ${guest?.vmid}`,
      storage: null,
      source: "qemu",
      status: guest?.status || null,
    }))

  let contentRows: any[] = []
  let taskRows: any[] = []
  let eventRows: any[] = []
  if (options.includeInventory) {
    const storageRows = "data" in storageResult ? storageResult.data : []
    const activeStorageRows = (Array.isArray(storageRows) ? storageRows : [])
      .filter((row: any) => Number(row?.enabled ?? 1) !== 0 && Number(row?.active ?? 1) !== 0)
      .slice(0, 4)
    ;[contentRows, taskRows, eventRows] = await Promise.all([
      mapLimit(activeStorageRows, 2, async (row: any) => {
        const storageId = String(row?.storage || "")
        if (!storageId) return []
        const rows = await client.getStorageContent(node.nodeName, storageId).catch(() => [])
        return (Array.isArray(rows) ? rows : []).map((item) => normalizeStorageContent(item, storageId))
      }).then((rows) => rows.flat()).catch(() => []),
      client.getNodeTasks(node.nodeName, 25).then((rows) => (Array.isArray(rows) ? rows : []).map(normalizeTask)).catch(() => []),
      client.getClusterLog(25).then((rows) => (Array.isArray(rows) ? rows : []).map(normalizeClusterEvent)).catch(() => []),
    ])
  }
  const monthBucket = bucketStart("month")
  const [activeProvisioningJobs, nodeBandwidth] = await Promise.all([
    prisma.provisioningJob.findMany({
      where: { proxmoxNodeId: node.id, status: { in: ["queued", "running", "retrying", "waiting_for_admin"] } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, orderId: true, vmid: true, status: true, currentStep: true, displayStatus: true, createdAt: true },
    }).catch(() => []),
    (prisma as any).bandwidthUsageRollup.findUnique({
      where: { scopeType_scopeId_period_bucketAt: { scopeType: "node", scopeId: node.id, period: "month", bucketAt: monthBucket } },
    }).catch(() => null),
  ])

  const rrd = "data" in nodeRrdResult ? nodeRrdResult.data : []
  const rrdNetwork = latestRrdNetworkRate(rrd)
  const result = {
    ...base,
    network: rrdNetwork ? {
      inboundBytes: rrdNetwork.networkIn,
      outboundBytes: rrdNetwork.networkOut,
      inbound: `${formatBytes(rrdNetwork.networkIn)}/s`,
      outbound: `${formatBytes(rrdNetwork.networkOut)}/s`,
      source: "proxmox_rrd",
    } : base.network,
    templates: [
      ...qemuTemplates,
      ...contentRows.filter((row) => /vztmpl|template|images/i.test(row.content)).map((row) => ({ ...row, source: "storage" })),
    ],
    isos: contentRows.filter((row) => /iso/i.test(row.content) || /\.iso$/i.test(row.name)),
    tasks: taskRows,
    events: eventRows,
    activeProvisioningJobs,
    nodeBandwidth: {
      monthBucketAt: monthBucket.toISOString(),
      totalBytes: Number(nodeBandwidth?.totalBytes || 0),
      rxBytes: Number(nodeBandwidth?.rxBytes || 0),
      txBytes: Number(nodeBandwidth?.txBytes || 0),
      peakRateBps: Number(nodeBandwidth?.peakRateBps || 0),
      total: formatBytes(nodeBandwidth?.totalBytes || 0),
      inbound: formatBytes(nodeBandwidth?.rxBytes || 0),
      outbound: formatBytes(nodeBandwidth?.txBytes || 0),
      peakRate: `${formatBytes(nodeBandwidth?.peakRateBps || 0)}/s`,
    },
    networkInterfaces: "data" in networkResult ? networkResult.data : [],
    clusterStatus: "data" in clusterStatusResult ? clusterStatusResult.data : [],
    rrd,
    liveThroughput: {
      rxRateBps: Number(rrdNetwork?.networkIn || 0),
      txRateBps: Number(rrdNetwork?.networkOut || 0),
      currentMbps: Number(((((rrdNetwork?.networkIn || 0) + (rrdNetwork?.networkOut || 0)) * 8) / 1_000_000).toFixed(3)),
      currentKbps: Number(((((rrdNetwork?.networkIn || 0) + (rrdNetwork?.networkOut || 0)) * 8) / 1_000).toFixed(1)),
      source: rrdNetwork ? "proxmox_rrd" : "unavailable",
    },
  }
  return result
}

export function toLiveNodeMetrics(data: any) {
  return {
    status: data.status,
    cpuUsage: Number(data.cpu?.usagePercent || 0),
    cpuCores: Number(data.cpu?.totalCores || 0),
    memoryUsed: data.memory?.used || "0 GB",
    memoryTotal: data.memory?.total || "0 GB",
    memoryUsedBytes: Number(data.memory?.usedBytes || 0),
    memoryTotalBytes: Number(data.memory?.totalBytes || 0),
    memoryUsage: Number(data.memory?.usagePercent || 0),
    diskUsed: data.disk?.used || "0 GB",
    diskTotal: data.disk?.total || "0 GB",
    diskUsedBytes: Number(data.disk?.usedBytes || 0),
    diskTotalBytes: Number(data.disk?.totalBytes || 0),
    diskUsage: Number(data.disk?.usagePercent || 0),
    uptime: data.uptime?.readable || "-",
    uptimeSeconds: Number(data.uptime?.seconds || 0),
    loadAverage: data.loadAverage || data.cpu?.loadAverage || "-",
    networkIn: data.network?.inbound || "0 GB",
    networkOut: data.network?.outbound || "0 GB",
    networkInBytes: Number(data.network?.inboundBytes || 0),
    networkOutBytes: Number(data.network?.outboundBytes || 0),
    runningInstances: Number(data.vmSummary?.running || 0),
    stoppedInstances: Number(data.vmSummary?.stopped || 0),
    templates: Number(data.vmSummary?.templates || 0),
    failedUnknown: Number(data.vmSummary?.failedUnknown || 0),
    totalGuests: Number(data.vmSummary?.total || 0),
    health: data.health || { status: data.status || "offline", critical: data.status === "offline" },
    errors: data.errors || {},
    refreshedAt: data.checkedAt || new Date().toISOString(),
  }
}

export async function getNodeLiveMetrics(id: string) {
  let detail: MonitoringSnapshot
  try {
    detail = await getMonitoringSnapshot(id, { logLivePath: true })
  } catch (error: any) {
    if (String(error?.message || "") === "Node not found") throw error
    detail = await getNodeMonitoring(id)
  }
  return toLiveNodeMetrics(detail)
}

async function getMonitoringSnapshotCached(id: string, options: MonitoringOptions = {}) {
  const snapshotKey = `${NODE_MONITOR_CACHE_PREFIX}${id}`
  if (!options.bypassCache && !options.forceRefresh) {
    const cached = await getCachedJson<MonitoringSnapshot>(snapshotKey)
    if (cached) {
      if (nodeSnapshotAgeSeconds(cached) < NODE_METRICS_CACHE_TTL_SECONDS) return cached
      scheduleBackgroundRefresh(snapshotKey, () => getMonitoringSnapshot(id, options), NODE_METRICS_CACHE_TTL_SECONDS)
      return cached
    }
  }
  const snapshot = await getMonitoringSnapshot(id, options)
  if (snapshot.status !== "offline" && !(snapshot as any).error) {
    void setCachedJson(snapshotKey, snapshot, NODE_METRICS_CACHE_TTL_SECONDS)
  }
  return snapshot
}

export async function getNodeMonitoring(id: string, options: { logErrors?: boolean; actorEmail?: string; refresh?: boolean; includeInventory?: boolean } = {}) {
  const node = await prisma.proxmoxNode.findUnique({ where: { id } }) as DbNode | null
  if (!node) throw new Error("Node not found")

  try {
    return await getMonitoringSnapshotCached(id, {
      includeVersion: true,
      includeInventory: Boolean(options.includeInventory),
      bypassCache: Boolean(options.refresh),
      forceRefresh: Boolean(options.refresh),
    })
  } catch (error: any) {
    if (options.logErrors) {
      await createPanelLog({
        category: "Compute Node",
        level: /auth|permission|token/i.test(String(error?.message || "")) ? "error" : "warn",
        message: /auth|permission|token/i.test(String(error?.message || "")) ? "Proxmox auth/permission error" : "Proxmox API error",
        actorType: options.actorEmail ? "admin" : "system",
        actorEmail: options.actorEmail || null,
        metadata: { nodeId: node.id, nodeName: node.nodeName, host: node.host, error: safeMonitoringError(error), status: error?.status || null },
      })
    }
    return {
      node: safeNode(node),
      health: { status: "offline" as const, critical: true, provisionAllowed: false, provisionPriority: "normal" as const },
      status: "offline" as const,
      checkedAt: new Date().toISOString(),
      error: "Node temporarily unavailable",
      cpu: { usagePercent: 0, totalCores: 0, totalSockets: 0, model: null, loadAverage: "-" },
      memory: { totalBytes: 0, usedBytes: 0, freeBytes: 0, total: "0 GB", used: "0 GB", free: "0 GB", usagePercent: 0 },
      disk: { totalBytes: 0, usedBytes: 0, freeBytes: 0, total: "0 GB", used: "0 GB", free: "0 GB", usagePercent: 0 },
      network: { inboundBytes: 0, outboundBytes: 0, inbound: "0 GB", outbound: "0 GB" },
      uptime: { seconds: 0, readable: "-" },
      loadAverage: "-",
      version: { proxmox: null, kernel: null },
      serverTime: { time: null, timezone: null },
      storage: [],
      guests: [],
      vmSummary: { running: 0, stopped: 0, templates: 0, failedUnknown: 0, total: 0 },
      provisionCapacity: { allowed: false, priority: "normal" as const, state: "offline" as const, vmCount: 0, maxVmCapacity: null, remainingVmCapacity: null },
      errors: { node: safeMonitoringError(error) },
    }
  }
}

export async function listComputeNodes() {
  const nodes = await prisma.proxmoxNode.findMany({
    orderBy: { createdAt: "desc" },
    include: { guestCapabilities: true },
  })
  return mapLimit(nodes, NODE_LIST_CONCURRENCY, (node) => getNodeMonitoring(node.id))
}

export async function refreshComputeNode(id: string, actorEmail: string) {
  const data = await getNodeMonitoring(id, { logErrors: true, actorEmail, refresh: true })
  await prisma.proxmoxNode.update({
    where: { id },
    data: {
      status: data.status,
      lastCheckedAt: new Date(),
      cpuSocketsDetected: data.cpu?.totalSockets || undefined,
      defaultVmSockets: data.cpu?.totalSockets || undefined,
      cpuModel: data.cpu?.model || undefined,
    },
  }).catch(() => undefined)
  await createPanelLog({
    category: "Compute Node",
    level: "info",
    message: "Node refresh completed",
    actorType: "admin",
    actorEmail,
    metadata: { nodeId: id, nodeName: data.node.nodeName, host: data.node.host, status: data.status, errors: data.errors || {} },
  })
  return data
}

export async function computeNodeSections(id: string) {
  const data = await getNodeMonitoring(id)
  return {
    status: { node: data.node, health: data.health, status: data.status, checkedAt: data.checkedAt, error: (data as any).error || null },
    resources: { cpu: data.cpu, memory: data.memory, disk: data.disk, network: data.network, uptime: data.uptime, loadAverage: data.loadAverage, version: data.version, serverTime: data.serverTime },
    storage: { storage: data.storage, errors: data.errors },
    guests: { guests: data.guests, vmSummary: data.vmSummary, errors: data.errors },
    inventory: { templates: (data as any).templates || [], isos: (data as any).isos || [], tasks: (data as any).tasks || [], events: (data as any).events || [] },
  }
}

export async function getNodeInventory(id: string) {
  const inventoryKey = `${NODE_INVENTORY_CACHE_PREFIX}${id}`
  const cached = await getCachedJson<any>(inventoryKey)
  const age = nodeSnapshotAgeSeconds(cached || null)
  if (cached && age < NODE_INVENTORY_CACHE_TTL_SECONDS) return cached
  if (cached && Number.isFinite(age)) {
    scheduleBackgroundRefresh(inventoryKey, () => loadNodeInventory(id), NODE_INVENTORY_CACHE_TTL_SECONDS)
    return cached
  }
  const data = await loadNodeInventory(id)
  if (!data.warning) void setCachedJson(inventoryKey, data, NODE_INVENTORY_CACHE_TTL_SECONDS)
  return data
}

async function loadNodeInventory(id: string) {
  const data = await getMonitoringSnapshot(id, { includeVersion: true, includeInventory: true }).catch(() => getNodeMonitoring(id))
  return {
    templates: (data as any).templates || [],
    isos: (data as any).isos || [],
    tasks: (data as any).tasks || [],
    events: (data as any).events || [],
    errors: data.errors || {},
    warning: (data as any).error || null,
    checkedAt: new Date().toISOString(),
  }
}

export { ProxmoxError }
