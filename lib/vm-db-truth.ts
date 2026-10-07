import { prisma } from "@/lib/db"
import { customerStepContentForJob, normalizeStep, sanitizeCustomerProvisioningMessage, STEP_LABELS } from "@/lib/provisioning-status"
import { customerFacingVpsStatus, mapLiveVpsStatus } from "@/lib/vps-lifecycle"
import { lifecycleDates } from "@/lib/renewals"
import { normalizeVmAutomationState, normalizeVmLifecycleState } from "@/lib/vm-state-machine"
import { formatBandwidthQuota } from "@/lib/bandwidth-format"
import { bytesToDecimalGb, gbToBytesDecimal } from "@/lib/format-units"
import { resolveBrandIdentity } from "@/lib/brand-identity"
import { consoleModeLabel } from "@/lib/console-mode"
import { getConsoleAccess, getConsoleSettings } from "@/lib/console-access"
import { consoleModeForResolvedType, normalizeConsoleType, resolveConsoleType } from "@/lib/console-resolution"
import { friendlyVmDisplayName, instanceDisplayName, internalVmHostname } from "@/lib/vm-hostname"

const ACTIVE_IP_STATUSES = ["active", "assigned", "used", "reserved", "moved", "pending"]

function numberValue(value: unknown) {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function decimalNumber(value: unknown) {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function firstPresent<T = unknown>(...values: T[]): T | null {
  for (const value of values) {
    if (value === null || value === undefined) continue
    if (typeof value === "string" && !value.trim()) continue
    return value
  }
  return null
}

function firstPositiveNumber(...values: unknown[]) {
  for (const value of values) {
    const parsed = Number(value || 0)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}

function percent(used: number, total: number) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(100, (used / total) * 100))
}

function hasReportedDiskUsage(metric: any) {
  const usedBytes = numberValue(metric?.diskUsedBytes || metric?.disk_used_bytes)
  const totalBytes = numberValue(metric?.diskTotalBytes || metric?.disk_total_bytes)
  if (usedBytes > 0 && totalBytes > 0) return true
  const usage = metric?.metadata?.diskUsage
  return Boolean(usage?.ok && numberValue(usage?.totalBytes) > 0 && numberValue(usage?.usedBytes) === 0)
}

function iso(value: unknown) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function isFresh(value: unknown, staleAfter?: unknown) {
  const stale = staleAfter ? new Date(String(staleAfter)).getTime() : 0
  const recorded = value ? new Date(String(value)).getTime() : 0
  if (stale) return Date.now() <= stale
  if (!recorded) return false
  return Date.now() - recorded <= 60_000
}

export type MetricFreshnessState = "CURRENT" | "STALE" | "UNAVAILABLE"

export function metricFreshness(point: any): { state: MetricFreshnessState; source: string; lastUpdatedAt: string | null } {
  const recordedAt = point?.recordedAt || point?.recorded_at || point?.lastSyncedAt || point?.last_synced_at || null
  const staleAfter = point?.staleAfter || point?.stale_after || null
  const now = Date.now()
  const recorded = recordedAt ? new Date(String(recordedAt)).getTime() : 0
  let state: MetricFreshnessState
  if (!recorded) {
    state = "UNAVAILABLE"
  } else if (staleAfter && new Date(String(staleAfter)).getTime() > 0) {
    state = now <= new Date(String(staleAfter)).getTime() ? "CURRENT" : "STALE"
  } else {
    // Default: CURRENT < 90s, STALE 90s–10min, UNAVAILABLE > 10min
    const age = now - recorded
    if (age <= 90_000) state = "CURRENT"
    else if (age <= 600_000) state = "STALE"
    else state = "UNAVAILABLE"
  }
  return {
    state,
    source: state === "UNAVAILABLE" ? "unavailable" : "cached",
    lastUpdatedAt: recorded ? new Date(recorded).toISOString() : null,
  }
}

function freshness(point: any) {
  const mf = metricFreshness(point)
  return { state: mf.state, source: mf.source, lastUpdatedAt: mf.lastUpdatedAt }
}

function customerSteps(steps: any[] = [], jobType?: string | null) {
  const source = steps.length ? steps : [
    { id: "payment_confirmed", step: "QUEUED", status: "completed", label: "Payment confirmed" },
    { id: "selecting_location", step: "SELECTING_NODE", status: "pending", label: "Selecting deployment location" },
    { id: "preparing_os", step: "CLONING_TEMPLATE", status: "pending", label: "Preparing OS image" },
    { id: "creating_instance", step: "RESIZING_DISK", status: "pending", label: "Creating cloud instance" },
    { id: "configuring_network", step: "APPLYING_CLOUD_INIT", status: "pending", label: "Configuring network" },
    { id: "starting_server", step: "STARTING_VM", status: "pending", label: "Starting server" },
    { id: "verification", step: "VERIFYING_VM", status: "pending", label: "Final verification" },
  ]
  return source.map((step) => {
    const content = customerStepContentForJob(step.step, jobType)
    return {
      id: step.id,
      step: step.step,
      status: step.status,
      title: step.label || content.title,
      label: step.label || content.title,
      message: step.error ? sanitizeCustomerProvisioningMessage(step.error) : content.message,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      createdAt: step.createdAt,
    }
  })
}

function customerLog(log: any, jobType?: string | null) {
  if (!log) return null
  const content = customerStepContentForJob(log.step, jobType)
  return {
    id: log.id,
    createdAt: log.createdAt,
    level: log.level,
    title: content.title,
    message: sanitizeCustomerProvisioningMessage(log.message) || content.message,
  }
}

function cleanProgress(job: any) {
  if (!job) return null
  const content = customerStepContentForJob(job.currentStep, job.type)
  return {
    id: job.id,
    status: job.status,
    displayStatus: content.title,
    currentStep: job.currentStep,
  }
}

function customerJob(job: any) {
  if (!job) return null
  const reinstallSteps = (job.steps || []).filter((step: any) => String(step.step || "").startsWith("REINSTALL_"))
  const total = reinstallSteps.length || 17
  const completed = reinstallSteps.filter((step: any) => step.status === "completed").length
  const progress = job.status === "completed" ? 100 : job.type === "reinstall" ? Math.min(99, Math.round((completed / total) * 100)) : Number(job.progress || 0)
  const estimatedDurationSeconds = Number(job.metadata?.estimatedDurationSeconds || 900)
  const elapsedSeconds = job.startedAt ? Math.max(0, Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000)) : 0
  return {
    id: job.id,
    status: job.status,
    displayStatus: job.displayStatus,
    currentStep: job.currentStep,
    progress,
    estimatedDurationSeconds,
    etaSeconds: ["completed", "failed", "cancelled"].includes(String(job.status)) ? 0 : Math.max(0, estimatedDurationSeconds - elapsedSeconds),
    liveLogCursor: job.logs?.[0]?.id || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

function metricPoint(row: any) {
  if (!row) return null
  const ramUsedBytes = Number(row.ramUsedBytes || row.ram_used_bytes || 0)
  const ramTotalBytes = Number(row.ramTotalBytes || row.ram_total_bytes || 0)
  const diskReported = hasReportedDiskUsage(row)
  const diskUsedBytes = diskReported ? Number(row.diskUsedBytes || row.disk_used_bytes || 0) : 0
  const diskTotalBytes = diskReported ? Number(row.diskTotalBytes || row.disk_total_bytes || 0) : 0
  const diskFreeBytes = diskReported ? Number(row.diskFreeBytes || row.disk_free_bytes || 0) : 0
  return {
    id: row.id,
    recordedAt: iso(row.recordedAt || row.recorded_at) || new Date().toISOString(),
    runtimeStatus: row.runtimeStatus || row.runtime_status || null,
    cpuPercent: Number(row.cpuPercent || row.cpu_percent || 0),
    ramUsedBytes,
    ramTotalBytes,
    ramPercent: percent(ramUsedBytes, ramTotalBytes),
    diskUsedBytes,
    diskTotalBytes,
    diskFreeBytes,
    diskReported,
    diskPercent: percent(diskUsedBytes, diskTotalBytes),
    diskFreePercent: diskTotalBytes > 0 ? Math.max(0, Math.min(100, 100 - percent(diskUsedBytes, diskTotalBytes))) : 0,
    diskReadBytes: Number(row.diskReadBytes || row.disk_read_bytes || 0),
    diskWriteBytes: Number(row.diskWriteBytes || row.disk_write_bytes || 0),
    networkInBytes: Number(row.networkInBytes || row.network_in_bytes || 0),
    networkOutBytes: Number(row.networkOutBytes || row.network_out_bytes || 0),
    rxRateBps: Number(row.rxRateBps || row.rx_rate_bps || 0),
    txRateBps: Number(row.txRateBps || row.tx_rate_bps || 0),
    uptimeSeconds: Number(row.uptimeSeconds || row.uptime_seconds || 0),
  }
}

function bucketMetricPoints(rows: any[], bucketMs = 5 * 60_000) {
  const buckets = new Map<number, { rows: any[] }>()
  for (const row of rows) {
    const point = metricPoint(row)
    if (!point) continue
    const time = new Date(point.recordedAt).getTime()
    if (!Number.isFinite(time)) continue
    const key = Math.floor(time / bucketMs) * bucketMs
    const bucket = buckets.get(key) || { rows: [] }
    bucket.rows.push(point)
    buckets.set(key, bucket)
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucketAt, bucket]) => {
      const rows = bucket.rows.sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime())
      const latest = rows[rows.length - 1]
      const avg = (key: string) => rows.reduce((sum, row) => sum + Number(row[key] || 0), 0) / Math.max(1, rows.length)
      const diskPercent = avg("diskPercent")
      return {
        ...latest,
        recordedAt: new Date(bucketAt).toISOString(),
        cpuPercent: Number(avg("cpuPercent").toFixed(2)),
        ramPercent: Number(avg("ramPercent").toFixed(2)),
        diskPercent: Number(diskPercent.toFixed(2)),
        diskFreePercent: Number(Math.max(0, Math.min(100, 100 - diskPercent)).toFixed(2)),
        samples: rows.length,
      }
    })
}

