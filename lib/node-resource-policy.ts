import { z } from "zod"

/**
 * Node resource allocation policy.
 *
 * This module is deliberately pure: it takes numbers in and returns a decision
 * plus the exact figures behind it. Nothing here touches the database, the
 * Proxmox API or the filesystem, which keeps the safety rules fully unit
 * testable and keeps the provisioning hot path free of side effects.
 *
 * Two ideas are kept strictly apart, because conflating them is what makes a
 * hypervisor run out of memory or disk:
 *
 *   ALLOCATION  - how much we have *promised* to hand to VMs. A promise is not
 *                 backed by physical resources, which is what allows any
 *                 overcommit ratio at all.
 *   CONSUMPTION - how much is physically in use right now. This is what must
 *                 stay below the safety thresholds that stop new allocations.
 *
 * So 80% RAM allocation says "we will not promise more than 80% of allocatable
 * RAM". It does NOT promise that 80% of RAM is free, and a host can hit real
 * memory pressure while still sitting far below its allocation ceiling. Every
 * explanation string below says so explicitly.
 */

const BYTES_PER_GB = 1024 * 1024 * 1024

/**
 * Default share of allocatable RAM that planned VM allocations may consume.
 * 80% leaves headroom for the host, its page cache and Proxmox itself.
 */
export const DEFAULT_RAM_ALLOCATION_PERCENT = 80

/** Absolute floor held back from the host regardless of total size. */
export const DEFAULT_SYSTEM_RAM_RESERVE_GB = 2

/**
 * Default logical:physical disk ratio. 1.0 means no overcommit at all.
 * Ratios above 1.0 are only honoured on storage verified as thin provisioned,
 * so the safe default stays at 1.0 and any overcommit is a deliberate,
 * per-pool opt-in.
 */
export const DEFAULT_DISK_ALLOCATION_RATIO = 1

/** Hard ceiling on disk overcommit, expressed as a logical:physical ratio. */
export const MAX_DISK_ALLOCATION_RATIO = 5

/**
 * Physical storage utilisation thresholds. These gate *physical* consumption
 * and are deliberately independent of the logical allocation ratio: a thin pool
 * may hold 5x logical capacity and still be a hard stop at 90% real usage.
 */
export const DEFAULT_STORAGE_WARN_PERCENT = 80
export const DEFAULT_STORAGE_CRITICAL_PERCENT = 90

/** CPU is never oversold unless an administrator explicitly asks for it. */
export const DEFAULT_CPU_ALLOCATION_RATIO = 1

export const nodeResourcePolicySchema = z.object({
  /** Share of allocatable RAM planned VM allocations may claim. 1-100. */
  ramAllocationPercent: z.coerce.number().int().min(1).max(100).default(DEFAULT_RAM_ALLOCATION_PERCENT),
  /** RAM permanently reserved for the host, in GB. 0-1024. */
  systemRamReserveGb: z.coerce.number().min(0).max(1024).default(DEFAULT_SYSTEM_RAM_RESERVE_GB),
  /** Logical:physical disk ratio. 1-5. Values >1 need thin provisioning. */
  diskAllocationRatio: z.coerce.number().min(1).max(MAX_DISK_ALLOCATION_RATIO).default(DEFAULT_DISK_ALLOCATION_RATIO),
  /** Physical disk utilisation that raises an administrator warning. */
  storageWarnPercent: z.coerce.number().int().min(1).max(100).default(DEFAULT_STORAGE_WARN_PERCENT),
  /** Physical disk utilisation at which new allocations are refused. */
  storageCriticalPercent: z.coerce.number().int().min(1).max(100).default(DEFAULT_STORAGE_CRITICAL_PERCENT),
  /** CPU logical:physical ratio. 1 means no CPU overselling. */
  cpuAllocationRatio: z.coerce.number().min(1).max(10).default(DEFAULT_CPU_ALLOCATION_RATIO),
})

export type NodeResourcePolicy = z.infer<typeof nodeResourcePolicySchema>

