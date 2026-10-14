import assert from "node:assert/strict"
import test from "node:test"
import {
  DEFAULT_DISK_ALLOCATION_RATIO,
  DEFAULT_NODE_RESOURCE_POLICY,
  DEFAULT_RAM_ALLOCATION_PERCENT,
  DEFAULT_STORAGE_CRITICAL_PERCENT,
  DEFAULT_STORAGE_WARN_PERCENT,
  MAX_DISK_ALLOCATION_RATIO,
  detectThinProvisioning,
  evaluateDiskAllocation,
  evaluateRamAllocation,
  explainNodeEligibility,
  normalizeNodeResourcePolicy,
} from "../../../lib/node-resource-policy"

const GB = 1024 ** 3
const policy = DEFAULT_NODE_RESOURCE_POLICY

test("the shipped defaults are 80% RAM, no disk overcommit and 80/90 storage limits", () => {
  assert.equal(DEFAULT_RAM_ALLOCATION_PERCENT, 80)
  assert.equal(policy.ramAllocationPercent, 80)
  // Overcommit is opt-in: the default is 1:1 even on thin storage.
  assert.equal(DEFAULT_DISK_ALLOCATION_RATIO, 1)
  assert.equal(policy.diskAllocationRatio, 1)
  assert.equal(MAX_DISK_ALLOCATION_RATIO, 5)
  assert.equal(policy.storageWarnPercent, DEFAULT_STORAGE_WARN_PERCENT)
  assert.equal(policy.storageCriticalPercent, DEFAULT_STORAGE_CRITICAL_PERCENT)
  // CPU is never oversold without an explicit setting.
  assert.equal(policy.cpuAllocationRatio, 1)
})

test("policy validation rejects out-of-range values and clamps a bad warning threshold", () => {
  const valid = normalizeNodeResourcePolicy({ ramAllocationPercent: 85, diskAllocationRatio: 5, storageWarnPercent: 75, storageCriticalPercent: 95 })
  assert.equal(valid.ramAllocationPercent, 85)
  assert.equal(valid.diskAllocationRatio, 5)

  // Anything unparseable falls back to safe defaults rather than throwing, so a
  // bad value can never wedge provisioning.
  for (const bad of [{ ramAllocationPercent: 0 }, { ramAllocationPercent: 101 }, { diskAllocationRatio: 6 }, { diskAllocationRatio: 0 }, { storageCriticalPercent: 0 }]) {
    assert.deepEqual(normalizeNodeResourcePolicy(bad), DEFAULT_NODE_RESOURCE_POLICY, `${JSON.stringify(bad)} must fall back to defaults`)
  }
  assert.deepEqual(normalizeNodeResourcePolicy(null), DEFAULT_NODE_RESOURCE_POLICY)
  assert.deepEqual(normalizeNodeResourcePolicy("nonsense"), DEFAULT_NODE_RESOURCE_POLICY)

  // A warning at or above the critical limit would fire after the hard stop.
  const inverted = normalizeNodeResourcePolicy({ storageWarnPercent: 95, storageCriticalPercent: 90 })
  assert.ok(inverted.storageWarnPercent < inverted.storageCriticalPercent, "the warning must stay below the critical stop")
})

test("only verified thin-provisioned storage may carry a logical overcommit ratio", () => {
  // The real backends behind the development node.
  assert.equal(detectThinProvisioning({ proxmoxType: "lvmthin", type: "lvmthin" }).thin, true)
  assert.equal(detectThinProvisioning({ proxmoxType: "dir", type: "dir" }).thin, false)
  assert.equal(detectThinProvisioning({ proxmoxType: "dir" }).reason, "thick_provisioned")
  assert.equal(detectThinProvisioning({ proxmoxType: "lvm" }).thin, false)

  // Conditional backends need positive confirmation before overcommit applies.
  assert.equal(detectThinProvisioning({ proxmoxType: "zfspool" }).thin, false)
  assert.equal(detectThinProvisioning({ proxmoxType: "zfspool" }).reason, "thin_not_confirmed")
  assert.equal(detectThinProvisioning({ proxmoxType: "zfspool", metadata: { thin: true } }).thin, true)
  assert.equal(detectThinProvisioning({ proxmoxType: "btrfs", metadata: { thin: "1" } }).thin, true)

  // An unknown backend must never be trusted with overcommit.
  const unknown = detectThinProvisioning({})
  assert.equal(unknown.thin, false)
  assert.equal(unknown.reason, "unknown_storage_type")
  assert.equal(detectThinProvisioning(null).thin, false)
})