function safeBigIntBytes(value: unknown) {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function sanitizeSnapshotRow(row: any) {
  return {
    id: row.id,
    vpsInstanceId: row.vpsInstanceId,
    customerId: row.customerId,
    proxmoxNodeId: row.proxmoxNodeId,
    vmid: row.vmid ?? null,
    name: row.name,
    status: row.status,
    sizeBytes: safeBigIntBytes(row.sizeBytes),
    createdBy: row.createdBy,
    createdOnNodeAt: row.createdOnNodeAt ? new Date(row.createdOnNodeAt).toISOString() : null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    metadata: row.metadata || {},
  }
}

function sanitizeBackupRow(row: any) {
  const backupPath = row.backupPath || (row.metadata && (row.metadata.volid as string | undefined)) || null
  const fileName = backupPath ? (String(backupPath).split("/").pop() || backupPath) : null
  const startedAt = row.startedAt ? new Date(row.startedAt).getTime() : null
  const completedAt = row.completedAt ? new Date(row.completedAt).getTime() : null
  return {
    id: row.id,
    vpsInstanceId: row.vpsInstanceId,
    customerId: row.customerId,
    proxmoxNodeId: row.proxmoxNodeId,
    vmid: row.vmid ?? null,
    schedule: row.schedule,
    status: row.status,
    destination: row.destination,
    storage: row.destination,
    backupPath,
    fileName,
    sizeBytes: safeBigIntBytes(row.sizeBytes),
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
    finishedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    durationMs: startedAt && completedAt ? Math.max(0, completedAt - startedAt) : null,
    taskId: (row.metadata && (row.metadata.upid || row.metadata.taskId as string | undefined)) || null,
    error: (row.metadata && (row.metadata.error as string | undefined)) || null,
    metadata: row.metadata || {},
  }
}

function clientIpHistoryRow(row: any) {
  return {
    ipAddress: row.ipAddress || row.ip || null,
    assignedAt: iso(row.assignedAt),
    releasedAt: iso(row.releasedAt),
    status: row.status || null,
    isPrimary: Boolean(row.isPrimary),
  }
}

function clientSnapshotRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    sizeBytes: row.sizeBytes ?? null,
    createdBy: row.createdBy || null,
    createdOnNodeAt: iso(row.createdOnNodeAt),
    createdAt: iso(row.createdAt),
  }
}

function clientBackupRow(row: any) {
  return {
    id: row.id,
    status: row.status,
    sizeBytes: row.sizeBytes ?? null,
    schedule: row.schedule || null,
    // The internal storage artifact name (volid/fileName) is NEVER exposed to
    // clients — Proxmox internals must not leak to customer surfaces.
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    finishedAt: iso(row.finishedAt),
    createdAt: iso(row.createdAt),
    durationMs: row.durationMs ?? null,
    error: row.error || null,
  }
}

function isWindowsOs(vps: any) {
  const text = [
    vps?.operatingSystem?.name,
    vps?.operatingSystem?.slug,
    vps?.operatingSystem?.osType,
    vps?.operatingSystem?.category,
    vps?.operatingSystem?.proxmoxTemplateName,
    vps?.order?.osName,
  ].filter(Boolean).join(" ").toLowerCase()
  return text.includes("windows") || /\bwin(?:dows)?\b/.test(text)
}