export const DEFAULT_NODE_RESOURCE_POLICY: NodeResourcePolicy = {
  ramAllocationPercent: DEFAULT_RAM_ALLOCATION_PERCENT,
  systemRamReserveGb: DEFAULT_SYSTEM_RAM_RESERVE_GB,
  diskAllocationRatio: DEFAULT_DISK_ALLOCATION_RATIO,
  storageWarnPercent: DEFAULT_STORAGE_WARN_PERCENT,
  storageCriticalPercent: DEFAULT_STORAGE_CRITICAL_PERCENT,
  cpuAllocationRatio: DEFAULT_CPU_ALLOCATION_RATIO,
}

/**
 * Validate persisted settings.
 *
 * The warning threshold must sit below the critical threshold, otherwise the
 * critical limit would be unreachable and the warning would fire after the
 * hard stop. Invalid input falls back to defaults rather than throwing, so a
 * bad value can never wedge provisioning.
 */
export function normalizeNodeResourcePolicy(raw: unknown): NodeResourcePolicy {
  const parsed = nodeResourcePolicySchema.safeParse(raw ?? {})
  if (!parsed.success) return { ...DEFAULT_NODE_RESOURCE_POLICY }
  const value = parsed.data
  if (value.storageWarnPercent >= value.storageCriticalPercent) {
    return {
      ...value,
      storageWarnPercent: Math.min(DEFAULT_STORAGE_WARN_PERCENT, value.storageCriticalPercent - 1),
    }
  }
  return value
}

/**
 * Storage backends whose allocation is genuinely thin.
 *
 * `lvmthin` is thin by definition. `zfspool` and `btrfs` can be thin but are
 * not thin by default, so they only qualify when the caller has positively
 * confirmed it from the pool metadata. Everything else - notably `dir` and
 * thick `lvm` - reserves the full declared size up front and must never be
 * overcommitted.
 */
const THIN_PROVISIONING_TYPES = new Set(["lvmthin"])
const CONDITIONAL_THIN_PROVISIONING_TYPES = new Set(["zfspool", "zfs", "btrfs"])

export type ThinProvisioningVerdict = {
  thin: boolean
  /** Machine-readable reason, safe to persist and to show to an administrator. */
  reason: string
  detail: string
}

export function detectThinProvisioning(pool: {
  type?: string | null
  proxmoxType?: string | null
  storageType?: string | null
  metadata?: unknown
} | null | undefined): ThinProvisioningVerdict {
  const raw = String(pool?.proxmoxType || pool?.type || pool?.storageType || "").trim().toLowerCase()
  if (!raw) {
    return { thin: false, reason: "unknown_storage_type", detail: "Storage type is not known, so thin provisioning cannot be confirmed and overcommit is refused." }
  }
  if (THIN_PROVISIONING_TYPES.has(raw)) {
    return { thin: true, reason: "thin_provisioned", detail: `${raw} is a thin-provisioned backend, so logical capacity may exceed physical capacity.` }
  }
  if (CONDITIONAL_THIN_PROVISIONING_TYPES.has(raw)) {
    const metadata = pool?.metadata && typeof pool.metadata === "object" && !Array.isArray(pool.metadata)
      ? pool.metadata as Record<string, unknown>
      : {}
    const declaredThin = metadata.thin === true || metadata.thinProvisioning === true || metadata.thin === "1"
    if (declaredThin) {
      return { thin: true, reason: "thin_provisioned", detail: `${raw} is confirmed thin provisioned by its pool metadata.` }
    }
    return {
      thin: false,
      reason: "thin_not_confirmed",
      detail: `${raw} may support thin provisioning, but the pool metadata does not confirm it. Overcommit stays disabled until it does.`,
    }
  }
  return {
    thin: false,
    reason: "thick_provisioned",
    detail: `${raw} reserves the full declared size up front. A ${MAX_DISK_ALLOCATION_RATIO}:1 logical ratio cannot be applied to it.`,
  }
}

/** Byte counts may arrive as Prisma `bigint`, so both widths are accepted. */
type ByteCount = number | bigint | null | undefined

function toGb(bytes: ByteCount) {
  const value = Number(bytes || 0)
  return Number.isFinite(value) && value > 0 ? value / BYTES_PER_GB : 0
}

