import { prisma } from "@/lib/db"
import { assignableIpPoolStatus, findAssignablePools } from "@/lib/ip-pool"
import { getAvailableOsTemplates, resolvedOsTemplateFamily, serializeAvailableOsTemplate as serializePublicOperatingSystem } from "@/lib/os-template-availability"
import { osKindFromText, resolveTemplateFamilyVersion } from "@/lib/os-routing"
import { recordCapacityAlert } from "@/lib/provisioning-alerts"
import { createProxmoxClient } from "@/lib/proxmox"
import { cachedJson } from "@/lib/runtime-cache"
import { safeJson } from "@/lib/safe-json"
import { resolveStoragePoolForPurchase } from "@/lib/storage-pools"
import { provisionBlocked } from "@/lib/compute-node-monitoring"
import { guestAgentChannelOpen } from "@/lib/proxmox-agent-flag"
import { evaluateDiskAllocation, evaluateRamAllocation, type NodeResourcePolicy } from "@/lib/node-resource-policy"
import { readNodeResourcePolicy } from "@/lib/node-resource-policy-store"

const MIN_SAFE_VMID = 100
const MAX_SAFE_VMID = 999999
const DEFAULT_RAM_THRESHOLD_PERCENT = 90

type PlacementInput = {
  nodeId?: string | null
  vcpu: number
  ramGb: number
  storageGb: number
  productId?: string | null
  bandwidthTb?: number
  osFamily?: string | null
  osVersion?: string | null
  osTemplateId?: string | null
  nodeClassId?: string | null
  region?: string | null
  storagePoolId?: string | null
  storagePolicyType?: string | null
  requiredStorageType?: string | null
  requiredStoragePoolId?: string | null
  allowStorageFallback?: boolean | null
  allowPremiumNewPurchase?: boolean
  poolId?: string | null
  requestedIp?: string | null
  forceIpOverride?: boolean
  requireHealthyOrWarning?: boolean
}

export type PlacementCandidate = {
  nodeId: string
  nodeName: string
  nodeDisplayName: string
  ok: boolean
  reason: string
  capacity?: NodeCapacitySnapshot | null
}

export type NodeCapacitySnapshot = {
  cpuUsage: number
  ramUsage: number
  ramTotalGb: number | null
  ramFreeGb: number | null
  diskUsage: number
  runningVms: number
  stoppedVms: number
  storageFree: number
  networkIn: number
  networkOut: number
  recordedAt: string | null
  stale: boolean
  availability: "green" | "yellow" | "red" | "unknown"
}

function normalizedPlacementStatus(value: unknown) {
  const status = String(value || "").toLowerCase()
  if (status === "connected") return "healthy"
  if (status === "failed") return "offline"
  if (status === "unknown") return "warning"
  return status || "warning"
}

function nodePlacementScore(input: { capacity: NodeCapacitySnapshot | null; runningVms: number; recentProvisionCount: number }) {
  const templateScore = 40
  const ramFreePercent = input.capacity ? Math.max(0, 100 - Number(input.capacity.ramUsage || 0)) : 100
  const cpuFreePercent = input.capacity ? Math.max(0, 100 - Number(input.capacity.cpuUsage || 0)) : 100
  const vmScore = Math.max(0, 10 - Math.min(10, input.runningVms / 10))
  const recentScore = Math.max(0, 10 - Math.min(10, input.recentProvisionCount))
  return Number((templateScore + ramFreePercent * 0.2 + cpuFreePercent * 0.2 + vmScore + recentScore).toFixed(2))
}

type ProvisioningSystemSettings = {
  ramThresholdPercent: number
  maintenanceMode: boolean
  autoFailover: boolean
}

export type ProvisioningPlacement =
  | {
      ok: true
      node: any
      template: any
      storagePool: any
      failoverFromNodeId?: string | null
      failoverReason?: string | null
      reason: string
      candidates: PlacementCandidate[]
    }
  | {
      ok: false
      reason: string
      errorCode: string
      candidates: PlacementCandidate[]
    }

function sameFamily(left: unknown, right: unknown) {
  const a = resolvedOsTemplateFamily(typeof left === "object" && left ? left : { name: left, osFamily: left, category: left, osType: left, slug: left }).toLowerCase()
  const b = resolvedOsTemplateFamily(typeof right === "object" && right ? right : { name: right, osFamily: right, category: right, osType: right, slug: right }).toLowerCase()
  return a === b
}