export async function resolveCanonicalVmDataForVpsIds(vpsIds: string[]) {
  const ids = Array.from(new Set(vpsIds.filter(Boolean)))
  if (!ids.length) return new Map<string, any>()
  const [networkCacheRows, legacyNetworkRows, runtimeRows, metricRows, stateRows, addonRows, snapshotRows, backupRows, historyRows, canonicalAssignments, interfaceRows] = await Promise.all([
    (prisma as any).vmNetworkCache.findMany({ where: { vpsInstanceId: { in: ids } } }).catch(() => []),
    (prisma as any).vmNetwork.findMany({ where: { vpsInstanceId: { in: ids } } }).catch(() => []),
    (prisma as any).vmRuntime.findMany({ where: { vpsInstanceId: { in: ids } } }).catch(() => []),
    (prisma as any).vmMetricsCache.findMany({ where: { vpsInstanceId: { in: ids } } }).catch(() => []),
    (prisma as any).vmStateCache.findMany({ where: { vpsInstanceId: { in: ids } } }).catch(() => []),
    (prisma as any).vmAddon.findMany({ where: { vpsInstanceId: { in: ids }, status: { in: ["active", "queued", "pending"] } } }).catch(() => []),
    (prisma as any).vmSnapshot.findMany({ where: { vpsInstanceId: { in: ids }, deletedAt: null } }).catch(() => []),
    (prisma as any).vmBackup.findMany({ where: { vpsInstanceId: { in: ids } }, orderBy: { createdAt: "desc" } }).catch(() => []),
    (prisma as any).ipHistory.findMany({ where: { vpsInstanceId: { in: ids } }, orderBy: { assignedAt: "desc" }, take: Math.max(200, ids.length * 20) }).catch(() => []),
    (prisma as any).ipAssignment.findMany({
      where: {
        vpsInstanceId: { in: ids },
        status: { in: ACTIVE_IP_STATUSES as any },
      },
      orderBy: [{ isPrimary: "desc" }, { assignmentDate: "desc" }, { createdAt: "asc" }],
    }).catch(() => []),
    prisma.vmNetworkInterface.findMany({
      where: { vpsInstanceId: { in: ids } },
      orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
    }).catch(() => []),
  ])

  // Legacy assignments are retained for diagnostics only. They must not decide the display IP.
  const activeAssignments = await prisma.vmIpAssignment.findMany({
    where: {
      vpsInstanceId: { in: ids },
      status: { in: ACTIVE_IP_STATUSES as any },
      ipAddress: { not: null },
    },
    include: { pool: true },
    orderBy: [{ isPrimary: "desc" }, { attachedAt: "desc" }, { createdAt: "asc" }],
  }).catch(() => [])

  const byId = new Map<string, any>()
  for (const id of ids) byId.set(id, { additionalIps: [], addons: [], snapshots: [], backups: [], ipHistory: [] })
  for (const row of legacyNetworkRows) byId.get(row.vpsInstanceId).legacyNetwork = row
  for (const row of networkCacheRows) byId.get(row.vpsInstanceId).network = row
  for (const row of runtimeRows) byId.get(row.vpsInstanceId).runtime = row
  for (const row of metricRows) byId.get(row.vpsInstanceId).metrics = row
  for (const row of stateRows) byId.get(row.vpsInstanceId).state = row
  for (const row of addonRows) byId.get(row.vpsInstanceId)?.addons.push(row)
  for (const row of snapshotRows) byId.get(row.vpsInstanceId)?.snapshots.push(sanitizeSnapshotRow(row))
  for (const row of backupRows) byId.get(row.vpsInstanceId)?.backups.push(sanitizeBackupRow(row))
  for (const row of historyRows) byId.get(row.vpsInstanceId)?.ipHistory.push(row)
  for (const row of interfaceRows) {
    const bucket = byId.get(row.vpsInstanceId)
    if (!bucket) continue
    bucket.interfaces = bucket.interfaces || []
    bucket.interfaces.push(row)
  }
  for (const assignment of canonicalAssignments) {
    const bucket = byId.get(assignment.vpsInstanceId)
    if (!bucket) continue
    bucket.ipAssignments = bucket.ipAssignments || []
    bucket.ipAssignments.push(assignment)
  }
  for (const assignment of activeAssignments) {
    const bucket = byId.get(assignment.vpsInstanceId)
    if (!bucket) continue
    bucket.legacyAssignments = bucket.legacyAssignments || []
    bucket.legacyAssignments.push(assignment)
  }

  for (const [id, bucket] of byId) {
    const primaryAssignment = bucket.ipAssignments?.find((item: any) => item.isPrimary) || bucket.ipAssignments?.[0] || null
    const network = bucket.network || bucket.legacyNetwork
    const primaryInterface = bucket.interfaces?.find((item: any) => item.isPrimary) || bucket.interfaces?.[0] || null
    bucket.primaryIp = primaryAssignment?.assignedIp || null
    bucket.macAddress = primaryInterface?.macAddress || bucket.network?.metadata?.macAddress || null
    bucket.primaryInterface = primaryInterface
    bucket.primaryAssignment = primaryAssignment
    bucket.primaryPool = primaryAssignment?.poolId ? { id: primaryAssignment.poolId, name: primaryAssignment.poolName || primaryAssignment.poolId } : null
    bucket.additionalIps = Array.isArray(network?.additionalIps)
      ? network.additionalIps
      : (bucket.ipAssignments || [])
          .filter((item: any) => !item.isPrimary && item.assignedIp)
          .map((item: any) => ({ id: item.id, ipAddress: item.assignedIp, role: "secondary", poolId: item.poolId, status: item.status }))
    bucket.ipDiagnostics = {
      billingIp: primaryAssignment?.billingIp || null,
      cloudInitIp: primaryAssignment?.cloudInitIp || network?.cloudInitIp || null,
      guestAgentIp: primaryAssignment?.guestAgentIp || network?.discoveredIp || null,
      proxmoxIp: primaryAssignment?.proxmoxIp || network?.proxmoxIp || null,
      source: primaryAssignment?.source || null,
      legacyAssignedIp: bucket.legacyAssignments?.find((item: any) => item.isPrimary)?.ipAddress || null,
      networkCacheIp: network?.primaryAssignedIp || null,
    }
    byId.set(id, bucket)
  }

  return byId
}

export async function getCanonicalClientVm(customerId: string, id: string) {
  const vps = await prisma.vpsInstance.findFirst({
    where: { OR: [{ id }, { orderId: id }], customerId, deletedAt: null, status: { not: "DELETED" }, order: { deletedAt: null, status: { not: "DELETED" } } },
    include: {
      order: { select: { id: true, createdAt: true, termMonths: true, status: true, provisioningStatus: true, provisioningError: true, osName: true } },
      product: { select: { name: true, cpuCores: true, ramGb: true, storageGb: true, storageType: true, bandwidthTb: true, metadata: true } },
      storagePool: true,
      operatingSystem: { select: { id: true, name: true, slug: true, osType: true, category: true, osFamily: true, osVersion: true, consoleType: true, proxmoxTemplateName: true, proxmoxConfig: true, cloudInitSupported: true } },
      proxmoxNode: true,
      disks: { where: { status: { not: "DELETED" } }, include: { storagePool: true }, orderBy: [{ isPrimary: "desc" }, { displayName: "asc" }] },
      provisioningJobs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          steps: { orderBy: { createdAt: "asc" } },
          logs: { orderBy: { createdAt: "desc" }, take: 50 },
        },
      },
    },
  })
  return vps
}

