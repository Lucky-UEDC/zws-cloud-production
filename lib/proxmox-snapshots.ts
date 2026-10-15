import { prisma } from "@/lib/db"
import { createProxmoxClient, ProxmoxError, PROXMOX_LONG_TIMEOUT_MS } from "@/lib/proxmox"
import { storageTypeIsSnapshotCapable } from "@/lib/proxmox/storage-snapshot-rule"
import { writeAuditLog } from "@/lib/audit-log"

// The snapshot-capability rule is a property of the storage type, not of the
// snapshot operations, so it lives with the storage rules and is re-exported
// here for the callers that already import it from this module.
export { storageTypeIsSnapshotCapable }

const SNAPSHOT_TASK_TIMEOUT_MS = 15 * 60 * 1000

function proxmoxClientForNode(node: { host: string; tokenId: string; tokenSecret: string; allowInsecureTls: boolean }) {
  if (!node.host) throw new ProxmoxError(404, "Node has no host configured")
  return createProxmoxClient(node.host, node.tokenId, node.tokenSecret, {
    allowInsecureTls: node.allowInsecureTls,
    timeoutMs: PROXMOX_LONG_TIMEOUT_MS,
  })
}

function listFrom(payload: any): any[] {
  if (Array.isArray(payload)) return payload
  if (payload && Array.isArray(payload.data)) return payload.data
  return []
}

export type SnapshotVmOption = {
  vpsInstanceId: string
  customerId: string
  nodeId: string | null
  nodeName: string | null
  vmid: number
  name: string
  status: string
}

export type VmSnapshotView = {
  name: string
  description?: string
  vmstate: boolean
  current: boolean
  parent?: string
  created: string | null
  sizeBytes?: string | number | null
  raw: any
  dbRecord?: {
    id: string
    status: string
    createdBy: string | null
    createdAt: string | null
  } | null
}

export async function listSnapshotVmCandidates(nodeId?: string): Promise<SnapshotVmOption[]> {
  const instances = await prisma.vpsInstance.findMany({
    where: {
      deletedAt: null,
      vmid: { gt: 0 },
      ...(nodeId ? { proxmoxNodeId: nodeId } : {}),
    },
    select: {
      id: true,
      customerId: true,
      proxmoxNodeId: true,
      proxmoxNode: { select: { nodeName: true, status: true } },
      vmid: true,
      name: true,
      instanceName: true,
      hostname: true,
      status: true,
    },
    orderBy: { vmid: "asc" },
  })

  return instances
    .filter((instance) => !["deleted", "provisioning_failed"].includes(instance.status))
    .map((instance) => ({
      vpsInstanceId: instance.id,
      customerId: instance.customerId,
      nodeId: instance.proxmoxNodeId,
      nodeName: instance.proxmoxNode?.nodeName || null,
      vmid: Number(instance.vmid),
      name: instance.instanceName || instance.hostname || instance.name,
      status: instance.status,
    }))
}

function normalizeUpid(payload: any): string | null {
  if (!payload) return null
  if (typeof payload === "string") return payload
  const data = payload?.data ?? payload
  if (typeof data === "string") return data
  if (typeof data?.upid === "string") return data.upid
  return null
}

async function loadSnapshotDbRecords(nodeId: string, vmid: number): Promise<Record<string, any>> {
  try {
    const rows = await prisma.vmSnapshot.findMany({
      where: { proxmoxNodeId: nodeId, vmid: Number(vmid), deletedAt: null },
      orderBy: { createdAt: "desc" },
    })
    return Object.fromEntries(rows.map((row) => [row.name, row]))
  } catch {
    return {}
  }
}

export async function listSnapshotsForVm(nodeId: string, vmid: number): Promise<VmSnapshotView[]> {
  const node = await prisma.proxmoxNode.findUnique({ where: { id: nodeId } })
  if (!node || !node.host || !node.nodeName) throw new ProxmoxError(404, "Proxmox node not found or offline")

  const client = proxmoxClientForNode(node)
  const [rawSnapshots, dbRows] = await Promise.all([
    client.getVMSnapshots(node.nodeName, Number(vmid)).catch((error: any) => {
      throw new ProxmoxError(error?.status || 502, `Failed to read snapshots: ${error?.message || "unknown error"}`)
    }),
    loadSnapshotDbRecords(nodeId, Number(vmid)),
  ])

  const views = listFrom(rawSnapshots).map((snap) => {
    const snapName = String(snap.name)
    const isLive = snapName === "current"
    const dbRow = dbRows[snapName]
    return {
      name: snapName,
      description: snap.description ? String(snap.description) : isLive ? "Live state of the server" : undefined,
      vmstate: Boolean(snap.vmstate),
      current: isLive,
      parent: snap.parent ? String(snap.parent) : undefined,
      created: snap.snaptime ? new Date((Number(snap.snaptime) || 0) * 1000).toISOString() : null,
      sizeBytes: snap.snapsize != null ? Number(snap.snapsize) : null,
      raw: snap,
      dbRecord: dbRow
        ? {
            id: String(dbRow.id),
            status: String(dbRow.status),
            createdBy: dbRow.createdBy ? String(dbRow.createdBy) : null,
            createdAt: dbRow.createdAt ? new Date(dbRow.createdAt).toISOString() : null,
          }
        : null,
    }
  })

  const hasLive = views.some((view) => view.name === "current")
  return hasLive ? views : [{ name: "current", description: "Live state of the server", vmstate: false, current: true, created: null, sizeBytes: null, raw: { name: "current" }, dbRecord: null }, ...views]
}

