/**
 * Backup retention, made real.
 *
 * `BackupPlan.retentionCount` was sold to customers ("Retention: latest 10"),
 * returned by every API and computed in every summary — and never enforced
 * anywhere. Meanwhile the same plan advertised `maxBackups: 15`, so the plan
 * page told a customer two different things about the same limit. The creation
 * path only refused a backup once `backupCount >= maxBackups`, so an account
 * sat at 15 forever, permanently reported "0 remaining", and never converged on
 * the retention it was sold.
 *
 * The honest limit is the *stricter* of the two: retention cannot exceed the
 * number of backups the plan allows to exist. `effectiveBackupLimit()` is the
 * single answer every surface must show.
 *
 * Pruning order matters and is not optional:
 *
 *   1. the Proxmox archive is deleted first and confirmed;
 *   2. only then is the row marked cancelled with `prunedByRetention`;
 *   3. the row is never hard-deleted, and never a `failed`/`running` row.
 *
 * If the storage cannot be reached, the backup is reported as un-pruned rather
 * than silently dropped from the count — usage is never reduced before storage
 * confirms the bytes are gone.
 */

import { prisma } from "@/lib/db"
import { createProxmoxClient, PROXMOX_LONG_TIMEOUT_MS } from "@/lib/proxmox"
import { resolveBackupEntitlement } from "@/lib/billing/entitlements"
import { effectiveBackupLimit, selectBackupsToPrune } from "@/lib/backups-retention-limit"

export { effectiveBackupLimit, selectBackupsToPrune }

/** Statuses that represent a real stored artifact. */
const COUNTED_STATUSES = ["success", "completed"] as const

export type PruneCandidate = {
  id: string
  volid: string
  storage: string | null
  nodeHost: string | null
  nodeName: string | null
  tokenId: string | null
  tokenSecret: string | null
  allowInsecureTls: boolean | null
}

export type PruneOutcome = {
  pruned: string[]
  unpruned: Array<{ id: string; reason: string }>
  limit: number | null
  keptCount: number
}

/**
 * Which completed backups fall outside the retention window.
 *
 * Only completed backups count. A `running` backup has no settled artifact yet
 * and a `failed` one has nothing worth pruning; pruning either would destroy
 * evidence of a real failure.
 */
/** Resolve node/storage for an artifact without trusting browser input. */
async function resolveCandidate(backupId: string): Promise<PruneCandidate | null> {
  // Fetch the backup, then the owning instance separately. `vmBackup` has no
  // relation to `vpsInstance` in the Prisma model, so an `include` here would not
  // typecheck.
  const row = await prisma.vmBackup.findUnique({ where: { id: backupId } })
  if (!row) return null
  const metadata = (row.metadata as Record<string, unknown>) || {}
  const volid = String(row.backupPath || metadata.volid || "").trim()
  if (!volid) return null

  let storage: string | null = null
  let nodeId = row.proxmoxNodeId || null
  if (row.vpsInstanceId) {
    const instance = await prisma.vpsInstance.findUnique({
      where: { id: row.vpsInstanceId },
      select: { proxmoxNodeId: true },
    })
    if (!nodeId) nodeId = instance?.proxmoxNodeId || null
  }
  if (row.schedule) {
    const policy = await prisma.vmBackupPolicy.findUnique({ where: { id: row.schedule }, select: { storage: true, nodeId: true } })
    if (policy) {
      storage = policy.storage || null
      if (!nodeId && policy.nodeId) nodeId = policy.nodeId
    }
  }
  const node = nodeId ? await prisma.proxmoxNode.findUnique({ where: { id: nodeId } }) : null
  return {
    id: row.id,
    volid,
    storage: storage || volid.split(":")[0] || null,
    nodeHost: node?.host || null,
    nodeName: node?.nodeName || null,
    tokenId: node?.tokenId || null,
    tokenSecret: node?.tokenSecret || null,
    allowInsecureTls: node ? Boolean(node.allowInsecureTls) : null,
  }
}

/**
 * Delete one artifact from Proxmox storage. Returns true when the bytes are
 * gone, including the benign "already absent" case.
 */
async function deleteArtifact(candidate: PruneCandidate): Promise<{ ok: boolean; reason?: string }> {
  if (!candidate.nodeHost || !candidate.nodeName || !candidate.tokenId || !candidate.tokenSecret) {
    return { ok: false, reason: "node_unavailable" }
  }
  if (!candidate.storage) return { ok: false, reason: "storage_unknown" }
  try {
    const client = createProxmoxClient(candidate.nodeHost, candidate.tokenId, candidate.tokenSecret, {
      allowInsecureTls: Boolean(candidate.allowInsecureTls),
      timeoutMs: PROXMOX_LONG_TIMEOUT_MS,
    })
    await client.deleteVmBackup(candidate.nodeName, candidate.storage, candidate.volid)
    return { ok: true }
  } catch (error: any) {
    const message = String(error?.message || "")
    // Already gone is the outcome we wanted.
    if (/not found|doesn'?t exist|no such|404/i.test(message)) return { ok: true }
    return { ok: false, reason: "proxmox_delete_failed" }
  }
}

/**
 * Bring one customer's completed backups back inside their retention window.
 *
 * Safe to call from the completion path, the scheduler, or an admin action: it
 * only ever removes the oldest archives beyond the limit, and it reports
 * exactly what it could and could not do.
 */
export async function pruneBackupsToRetention(customerId: string): Promise<PruneOutcome> {
  const entitlementResult = await resolveBackupEntitlement(customerId).catch(() => null)
  const entitlement = entitlementResult?.entitlement || null
  const limit = effectiveBackupLimit({ maxBackups: entitlement?.maxBackups ?? null, retentionCount: entitlement?.retentionCount ?? null })

  const instances = await prisma.vpsInstance.findMany({ where: { customerId, deletedAt: null }, select: { id: true } })
  const instanceIds = instances.map((instance) => instance.id)

  if (!instanceIds.length) return { pruned: [], unpruned: [], limit, keptCount: 0 }

  const completedBackups = await prisma.vmBackup.findMany({
    where: { customerId, vpsInstanceId: { in: instanceIds }, status: { in: [...COUNTED_STATUSES] } },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  })

  const expired = selectBackupsToPrune({ completedBackups, limit })
  const pruned: string[] = []
  const unpruned: Array<{ id: string; reason: string }> = []

  for (const backup of expired) {
    const candidate = await resolveCandidate(backup.id)
    if (!candidate) {
      unpruned.push({ id: backup.id, reason: "artifact_unknown" })
      continue
    }
    const result = await deleteArtifact(candidate)
    if (!result.ok) {
      // Usage is deliberately NOT reduced: the bytes may still be on storage.
      unpruned.push({ id: backup.id, reason: result.reason || "unknown" })
      continue
    }
    await prisma.vmBackup.update({
      where: { id: backup.id },
      data: {
        status: "cancelled",
        metadata: {
          ...(((await prisma.vmBackup.findUnique({ where: { id: backup.id }, select: { metadata: true } }))?.metadata as Record<string, unknown>) || {}),
          prunedByRetention: true,
          prunedAt: new Date().toISOString(),
          retentionLimit: limit,
        },
      },
    }).catch(() => null)
    pruned.push(backup.id)
  }

  return { pruned, unpruned, limit, keptCount: completedBackups.length - pruned.length }
}