export async function getCanonicalPendingOrder(customerId: string, id: string) {
  return prisma.order.findFirst({
    where: { id, customerId, deletedAt: null, status: { not: "DELETED" } },
    include: {
      provisioningJobs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          steps: { orderBy: { createdAt: "asc" } },
          logs: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
      product: { select: { name: true, cpuCores: true, ramGb: true, storageGb: true, bandwidthTb: true } },
      operatingSystem: { select: { name: true } },
    },
  })
}

export function serializePendingOrderStatus(order: any) {
  const job = order?.provisioningJobs?.[0] || null
  const step = normalizeStep(job?.currentStep || order.provisioningStatus)
  return {
    success: true,
    status: order.provisioningStatus || "pending",
    displayStatus: job?.displayStatus || STEP_LABELS[step],
    provisioningStatus: order.provisioningStatus,
    provisioningError: order.provisioningError,
    job: customerJob(job),
    os: order.operatingSystem?.name || order.osName,
    currentStep: job?.currentStep || order.provisioningStatus,
    latestLog: customerLog(job?.logs?.[0], job?.type),
    steps: customerSteps(job?.steps || [], job?.type),
    hostname: job?.hostname || null,
    ipAddress: null,
    plan: order.product?.name || "Instance",
    billingStatus: order.status,
    createdAt: order.createdAt,
    cpu: 0,
    cpuPercent: 0,
    memory: 0,
    ramUsedBytes: 0,
    ramTotalBytes: 0,
    ramPercent: 0,
    diskUsedBytes: 0,
    diskTotalBytes: 0,
    diskPercent: 0,
    uptime: 0,
    netin: 0,
    netout: 0,
  }
}

