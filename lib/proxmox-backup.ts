import { prisma } from "@/lib/db"
import { createProxmoxClient, ProxmoxError, PROXMOX_LONG_TIMEOUT_MS } from "@/lib/proxmox"
import { BACKUP_CONTENT_TYPES, describeStorageCapability, parseStorageContent } from "@/lib/proxmox/storage-capabilities"
import { listComputeNodes } from "@/lib/compute-node-monitoring"
import { writeAuditLog } from "@/lib/audit-log"
import { emitBackupLifecycleEvent } from "@/lib/notifications/backup-events"
import { rebuildBackupUsage } from "@/lib/billing/entitlements"
import { pruneBackupsToRetention } from "@/lib/backups-retention"

export type BackupVmEntry = {
  vmid: number
  name: string
  customerName?: string
}

export type BackupStorageInfo = {
  name: string
  type: string
  content: string
  supportsBackup: boolean
  totalBytes: number
  usedBytes: number
  availBytes: number
  enabled: boolean
}

export type BackupRequest = {
  policyId: string
  vmid?: number
  actor?: string
  sync?: boolean
}

export type BackupTaskResult = {
  backupId: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
  upid?: string | null
}

const BACKUP_REQUEST_ALLOWED_KEYS = new Set(["policyId", "vmid", "actor", "sync"])

export function sanitizeBackupRequest(input: unknown): { request: BackupRequest | null; dropped: string[]; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { request: null, error: "Invalid backup request payload", dropped: [] }
  const record = input as Record<string, unknown>
  const dropped = Object.keys(record).filter((key) => !BACKUP_REQUEST_ALLOWED_KEYS.has(key))
  const policyId = String(record.policyId || "").trim()
  if (!policyId) return { request: null, dropped, error: "policyId is required" }
  const rawVmid = record.vmid
  if (rawVmid != null) {
    const vmid = Number(rawVmid)
    if (!Number.isInteger(vmid) || vmid <= 0) return { request: null, dropped, error: "vmid must be a positive integer" }
  }
  const request: BackupRequest = { policyId }
  if (rawVmid != null) request.vmid = Number(rawVmid)
  if (typeof record.actor === "string" && record.actor.trim()) request.actor = record.actor.trim().slice(0, 120)
  if (typeof record.sync === "boolean") request.sync = record.sync
  return { request, dropped }
}

const BACKUP_TASK_TIMEOUT_MS = 30 * 60 * 1000

const BACKUP_TASK_STATUS_ORDER = ["queued", "running", "completed", "failed", "cancelled"]

export function normalizeBackupStatus(status: string): string {
  const value = String(status || "").toLowerCase()
  return BACKUP_TASK_STATUS_ORDER.includes(value) ? value : "queued"
}

export type RetainedBackupSelection = {
  protectedCount: number
  retained: Array<{ id: string; metadata: Record<string, unknown> }>
  toTrim: Array<{ id: string; metadata: Record<string, unknown> }>
}

export function selectRetainedBackups(
  completedBackups: Array<{ id: string; metadata: Record<string, unknown> }>,
  retention: number,
): RetainedBackupSelection {
  const keep = Math.max(0, retention || 0)
  const protectedRows = completedBackups.filter((b) => b.metadata?.isProtected === true)
  const unProtected = completedBackups.filter((b) => b.metadata?.isProtected !== true)
  const retainedUnProtected = unProtected.slice(0, keep)
  const toTrim = unProtected.slice(keep)
  return {
    protectedCount: protectedRows.length,
    retained: [...protectedRows, ...retainedUnProtected],
    toTrim,
  }
}

function proxmoxClientForNode(node: { host: string; tokenId: string; tokenSecret: string; allowInsecureTls: boolean }) {
  if (!node.host) throw new ProxmoxError(404, "Node has no host configured")
  return createProxmoxClient(node.host, node.tokenId, node.tokenSecret, {
    allowInsecureTls: node.allowInsecureTls,
    timeoutMs: PROXMOX_LONG_TIMEOUT_MS,
  })
}

/**
 * Whether a storage can hold backups.
 *
 * Proxmox has two distinct backup content types and they are not
 * interchangeable: `vzdump` is an ordinary storage that receives `.tar.zst`
 * archives written by `POST /nodes/{node}/vzdump`, and `backup` is a Proxmox
 * Backup Server datastore written over the PBS protocol.
 *
 * This used to accept only `backup`, while the node-level capability diagnostic
 * accepted `backup` *or* `vzdump`. The result was a node card that advertised a
 * working backup target which then vanished from the backup picker, because the
 * most common backup storage in the world — a directory or NFS share with
 * `content=images,vzdump` — matched one check and not the other. Both call sites
 * now go through the one rule.
 */
function isBackupCapable(content?: string | string[]): boolean {
  const parsed = parseStorageContent(content)
  return parsed.some((entry) => BACKUP_CONTENT_TYPES.includes(entry))
}