test("a 5:1 ratio is capped at exactly the physical size on a thick pool", () => {
  const thick = evaluateDiskAllocation({
    pool: { storageId: "local", proxmoxType: "dir", totalBytes: 100 * GB, usedBytes: 10 * GB },
    logicalAllocatedGb: 90,
    requestedDiskGb: 20,
    policy: { ...policy, diskAllocationRatio: 5 },
  })
  // 500% of 100GB would be 500GB logically, but a dir pool reserves the full
  // size up front, so the ceiling collapses to the physical 100GB.
  assert.equal(thick.thin.thin, false)
  assert.equal(thick.requestedRatio, 5)
  assert.equal(thick.effectiveRatio, 1)
  assert.equal(thick.logicalCapacityAllowedGb, 100)
  assert.equal(thick.ok, false)
  assert.equal(thick.reason, "physical_disk_capacity_exceeded")
  assert.match(thick.explanation, /refused for this pool/)
  assert.match(thick.explanation, /reserves the full declared size/)
})

test("a 5:1 ratio on verified thin storage allows five times the physical size", () => {
  const thin = evaluateDiskAllocation({
    pool: { storageId: "local-lvm", proxmoxType: "lvmthin", totalBytes: 100 * GB, usedBytes: 10 * GB },
    logicalAllocatedGb: 400,
    requestedDiskGb: 100,
    policy: { ...policy, diskAllocationRatio: 5 },
  })
  assert.equal(thin.thin.thin, true)
  assert.equal(thin.effectiveRatio, 5)
  assert.equal(thin.logicalCapacityAllowedGb, 500)
  assert.equal(thin.ok, true, "500GB of a 500GB logical ceiling is within policy")
  // Physical reality is still reported alongside the logical figure.
  assert.equal(thin.physicalUsagePercent, 10)
  assert.equal(thin.physicalFreeGb, 90)

  const over = evaluateDiskAllocation({
    pool: { storageId: "local-lvm", proxmoxType: "lvmthin", totalBytes: 100 * GB, usedBytes: 10 * GB },
    logicalAllocatedGb: 480,
    requestedDiskGb: 30,
    policy: { ...policy, diskAllocationRatio: 5 },
  })
  assert.equal(over.ok, false)
  assert.equal(over.reason, "logical_disk_capacity_exceeded")
})

test("physical storage limits stop allocations no matter the logical ratio", () => {
  const pool = { storageId: "local-lvm", proxmoxType: "lvmthin", totalBytes: 100 * GB }
  // Warning band: still allowed, but reported.
  const warning = evaluateDiskAllocation({
    pool: { ...pool, usedBytes: 82 * GB },
    logicalAllocatedGb: 0,
    requestedDiskGb: 5,
    policy: { ...policy, diskAllocationRatio: 5 },
  })
  assert.equal(warning.ok, true)
  assert.equal(warning.level, "warning")
  assert.equal(warning.physicalUsagePercent, 82)

  // Critical: refused even though only 1GB of logical space is requested and a
  // 5:1 ratio would permit far more.
  const critical = evaluateDiskAllocation({
    pool: { ...pool, usedBytes: 91 * GB },
    logicalAllocatedGb: 0,
    requestedDiskGb: 1,
    policy: { ...policy, diskAllocationRatio: 5 },
  })
  assert.equal(critical.ok, false)
  assert.equal(critical.reason, "storage_physical_critical")
  assert.equal(critical.level, "critical")
  assert.match(critical.explanation, /overcommit does not change this/)
})

test("snapshot and other consumers are surfaced separately from VM logical size", () => {
  const decision = evaluateDiskAllocation({
    pool: { storageId: "local-lvm", proxmoxType: "lvmthin", totalBytes: 100 * GB, usedBytes: 40 * GB },
    logicalAllocatedGb: 200,
    requestedDiskGb: 10,
    otherConsumersGb: 30,
    policy: { ...policy, diskAllocationRatio: 5 },
  })
  assert.equal(decision.otherConsumersGb, 30)
  assert.equal(decision.logicalAllocatedGb, 200)
  assert.equal(decision.physicalUsedGb, 40)
  assert.match(decision.explanation, /physically free/)
})

test("an unreported storage size refuses rather than guessing", () => {
  const decision = evaluateDiskAllocation({
    pool: { storageId: "local", proxmoxType: "dir", totalBytes: null, usedBytes: null },
    logicalAllocatedGb: 0,
    requestedDiskGb: 10,
    policy,
  })
  assert.equal(decision.ok, false)
  assert.equal(decision.reason, "storage_capacity_unknown")
  assert.equal(decision.level, "unknown")
})

test("RAM allocation gates on the 80% policy, not on live free memory", () => {
  // 64GB physical, 2GB reserve -> 62GB allocatable -> 49.6GB cap at 80%.
  const base = {
    physicalRamGb: 64,
    allocatedVmRamGb: 0,
    requestedRamGb: 0,
    policy: { ...policy, systemRamReserveGb: 2 },
  }
  const full = evaluateRamAllocation(base)
  assert.equal(full.allocatableRamGb, 62)
  assert.equal(full.policyCapGb, 49.6)
  assert.equal(full.ok, true)

  // Exactly at the cap is allowed; one GB more is refused.
  const atCap = evaluateRamAllocation({ ...base, allocatedVmRamGb: 46.6, requestedRamGb: 3 })
  assert.equal(Number((46.6 + 3).toFixed(2)), 49.6)
  assert.equal(atCap.ok, true)

  const overCap = evaluateRamAllocation({ ...base, allocatedVmRamGb: 46.6, requestedRamGb: 3.1 })
  assert.equal(overCap.ok, false)
  assert.equal(overCap.reason, "ram_allocation_policy_exceeded")
  assert.match(overCap.explanation, /allocation policy, not a guarantee/)
})