export type RamAllocationInput = {
  /** Physical RAM installed on the host, in GB. */
  physicalRamGb: number | null | undefined
  /** RAM promised to existing VMs, in GB. Counted once per VM. */
  allocatedVmRamGb: number | null | undefined
  /**
   * Additional holds on top of VM allocations, in GB. Must be disjoint from
   * `allocatedVmRamGb`: a VM that is already counted in the allocations must
   * not also be counted here, or the same RAM would be spent twice.
   */
  reservedRamGb?: number | null
  /** RAM the pending request would add, in GB. */
  requestedRamGb: number | null | undefined
  policy: Pick<NodeResourcePolicy, "ramAllocationPercent" | "systemRamReserveGb">
}

export type RamAllocationDecision = {
  ok: boolean
  reason: string
  /** True when the decision rests on stale or absent telemetry. */
  assumed: boolean
  physicalRamGb: number | null
  systemReserveGb: number
  allocatableRamGb: number | null
  policyCapGb: number | null
  committedRamGb: number
  requestedRamGb: number
  committedAfterRequestGb: number
  remainingPolicyCapacityGb: number | null
  usagePercentOfPolicy: number | null
  /** Plain-language explanation shown to an administrator. */
  explanation: string
}

const RAM_POLICY_NOTE =
  "This is an allocation policy, not a guarantee that the memory is free right now. Live usage can be higher; actual memory pressure is reported separately."

export function evaluateRamAllocation(input: RamAllocationInput): RamAllocationDecision {
  const policy = input.policy || DEFAULT_NODE_RESOURCE_POLICY
  const requestedRamGb = Number(input.requestedRamGb || 0)
  const allocated = Number(input.allocatedVmRamGb || 0)
  const reserved = Number(input.reservedRamGb || 0)
  const committedRamGb = Number((allocated + reserved).toFixed(2))
  const systemReserveGb = Number(policy.systemRamReserveGb || 0)

  const physical = Number(input.physicalRamGb)
  if (!Number.isFinite(physical) || physical <= 0) {
    // Telemetry is missing. Refusing would stall every order on a node that
    // simply has not reported yet, so the request is admitted and explicitly
    // flagged as unverified rather than silently trusted.
    return {
      ok: true,
      reason: "capacity_unknown",
      assumed: true,
      physicalRamGb: null,
      systemReserveGb,
      allocatableRamGb: null,
      policyCapGb: null,
      committedRamGb,
      requestedRamGb,
      committedAfterRequestGb: Number((committedRamGb + requestedRamGb).toFixed(2)),
      remainingPolicyCapacityGb: null,
      usagePercentOfPolicy: null,
      explanation: `Physical RAM for this node is not reported yet, so the ${policy.ramAllocationPercent}% allocation policy could not be verified. The allocation was allowed on the assumption that capacity exists; treat it as unverified. ${RAM_POLICY_NOTE}`,
    }
  }

  const allocatableRamGb = Number(Math.max(0, physical - systemReserveGb).toFixed(2))
  const policyCapGb = Number(((allocatableRamGb * policy.ramAllocationPercent) / 100).toFixed(2))
  const committedAfterRequestGb = Number((committedRamGb + requestedRamGb).toFixed(2))
  const remainingPolicyCapacityGb = Number((policyCapGb - committedRamGb).toFixed(2))
  const usagePercentOfPolicy = policyCapGb > 0 ? Number(((committedRamGb / policyCapGb) * 100).toFixed(1)) : null

  if (committedAfterRequestGb > policyCapGb) {
    return {
      ok: false,
      reason: "ram_allocation_policy_exceeded",
      assumed: false,
      physicalRamGb: physical,
      systemReserveGb,
      allocatableRamGb,
      policyCapGb,
      committedRamGb,
      requestedRamGb,
      committedAfterRequestGb,
      remainingPolicyCapacityGb,
      usagePercentOfPolicy,
      explanation: `Planned VM RAM would reach ${committedAfterRequestGb}GB against a ${policyCapGb}GB allocation cap (${policy.ramAllocationPercent}% of ${allocatableRamGb}GB allocatable after a ${systemReserveGb}GB system reserve). ${committedRamGb}GB is already committed to existing VMs. ${RAM_POLICY_NOTE}`,
    }
  }

  return {
    ok: true,
    reason: "within_ram_allocation_policy",
    assumed: false,
    physicalRamGb: physical,
    systemReserveGb,
    allocatableRamGb,
    policyCapGb,
    committedRamGb,
    requestedRamGb,
    committedAfterRequestGb,
    remainingPolicyCapacityGb,
    usagePercentOfPolicy,
    explanation: `Planned VM RAM after this request is ${committedAfterRequestGb}GB of the ${policyCapGb}GB allocation cap, leaving ${remainingPolicyCapacityGb}GB still allocatable. ${RAM_POLICY_NOTE}`,
  }
}