export async function serializeClientVmStatus(vps: any) {
  const canonical = (await resolveCanonicalVmDataForVpsIds([vps.id])).get(vps.id) || {}
  const job = vps.provisioningJobs?.[0] || null
  const metric = metricPoint(canonical.metrics)
  const state = canonical.state || {}
  const stateFreshness = freshness(state)
  const metricFreshness = freshness(canonical.metrics)
  const stateRuntimeStatus = stateFreshness.state === "CURRENT" ? (state.runtimeStatus || state.runtime_status || null) : null
  const metricRuntimeStatus = metricFreshness.state === "CURRENT" ? (canonical.metrics?.runtimeStatus || canonical.metrics?.runtime_status || null) : null
  const runtimeStatus = stateRuntimeStatus || metricRuntimeStatus || null
  const stateStatus = stateFreshness.state === "CURRENT" ? state.status : null
  const mapped = mapLiveVpsStatus(runtimeStatus ? { status: runtimeStatus } : null, vps.order.provisioningStatus, stateStatus || "UNKNOWN")
  const runtimeRunning = runtimeStatus === "running" || mapped.status === "ACTIVE"
  const explicitAgentStatus = String(canonical.metrics?.metadata?.agentStatus || canonical.state?.metadata?.agentStatus || "").toLowerCase()
  const primaryDisk = (vps.disks || []).find((item: any) => item.isPrimary) || vps.disks?.[0] || null
  const dueInvoice = await prisma.invoice.findFirst({
    where: {
      customerId: vps.customerId,
      deletedAt: null,
      status: { in: ["draft", "sent", "pending", "overdue"] },
      metadata: { path: ["vpsInstanceId"], equals: vps.id },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, invoiceNumber: true, status: true, totalAmount: true, dueDate: true, currency: true },
  }).catch(() => null)
  const lifecycle = lifecycleDates({
    createdAt: vps.createdAt,
    termMonths: vps.order.termMonths,
    renewalDueAt: vps.renewalDueAt || vps.nextRenewalAt,
    graceDays: vps.graceDays,
    penaltyWindowDays: vps.penaltyWindowDays,
    terminationWindowDays: vps.terminationWindowDays,
    retentionDays: vps.retentionDays,
  })
  const expiryTargetDate = lifecycle.renewalDueAt ? new Date(lifecycle.renewalDueAt) : null
  const expiryTargetValid = expiryTargetDate ? Number.isFinite(expiryTargetDate.getTime()) : false
  const daysToExpireRaw = expiryTargetValid ? Math.ceil((expiryTargetDate!.getTime() - Date.now()) / 86400000) : null
  const expired = expiryTargetValid ? expiryTargetDate!.getTime() < Date.now() : false
  const daysToExpire = expired ? -Math.abs(daysToExpireRaw ?? 0) : daysToExpireRaw
  const expiryState = expired ? "expired" : daysToExpire !== null && daysToExpire <= 7 ? "expiring_soon" : "active"
  const lifecycleSuspendAt = vps.suspendAt && lifecycle.deletionAt && vps.suspendAt.getTime() <= lifecycle.deletionAt.getTime() ? vps.suspendAt : lifecycle.suspendAt
  const lifecyclePenaltyAt = vps.penaltyAt && lifecycle.deletionAt && vps.penaltyAt.getTime() <= lifecycle.deletionAt.getTime() ? vps.penaltyAt : lifecycle.penaltyAt
  const lifecycleTerminationAt = vps.terminationAt && lifecycle.deletionAt && vps.terminationAt.getTime() <= lifecycle.deletionAt.getTime() ? vps.terminationAt : lifecycle.terminationAt
  const lifecycleDeletionAt = vps.deletionAt || lifecycle.deletionAt
  const cachedDiskUsedGb = vps.diskUsedGb === null || vps.diskUsedGb === undefined ? null : Number(vps.diskUsedGb)
  const cachedDiskTotalGb = vps.diskTotalGb === null || vps.diskTotalGb === undefined ? null : Number(vps.diskTotalGb)
  const cachedDiskPercent = vps.diskUsagePercent === null || vps.diskUsagePercent === undefined ? null : Number(vps.diskUsagePercent)
  const hasCachedDiskUsage = Boolean(cachedDiskTotalGb && ((cachedDiskUsedGb || 0) > 0 || (cachedDiskPercent || 0) > 0))
  const diskTotalBytes = numberValue(metric?.diskTotalBytes)
  const diskUsedBytes = numberValue(metric?.diskUsedBytes)
  const hasMetricDiskUsage = hasReportedDiskUsage(metric)
  const configuredDiskGb = firstPositiveNumber(vps.diskTotalGb, vps.diskGb, primaryDisk?.sizeGb, vps.product?.storageGb, canonical.runtime?.diskGb)
  const diskUsageReported = hasCachedDiskUsage || hasMetricDiskUsage || Boolean(configuredDiskGb)
  const effectiveDiskTotalGb = hasCachedDiskUsage
    ? cachedDiskTotalGb
    : hasMetricDiskUsage
      ? Number(bytesToDecimalGb(diskTotalBytes).toFixed(2))
      : configuredDiskGb
  const effectiveDiskUsedGb = hasCachedDiskUsage
    ? cachedDiskUsedGb
    : hasMetricDiskUsage
      ? Number(bytesToDecimalGb(diskUsedBytes).toFixed(2))
      : null
  const effectiveDiskPercent = hasCachedDiskUsage
    ? cachedDiskPercent ?? percent(Number(gbToBytesDecimal(cachedDiskUsedGb)), Number(gbToBytesDecimal(effectiveDiskTotalGb)))
    : hasMetricDiskUsage
      ? Number(percent(diskUsedBytes, diskTotalBytes).toFixed(2))
      : null
  const terminalStates = new Set(["DELETED", "TERMINATED", "CANCELLED", "EXPIRED"])
  const consoleSettings = await getConsoleSettings().catch(() => null)
  const storedConsoleType = normalizeConsoleType(vps.consoleType)
  const detectedConsole = resolveConsoleType({ template: vps.operatingSystem ? { ...vps.operatingSystem, name: vps.operatingSystem.name || vps.order.osName } : { name: vps.order.osName }, settings: consoleSettings })
  const resolvedConsoleType = storedConsoleType === "auto" ? detectedConsole.consoleType : storedConsoleType
  const consoleMode = consoleModeForResolvedType({ consoleType: resolvedConsoleType })
  const consoleAccess = await getConsoleAccess(vps, consoleMode)
  const consoleAvailable = Boolean(
    vps.consoleEnabled !== false &&
    vps.vmid &&
    vps.proxmoxNode?.nodeName &&
    !terminalStates.has(String(mapped.status || vps.status || "").toUpperCase())
  )
  const brandName = await resolveBrandIdentity()
  const diskFreshness = hasCachedDiskUsage
    ? { state: "STALE", source: "cached", lastUpdatedAt: iso(vps.diskUsageCheckedAt) }
    : metricFreshness
  const snapshotCount = canonical.snapshots?.filter((item: any) => !["deleted", "failed"].includes(String(item.status || "").toLowerCase())).length || 0
  const backupCount = canonical.backups?.filter((item: any) => !["deleted", "failed"].includes(String(item.status || "").toLowerCase())).length || 0
  const addonSummary = (canonical.addons || []).reduce((acc: Record<string, number>, addon: any) => {
    acc[addon.addonType] = (acc[addon.addonType] || 0) + Number(addon.quota || 1)
    return acc
  }, {})

  return {
    success: true,
    status: mapped.status,
    runtimeStatus,
    displayStatus: mapped.overloaded ? "Active" : (mapped.displayStatus === "Installing" || mapped.displayStatus === "Configuring" ? "Provisioning" : mapped.displayStatus || "Provisioning"),
    overloaded: mapped.overloaded,
    provisioningStatus: vps.order.provisioningStatus,
    provisioningError: vps.order.provisioningError,
    job: customerJob(job),
    os: vps.operatingSystem?.name || vps.order.osName,
    currentStep: job?.currentStep || vps.order.provisioningStatus,
    latestLog: customerLog(job?.logs?.[0], job?.type),
    steps: customerSteps(job?.steps || [], job?.type),
    hostname: instanceDisplayName(vps),
    instanceName: instanceDisplayName(vps),
    displayTag: typeof vps.displayTag === "string" ? vps.displayTag : null,
    name: friendlyVmDisplayName(vps) || instanceDisplayName(vps),
    internalHostname: internalVmHostname(vps, canonical.primaryIp || vps.ipAddress || null),
    vmid: null,
    nodeName: null,
    node: null,
    template: vps.operatingSystem ? { name: vps.operatingSystem.name, family: vps.operatingSystem.osFamily } : null,
    ipAddress: canonical.primaryIp || vps.ipAddress || null,
    primaryIp: canonical.primaryIp || vps.ipAddress || null,
    macAddress: vps.vmMacAddress || canonical.macAddress || null,
    network: {
      gateway: canonical.primaryAssignment?.gateway || canonical.network?.primaryGateway || null,
      cidr: canonical.primaryAssignment?.cidr || canonical.network?.primaryCidr || null,
      dns: canonical.primaryAssignment?.dns || canonical.network?.primaryDns || null,
      macAddress: vps.vmMacAddress || canonical.macAddress || null,
      model: canonical.primaryInterface?.model || null,
      lastSyncedAt: iso(canonical.network?.lastSyncedAt),
      source: canonical.network?.source || canonical.primaryAssignment?.source || "unavailable",
    },
    firewall: null,
    additionalIps: canonical.additionalIps || [],
    ipHistory: (canonical.ipHistory || []).map(clientIpHistoryRow),
    username: vps.username || vps.adminUsername || null,
    plan: vps.product?.name || "Instance",
    bandwidthTb: decimalNumber(vps.bandwidthTb) ?? (vps.product ? Number(vps.product.bandwidthTb || 0) : null),
    bandwidthLabel: vps.bandwidthTb ? formatBandwidthQuota(vps.bandwidthTb) : vps.product ? formatBandwidthQuota(vps.product.bandwidthTb) : null,
    addonSummary,
    snapshots: { count: snapshotCount, items: (canonical.snapshots || []).map(clientSnapshotRow) },
    backups: { count: backupCount, items: (canonical.backups || []).map(clientBackupRow) },
    billingStatus: vps.order.status,
    billingLabels: {
      nextBillingDate: lifecycle.renewalDueAt,
      gracePeriodEnds: lifecycle.gracePeriodEnds,
      serviceSuspensionDate: lifecycleSuspendAt,
      penaltyActivation: lifecyclePenaltyAt,
      permanentDeletionDate: lifecycleDeletionAt,
      dataRetentionWindow: `${vps.retentionDays || 7} days`,
      billingCycle: vps.billingCycle,
      autoRenewal: vps.autoSuspendEnabled && vps.autoDeleteEnabled ? "Automation active" : "Manual review",
      outstandingBalance: dueInvoice ? Number(dueInvoice.totalAmount) : 0,
      serviceStatus: mapped.status,
    },
    nextRenewalAt: lifecycle.renewalDueAt,
    renewalDueAt: lifecycle.renewalDueAt,
    deadlineAt: lifecycle.renewalDueAt || null,
    daysToExpire,
    expiresAt: lifecycle.renewalDueAt || null,
    expiry: {
      state: expiryState,
      daysToExpire,
      expiresAt: lifecycle.renewalDueAt || null,
      expired,
    },
    suspendAt: lifecycleSuspendAt,
    penaltyAt: lifecyclePenaltyAt,
    terminationAt: lifecycleTerminationAt,
    deletionAt: lifecycleDeletionAt,
    penaltyAppliedAt: vps.penaltyAppliedAt,
    lastReminderLevel: vps.lastReminderLevel,
    lastReminderSentAt: vps.lastReminderSentAt,
    autoSuspendEnabled: vps.autoSuspendEnabled,
    autoDeleteEnabled: vps.autoDeleteEnabled,
    automationPausedAt: vps.automationPausedAt,
    remindersPausedAt: vps.remindersPausedAt,
    lifecycle: {
      orderCreatedAt: lifecycle.orderCreatedAt,
      nextBillingDate: lifecycle.renewalDueAt,
      renewalDueAt: lifecycle.renewalDueAt,
      gracePeriodEnds: lifecycle.gracePeriodEnds,
      serviceSuspensionDate: lifecycleSuspendAt,
      suspendAt: lifecycleSuspendAt,
      penaltyActivation: lifecyclePenaltyAt,
      penaltyAt: lifecyclePenaltyAt,
      terminationAt: lifecycleTerminationAt,
      permanentDeletionDate: lifecycleDeletionAt,
      deletionAt: lifecycleDeletionAt,
      dataRetentionWindow: `${vps.retentionDays || lifecycle.dataRetentionWindowDays} days`,
      billingCycle: vps.billingCycle || "monthly",
      autoRenewal: vps.autoSuspendEnabled && vps.autoDeleteEnabled ? "Automation active" : "Manual review",
      outstandingBalance: dueInvoice ? Number(dueInvoice.totalAmount) : 0,
      serviceStatus: mapped.status,
    },
    automationState: normalizeVmAutomationState(
      vps.automationPausedAt || vps.remindersPausedAt
        ? "paused"
        : vps.suspendedAt
          ? "suspended"
          : job?.status || vps.order.provisioningStatus || vps.status
    ),
    stateMachine: {
      lifecycleState: normalizeVmLifecycleState(mapped.status),
      automationState: normalizeVmAutomationState(job?.status || vps.order.provisioningStatus || vps.status),
      rawStatus: vps.status,
      provisioningStatus: vps.order.provisioningStatus,
    },
    metricsSource: {
      runtime: metricFreshness.source,
      cpu: metricFreshness.source,
      memory: metricFreshness.source,
      disk: diskFreshness.source,
      network: metricFreshness.source,
    },
    metricsFreshness: {
      runtime: metricFreshness,
      cpu: metricFreshness,
      memory: metricFreshness,
      disk: diskFreshness,
      network: metricFreshness,
    },
    renewalAmount: vps.renewalAmount ? Number(vps.renewalAmount) : null,
    dueInvoice: dueInvoice ? { ...dueInvoice, totalAmount: Number(dueInvoice.totalAmount) } : null,
    createdAt: vps.createdAt,
    resources: {
      cpuCores: firstPositiveNumber(vps.cpuCores, vps.product?.cpuCores, canonical.runtime?.cpuCores),
      ramGb: firstPositiveNumber(vps.ramGb, vps.product?.ramGb, canonical.runtime?.ramGb),
      diskGb: firstPositiveNumber(vps.diskGb, vps.product?.storageGb, canonical.runtime?.diskGb),
      bandwidthTb: firstPositiveNumber(vps.bandwidthTb, vps.product?.bandwidthTb, canonical.runtime?.bandwidthTb),
      bandwidthLabel: firstPresent(vps.bandwidthTb, vps.product?.bandwidthTb, canonical.runtime?.bandwidthTb)
        ? formatBandwidthQuota(firstPresent(vps.bandwidthTb, vps.product?.bandwidthTb, canonical.runtime?.bandwidthTb))
        : null,
    },
    storage: {
      diskGb: vps.diskGb || vps.product?.storageGb || null,
      displayName: vps.storagePoolSnapshot?.displayName || vps.storagePool?.displayName || vps.storagePool?.storageId || "Default storage",
      storageType: vps.storagePoolSnapshot?.storageType || vps.storagePool?.storageType || vps.product?.storageType || null,
      includedDiskGb: vps.storagePoolSnapshot?.includedDiskGb ?? vps.product?.storageGb ?? vps.diskGb ?? null,
      extraDiskGb: vps.storagePoolSnapshot?.extraDiskGb ?? Math.max(0, Number(vps.diskGb || 0) - Number(vps.product?.storageGb || 0)),
      diskMonthlyCost: vps.storagePoolSnapshot?.diskMonthlyCost ?? 0,
      pricePerGbMonthly: vps.storagePoolSnapshot?.pricePerGbMonthly ?? Number(vps.storagePool?.pricePerGbMonthly || 0),
      storagePoolId: vps.storagePoolId,
      primaryDisk: primaryDisk ? {
        id: primaryDisk.id,
        displayName: primaryDisk.displayName,
        sizeGb: Number(primaryDisk.sizeGb || 0),
        storagePoolName: primaryDisk.storagePool?.displayName || primaryDisk.storagePool?.storageId || null,
      } : null,
      disks: (vps.disks || []).map((disk: any) => ({
        id: disk.id,
        displayName: disk.displayName,
        sizeGb: disk.sizeGb,
        isPrimary: disk.isPrimary,
        status: disk.status,
        storagePoolId: disk.storagePoolId,
        storagePoolName: disk.storagePool?.displayName || disk.storagePool?.storageId || null,
      })),
      enterprise: {
        tier: "Enterprise NVMe",
        technology: "VirtIO SCSI",
        source: hasCachedDiskUsage ? "guest-filesystem" : metricFreshness.source,
        replicationStatus: diskUsageReported ? "Healthy" : "Usage unavailable",
        region: "India",
        latencyIndicator: Number(effectiveDiskPercent || 0) > 90 ? "elevated" : "low",
        health: "Healthy",
      },
    },
    storageEnterprise: {
      source: hasCachedDiskUsage ? "guest-filesystem" : metricFreshness.source,
      health: diskUsageReported ? "Healthy" : "Usage unavailable",
      replicationStatus: diskUsageReported ? "Healthy" : "Usage unavailable",
    },
    networkIntelligence: {
      infrastructure: `${brandName} Zone`,
      region: canonical.runtime?.region || vps.proxmoxNode?.location || vps.serviceLocation || "India",
      network: "Protected",
      status: mapped.status === "STOPPED" || String(runtimeStatus || "").toLowerCase() === "stopped" ? "Offline" : "Healthy",
    },
    infrastructure: {
      infrastructure: `${brandName} Zone`,
      region: canonical.runtime?.region || vps.proxmoxNode?.location || vps.serviceLocation || "India",
      network: "Protected",
      status: mapped.status === "STOPPED" || String(runtimeStatus || "").toLowerCase() === "stopped" ? "Offline" : "Healthy",
    },
    monitoringStatus: runtimeRunning
      ? metricFreshness.state === "UNAVAILABLE"
        ? explicitAgentStatus === "offline"
          ? "Guest agent offline"
          : "Monitoring unavailable"
        : "Monitoring available"
      : "Server offline",
    guestAgentStatus: explicitAgentStatus || (runtimeRunning && metricFreshness.state !== "UNAVAILABLE" ? "online" : runtimeRunning ? "unavailable" : "offline"),
    provisionLogs: (job?.logs || []).map((log: any) => customerLog(log, job?.type)).filter(Boolean),
    console: {
      available: consoleAvailable,
      consoleType: resolvedConsoleType,
      mode: consoleMode.mode,
      defaultMode: consoleMode.defaultMode,
      label: consoleModeLabel(consoleMode.mode),
      display: consoleMode.display,
      switches: consoleMode.switches,
      access: consoleAccess,
    },
    access: {
      isWindows: isWindowsOs(vps),
      sshEnabled: !isWindowsOs(vps),
      rdpEnabled: isWindowsOs(vps),
    },
    credentialVerification: {
      status: vps.credentialVerificationStatus || null,
      label: vps.credentialVerificationStatus === "VERIFIED" ? "Verified" : vps.credentialVerificationStatus === "FAILED" ? "Verification Failed" : null,
      checkedAt: vps.credentialVerificationCheckedAt || null,
      verifiedAt: vps.credentialVerifiedAt || null,
    },
    cpu: metric?.cpuPercent || 0,
    cpuPercent: metric?.cpuPercent || 0,
    cpuCores: Number(firstPositiveNumber(vps.cpuCores, vps.product?.cpuCores, canonical.runtime?.cpuCores) || 0),
    memory: metric?.ramPercent || 0,
    ramUsedBytes: metric?.ramUsedBytes || 0,
    ramTotalBytes: metric?.ramTotalBytes || 0,
    ramPercent: metric?.ramPercent || 0,
    diskUsedBytes: diskUsageReported ? diskUsedBytes : 0,
    diskTotalBytes: diskUsageReported ? diskTotalBytes : 0,
    diskPercent: diskUsageReported ? Number(effectiveDiskPercent || 0) : 0,
    diskUsage: {
      usedGb: effectiveDiskUsedGb,
      totalGb: effectiveDiskTotalGb,
      freeGb: effectiveDiskTotalGb !== null && effectiveDiskUsedGb !== null ? Math.max(0, Number((effectiveDiskTotalGb - effectiveDiskUsedGb).toFixed(2))) : null,
      percent: effectiveDiskPercent,
      checkedAt: hasCachedDiskUsage ? vps.diskUsageCheckedAt : metric?.recordedAt || null,
      source: hasCachedDiskUsage ? "cached" : metricFreshness.source,
      reported: diskUsageReported,
    },
    diagnostics: {
      runtimeStatusAvailable: Boolean(runtimeStatus),
      runtimeConfigAvailable: Boolean(canonical.state?.proxmoxState || canonical.state?.proxmox_state),
      diskUsageSource: hasCachedDiskUsage ? "cached" : metricFreshness.source,
      metricsSource: {
        runtime: metricFreshness.source,
        cpu: metricFreshness.source,
        memory: metricFreshness.source,
        disk: diskFreshness.source,
        network: metricFreshness.source,
      },
    },
    activity: {
      latestLog: customerLog(job?.logs?.[0], job?.type),
      steps: customerSteps(job?.steps || [], job?.type).slice(-5),
    },
    uptime: metric?.uptimeSeconds || 0,
    netin: metric?.networkInBytes || 0,
    netout: metric?.networkOutBytes || 0,
  }
}