function sameVersion(left: unknown, right: unknown) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase()
}

export function requestedOsKind(input?: { osFamily?: string | null; osVersion?: string | null; osName?: string | null }) {
  return osKindFromText([input?.osFamily, input?.osVersion, input?.osName].filter(Boolean).join(" "))
}

export function nodeProvisioningModeCompatible(mode: unknown, osKind: "windows" | "linux" | "unknown") {
  return true
}

async function provisioningSystemSettings(): Promise<ProvisioningSystemSettings> {
  const row = await (prisma as any).systemSetting.findFirst({
    where: { active: true },
    orderBy: { updatedAt: "desc" },
    select: {
      ramThresholdPercent: true,
      maintenanceMode: true,
      autoFailover: true,
    },
  }).catch(() => null)
  const ramThresholdPercent = Number(row?.ramThresholdPercent || DEFAULT_RAM_THRESHOLD_PERCENT)
  return {
    ramThresholdPercent: Number.isFinite(ramThresholdPercent) ? Math.max(1, Math.min(100, ramThresholdPercent)) : DEFAULT_RAM_THRESHOLD_PERCENT,
    maintenanceMode: Boolean(row?.maintenanceMode),
    autoFailover: row?.autoFailover !== false,
  }
}

function capacityAvailability(capacity: Pick<NodeCapacitySnapshot, "ramUsage" | "diskUsage"> | null) {
  if (!capacity) return "unknown" as const
  const high = Math.max(Number(capacity.ramUsage || 0), Number(capacity.diskUsage || 0))
  if (high >= 85) return "red" as const
  if (high >= 70) return "yellow" as const
  return "green" as const
}

async function latestCapacitySnapshot(nodeId: string): Promise<NodeCapacitySnapshot | null> {
  return cachedJson(`capacity:node:${nodeId}`, 30, async () => {
    const metric = await (prisma as any).nodeMetric.findFirst({
      where: { nodeId },
      orderBy: { recordedAt: "desc" },
      select: {
        cpuUsage: true,
        ramUsage: true,
        diskUsage: true,
        runningVms: true,
        stoppedVms: true,
        storageFree: true,
        networkIn: true,
        networkOut: true,
        metadata: true,
        recordedAt: true,
      },
    }).catch(() => null)
    if (!metric) return null
    const recordedAt = metric.recordedAt ? new Date(metric.recordedAt) : null
    const metadata = metric.metadata && typeof metric.metadata === "object" && !Array.isArray(metric.metadata) ? metric.metadata as Record<string, unknown> : {}
    const memoryTotalBytes = Number(metadata.memoryTotalBytes || metadata.memoryTotal || 0)
    const memoryFreeBytes = Number(metadata.memoryFreeBytes || metadata.memoryFree || 0)
    const snapshot = {
      cpuUsage: Number(metric.cpuUsage || 0),
      ramUsage: Number(metric.ramUsage || 0),
      ramTotalGb: memoryTotalBytes > 0 ? Number((memoryTotalBytes / 1024 / 1024 / 1024).toFixed(2)) : null,
      ramFreeGb: memoryFreeBytes > 0 ? Number((memoryFreeBytes / 1024 / 1024 / 1024).toFixed(2)) : null,
      diskUsage: Number(metric.diskUsage || 0),
      runningVms: Number(metric.runningVms || 0),
      stoppedVms: Number(metric.stoppedVms || 0),
      storageFree: Number(metric.storageFree || 0),
      networkIn: Number(metric.networkIn || 0),
      networkOut: Number(metric.networkOut || 0),
      recordedAt: recordedAt?.toISOString() || null,
      stale: !recordedAt || Date.now() - recordedAt.getTime() > 2 * 60_000,
      availability: "unknown" as const,
    }
    return safeJson({ ...snapshot, availability: capacityAvailability(snapshot) })
  })
}

function capacityBlockReason(capacity: NodeCapacitySnapshot | null, _ramThresholdPercent: number, requiredRamGb: number) {
  if (!capacity || capacity.stale) return null
  if (capacity.ramFreeGb !== null && Number.isFinite(capacity.ramFreeGb)) {
    return capacity.ramFreeGb > requiredRamGb ? null : `Insufficient RAM available on target node (${capacity.ramFreeGb.toFixed(1)}GB free, ${requiredRamGb}GB required)`
  }
  return null
}