export type DiskAllocationInput = {
  pool: {
    storageId?: string | null
    displayName?: string | null
    type?: string | null
    proxmoxType?: string | null
    storageType?: string | null
    totalBytes?: ByteCount
    usedBytes?: ByteCount
    metadata?: unknown
  } | null | undefined
  /** Sum of the logical disk sizes already promised to VMs on this pool, GB. */
  logicalAllocatedGb: number | null | undefined
  /** Snapshot/backups/other consumers, GB, when the backend reports them. */
  otherConsumersGb?: number | null
  requestedDiskGb: number | null | undefined
  policy: Pick<NodeResourcePolicy, "diskAllocationRatio" | "storageWarnPercent" | "storageCriticalPercent">
}

export type DiskAllocationDecision = {
  ok: boolean
  reason: string
  thin: ThinProvisioningVerdict
  /** Ratio actually permitted on this pool after verifying provisioning type. */
  effectiveRatio: number
  requestedRatio: number
  physicalTotalGb: number
  physicalUsedGb: number
  physicalFreeGb: number
  /** Bytes consumed by non-VM consumers, when reported. */
  otherConsumersGb: number
  logicalAllocatedGb: number
  logicalCapacityAllowedGb: number
  physicalUsagePercent: number
  level: "ok" | "warning" | "critical" | "unknown"
  explanation: string
}