export async function getClientVmMetricSeries(input: { customerId: string; id: string; range: "1h" | "24h" | "48h" }) {
  const vps = await prisma.vpsInstance.findFirst({
    where: { OR: [{ id: input.id }, { orderId: input.id }], customerId: input.customerId, deletedAt: null, status: { not: "DELETED" } },
    select: { id: true, status: true },
  })
  if (!vps) return null
  const rangeHours = input.range === "48h" ? 48 : input.range === "24h" ? 24 : 1
  const since = new Date(Date.now() - rangeHours * 60 * 60 * 1000)
  // Target ~288 points for 48h (10-min buckets), 288 for 24h (5-min), 120 for 1h (30s)
  const targetPoints = input.range === "48h" ? 288 : input.range === "24h" ? 288 : 120
  const [cache, rows] = await Promise.all([
    (prisma as any).vmMetricsCache.findUnique({ where: { vpsInstanceId: vps.id } }).catch(() => null),
    prisma.vpsMetric.findMany({
      where: { vpsInstanceId: vps.id, recordedAt: { gte: since } },
      orderBy: { recordedAt: "asc" },
      take: targetPoints * 2, // oversample for downsampling
    }).catch(() => []),
  ])
  const bucketMs = input.range === "48h" ? 10 * 60_000 : input.range === "24h" ? 5 * 60_000 : 30_000
  const points = bucketMetricPoints(rows, bucketMs)
  if (!points.length && cache) {
    const cachedPoint = metricPoint(cache)
    if (cachedPoint) points.push(cachedPoint as any)
  }
  const latest = points[points.length - 1] || metricPoint(cache)
  const fresh = metricFreshness(cache || latest)
  const runtimeStatus = String(latest?.runtimeStatus || cache?.runtimeStatus || cache?.runtime_status || "").toLowerCase()
  const running = runtimeStatus === "running"
  return {
    success: true,
    range: input.range,
    polling: running,
    state: running ? "active" : "paused",
    status: runtimeStatus === "stopped" ? "offline" : runtimeStatus || "unknown",
    metricsFreshness: {
      cpu: fresh,
      memory: fresh,
      network: fresh,
      disk: fresh,
    },
    points,
  }
}