/**
 * Sum of RAM already promised to VMs on a node.
 *
 * This is the "allocated" side of the allocation policy, counted once per
 * instance from `vps_instances.ramGb` - the same field the order flow uses to
 * size a VM - so a pending request is always compared against the commitment
 * that was actually recorded, not against live memory pressure. Using live free
 * RAM here is what made placement flap: a node that was merely busy looked full
 * and orders stalled behind it.
 *
 * Deliberately keyed on instance rows rather than on the metric sample so the
 * figure does not drift between telemetry updates.
 */
async function allocatedRamForNode(nodeId: string) {
  const rows = await (prisma as any).vpsInstance.findMany({
    where: { proxmoxNodeId: nodeId },
    select: { ramGb: true, status: true },
  }).catch(() => [] as Array<{ ramGb?: number | null; status?: string | null }>)
  if (!Array.isArray(rows)) return 0
  return Number(rows.reduce((total, row) => total + (Number(row?.ramGb) || 0), 0).toFixed(2))
}

/** Sum of logical disk already promised on a storage pool, in GB. */
async function allocatedDiskForPool(nodeId: string, storageId: string) {
  const rows = await (prisma as any).vpsInstance.findMany({
    where: { proxmoxNodeId: nodeId },
    select: { diskGb: true, diskTotalGb: true, storageId: true },
  }).catch(() => [] as Array<{ diskGb?: number | null; diskTotalGb?: number | null; storageId?: string | null }>)
  if (!Array.isArray(rows)) return 0
  return Number(
    rows
      .filter((row) => String(row?.storageId || "") === String(storageId || ""))
      .reduce((total, row) => total + (Number(row?.diskGb) || Number(row?.diskTotalGb) || 0), 0)
      .toFixed(2)
  )
}

async function hasAvailableIp(input: { proxmoxNodeId: string; productId?: string | null; poolId?: string | null; requestedIp?: string | null; forceIpOverride?: boolean }) {
  return (await assignableIpPoolStatus({
    proxmoxNodeId: input.proxmoxNodeId,
    productId: input.productId,
    poolId: input.poolId || null,
    requestedIp: input.requestedIp || null,
    forceOverride: input.forceIpOverride === true,
    allocationType: "default",
  })).ok
}

async function provisioningNetworkBridge(input: { proxmoxNodeId: string; productId?: string | null }) {
  const pools = await findAssignablePools({ proxmoxNodeId: input.proxmoxNodeId, productId: input.productId, allocationType: "default" })
  const pool = pools[0]
  if (pool) return String(pool.bridge || process.env.PROXMOX_DEFAULT_BRIDGE || "vmbr0")
  return String(process.env.PROXMOX_DEFAULT_BRIDGE || "vmbr0")
}

async function resolvePlacementStorage(input: {
  proxmoxNodeId: string
  storagePoolId?: string | null
  storagePolicyType?: string | null
  requiredStorageType?: string | null
  requiredStoragePoolId?: string | null
  allowStorageFallback?: boolean | null
  storageGb: number
  allowPremiumNewPurchase?: boolean
}) {
  const preferred = await resolveStoragePoolForPurchase({
    proxmoxNodeId: input.proxmoxNodeId,
    storagePoolId: input.storagePoolId,
    storagePolicyType: input.storagePolicyType,
    requiredStorageType: input.requiredStorageType,
    requiredStoragePoolId: input.requiredStoragePoolId,
    allowStorageFallback: input.allowStorageFallback,
    allowPremiumNewPurchase: input.allowPremiumNewPurchase,
    storageGb: input.storageGb,
  }).catch(() => null)
  const hasRoom = (pool: any) => {
    const freeGb = pool?.freeBytes ? Number(pool.freeBytes) / 1024 / 1024 / 1024 : 0
    return freeGb <= 0 || freeGb >= Number(input.storageGb || 0)
  }
  if (preferred && hasRoom(preferred)) return preferred
  // Only hard-stop on an explicitly requested pool when fallback is explicitly disabled. Otherwise
  // (allowStorageFallback defaults to true) fall through and auto-select any eligible pool with capacity
  // so provisioning never stalls at "Waiting for storage allocation" while other storage exists.
  if (input.storagePoolId && input.allowStorageFallback === false) return null

  return prisma.nodeStoragePoolConfig.findFirst({
    where: {
      proxmoxNodeId: input.proxmoxNodeId,
      enabled: true,
      missingFromProxmox: false,
      isUpgradeOnly: false,
      OR: [{ isPremium: false }, { premium: false }, { isCustomerSelectable: true }, { allowNewPurchase: true }],
      AND: [
        { OR: [{ freeBytes: null }, { freeBytes: { gte: BigInt(Math.ceil(Number(input.storageGb || 0) * 1024 * 1024 * 1024)) } }] },
      ],
    },
    orderBy: [{ defaultForNewVm: "desc" }, { premium: "asc" }, { sortOrder: "asc" }, { storageId: "asc" }],
  })
}