export function evaluateDiskAllocation(input: DiskAllocationInput): DiskAllocationDecision {
  const policy = input.policy || DEFAULT_NODE_RESOURCE_POLICY
  const requestedRatio = Number(policy.diskAllocationRatio || DEFAULT_DISK_ALLOCATION_RATIO)
  const requestedDiskGb = Number(input.requestedDiskGb || 0)
  const logicalAllocatedGb = Number(input.logicalAllocatedGb || 0)
  const otherConsumersGb = Number(input.otherConsumersGb || 0)
  const physicalTotalGb = Number(toGb(input.pool?.totalBytes).toFixed(2))
  const physicalUsedGb = Number(toGb(input.pool?.usedBytes).toFixed(2))
  const physicalFreeGb = Number(Math.max(0, physicalTotalGb - physicalUsedGb).toFixed(2))

  const thin = detectThinProvisioning(input.pool)
  const ratioAllowed = requestedRatio > 1
  const base = {
    thin,
    requestedRatio,
    physicalTotalGb,
    physicalUsedGb,
    physicalFreeGb,
    otherConsumersGb,
    logicalAllocatedGb,
  }

  if (!Number.isFinite(physicalTotalGb) || physicalTotalGb <= 0) {
    return {
      ...base,
      ok: false,
      reason: "storage_capacity_unknown",
      effectiveRatio: 1,
      logicalCapacityAllowedGb: 0,
      physicalUsagePercent: 0,
      level: "unknown" as const,
      explanation: "Physical size for this storage pool is not reported, so no safe allocation can be made.",
    }
  }

  const physicalUsagePercent = Number(((physicalUsedGb / physicalTotalGb) * 100).toFixed(1))

  // A non-thin pool can never carry a logical ratio above 1:1, whatever the
  // configured value says. The configured ratio is reported but not applied.
  const effectiveRatio = ratioAllowed && thin.thin ? requestedRatio : 1
  if (ratioAllowed && !thin.thin) {
    // Fall through to the 1:1 checks below, but remember why.
  }
  const logicalCapacityAllowedGb = Number((physicalTotalGb * effectiveRatio).toFixed(2))
  const ratioRefusal = ratioAllowed && !thin.thin
    ? ` A ${requestedRatio}:1 logical allocation ratio is configured but was refused for this pool: ${thin.detail}`
    : ""

  if (physicalUsagePercent >= policy.storageCriticalPercent) {
    return {
      ...base,
      ok: false,
      reason: "storage_physical_critical",
      effectiveRatio,
      logicalCapacityAllowedGb,
      physicalUsagePercent,
      level: "critical" as const,
      explanation: `Physical storage is at ${physicalUsagePercent}%, at or above the ${policy.storageCriticalPercent}% critical limit. New allocations are refused until it falls below that limit. Logical overcommit does not change this.${ratioRefusal}`,
    }
  }

  const level = physicalUsagePercent >= policy.storageWarnPercent ? ("warning" as const) : ("ok" as const)

  if (logicalAllocatedGb + requestedDiskGb > logicalCapacityAllowedGb) {
    return {
      ...base,
      ok: false,
      reason: thin.thin && effectiveRatio > 1 ? "logical_disk_capacity_exceeded" : "physical_disk_capacity_exceeded",
      effectiveRatio,
      logicalCapacityAllowedGb,
      physicalUsagePercent,
      level,
      explanation: thin.thin && effectiveRatio > 1
        ? `Allocating ${requestedDiskGb}GB would put logical disk at ${Number((logicalAllocatedGb + requestedDiskGb).toFixed(2))}GB against ${logicalCapacityAllowedGb}GB allowed at the configured ${effectiveRatio}:1 thin-provisioned ratio. Physical usage is ${physicalUsagePercent}%.${ratioRefusal}`
        : `Allocating ${requestedDiskGb}GB would put logical disk at ${Number((logicalAllocatedGb + requestedDiskGb).toFixed(2))}GB, but this pool only allows ${logicalCapacityAllowedGb}GB because it reserves the full declared size. Physical usage is ${physicalUsagePercent}%.${ratioRefusal}`,
    }
  }

  return {
    ...base,
    ok: true,
    reason: "within_disk_allocation_policy",
    effectiveRatio,
    logicalCapacityAllowedGb,
    physicalUsagePercent,
    level,
    explanation: `Logical disk after this request is ${Number((logicalAllocatedGb + requestedDiskGb).toFixed(2))}GB of ${logicalCapacityAllowedGb}GB allowed at ${effectiveRatio}:1. Physical usage is ${physicalUsagePercent}% of ${physicalTotalGb}GB (${physicalFreeGb}GB physically free), warning at ${policy.storageWarnPercent}% and critical at ${policy.storageCriticalPercent}%.${ratioRefusal}`,
  }
}

export type NodeEligibilityInput = {
  /** Proxmox reachability and health, evaluated separately from resources. */
  health: { ok: boolean; reason: string }
  /** Clone/provision queue availability, also separate from resources. */
  queue: { ok: boolean; reason: string }
  ram: RamAllocationDecision
  disk: DiskAllocationDecision | null
  /** CPU is reported for visibility and only gates when oversold. */
  cpu?: { ok: boolean; reason: string } | null
}

/**
 * Combine the independent concerns into one placement answer.
 *
 * Each concern keeps its own reason so an administrator is told *which* gate
 * failed - "node is healthy but its clone queue is full" is a completely
 * different problem from "this node is out of allocatable RAM", and collapsing
 * them into one message is what makes these failures hard to diagnose.
 */
export function explainNodeEligibility(input: NodeEligibilityInput) {
  const failures: Array<{ concern: string; reason: string; explanation: string }> = []
  if (!input.health.ok) failures.push({ concern: "health", reason: input.health.reason, explanation: input.health.reason })
  if (!input.queue.ok) failures.push({ concern: "queue", reason: input.queue.reason, explanation: input.queue.reason })
  if (input.cpu && !input.cpu.ok) failures.push({ concern: "cpu", reason: input.cpu.reason, explanation: input.cpu.reason })
  if (!input.ram.ok) failures.push({ concern: "ram", reason: input.ram.reason, explanation: input.ram.explanation })
  if (input.disk && !input.disk.ok) failures.push({ concern: "storage", reason: input.disk.reason, explanation: input.disk.explanation })

  return {
    eligible: failures.length === 0,
    // The most fundamental failure leads, so the message names the root cause
    // rather than a downstream symptom of it.
    primaryReason: failures[0]?.reason || null,
    failures,
  }
}