export async function serializeClientVmListRow(vps: any, customer: any, canonical: any) {
  const lifecycle = lifecycleDates({
    createdAt: vps.createdAt,
    termMonths: vps.order.termMonths,
    renewalDueAt: vps.renewalDueAt || vps.nextRenewalAt,
    graceDays: vps.graceDays,
    penaltyWindowDays: vps.penaltyWindowDays,
    terminationWindowDays: vps.terminationWindowDays,
    retentionDays: vps.retentionDays,
  })
  const lifecycleSuspendAt = vps.suspendAt && lifecycle.deletionAt && vps.suspendAt.getTime() <= lifecycle.deletionAt.getTime() ? vps.suspendAt : lifecycle.suspendAt
  const lifecyclePenaltyAt = vps.penaltyAt && lifecycle.deletionAt && vps.penaltyAt.getTime() <= lifecycle.deletionAt.getTime() ? vps.penaltyAt : lifecycle.penaltyAt
  const lifecycleTerminationAt = vps.terminationAt && lifecycle.deletionAt && vps.terminationAt.getTime() <= lifecycle.deletionAt.getTime() ? vps.terminationAt : lifecycle.terminationAt
  const lifecycleDeletionAt = vps.deletionAt || lifecycle.deletionAt
  const serviceState = String(vps.status || "").toUpperCase()
  const consoleAvailable = Boolean(
    vps.id &&
    vps.consoleEnabled !== false &&
    vps.vmid &&
    vps.proxmoxNodeId &&
    vps.proxmoxNode?.nodeName &&
    !["DELETED", "TERMINATED", "CANCELLED", "EXPIRED"].includes(serviceState)
  )
  const automationState = normalizeVmAutomationState(
    vps.automationPausedAt || vps.remindersPausedAt
      ? "paused"
      : vps.suspendedAt
        ? "suspended"
        : vps.provisioningJobs[0]?.status || vps.order.provisioningStatus || vps.status
  )
  const metricFreshness = freshness(canonical?.metrics)
  return {
    id: vps.id,
    orderId: vps.orderId,
    orderNumber: vps.order.orderNumber,
    hostname: instanceDisplayName(vps),
    instanceName: instanceDisplayName(vps),
    displayTag: typeof vps.displayTag === "string" ? vps.displayTag : null,
    name: friendlyVmDisplayName(vps) || instanceDisplayName(vps),
    internalHostname: internalVmHostname(vps, canonical?.primaryIp || vps.ipAddress || null),
    ipAddress: canonical?.primaryIp || vps.ipAddress || null,
    primaryIp: canonical?.primaryIp || vps.ipAddress || null,
    os: vps.operatingSystem?.name || vps.order.osName,
    plan: vps.product?.name || "Instance",
    customerEmail: customer?.email || null,
    resources: {
      cpuCores: firstPositiveNumber(vps.cpuCores, vps.product?.cpuCores, canonical?.runtime?.cpuCores),
      ramGb: firstPositiveNumber(vps.ramGb, vps.product?.ramGb, canonical?.runtime?.ramGb),
      diskGb: firstPositiveNumber(vps.diskGb, vps.product?.storageGb, canonical?.runtime?.diskGb),
      bandwidthTb: firstPositiveNumber(vps.bandwidthTb, vps.product?.bandwidthTb, canonical?.runtime?.bandwidthTb),
      bandwidthLabel: firstPresent(vps.bandwidthTb, vps.product?.bandwidthTb, canonical?.runtime?.bandwidthTb)
        ? formatBandwidthQuota(firstPresent(vps.bandwidthTb, vps.product?.bandwidthTb, canonical?.runtime?.bandwidthTb))
        : null,
    },
    status: canonical?.state?.status || canonical?.runtime?.status || vps.status,
    runtimeStatus: canonical?.metrics?.runtimeStatus || canonical?.state?.runtimeStatus || null,
    customerStatus: customerFacingVpsStatus(vps.status, vps.order.provisioningStatus),
    consoleEnabled: vps.consoleEnabled,
    consoleAvailable,
    vmid: vps.vmid,
    nodeName: canonical?.runtime?.nodeName || vps.proxmoxNode?.nodeName || null,
    provisioningStatus: vps.order.provisioningStatus,
    provisioningError: vps.order.provisioningError,
    billingStatus: vps.order.status,
    progress: cleanProgress(vps.provisioningJobs[0]),
    currentStep: vps.provisioningJobs[0]?.currentStep || vps.order.provisioningStatus,
    latestLog: customerLog(vps.provisioningJobs[0]?.logs?.[0] ? { ...vps.provisioningJobs[0]?.logs?.[0], jobType: vps.provisioningJobs[0]?.type } : null),
    nextRenewalAt: lifecycle.renewalDueAt,
    renewalDueAt: lifecycle.renewalDueAt,
    suspendAt: lifecycleSuspendAt,
    penaltyAt: lifecyclePenaltyAt,
    terminationAt: lifecycleTerminationAt,
    deletionAt: lifecycleDeletionAt,
    penaltyAppliedAt: vps.penaltyAppliedAt,
    lastReminderLevel: vps.lastReminderLevel,
    lastReminderSentAt: vps.lastReminderSentAt,
    autoSuspendEnabled: vps.autoSuspendEnabled,
    autoDeleteEnabled: vps.autoDeleteEnabled,
    automationPausedAt: vps.automationPausedAt,
    remindersPausedAt: vps.remindersPausedAt,
    renewalAmount: vps.renewalAmount ? Number(vps.renewalAmount) : null,
    lifecycle: {
      orderCreatedAt: lifecycle.orderCreatedAt,
      nextBillingDate: lifecycle.renewalDueAt,
      renewalDueAt: lifecycle.renewalDueAt,
      gracePeriodEnds: lifecycle.gracePeriodEnds,
      serviceSuspensionDate: lifecycleSuspendAt,
      suspendAt: lifecycleSuspendAt,
      penaltyActivation: lifecyclePenaltyAt,
      penaltyAt: lifecyclePenaltyAt,
      terminationAt: lifecycleTerminationAt,
      permanentDeletionDate: lifecycleDeletionAt,
      deletionAt: lifecycleDeletionAt,
      dataRetentionWindow: `${vps.retentionDays || lifecycle.dataRetentionWindowDays} days`,
      billingCycle: vps.billingCycle || "monthly",
      autoRenewal: vps.autoSuspendEnabled && vps.autoDeleteEnabled ? "Automation active" : "Manual review",
      outstandingBalance: 0,
      serviceStatus: vps.status,
    },
    automationState,
    stateMachine: {
      lifecycleState: normalizeVmLifecycleState(vps.status),
      automationState,
      rawStatus: vps.status,
      provisioningStatus: vps.order.provisioningStatus,
    },
    metricsSource: {
      runtime: metricFreshness.source,
      cpu: metricFreshness.source,
      memory: metricFreshness.source,
      disk: metricFreshness.source,
      network: metricFreshness.source,
    },
    storageEnterprise: { source: metricFreshness.source, health: metricFreshness.state === "UNAVAILABLE" ? "Unavailable" : "Healthy", replicationStatus: metricFreshness.state === "UNAVAILABLE" ? "Unavailable" : "Healthy" },
    networkIntelligence: null,
    diagnostics: { liveStatusAvailable: metricFreshness.state !== "UNAVAILABLE" },
    activity: {
      latestLog: customerLog(vps.provisioningJobs[0]?.logs?.[0] ? { ...vps.provisioningJobs[0]?.logs?.[0], jobType: vps.provisioningJobs[0]?.type } : null),
      currentStep: vps.provisioningJobs[0]?.currentStep || vps.order.provisioningStatus,
    },
    createdAt: vps.createdAt,
  }
}