test("existing reservations are added to VM allocations without double counting", () => {
  const common = { physicalRamGb: 64, requestedRamGb: 1, policy: { ...policy, systemRamReserveGb: 0 } }
  const allocations = evaluateRamAllocation({ ...common, allocatedVmRamGb: 40, reservedRamGb: 0 })
  assert.equal(allocations.committedRamGb, 40)

  const withHolds = evaluateRamAllocation({ ...common, allocatedVmRamGb: 40, reservedRamGb: 10 })
  // 51.2GB cap (80% of 64GB) - 40 + 10 + 1 = 51GB, just inside.
  assert.equal(withHolds.committedRamGb, 50)
  assert.equal(withHolds.policyCapGb, 51.2)
  assert.equal(withHolds.ok, true)
  assert.equal(withHolds.remainingPolicyCapacityGb, 1.2)

  const blocked = evaluateRamAllocation({ ...common, allocatedVmRamGb: 40, reservedRamGb: 12 })
  assert.equal(blocked.ok, false, "51 + 1 = 52GB exceeds the 51.2GB cap")
})

test("a custom allocation percent is honoured and validated", () => {
  const strict = evaluateRamAllocation({
    physicalRamGb: 100,
    allocatedVmRamGb: 70,
    requestedRamGb: 5,
    policy: { ramAllocationPercent: 50, systemRamReserveGb: 0 },
  })
  assert.equal(strict.policyCapGb, 50)
  assert.equal(strict.ok, false)
})

test("a node with no reported RAM is admitted but explicitly marked unverified", () => {
  const decision = evaluateRamAllocation({
    physicalRamGb: null,
    allocatedVmRamGb: 10,
    requestedRamGb: 4,
    policy,
  })
  assert.equal(decision.ok, true)
  assert.equal(decision.assumed, true)
  assert.equal(decision.reason, "capacity_unknown")
  assert.match(decision.explanation, /unverified/)
})

test("health, queue, cpu, ram and storage stay separate concerns", () => {
  const healthy = {
    health: { ok: true, reason: "" },
    queue: { ok: true, reason: "" },
    ram: evaluateRamAllocation({ physicalRamGb: 64, allocatedVmRamGb: 0, requestedRamGb: 1, policy }),
    disk: evaluateDiskAllocation({ pool: { proxmoxType: "lvmthin", totalBytes: 100 * GB, usedBytes: 1 * GB }, logicalAllocatedGb: 0, requestedDiskGb: 1, policy }),
  }
  assert.equal(explainNodeEligibility(healthy).eligible, true)

  // A full clone queue on a healthy, roomy node is its own problem.
  const queued = explainNodeEligibility({ ...healthy, queue: { ok: false, reason: "Node clone queue is full" } })
  assert.equal(queued.eligible, false)
  assert.equal(queued.primaryReason, "Node clone queue is full")
  assert.deepEqual(queued.failures.map((f) => f.concern), ["queue"])

  // Every failing concern is reported, not just the first.
  const many = explainNodeEligibility({
    ...healthy,
    queue: { ok: false, reason: "clone queue full" },
    ram: evaluateRamAllocation({ physicalRamGb: 64, allocatedVmRamGb: 49, requestedRamGb: 8, policy }),
  })
  assert.deepEqual(many.failures.map((f) => f.concern), ["queue", "ram"])
  // The most fundamental failure leads the message.
  assert.equal(many.primaryReason, "clone queue full")

  const storage = explainNodeEligibility({
    ...healthy,
    disk: evaluateDiskAllocation({ pool: { proxmoxType: "dir", totalBytes: 100 * GB, usedBytes: 95 * GB }, logicalAllocatedGb: 0, requestedDiskGb: 1, policy }),
  })
  assert.deepEqual(storage.failures.map((f) => f.concern), ["storage"])
  assert.equal(storage.failures[0].reason, "storage_physical_critical")
})

test("cpu is only a gate when an administrator enables overselling", () => {
  const ram = evaluateRamAllocation({ physicalRamGb: 64, allocatedVmRamGb: 0, requestedRamGb: 1, policy })
  const cpuOk = explainNodeEligibility({ health: { ok: true, reason: "" }, queue: { ok: true, reason: "" }, ram, disk: null, cpu: null })
  assert.equal(cpuOk.eligible, true, "cpu is informational by default")

  const cpuBlocked = explainNodeEligibility({ health: { ok: true, reason: "" }, queue: { ok: true, reason: "" }, ram, disk: null, cpu: { ok: false, reason: "CPU allocation policy exceeded" } })
  assert.equal(cpuBlocked.eligible, false)
  assert.deepEqual(cpuBlocked.failures.map((f) => f.concern), ["cpu"])
})