function numberFromBytes(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export async function discoverBackupStorages(nodeId: string): Promise<BackupStorageInfo[]> {
  const node = await prisma.proxmoxNode.findUnique({ where: { id: nodeId } })
  if (!node || !node.host || !node.nodeName) throw new ProxmoxError(404, "Proxmox node not found or offline")

  const client = proxmoxClientForNode(node)
  const [live, dbPools] = await Promise.all([
    client.getNodeStorage(node.nodeName).catch(() => []),
    prisma.nodeStoragePoolConfig.findMany({ where: { proxmoxNodeId: nodeId } }),
  ])

  const byId = new Map(dbPools.map((p) => [p.storageId, p]))
  const rows = Array.isArray(live) ? live : Array.isArray((live as any)?.data) ? (live as any).data : []

  // The verdict comes from the shared capability descriptor, so "backup-capable"
  // means the same thing here as it does on the node card. Previously this only
  // looked at the content string: a storage that Proxmox reports as `active: 0`
  // — unmounted, or simply not reachable from this node — was still handed to the
  // backup scheduler as a target, and the backup failed at run time rather than
  // at selection time.
  return rows
    .map((row: any) => {
      const capability = describeStorageCapability(row)
      const pool = byId.get(String(row.storage))
      const totalBytes = numberFromBytes(row.total)
      const usedBytes = numberFromBytes(row.used)
      const availBytes = numberFromBytes(row.avail)
      return {
        name: String(row.storage),
        type: String(row.type || ""),
        content: String(row.content || ""),
        // Requires the content type *and* a storage Proxmox says is usable.
        supportsBackup: capability.supportsBackups,
        totalBytes,
        usedBytes,
        availBytes,
        // The panel's own override still wins over the Proxmox view when an
        // administrator has deliberately disabled a pool here.
        enabled: pool ? pool.enabled !== false : true,
      }
    })
    .filter((row: BackupStorageInfo) => row.supportsBackup)
}

export async function listPolicyBackupTargets(policyId: string): Promise<BackupVmEntry[]> {
  const policy = await prisma.vmBackupPolicy.findUnique({ where: { id: policyId } })
  if (!policy) return []
  const ids = Array.isArray(policy.includeVms) ? policy.includeVms.map((v) => Number(v)) : []
  if (ids.length === 0) return []

  const instances = await prisma.vpsInstance.findMany({
    where: { vmid: { in: ids }, deletedAt: null },
    include: { customer: { select: { name: true } } },
  })

  return instances
    .map((inst) => ({
      vmid: Number(inst.vmid),
      name: inst.instanceName || inst.hostname || inst.name || `VM-${inst.vmid}`,
      customerName: inst.customer?.name || undefined,
    }))
}

export async function recoverStaleVmBackups(maxAgeMinutes = 45, actor = "vm-backup-scheduler"): Promise<number> {
  const stale = await prisma.vmBackup.findMany({
    where: {
      status: { in: ["queued", "running"] },
      updatedAt: { lt: new Date(Date.now() - maxAgeMinutes * 60 * 1000) },
    },
  })
  await Promise.all(
    stale.map((b) =>
      prisma.vmBackup.update({
        where: { id: b.id },
        data: {
          status: "failed",
          completedAt: b.completedAt || new Date(),
          metadata: { ...(b.metadata as Record<string, unknown>), stale: true, recoveredBy: actor },
        },
      }),
    ),
  )
  return stale.length
}

function normalizeUpid(payload: any): string | null {
  if (!payload) return null
  if (typeof payload === "string") return payload
  const data = payload?.data ?? payload
  if (typeof data === "string") return data
  if (typeof data?.upid === "string") return data.upid
  if (typeof payload?.upid === "string") return payload.upid
  return null
}

export async function runVmBackupTask(input: {
  policyId: string
  vmid: number
  actor?: string
  quiet?: boolean
}): Promise<{ backupId: string; status: string } | null> {
  const { policyId, vmid, actor = "vm-backup-scheduler", quiet = false } = input
  const policy = await prisma.vmBackupPolicy.findUnique({ where: { id: policyId } })
  if (!policy) {
    console.error(`[vm-backup] policy ${policyId} not found`)
    return null
  }
  if (!policy.isEnabled && actor !== "system-admin") return null

  const node = policy.nodeId ? await prisma.proxmoxNode.findUnique({ where: { id: policy.nodeId } }) : null
  const host = node && node.host && node.nodeName ? node : undefined

  const instance = await prisma.vpsInstance.findFirst({ where: { vmid: Number(vmid), deletedAt: null } })
  const row = await prisma.vmBackup.create({
    data: {
      id: `${Number(vmid)}-${policy.id}-${Date.now()}`,
      vpsInstanceId: instance?.id || `unmapped-${Number(vmid)}`,
      customerId: instance?.customerId || null,
      proxmoxNodeId: policy.nodeId || null,
      vmid: Number(vmid),
      purchaseId: instance?.orderId || null,
      schedule: policy.id,
      destination: policy.storage,
      status: "queued",
      startedAt: new Date(),
      metadata: { policyName: policy.name, mode: policy.mode, compress: policy.compress || null, actor, apiVersion: 2 },
    },
  })

  console.log("[vm-backup] backup started", { backupId: row.id, policyId, vmid: Number(vmid), storage: policy.storage, actor, mode: policy.mode })

  if (!host) {
    await prisma.vmBackup.update({ where: { id: row.id }, data: { status: "failed", completedAt: new Date(), metadata: { ...(row.metadata as Record<string, unknown>), error: "no resolvable node" } } }).catch(() => null)
    return { backupId: row.id, status: "failed" }
  }

  const client = proxmoxClientForNode(host)
  try {
    const payload = await client.createVmBackup(host.nodeName, Number(vmid), {
      storage: policy.storage,
      mode: (policy.mode as any) || "snapshot",
      ...(policy.compress ? { compress: policy.compress as any } : {}),
      notesTemplate: `zws-policy:${policy.id}`,
    })
    const upid = normalizeUpid(payload)
    if (!upid) {
      console.error("[vm-backup] vzdump returned no UPID", JSON.stringify(payload).slice(0, 500))
      throw new ProxmoxError(502, "Proxmox vzdump returned no UPID")
    }

    await prisma.vmBackup.update({
      where: { id: row.id },
      data: { status: "running", metadata: { ...(row.metadata as Record<string, unknown>), upid } },
    })

    console.log("[vm-backup] task created", { backupId: row.id, vmid: Number(vmid), upid })

    let task: any
    try {
      task = await client.waitForTask(host.nodeName, upid, BACKUP_TASK_TIMEOUT_MS)
      console.log("[vm-backup] task polling done", { backupId: row.id, upid, exitstatus: task?.exitstatus })
    } catch (error: any) {
      if (error instanceof ProxmoxError && error.status === 504) {
        await prisma.vmBackup.update({
          where: { id: row.id },
          data: { status: "failed", completedAt: new Date(), metadata: { ...(row.metadata as Record<string, unknown>), error: "task timed out" } },
        }).catch(() => null)
        console.error("[vm-backup] task timed out", { backupId: row.id, vmid: Number(vmid), upid })
        return { backupId: row.id, status: "failed" }
      }
      throw error
    }

    const found = await findBackupVolid(client, host.nodeName, policy.storage, Number(vmid))

    // Verification stage runs only when the task reported success. The row is
    // only marked COMPLETED after the artifact is confirmed on storage.
    let verification: BackupVerification | null = null
    let verifiedFound: { volid: string | null; sizeBytes: number } | null = null
    if (task && String(task?.exitstatus || "").toLowerCase() === "ok") {
      const result = await verifyCompletedBackup({ client, nodeName: host.nodeName, storage: policy.storage, vmid: Number(vmid), startedAt: row.startedAt, retries: 2 })
      verification = result.verification
      verifiedFound = result.found
      const hardFail = verification.passed === false && (verification.reason === "archive_not_found" || verification.reason === "stale_volume_only")
      if (hardFail) {
        const message = `Backup task reported success but verification failed: archive not found on storage ${policy.storage}`
        await prisma.vmBackup.update({
          where: { id: row.id },
          data: { status: "failed", completedAt: new Date(), metadata: { ...(row.metadata as Record<string, unknown>), error: message, exitStatus: task?.exitstatus || "OK", verification } },
        }).catch(() => null)
        writeAuditLog({
          action: "vm.backup.failed",
          customerId: row.customerId,
          targetType: "vm_backup",
          targetId: row.id,
          newValue: { vmid: Number(vmid), storage: policy.storage, upid, error: message },
          metadata: { policyId: policy.id, policyName: policy.name, actor },
        }).catch(() => null)
        if (row.customerId) {
          void emitBackupLifecycleEvent({
            backupId: row.id,
            outcome: "failed",
            vmid: Number(vmid),
            vpsInstanceId: instance?.id || row.vpsInstanceId,
            customerId: row.customerId,
            schedule: policy.id,
            destination: policy.storage,
            completedAt: new Date(),
            errorReason: message,
          }).catch(() => null)
        }
        return { backupId: row.id, status: "failed" }
      }
    }

    await prisma.vmBackup.update({
      where: { id: row.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        backupPath: (verifiedFound?.volid || found?.volid) || undefined,
        sizeBytes: (verifiedFound?.sizeBytes && verifiedFound.sizeBytes > 0 ? BigInt(Math.round(verifiedFound.sizeBytes)) : typeof found?.sizeBytes === "number" && found.sizeBytes > 0 ? BigInt(Math.round(found.sizeBytes)) : undefined) || undefined,
        metadata: { ...(row.metadata as Record<string, unknown>), volid: (verifiedFound?.volid || found?.volid) || null, exitStatus: task?.exitstatus || "OK", verification },
      },
    })

    console.log("[vm-backup] backup completed", {
      backupId: row.id,
      vmid: Number(vmid),
      storage: policy.storage,
      upid,
      volid: (verifiedFound?.volid || found?.volid) || null,
      sizeBytes: (verifiedFound?.sizeBytes || found?.sizeBytes) || 0,
      startedAt: row.startedAt?.toISOString() || null,
      finishedAt: new Date().toISOString(),
      verified: verification?.passed === true || (!verification && typeof found?.volid === "string"),
    })

    if (policy.retention > 0) {
      const retention = await enforceVmBackupRetention(policyId, Number(vmid)).catch((e) => {
        console.error(`[vm-backup] retention failed: ${e?.message}`)
        return null
      })
      if (retention) console.log("[vm-backup] retention enforced", { backupId: row.id, policyId, vmid: Number(vmid), deleted: retention.deleted, kept: retention.kept })
    }

    // Per-policy retention is scoped to one (schedule, vmid) pair. The limit the
    // customer actually bought is scoped to the whole account, and usage is
    // counted account-wide, so without this second pass an account with several
    // VMs accumulates retention x VM-count backups and is then permanently
    // blocked by a maxBackups check it can never get back under.
    if (row.customerId) {
      const accountRetention = await pruneBackupsToRetention(row.customerId).catch((e) => {
        console.error(`[vm-backup] account retention failed: ${e?.message}`)
        return null
      })
      if (accountRetention) {
        console.log("[vm-backup] account retention enforced", {
          backupId: row.id,
          customerId: row.customerId,
          limit: accountRetention.limit,
          pruned: accountRetention.pruned.length,
          unpruned: accountRetention.unpruned,
          kept: accountRetention.keptCount,
        })
      }
    }

    writeAuditLog({
      action: "vm.backup.completed",
      customerId: row.customerId,
      targetType: "vm_backup",
      targetId: row.id,
      newValue: { vmid: Number(vmid), storage: policy.storage, upid, sizeBytes: found?.sizeBytes || 0 },
      metadata: { policyId: policy.id, policyName: policy.name, actor },
    }).catch(() => null)

    if (row.customerId) {
      void emitBackupLifecycleEvent({
        backupId: row.id,
        outcome: "completed",
        vmid: Number(vmid),
        vpsInstanceId: instance?.id || row.vpsInstanceId,
        customerId: row.customerId,
        schedule: policy.id,
        destination: policy.storage,
        sizeBytes: verifiedFound?.sizeBytes || found?.sizeBytes || null,
        completedAt: new Date(),
        verification,
      }).catch(() => null)
    }

    return { backupId: row.id, status: "completed" }
  } catch (error: any) {
    const message = error?.message || "unknown failure"
    await prisma.vmBackup.update({
      where: { id: row.id },
      data: { status: "failed", completedAt: new Date(), metadata: { ...(row.metadata as Record<string, unknown>), error: message } },
    }).catch(() => null)
    console.error("[vm-backup] backup failed", { backupId: row.id, vmid: Number(vmid), storage: policy.storage, error: message })

    writeAuditLog({
      action: "vm.backup.failed",
      customerId: row.customerId,
      targetType: "vm_backup",
      targetId: row.id,
      newValue: { vmid: Number(vmid), storage: policy.storage, error: message },
      metadata: { policyId: policy.id, policyName: policy.name, actor },
    }).catch(() => null)

    if (row.customerId) {
      void emitBackupLifecycleEvent({
        backupId: row.id,
        outcome: "failed",
        vmid: Number(vmid),
        vpsInstanceId: instance?.id || row.vpsInstanceId,
        customerId: row.customerId,
        schedule: policy.id,
        destination: policy.storage,
        errorReason: message,
      }).catch(() => null)
    }

    if (!quiet) throw error
    return { backupId: row.id, status: "failed" }
  }
}

async function findBackupVolid(client: any, nodeName: string, storage: string, vmid: number): Promise<{ volid: string | null; sizeBytes: number } | null> {
  try {
    const items = await client.listVmBackups(nodeName, storage, { vmid })
    const list = Array.isArray(items) ? items : Array.isArray(items?.data) ? items.data : []
    const recent = list
      .filter((i: any) => String(i.vmid || "") === String(vmid))
      .sort((a: any, b: any) => (Number(b.ctime || 0) || 0) - (Number(a.ctime || 0) || 0))
    const first = recent[0]
    if (!first) return { volid: null, sizeBytes: 0 }
    return { volid: first.volid ? String(first.volid) : null, sizeBytes: numberFromBytes(first.size) }
  } catch {
    return { volid: null, sizeBytes: 0 }
  }
}

/**
 * Storage lookup that distinguishes "listing error" from "no matching archive",
 * so the verification stage can tell a real absence from a transient API failure.
 */
async function findBackupVolidStrict(
  client: any,
  nodeName: string,
  storage: string,
  vmid: number,
  startedAt?: Date | null,
): Promise<
  | { ok: true; found: { volid: string | null; sizeBytes: number; ctime: number | null } | null }
  | { ok: false; found: null; error: string }
> {
  try {
    const items = await client.listVmBackups(nodeName, storage, { vmid })
    const list = Array.isArray(items) ? items : Array.isArray(items?.data) ? items.data : []
    const filtered = list.filter((i: any) => String(i.vmid || "") === String(vmid))
    const found =
      filtered.length > 0
        ? filtered
            .map((i: any) => ({
              volid: i.volid ? String(i.volid) : null,
              sizeBytes: numberFromBytes(i.size),
              ctime: Number(i.ctime || 0) || null,
            }))
            .sort((a: any, b: any) => (b.ctime || 0) - (a.ctime || 0))[0]
        : null
    return { ok: true, found }
  } catch (error: any) {
    return { ok: false, found: null, error: error?.message || "storage list failed" }
  }
}

export type BackupVerification = {
  passed: boolean
  reason?: string | null
  volid?: string | null
  sizeBytes?: number
  storage?: string | null
  verifiedAt?: string
  checks?: Record<string, boolean>
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Verification stage, run only after the Proxmox task reports a successful
 * terminal state. Confirms the archive exists on the backup storage for the
 * right VMID, was created after the backup started, and has a non-zero size.
 *
 * Distinguishes outcomes so the caller can decide completed vs failed:
 *  - archive_not_found / stale_volume_only  -> genuine inconsistency, fail
 *  - storage_list_unavailable / size_unavailable -> cannot confirm, keep task
 *     outcome but mark unverified (no completion notification)
 */
async function verifyCompletedBackup(input: {
  client: any
  nodeName: string
  storage: string
  vmid: number
  startedAt?: Date | null
  retries?: number
}): Promise<{ verification: BackupVerification; found: { volid: string | null; sizeBytes: number } | null }> {
  const { client, nodeName, storage, vmid, startedAt = null, retries = 3 } = input
  for (let attempt = 1; attempt <= Math.max(1, retries); attempt++) {
    const result = await findBackupVolidStrict(client, nodeName, storage, vmid, startedAt)
    if (!result.ok) {
      if (attempt < retries) {
        await sleep(5000)
        continue
      }
      const reason = "storage_list_unavailable"
      return {
        verification: { passed: false, reason, storage, verifiedAt: new Date().toISOString(), checks: { volumeExists: false, storageListed: false } },
        found: null,
      }
    }

    const found = result.found
    if (!found || !found.volid) {
      if (attempt < retries) {
        await sleep(5000)
        continue
      }
      const reason = "archive_not_found"
      return {
        verification: { passed: false, reason, storage, verifiedAt: new Date().toISOString(), checks: { volumeExists: false, storageListed: true } },
        found: null,
      }
    }

    // The archive must postdate the backup start (a previous backup for the
    // same VMID must not be mistaken for this run).
    if (startedAt && found.ctime) {
      const startedMs = new Date(startedAt).getTime()
      const backupMs = Number(found.ctime) * 1000
      const recent = Number.isFinite(startedMs) && backupMs >= startedMs - 120_000
      if (!recent) {
        if (attempt < retries) {
          await sleep(5000)
          continue
        }
        return {
          verification: { passed: false, reason: "stale_volume_only", storage, verifiedAt: new Date().toISOString(), checks: { volumeExists: false, timestampValid: false, storageListed: true } },
          found: { volid: found.volid, sizeBytes: found.sizeBytes },
        }
      }
    }

    const sizeAvailable = found.sizeBytes > 0
    if (!sizeAvailable) {
      return {
        verification: { passed: false, reason: "size_unavailable", volid: found.volid, sizeBytes: 0, storage, verifiedAt: new Date().toISOString(), checks: { volumeExists: true, sizeAvailable: false, timestampValid: true, storageListed: true } },
        found: { volid: found.volid, sizeBytes: 0 },
      }
    }

    return {
      verification: {
        passed: true,
        reason: null,
        volid: found.volid,
        sizeBytes: found.sizeBytes,
        storage,
        verifiedAt: new Date().toISOString(),
        checks: { volumeExists: true, sizeAvailable: true, timestampValid: true, storageListed: true },
      },
      found: { volid: found.volid, sizeBytes: found.sizeBytes },
    }
  }

  // Unreachable (loop returns), but keeps the type checker honest.
  return {
    verification: { passed: false, reason: "storage_list_unavailable", storage, verifiedAt: new Date().toISOString() },
    found: null,
  }
}

export async function enforceVmBackupRetention(policyId: string, vmid: number, limit = -1): Promise<{ deleted: string[]; kept: number }> {
  const policy = await prisma.vmBackupPolicy.findUnique({ where: { id: policyId } })
  if (!policy) return { deleted: [], kept: 0 }
  const retention = limit >= 0 ? limit : Math.max(0, policy.retention || 5)
  const node = policy.nodeId ? await prisma.proxmoxNode.findUnique({ where: { id: policy.nodeId } }) : null
  if (!node || !node.nodeName || !node.host) return { deleted: [], kept: 0 }

  const backups = await prisma.vmBackup.findMany({
    where: { schedule: policyId, vmid: Number(vmid), status: "completed" },
    orderBy: { completedAt: "desc" },
  })

  const selection = selectRetainedBackups(backups.map((b) => ({ id: b.id, metadata: (b.metadata as Record<string, unknown>) || {} })), retention)
  const trimIds = new Set(selection.toTrim.map((b) => b.id))
  const candidates = backups.filter((b) => trimIds.has(b.id))

  const client = proxmoxClientForNode(node)
  let existing: Set<string> | null = null
  try {
    const live = await client.listVmBackups(node.nodeName, policy.storage, { vmid: Number(vmid) })
    const list = Array.isArray(live) ? (live as any[]) : Array.isArray((live as any)?.data) ? (live as any).data : []
    existing = new Set(list.map((i: any) => String(i.volid || "")))
  } catch (error: any) {
    // The listing is only an optimisation: it lets us skip rows whose archive is
    // already gone so we do not error on a 404. It must never become a reason
    // to prune nothing. Previously a failed listing left an empty set, every
    // candidate then looked "not on storage", every candidate was skipped, and
    // retention silently did nothing while still reporting success.
    existing = null
    console.error("[vm-backup] could not list existing archives; pruning by volid alone", { policyId, vmid: Number(vmid), error: error?.message })
  }

  const deleted: string[] = []
  for (const backup of candidates) {
    const volid = backup.backupPath || (backup.metadata as Record<string, unknown>)?.volid
    // Only trust the "already gone" shortcut when the listing actually worked.
    if (existing && volid && !existing.has(String(volid))) continue
    try {
      if (volid) await client.deleteVmBackup(node.nodeName, policy.storage, String(volid))
      await prisma.vmBackup.update({
        where: { id: backup.id },
        data: { status: "cancelled", completedAt: new Date(), metadata: { ...(backup.metadata as Record<string, unknown>), deletedByRetention: true } },
      })
      deleted.push(backup.id)
    } catch (error: any) {
      console.error(`[vm-backup] retention delete failed for ${backup.id}: ${error?.message}`)
    }
  }
  // `kept` is the number of completed backups this policy still holds for the
  // VM. The previous expression added the protected count to the post-delete
  // total, which double-counted every protected backup.
  return { deleted, kept: Math.max(0, backups.length - deleted.length) }
}

export async function listBackupHistory(policyId?: string, vmid?: number, limit = 200): Promise<unknown[]> {
  const rows = await prisma.vmBackup.findMany({
    where: {
      ...(policyId ? { schedule: policyId } : {}),
      ...(vmid ? { vmid: Number(vmid) } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(limit, 500)),
  })

  const instanceIds = [...new Set(rows.map((row) => row.vpsInstanceId))]
  const instances = await prisma.vpsInstance.findMany({
    where: { id: { in: instanceIds } },
    select: { id: true, name: true, instanceName: true, hostname: true },
  })
  const byId = new Map(instances.map((instance) => [instance.id, instance]))

  return rows.map((row) => ({
    id: row.id,
    vmid: row.vmid,
    vpsInstanceId: row.vpsInstanceId,
    customerId: row.customerId,
    schedule: row.schedule,
    status: row.status,
    destination: row.destination,
    backupPath: row.backupPath,
    sizeBytes: row.sizeBytes ? String(row.sizeBytes) : null,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    metadata: row.metadata,
    vmName: (() => {
      const instance = byId.get(row.vpsInstanceId)
      return instance ? instance.instanceName || instance.name || instance.hostname || null : null
    })(),
  }))
}

export async function getPrimaryMonitoringNodeId(): Promise<string | null> {
  const nodes = await listComputeNodes().catch(() => [])
  const healthy = nodes.find((n) => n.status !== "offline")
  return healthy?.node?.id || null
}

export type BackupTargetInstance = {
  policy: { id: string; storage: string; mode: string; compress: string | null; retention: number; scheduleMinutes: number; name: string; isEnabled: boolean; nextRunAt: Date | null; lastRunAt: Date | null } | null
  nodeId: string
  storage: string
}

/**
 * Resolve the backup target (node + storage pool) for a customer-owned VPS.
 * Prefers an enabled backup policy on the VM's node; falls back to the node's
 * default backup storage pool.
 */
export async function resolveBackupTargetForInstance(input: { nodeId: string | null; vmid: number }): Promise<BackupTargetInstance | null> {
  if (!input.nodeId) return null

  const policy = await prisma.vmBackupPolicy.findFirst({
    where: { nodeId: input.nodeId, isEnabled: true },
    orderBy: { updatedAt: "desc" },
  })

  if (policy) {
    return {
      policy: {
        id: policy.id,
        storage: policy.storage,
        mode: policy.mode || "snapshot",
        compress: policy.compress || null,
        retention: policy.retention ?? 5,
        scheduleMinutes: policy.scheduleMinutes ?? 60,
        name: policy.name,
        isEnabled: policy.isEnabled,
        nextRunAt: policy.nextRunAt,
        lastRunAt: policy.lastRunAt,
      },
      nodeId: input.nodeId,
      storage: policy.storage,
    }
  }

  const pool = await prisma.nodeStoragePoolConfig.findFirst({
    where: { proxmoxNodeId: input.nodeId, defaultForBackup: true, enabled: true },
  })
  if (pool?.storageId) {
    return { policy: null, nodeId: input.nodeId, storage: pool.storageId }
  }

  return null
}

export type StartedVmBackup = {
  backupId: string
  upid: string
  nodeName: string
  nodeId: string
  storage: string
  storageConfig: { totalBytes: number; usedBytes: number; freeBytes: number } | null
}

/**
 * Start a backup immediately (fire-and-forget):
 * creates the VmBackup row, calls vzdump on the node, and returns the UPID
 * without waiting for completion. Consumers poll `finalizeBackupFromTask`.
 */
export async function startVmBackupDirect(input: {
  nodeId: string
  vmid: number
  vpsInstanceId: string
  customerId?: string | null
  storage: string
  policyId?: string | null
  mode?: string
  compress?: string | null
  actor?: string
}): Promise<StartedVmBackup> {
  const { nodeId, vmid, vpsInstanceId, customerId = null, storage, policyId = null, mode = "snapshot", compress = null, actor = "client" } = input

  const node = await prisma.proxmoxNode.findUnique({ where: { id: nodeId } })
  if (!node || !node.host || !node.nodeName) throw new ProxmoxError(404, "Proxmox node not found or offline")

  const policy = policyId ? await prisma.vmBackupPolicy.findUnique({ where: { id: policyId } }) : null
  const row = await prisma.vmBackup.create({
    data: {
      id: `${Number(vmid)}-${policy?.id || "manual"}-${Date.now()}`,
      vpsInstanceId,
      customerId,
      proxmoxNodeId: node.id,
      vmid: Number(vmid),
      purchaseId: null,
      schedule: policy?.id || null,
      destination: storage,
      status: "queued",
      startedAt: new Date(),
      metadata: { policyName: policy?.name || "Manual backup", mode, compress, actor, apiVersion: 2 },
    },
  })

  const client = proxmoxClientForNode(node)
  const payload = await client.createVmBackup(node.nodeName, Number(vmid), {
    storage,
    mode: (mode as any) || "snapshot",
    ...(compress ? { compress: compress as any } : {}),
    notesTemplate: policyId ? `zws-policy:${policyId}` : `zws-manual:${row.id}`,
  })
  const upid = normalizeUpid(payload)
  if (!upid) {
    await prisma.vmBackup.update({ where: { id: row.id }, data: { status: "failed", completedAt: new Date(), metadata: { ...(row.metadata as Record<string, unknown>), error: "vzdump returned no UPID" } } }).catch(() => null)
    throw new ProxmoxError(502, "Proxmox vzdump returned no UPID")
  }

  await prisma.vmBackup.update({ where: { id: row.id }, data: { status: "running", metadata: { ...(row.metadata as Record<string, unknown>), upid } } })

  const storageStatus = await client.getStorageStatus(node.nodeName, storage).catch(() => null)
  const storageConfig: StartedVmBackup["storageConfig"] = storageStatus
    ? {
        totalBytes: Number(storageStatus.total || 0),
        usedBytes: Number(storageStatus.used || 0),
        freeBytes: Number(storageStatus.avail || 0),
      }
    : null

  console.log("[vm-backup] direct backup started", { backupId: row.id, vmid: Number(vmid), storage, upid, actor })
  return { backupId: row.id, upid, nodeName: node.nodeName, nodeId: node.id, storage, storageConfig }
}

// Concurrent callers (browser polling + scheduler reconcile) must not run
// duplicate verification or duplicate terminal writes for the same backup.
const finalizeInflight = new Map<string, Promise<{ status: "running" | "queued" | "completed" | "failed" | "cancelled"; percent?: number | null; phase?: string | null; verification?: BackupVerification | null; justFinalized?: boolean }>>()

export async function finalizeBackupFromTask(
  backupId: string,
): Promise<{
  status: "running" | "queued" | "completed" | "failed" | "cancelled"
  percent?: number | null
  phase?: string | null
  verification?: BackupVerification | null
  justFinalized?: boolean
}> {
  const existing = finalizeInflight.get(backupId)
  if (existing) return existing
  const promise = runFinalizeBackupFromTask(backupId).finally(() => finalizeInflight.delete(backupId))
  finalizeInflight.set(backupId, promise)
  return promise
}

/**
 * Poll the DB row's UPID against Proxmox. If the task reached a terminal state,
 * finalize the row: verification stage -> status/size/volid, retention, audit
 * log, and (fire-and-forget) lifecycle notifications. The final Proxmox task
 * status is authoritative for the row status; the verification stage gates
 * notifications and can surface genuine inconsistencies as failures.
 */
async function runFinalizeBackupFromTask(
  backupId: string,
): Promise<{
  status: "running" | "queued" | "completed" | "failed" | "cancelled"
  percent?: number | null
  phase?: string | null
  verification?: BackupVerification | null
  justFinalized?: boolean
}> {
  const row = await prisma.vmBackup.findUnique({ where: { id: backupId } })
  if (!row) throw new ProxmoxError(404, "Backup not found")
  if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
    const verification = ((row.metadata as Record<string, unknown>).verification || null) as BackupVerification | null
    return {
      status: row.status as any,
      percent: row.status === "completed" ? 100 : null,
      phase: row.status === "completed" ? "Backup completed" : row.status === "failed" ? "Backup failed" : "Backup cancelled",
      verification,
    }
  }

  const upid = typeof (row.metadata as Record<string, unknown>)?.upid === "string" ? (row.metadata as Record<string, unknown>).upid as string : null
  if (!upid) return { status: "queued" }

  const node = row.proxmoxNodeId ? await prisma.proxmoxNode.findUnique({ where: { id: row.proxmoxNodeId } }) : null
  if (!node || !node.host || !node.nodeName) {
    await prisma.vmBackup.update({ where: { id: row.id }, data: { status: "failed", completedAt: new Date(), metadata: { ...(row.metadata as Record<string, unknown>), error: "node unreachable" } } }).catch(() => null)
    return { status: "failed", percent: null, phase: "Backup failed", justFinalized: true }
  }

  const client = proxmoxClientForNode(node)
  const status = await client.getTaskStatus(node.nodeName, upid).catch(() => null)
  const taskStatus = String(status?.status || "").toLowerCase()
  const exitStatus = String(status?.exitstatus || "").toLowerCase() || null
  const terminal = taskStatus === "stopped" || Boolean(exitStatus)

  if (!terminal) {
    // Live progress is fetched separately (snapshotTaskProgress) by consumers;
    // do not issue a second task-log request per poll.
    return { status: "running", percent: null, phase: (row.metadata as Record<string, unknown>).phase as string | null | undefined }
  }

  const failed = exitStatus !== null && exitStatus.toLowerCase() !== "ok"
  const storage = (row.destination as string) || ""
  const vmid = Number(row.vmid) || 0

  let verification: BackupVerification | null = null
  let found: { volid: string | null; sizeBytes: number } | null = null

  if (failed) {
    verification = { passed: false, reason: "task_failed", storage, verifiedAt: new Date().toISOString(), checks: { taskExitOk: false } }
  } else {
    const result = await verifyCompletedBackup({ client, nodeName: node.nodeName, storage, vmid, startedAt: row.startedAt })
    verification = result.verification
    found = result.found
  }

  // Verification failure modes that mean the artifact really is not there:
  // the task said OK but the archive is missing or only an old archive exists.
  const verificationHardFail = !failed && verification.passed === false && (verification.reason === "archive_not_found" || verification.reason === "stale_volume_only")
  const finalFailed = failed || verificationHardFail

  // Absence of the archive is a real failure — surface it honestly.
  const errorMessage =
    verificationHardFail
      ? `Backup task reported success but verification failed: archive not found on storage ${storage}`
      : failed
        ? `Task failed with status: ${exitStatus}`
        : null

  await prisma.vmBackup.update({
    where: { id: row.id },
    data: finalFailed
      ? {
          status: "failed",
          completedAt: new Date(),
          sizeBytes: found?.sizeBytes && found.sizeBytes > 0 ? BigInt(Math.round(found.sizeBytes)) : row.sizeBytes,
          backupPath: found?.volid ? String(found.volid) : row.backupPath,
          metadata: { ...(row.metadata as Record<string, unknown>), error: errorMessage, exitStatus: exitStatus || "ERROR", verification },
        }
      : {
          status: "completed",
          completedAt: new Date(),
          backupPath: found?.volid ? String(found.volid) : verification?.volid ? String(verification.volid) : row.backupPath,
          sizeBytes: (found?.sizeBytes && found.sizeBytes > 0 ? BigInt(Math.round(found.sizeBytes)) : verification?.sizeBytes && verification.sizeBytes > 0 ? BigInt(Math.round(verification.sizeBytes)) : null) ?? row.sizeBytes,
          metadata: { ...(row.metadata as Record<string, unknown>), volid: found?.volid || verification?.volid || null, exitStatus: exitStatus || "OK", verification },
        },
  })

  writeAuditLog({
    action: finalFailed ? "vm.backup.failed" : "vm.backup.completed",
    customerId: row.customerId,
    targetType: "vm_backup",
    targetId: row.id,
    newValue: {
      vmid,
      storage,
      upid,
      sizeBytes: found?.sizeBytes || (verification?.sizeBytes ?? 0) || 0,
      error: errorMessage,
      verification: verification ? { passed: verification.passed, reason: verification.reason } : null,
    },
    metadata: { policyId: row.schedule || null, actor: (row.metadata as Record<string, unknown>)?.actor || "client" },
  }).catch(() => null)

  // Fire-and-forget lifecycle notifications — only after the terminal state is
  // persisted. Emitting is async and must never block the caller or change the
  // backup row.
  if (row.customerId) {
    void emitBackupLifecycleEvent({
      backupId: row.id,
      outcome: finalFailed ? "failed" : "completed",
      vmid,
      vpsInstanceId: row.vpsInstanceId,
      customerId: row.customerId,
      schedule: row.schedule || null,
      destination: storage,
      sizeBytes: (found?.sizeBytes || (verification?.sizeBytes ?? 0)) || null,
      completedAt: new Date(),
      errorReason: errorMessage,
      verification,
    }).catch((error: any) => console.error("[vm-backup] notification emit failed", { backupId: row.id, error: error?.message || String(error) }))
  }

  if (!finalFailed && row.schedule) {
    const retention = await enforceVmBackupRetention(row.schedule, vmid).catch(() => null)
    if (retention) console.log("[vm-backup] retention enforced", { backupId: row.id, deleted: retention.deleted, kept: retention.kept })
  }

  // Part 8.1: refresh the persisted usage snapshot (and materialize overage)
  // immediately after successful verification so history / plan quota / billing
  // display reconciled numbers. Asynchronous and never affects backup state.
  if (!finalFailed && row.customerId) {
    void rebuildBackupUsage({ customerId: row.customerId, persist: true })
      .then((results) => {
        const result = results?.[0]
        if (result?.corrected) {
          console.log("[vm-backup] backup usage reconciled after completion", {
            backupId: row.id,
            customerId: row.customerId,
            beforeCount: result.before.backupCount,
            beforeBytes: result.before.usedBytes.toString(),
            afterCount: result.after.backupCount,
            afterBytes: result.after.usedBytes.toString(),
          })
        }
      })
      .catch((error: any) => console.error("[vm-backup] backup usage rebuild failed", { backupId: row.id, error: error?.message || String(error) }))
  }

  if (finalFailed) {
    console.error("[vm-backup] backup failed", { backupId: row.id, vmid, storage, upid, error: errorMessage, verification: verification ? { passed: verification.passed, reason: verification.reason } : null })
  } else {
    console.log("[vm-backup] backup completed", {
      backupId: row.id,
      vmid,
      storage,
      upid,
      volid: found?.volid || verification?.volid || null,
      sizeBytes: found?.sizeBytes || (verification?.sizeBytes ?? 0),
      startedAt: row.startedAt?.toISOString() || null,
      finishedAt: new Date().toISOString(),
      verified: verification?.passed === true,
    })
  }

  return {
    status: finalFailed ? "failed" : "completed",
    percent: finalFailed ? null : 100,
    phase: finalFailed ? "Backup failed" : "Backup completed",
    verification,
    justFinalized: true,
  }
}

/**
 * Server-side reconciler: finalize any queued/running backups that have a UPID
 * (and are not yet stale). This makes backup state independent of the browser —
 * a user can close the tab and the backup still completes, gets verified, and
 * (if applicable) sends notifications.
 */
export async function reconcileInProgressBackups(): Promise<{ checked: number; finalized: number }> {
  const rows = await prisma.vmBackup.findMany({
    where: {
      status: { in: ["queued", "running"] },
      updatedAt: { gt: new Date(Date.now() - 45 * 60 * 1000) },
    },
    orderBy: { updatedAt: "asc" },
    take: 25,
    select: { id: true, status: true, metadata: true },
  })
  let finalized = 0
  for (const row of rows) {
    const metadata = (row.metadata as Record<string, unknown>) || {}
    if (typeof metadata?.upid !== "string" || !metadata.upid) continue
    const result = await finalizeBackupFromTask(row.id).catch(() => null)
    if (result && (result.status === "completed" || result.status === "failed" || result.status === "cancelled")) {
      finalized += 1
    }
  }
  return { checked: rows.length, finalized }
}