export type SnapshotDiskDiagnostic = {
  key: string
  storage: string
  format: string
  type: string
  snapshotCapable: boolean
}

export type SnapshotCapabilityDiagnostic = {
  vmid: number
  nodeName: string | null
  capable: boolean
  reason: string | null
  disks: SnapshotDiskDiagnostic[]
}

function capabilityFailureReason(diag: SnapshotCapabilityDiagnostic): string {
  const disk = diag.disks.find((d) => !d.snapshotCapable)
  if (disk) {
    const flavor = String(disk.type || "unknown")
    return `Snapshots are unavailable for this server because its current disk storage does not support Proxmox snapshots. VM: ${diag.vmid} · Disk storage: ${disk.storage} · Storage type: ${flavor}${disk.format ? ` · Disk format: ${disk.format}` : ""}`
  }
  return ""
}

export async function getVmStorageCapability(nodeId: string, vmid: number): Promise<SnapshotCapabilityDiagnostic> {
  const node = await prisma.proxmoxNode.findUnique({ where: { id: nodeId } })
  if (!node || !node.host || !node.nodeName) {
    return { vmid: Number(vmid), nodeName: null, capable: false, reason: "Proxmox node not found or offline", disks: [] }
  }
  const client = proxmoxClientForNode(node)
  const config: any = await client.getVMConfig(node.nodeName, Number(vmid)).catch(() => null)
  const rows: any[] = []
  try {
    const list: any = await (client as any).request(`/nodes/${encodeURIComponent(node.nodeName)}/storage`)
    rows.push(...(Array.isArray(list) ? list : list?.data || []))
  } catch {
    // storage type lookup unavailable; capability falls back to configuration
  }
  const storageTypes = new Map<string, string>(rows.map((row: any) => [String(row.storage), String(row.type || "")]))

  const disks: SnapshotDiskDiagnostic[] = []
  if (config) {
    const diskKeys = Object.keys(config).filter((key) => /^(scsi|virtio|sata|ide)\d+$/.test(key))
    for (const key of diskKeys) {
      const value = String(config[key] || "")
      if (!value || /media=cdrom|cloudinit/i.test(value)) continue
      const storage = value.split(":")[0]
      const format = (value.match(/\.(raw|qcow2|vmdk)\b/i) || [])[1]?.toLowerCase() || (storageTypes.get(storage) === "dir" ? "raw" : "raw")
      const type = storageTypes.get(storage) || ""
      disks.push({ key, storage, format, type, snapshotCapable: storageTypeIsSnapshotCapable(type, format) })
    }
  }

  const capable = disks.length > 0 && disks.every((d) => d.snapshotCapable)
  return {
    vmid: Number(vmid),
    nodeName: node.nodeName,
    capable,
    reason: capable ? null : capabilityFailureReason({ vmid: Number(vmid), nodeName: node.nodeName, capable: false, reason: null, disks }),
    disks,
  }
}

export async function snapshotSupportIssue(nodeId: string, vmid: number): Promise<string | null> {
  const diag = await getVmStorageCapability(nodeId, vmid)
  if (diag.capable) return null
  return diag.reason
}

export async function snapshotCapabilitySummary(nodeId: string, vmid: number): Promise<{ capable: boolean; reason: string | null; storage: string | null; type: string | null; format: string | null }> {
  const diag = await getVmStorageCapability(nodeId, vmid)
  const disk = diag.disks.find((d) => !d.snapshotCapable) || diag.disks[0] || null
  return {
    capable: diag.capable,
    reason: diag.capable ? null : diag.reason,
    storage: disk?.storage || null,
    type: disk?.type || null,
    format: disk?.format || null,
  }
}