export async function findTemplateForNode(input: {
  nodeId: string
  osTemplateId?: string | null
  osFamily?: string | null
  osVersion?: string | null
  allowFallback?: boolean
}) {
  const requestedTemplate = await resolveTemplateFamilyVersion(input.osTemplateId || null)
  const templates = (await getAvailableOsTemplates({ nodeId: input.nodeId, purpose: "provision" }))
    .sort((a, b) => {
      const recommended = Number(Boolean(b.isDefault || b.isRecommended)) - Number(Boolean(a.isDefault || a.isRecommended))
      if (recommended !== 0) return recommended
      return String(a.name || "").localeCompare(String(b.name || ""))
    })
  const targetFamily = requestedTemplate?.family || input.osFamily || null
  const targetVersion = requestedTemplate?.version || input.osVersion || null
  const familyMatches = templates.filter((template) => !targetFamily || sameFamily(template, targetFamily))
  const exact = familyMatches.find((template) => !targetVersion || sameVersion(serializePublicOperatingSystem(template).version || template.name, targetVersion))
  if (exact) return exact
  if (input.allowFallback && !requestedTemplate) return familyMatches.find((template) => template.isDefault || template.isRecommended) || familyMatches[0] || null
  return null
}

export async function selectProvisioningNode(input: PlacementInput): Promise<ProvisioningPlacement> {
  const preferredNodeId = input.nodeId ? String(input.nodeId).trim() : null
  const preferredNodeWhere = { ...(input.nodeId ? { id: input.nodeId } : {}) }
  const systemSettings = await provisioningSystemSettings()
  const resourcePolicy: NodeResourcePolicy = await readNodeResourcePolicy()
  if (systemSettings.maintenanceMode) {
    return { ok: false, reason: "Provisioning is paused for maintenance", errorCode: "MAINTENANCE_MODE", candidates: [] }
  }
  const nodes = await prisma.proxmoxNode.findMany({
    where: {
      isActive: true,
      schedulingEnabled: true,
      ...(input.nodeClassId ? { nodeClassId: input.nodeClassId } : {}),
      ...(input.region ? { OR: [{ location: null }, { location: input.region }] } : {}),
    },
    include: {
      nodeWorker: true,
      vpsInstances: {
        where: { deletedAt: null, status: { notIn: ["DELETED", "FAILED"] } },
        select: { cpuCores: true, ramGb: true, diskGb: true },
      },
    },
  })
  const candidates: PlacementCandidate[] = []
  const eligible: Array<{ node: any; template: any; storagePool: any; capacity: NodeCapacitySnapshot | null; queuedTasks: number; activeTasks: number; ramUsage: number; freeRamPercent: number; preferred: boolean; placementScore: number; healthStatus: string }> = []

  if (preferredNodeId && !nodes.some((node) => node.id === preferredNodeId)) {
    const preferredNodeExists = Boolean(await prisma.proxmoxNode.findFirst({
      where: { isActive: true, ...preferredNodeWhere },
      select: { id: true, schedulingEnabled: true, drainReason: true },
    }))
    return {
      ok: false,
      reason: preferredNodeExists ? "Selected provision node is drained or does not match requested placement filters" : "Selected provision node is unavailable or inactive",
      errorCode: "NODE_UNAVAILABLE",
      candidates: [],
    }
  }

  for (const node of nodes) {
    const base = { nodeId: node.id, nodeName: node.nodeName, nodeDisplayName: node.name }
    const healthStatus = normalizedPlacementStatus(node.status)
    if (provisionBlocked(healthStatus) || (input.requireHealthyOrWarning && !["healthy", "warning"].includes(healthStatus))) {
      candidates.push({ ...base, ok: false, reason: `Node health is ${healthStatus}` })
      continue
    }

    const template = await findTemplateForNode({ nodeId: node.id, osTemplateId: input.osTemplateId || null, osFamily: input.osFamily, osVersion: input.osVersion, allowFallback: Boolean(input.nodeId) })
    if (!template) {
      candidates.push({ ...base, ok: false, reason: "OS template not available on this node" })
      continue
    }

    const capacity = await latestCapacitySnapshot(node.id)
    // The gate is a planned-allocation policy, not a live free-memory reading.
    // Live usage is still captured and shown, but a busy node is no longer
    // treated as a full one.
    const ramDecision = evaluateRamAllocation({
      physicalRamGb: capacity?.ramTotalGb ?? null,
      allocatedVmRamGb: await allocatedRamForNode(node.id),
      requestedRamGb: Number(input.ramGb || 0),
      policy: resourcePolicy,
    })
    const capacityReason = ramDecision.ok ? null : ramDecision.explanation
    if (capacityReason) {
      candidates.push({ ...base, ok: false, reason: capacityReason, capacity })
      if (node.id === preferredNodeId) {
        await recordCapacityAlert({
          event: "node_capacity_warning",
          dedupeKey: `node:${node.id}:provisioning_capacity_warning`,
          title: `${node.name} capacity warning`,
          message: `⚠️ Node Alert\n\nNode:\n${node.name}\n\nRAM policy:\n${capacityReason}`,
          nodeId: node.id,
          severity: "warning",
          metadata: {
            ramUsage: capacity?.ramUsage,
            ramTotalGb: ramDecision.physicalRamGb,
            systemReserveGb: ramDecision.systemReserveGb,
            allocatableRamGb: ramDecision.allocatableRamGb,
            policyCapGb: ramDecision.policyCapGb,
            committedRamGb: ramDecision.committedRamGb,
            remainingPolicyCapacityGb: ramDecision.remainingPolicyCapacityGb,
            requiredRamGb: input.ramGb,
            allocationPercent: resourcePolicy.ramAllocationPercent,
            note: "RAM gating uses planned allocation, not live free memory. CPU usage is informational and does not block provisioning.",
          },
        }).catch(() => null)
      }
      continue
    }

    const storagePool = await resolvePlacementStorage({
      proxmoxNodeId: node.id,
      storagePoolId: input.storagePoolId,
      storagePolicyType: input.storagePolicyType,
      requiredStorageType: input.requiredStorageType,
      requiredStoragePoolId: input.requiredStoragePoolId,
      allowStorageFallback: input.allowStorageFallback,
      storageGb: input.storageGb,
      allowPremiumNewPurchase: input.allowPremiumNewPurchase,
    })
    if (!storagePool) {
      candidates.push({ ...base, ok: false, reason: input.storagePoolId ? "Selected storage pool unavailable" : "Storage pool unavailable" })
      continue
    }

    // Storage is gated on the verified provisioning type, so a 5:1 logical
    // ratio can never be applied to a datastore that reserves the full size.
    const diskDecision = evaluateDiskAllocation({
      pool: storagePool,
      logicalAllocatedGb: await allocatedDiskForPool(node.id, String(storagePool.storageId || "")),
      requestedDiskGb: Number(input.storageGb || 0),
      policy: resourcePolicy,
    })
    if (!diskDecision.ok) {
      candidates.push({ ...base, ok: false, reason: diskDecision.explanation, capacity })
      continue
    }

    const ipStatus = await assignableIpPoolStatus({
      proxmoxNodeId: node.id,
      productId: input.productId,
      poolId: input.poolId || null,
      requestedIp: input.requestedIp || null,
      forceOverride: input.forceIpOverride === true,
      allocationType: "default",
      region: input.region || null,
    })
    if (!ipStatus.ok) {
      candidates.push({ ...base, ok: false, reason: ipStatus.reason })
      continue
    }

    const worker = (node as any).nodeWorker || null
    const queuedTasks = Math.max(0, Number(worker?.queuedTasks || 0))
    const activeTasks = Math.max(0, Number(worker?.activeTasks || 0))
    const maxTasks = Math.max(1, Number(worker?.maxTasks || 1))
    if (activeTasks >= maxTasks) {
      candidates.push({ ...base, ok: false, reason: "Node clone queue is full", capacity })
      continue
    }
    const freeRamPercent = capacity ? Math.max(0, 100 - Number(capacity.ramUsage || 0)) : 100
    const recentProvisionCount = await prisma.provisioningJob.count({
      where: { proxmoxNodeId: node.id, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, type: { in: ["provision", "reinstall"] } },
    }).catch(() => 0)
    const placementScore = nodePlacementScore({ capacity, runningVms: Number(capacity?.runningVms || node.vpsInstances?.length || 0), recentProvisionCount })
    candidates.push({ ...base, ok: true, reason: healthStatus === "critical" ? "Eligible at low priority" : `Eligible; score ${placementScore}`, capacity })
    eligible.push({ node, template, storagePool, capacity, queuedTasks, activeTasks, ramUsage: capacity ? Number(capacity.ramUsage || 0) : 0, freeRamPercent, preferred: Boolean(preferredNodeId && node.id === preferredNodeId), placementScore, healthStatus })
  }

  eligible.sort((a, b) => {
    if (preferredNodeId && systemSettings.autoFailover === false) {
      if (a.preferred !== b.preferred) return a.preferred ? -1 : 1
    }
    if (a.healthStatus !== b.healthStatus) {
      if (a.healthStatus === "critical") return 1
      if (b.healthStatus === "critical") return -1
    }
    return b.placementScore - a.placementScore ||
      a.ramUsage - b.ramUsage ||
      a.queuedTasks - b.queuedTasks ||
      a.activeTasks - b.activeTasks ||
      b.freeRamPercent - a.freeRamPercent ||
      a.node.nodeName.localeCompare(b.node.nodeName)
  })
  const selected = eligible[0]
  if (preferredNodeId && systemSettings.autoFailover === false && selected && selected.node.id !== preferredNodeId) {
    return {
      ok: false,
      reason: candidates.find((candidate) => candidate.nodeId === preferredNodeId)?.reason || "Selected node is not eligible and auto failover is disabled",
      errorCode: "AUTO_FAILOVER_DISABLED",
      candidates,
    }
  }
  if (!selected) {
    const reason = candidates.find((candidate) => candidate.reason.includes("Storage"))?.reason || candidates.find((candidate) => candidate.reason.includes("template"))?.reason || candidates[0]?.reason || "No healthy node available"
    const code = reason.includes("template") ? "TEMPLATE_UNAVAILABLE" : reason.includes("no free IP") ? "IP_POOL_EXHAUSTED" : reason.includes("IP pool") ? "IP_POOL_UNAVAILABLE" : reason.includes("Storage") ? "STORAGE_UNAVAILABLE" : "NO_ELIGIBLE_NODE"
    return { ok: false, reason, errorCode: code, candidates }
  }

  const failoverFromNodeId = preferredNodeId && selected.node.id !== preferredNodeId ? preferredNodeId : null
  const failoverReason = failoverFromNodeId ? candidates.find((candidate) => candidate.nodeId === failoverFromNodeId)?.reason || "Preferred node was not eligible" : null

  return {
    ok: true,
    node: selected.node,
    template: selected.template,
    storagePool: selected.storagePool,
    failoverFromNodeId,
    failoverReason,
    reason: failoverFromNodeId ? `Failed over to ${selected.node.nodeName}` : `Selected ${selected.node.nodeName}`,
    candidates,
  }
}