export async function createVmSnapshot(input: {
  nodeId: string
  vmid: number
  name: string
  description?: string
  vmstate?: boolean
  actor?: string
}): Promise<{ snapshot: VmSnapshotView; dbId?: string }> {
  const { nodeId, vmid, name, description, vmstate = false, actor = "admin" } = input
  const safeName = String(name || "").trim()
  if (!/^[A-Za-z0-9._-]+$/.test(safeName)) throw new ProxmoxError(400, "Snapshot name may only contain letters, digits, dots, underscores and dashes")
  if (safeName === "current" || safeName === "root") throw new ProxmoxError(400, `Snapshot name "${safeName}" is reserved`)

  const node = await prisma.proxmoxNode.findUnique({ where: { id: nodeId } })
  if (!node || !node.host || !node.nodeName) throw new ProxmoxError(404, "Proxmox node not found or offline")

  const supportIssue = await snapshotSupportIssue(nodeId, Number(vmid))
  if (supportIssue) throw new ProxmoxError(409, supportIssue)

  const instance = await prisma.vpsInstance.findFirst({ where: { vmid: Number(vmid), deletedAt: null } })
  const client = proxmoxClientForNode(node)
  const existing = await listFrom(
    await client.getVMSnapshots(node.nodeName, Number(vmid)).catch(() => ({ data: [] as any[] })),
  ).some((snap) => String(snap.name) === safeName)
  if (existing) throw new ProxmoxError(409, `Snapshot "${safeName}" already exists on vmid ${vmid}`)

  const payload = await client.createVMSnapshot(node.nodeName, Number(vmid), safeName, { description: description || "ZWS admin snapshot", vmstate })
  const upid = normalizeUpid(payload)
  if (upid) {
    const task = await client.waitForTask(node.nodeName, upid, SNAPSHOT_TASK_TIMEOUT_MS).catch((error: any) => {
      throw new ProxmoxError(502, String(error?.message || "Snapshot task failed"))
    })
    if (task && task.exitstatus && String(task.exitstatus).toUpperCase() !== "OK") {
      throw new ProxmoxError(502, `Snapshot task failed: ${task.exitstatus}`)
    }
  }

  const after = await listFrom(await client.getVMSnapshots(node.nodeName, Number(vmid)).catch((error: any) => {
    throw new ProxmoxError(error?.status || 502, `Snapshot may have been created but verification failed: ${error?.message || "unknown error"}`)
  }))
  const created = after.find((snap) => String(snap.name) === safeName)
  if (!created) throw new ProxmoxError(502, "Snapshot creation did not complete on the Proxmox node")

  const dbRow = await prisma.vmSnapshot.create({
    data: {
      id: `${Number(vmid)}-${safeName}-${Date.now()}`,
      vpsInstanceId: instance?.id || `unmapped-${Number(vmid)}`,
      customerId: instance?.customerId || null,
      proxmoxNodeId: nodeId,
      vmid: Number(vmid),
      purchaseId: instance?.orderId || null,
      name: safeName,
      status: "completed",
      createdBy: actor,
      createdOnNodeAt: new Date(),
      metadata: { description: description || null, vmstate },
    },
  })

  console.log("[vm-snapshot] snapshot created", { dbId: dbRow.id, vmid: Number(vmid), name: safeName, actor, upid: upid || null })

  writeAuditLog({
    action: "vm.snapshot.created",
    customerId: dbRow.customerId,
    targetType: "vm_snapshot",
    targetId: dbRow.id,
    newValue: { vmid: Number(vmid), name: safeName, vmstate, description: description || null, upid: upid || null },
    metadata: { nodeId, actor },
  }).catch(() => null)

  return {
    snapshot: (await listSnapshotsForVm(nodeId, Number(vmid))).find((view) => view.name === safeName) as VmSnapshotView,
    dbId: dbRow.id,
  }
}

export async function deleteVmSnapshot(input: { nodeId: string; vmid: number; name: string; actor?: string }): Promise<{ deleted: boolean; verified: boolean }> {
  const { nodeId, vmid, name, actor = "admin" } = input
  const safeName = String(name || "").trim()
  if (!safeName) throw new ProxmoxError(400, "Snapshot name is required")

  const node = await prisma.proxmoxNode.findUnique({ where: { id: nodeId } })
  if (!node || !node.host || !node.nodeName) throw new ProxmoxError(404, "Proxmox node not found or offline")

  const client = proxmoxClientForNode(node)
  const before = listFrom(await client.getVMSnapshots(node.nodeName, Number(vmid)).catch(() => ({ data: [] as any[] })))
  if (!before.some((snap) => String(snap.name) === safeName)) {
    await markSnapshotDeleted(nodeId, Number(vmid), safeName, actor)
    return { deleted: true, verified: true }
  }

  const payload = await client.deleteVMSnapshot(node.nodeName, Number(vmid), safeName)
  const upid = normalizeUpid(payload)
  if (upid) await client.waitForTask(node.nodeName, upid, SNAPSHOT_TASK_TIMEOUT_MS).catch(() => null)

  const after = listFrom(await client.getVMSnapshots(node.nodeName, Number(vmid)).catch(() => ({ data: [] as any[] })))
  const verified = !after.some((snap) => String(snap.name) === safeName)
  await markSnapshotDeleted(nodeId, Number(vmid), safeName, actor)
  console.log("[vm-snapshot] snapshot deleted", { vmid: Number(vmid), name: safeName, actor, verified, upid: upid || null })

  const delInstance = await prisma.vpsInstance.findFirst({ where: { vmid: Number(vmid), deletedAt: null } })
  writeAuditLog({
    action: "vm.snapshot.deleted",
    customerId: delInstance?.customerId || null,
    targetType: "vm_snapshot",
    targetId: `${Number(vmid)}-${safeName}`,
    newValue: { vmid: Number(vmid), name: safeName, verified, upid: upid || null },
    metadata: { nodeId, actor },
  }).catch(() => null)

  return { deleted: true, verified }
}

export async function rollbackVmSnapshot(input: { nodeId: string; vmid: number; name: string; actor?: string }): Promise<{ rolledBack: boolean; taskStatus?: string }> {
  const { nodeId, vmid, name, actor = "admin" } = input
  const safeName = String(name || "").trim()
  if (!safeName) throw new ProxmoxError(400, "Snapshot name is required")

  const node = await prisma.proxmoxNode.findUnique({ where: { id: nodeId } })
  if (!node || !node.host || !node.nodeName) throw new ProxmoxError(404, "Proxmox node not found or offline")

  const client = proxmoxClientForNode(node)
  const current = listFrom(await client.getVMSnapshots(node.nodeName, Number(vmid)).catch((error: any) => {
    throw new ProxmoxError(error?.status || 502, `Failed to read snapshots: ${error?.message || "unknown error"}`)
  }))
  if (!current.some((snap) => String(snap.name) === safeName)) throw new ProxmoxError(404, `Snapshot "${safeName}" does not exist`)

  const runtimeStatus = String((await client.getVMStatus(node.nodeName, Number(vmid)).catch(() => null))?.status || "").toLowerCase()
  if (runtimeStatus !== "stopped") {
    throw new ProxmoxError(409, `VM must be stopped before rolling back (current status=${runtimeStatus || "unknown"})`)
  }

  const payload = await client.rollbackVMSnapshot(node.nodeName, Number(vmid), safeName)
  const upid = normalizeUpid(payload)
  let taskStatus: string | undefined
  if (upid) {
    const task = await client.waitForTask(node.nodeName, upid, SNAPSHOT_TASK_TIMEOUT_MS)
    taskStatus = task?.exitstatus || "OK"
  }

  await prisma.vmSnapshot
    .updateMany({
      where: { proxmoxNodeId: nodeId, vmid: Number(vmid), name: safeName },
      data: { metadata: { rolledBackAt: new Date().toISOString(), rolledBackBy: actor } },
    })
    .catch(() => null)

  const rollInstance = await prisma.vpsInstance.findFirst({ where: { vmid: Number(vmid), deletedAt: null } })
  writeAuditLog({
    action: "vm.rollback.completed",
    customerId: rollInstance?.customerId || null,
    targetType: "vm_snapshot",
    targetId: `${Number(vmid)}-${safeName}`,
    newValue: { vmid: Number(vmid), name: safeName, taskStatus: taskStatus || "OK", upid: upid || null },
    metadata: { nodeId, actor },
  }).catch(() => null)

  return { rolledBack: true, taskStatus }
}

async function markSnapshotDeleted(nodeId: string, vmid: number, name: string, actor: string) {
  await prisma.vmSnapshot
    .updateMany({
      where: { proxmoxNodeId: nodeId, vmid: Number(vmid), name },
      data: { status: "cancelled", deletedAt: new Date(), metadata: { deletedBy: actor, deletedAt: new Date().toISOString() } },
    })
    .catch(() => null)
}

export async function recordSnapshotFailure(input: { nodeId: string; vmid: number; name: string; error: string; actor?: string }) {
  await prisma.vmSnapshot
    .create({
      data: {
        id: `${Number(input.vmid)}-${input.name}-${Date.now()}`,
        vpsInstanceId: `unmapped-${Number(input.vmid)}`,
        proxmoxNodeId: input.nodeId,
        vmid: Number(input.vmid),
        name: input.name,
        status: "failed",
        createdBy: input.actor || "admin",
        metadata: { error: input.error },
      },
    })
    .catch(() => null)
}