export async function validateProvisioningPreflight(input: PlacementInput) {
  const placement = await selectProvisioningNode(input)
  const checks: Array<{ name: string; ok: boolean; message: string; metadata?: Record<string, unknown> }> = [
    {
      name: "placement",
      ok: placement.ok,
      message: placement.ok ? placement.reason : placement.reason,
      metadata: { candidates: placement.candidates },
    },
  ]

  if (!placement.ok) {
    return { ok: false, errorCode: placement.errorCode, reason: placement.reason, checks, placement }
  }

  const node = placement.node
  const template = placement.template
  const storagePool = placement.storagePool
  const client = createProxmoxClient(node.host, node.tokenId, node.tokenSecret, {
    allowInsecureTls: node.allowInsecureTls,
    timeoutMs: 10000,
    logRequests: false,
  })

  const [storage, network, templateConfig, apiStatus, vmRows, clusterResources] = await Promise.all([
    client.getNodeStorage(node.nodeName).catch((error: any) => ({ error: error?.message || "storage check failed" })),
    client.getNodeNetwork(node.nodeName).catch((error: any) => ({ error: error?.message || "network check failed" })),
    template?.proxmoxVmid ? client.getVMConfig(node.nodeName, Number(template.proxmoxVmid)).catch((error: any) => ({ error: error?.message || "template check failed" })) : Promise.resolve({ error: "template VMID missing" }),
    client.getNodeStats(node.nodeName).catch((error: any) => ({ error: error?.message || "Proxmox API check failed" })),
    client.getVMList(node.nodeName).catch((error: any) => ({ error: error?.message || "VM list check failed" })),
    client.getClusterResources().catch(() => []),
  ])

  const storageId = String(storagePool.storageId || storagePool.proxmoxStorage || storagePool.name || "")
  const storageRows = Array.isArray(storage) ? storage : []
  const storageMatch = storageRows.find((row: any) => String(row.storage || row.storageId || "") === storageId)
  const storageContent = String((storageMatch as any)?.content || "").toLowerCase()
  const storageWritable = !storageContent || storageContent.split(/[,\s]+/).some((item) => ["images", "rootdir"].includes(item))
  checks.push({
    name: "storage",
    ok: Boolean(storageMatch) && !(storage as any).error && Number((storageMatch as any)?.enabled ?? 1) !== 0 && Number((storageMatch as any)?.active ?? 1) !== 0 && storageWritable,
    message: storageMatch
      ? Number((storageMatch as any)?.enabled ?? 1) === 0
        ? "Storage pool is disabled"
        : Number((storageMatch as any)?.active ?? 1) === 0
          ? "Storage pool is inactive"
          : !storageWritable
            ? "Storage pool is not writable for VM disks"
            : "Storage pool is available"
      : String((storage as any).error || "Storage pool is missing from Proxmox"),
    metadata: { storageId, active: (storageMatch as any)?.active ?? null, enabled: (storageMatch as any)?.enabled ?? null, content: (storageMatch as any)?.content || null },
  })

  const requiredBytes = Math.ceil(Number(input.storageGb || 0) * 1024 * 1024 * 1024)
  const availableBytes = Number((storageMatch as any)?.avail ?? (storageMatch as any)?.free ?? storagePool?.freeBytes ?? 0)
  checks.push({
    name: "storage_capacity",
    ok: requiredBytes <= 0 || availableBytes <= 0 || availableBytes >= requiredBytes,
    message: availableBytes > 0 && availableBytes < requiredBytes ? "Insufficient storage capacity on target datastore" : "Storage capacity is sufficient",
    metadata: { storageId, requiredBytes, availableBytes },
  })

  const networkRows = Array.isArray(network) ? network : []
  const bridge = await provisioningNetworkBridge({ proxmoxNodeId: node.id, productId: input.productId })
  const bridgeMatch = networkRows.find((row: any) => String(row.iface || row.name || "") === bridge)
  checks.push({
    name: "bridge",
    ok: Boolean(bridgeMatch) && !(network as any).error,
    message: bridgeMatch ? "Network bridge is available" : String((network as any).error || `Network bridge ${bridge} is unavailable`),
    metadata: { bridge },
  })

  checks.push({
    name: "template",
    ok: Boolean(template?.proxmoxVmid) && !(templateConfig as any).error && Boolean((templateConfig as any)?.boot || (templateConfig as any)?.bootdisk || (templateConfig as any)?.scsi0 || (templateConfig as any)?.virtio0 || (templateConfig as any)?.sata0),
    message: (templateConfig as any).error ? String((templateConfig as any).error) : "Template exists on Proxmox",
    metadata: { templateId: template?.id || null, vmid: template?.proxmoxVmid || null },
  })

  // Replaces the Cloud-Init capability check. Guest automation configures the
  // server through the QEMU guest agent, so the channel being open is what
  // matters. Whether the agent is installed inside the image cannot be checked
  // from the host and is proven on the first clone.
  const guestAgentChannel = guestAgentChannelOpen((templateConfig as any) || {})
  checks.push({
    name: "guest_agent",
    ok: guestAgentChannel,
    message: guestAgentChannel
      ? "Guest agent channel is enabled on the template"
      : "Guest agent channel is not enabled on the template; guest automation cannot configure servers cloned from it",
    metadata: { agent: guestAgentChannel, osType: template?.osType || null },
  })

  const memoryTotal = Number((apiStatus as any)?.memory?.total || 0)
  const memoryUsed = Number((apiStatus as any)?.memory?.used || 0)
  const memoryFreeMb = Math.floor(Math.max(0, memoryTotal - memoryUsed) / 1024 / 1024)
  const requiredMemoryMb = Math.ceil(Number(input.ramGb || 0) * 1024)
  checks.push({
    name: "ram_capacity",
    ok: memoryFreeMb <= 0 || requiredMemoryMb <= 0 || memoryFreeMb >= requiredMemoryMb,
    message: memoryFreeMb > 0 && memoryFreeMb < requiredMemoryMb ? "Insufficient RAM available on target node" : "RAM capacity is sufficient",
    metadata: { requiredMemoryMb, memoryFreeMb },
  })

  const maxCpu = Number((apiStatus as any)?.cpuinfo?.cpus || (apiStatus as any)?.maxcpu || 0)
  const cpuLoad = Number((apiStatus as any)?.cpu || 0)
  const estimatedFreeCpu = maxCpu > 0 ? Math.max(0, Math.floor(maxCpu * (1 - Math.min(1, Math.max(0, cpuLoad))))) : 0
  const requiredCpu = Math.ceil(Number(input.vcpu || 0))
  checks.push({
    name: "cpu_monitoring",
    ok: true,
    message: "CPU usage is informational and does not block provisioning",
    metadata: { maxCpu, cpuLoad, estimatedFreeCpu, requiredCpu },
  })

  const worker = await (prisma as any).nodeWorker.findUnique({
    where: { nodeId: node.id },
    select: { activeTasks: true, maxTasks: true, queuedTasks: true },
  }).catch(() => null)
  const activeTasks = Math.max(0, Number(worker?.activeTasks || 0))
  const maxTasks = Math.max(1, Number(worker?.maxTasks || 1))
  checks.push({
    name: "queue_slot",
    ok: activeTasks < maxTasks,
    message: activeTasks >= maxTasks ? "Node clone queue is full" : "Node clone queue has an available slot",
    metadata: { activeTasks, maxTasks, queuedTasks: Number(worker?.queuedTasks || 0) },
  })

  const usedVmids = new Set((Array.isArray(vmRows) ? vmRows : [])
    .map((row: any) => Number(row?.vmid || 0))
    .filter((vmid) => Number.isInteger(vmid) && vmid >= MIN_SAFE_VMID && vmid <= MAX_SAFE_VMID))
  const nextId = await client.getNextVmid().catch(() => null)
  const nextSafe = Number.isInteger(Number(nextId)) && Number(nextId) >= MIN_SAFE_VMID && Number(nextId) <= MAX_SAFE_VMID
  let safeCandidate: number | null = nextSafe && !usedVmids.has(Number(nextId)) ? Number(nextId) : null
  if (!safeCandidate) {
    for (let candidate = MIN_SAFE_VMID; candidate <= MAX_SAFE_VMID; candidate += 1) {
      if (!usedVmids.has(candidate)) {
        safeCandidate = candidate
        break
      }
    }
  }
  checks.push({
    name: "vmid",
    ok: Boolean(safeCandidate),
    message: safeCandidate ? "Safe VMID is available" : "No safe VMID available in range 100-999999",
    metadata: { proxmoxNextId: nextId, safeCandidate, safeRange: `${MIN_SAFE_VMID}-${MAX_SAFE_VMID}` },
  })

  checks.push({
    name: "proxmox_api",
    ok: !(apiStatus as any).error,
    message: (apiStatus as any).error ? String((apiStatus as any).error) : "Proxmox API is reachable",
    metadata: { clusterResources: Array.isArray(clusterResources) ? clusterResources.length : null },
  })

  checks.push({
    name: "ip_availability",
    ok: await hasAvailableIp({
      proxmoxNodeId: node.id,
      productId: input.productId,
      poolId: input.poolId || null,
      requestedIp: input.requestedIp || null,
      forceIpOverride: input.forceIpOverride === true,
    }),
    message: "IP availability checked",
  })

  const failed = checks.find((check) => !check.ok)
  return {
    ok: !failed,
    errorCode: failed ? `PREFLIGHT_${failed.name.toUpperCase()}_FAILED` : null,
    reason: failed?.message || "Provisioning preflight passed",
    checks,
    placement,
  }
}
