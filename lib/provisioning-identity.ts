import crypto from "node:crypto"
import { prisma } from "@/lib/db"

export const PROVISION_PHASES = [
  "NEW",
  "LOCKED",
  "CLONING",
  "CONFIGURING",
  "RESIZING",
  "SETTING_NETWORK",
  "STARTING",
  "WAITING_GUEST_AGENT",
  "READY",
  "FAILED",
] as const

export type ProvisionPhase = (typeof PROVISION_PHASES)[number]

const ACTIVE_LEASE_MS = Math.max(60_000, Number(process.env.PROVISION_ORDER_LEASE_MS || 15 * 60_000))

function identityClient() {
  return (prisma as any).vmProvisioningIdentity
}

const TERMINAL_SERVICE_STATUSES = ["DELETED", "TERMINATED", "CANCELLED", "CANCELED"]

function serviceIsGone(service: { status?: string | null; deletedAt?: Date | string | null } | null | undefined) {
  if (!service) return true
  if (service.deletedAt) return true
  return TERMINAL_SERVICE_STATUSES.includes(String(service.status || "").toUpperCase())
}

/**
 * Hand a unique address back when nothing is behind it any more.
 *
 * `public_ip` carries a unique index, so one identity row owns an address for
 * as long as the row holds it. The repair below only ever handled the case where
 * the old service was still alive but had demonstrably moved to a different
 * address. It had no path for the far more common case: the service is gone.
 * In production that leaked seven addresses from a /24 -- every one of them
 * still carried an identity row for a service the panel had deleted -- and
 * because `allocateIp` treats a dead service as a free address it kept handing
 * those addresses out. Each one died at `ensureProvisioningIdentity` with a bare
 * unique-constraint violation, *after* the guest had been cloned, resized and
 * started, so a stale row cost a VM and produced a START_FAILED order.
 *
 * Releasing is guarded three ways: only a row whose service is definitively
 * gone, never the current order's own row, and never while any live service or
 * unreleased allocation still holds the address. The row itself is kept: it
 * still locks the order to its VMID, which is what stops a second clone.
 */
async function releaseAbandonedPublicIp(input: { orderId: string; publicIp: string; vpsInstanceId?: string | null; conflict: any }) {
  const { conflict } = input
  const requestedIp = input.publicIp
  if (!conflict || conflict.orderId === input.orderId) return
  if (!serviceIsGone(conflict.vpsInstance)) return

  // Somebody may still be serving this address even though the identity row's
  // own service is gone. Never take an address a live service is using.
  const liveService = await prisma.vpsInstance
    .findFirst({
      where: {
        ipAddress: requestedIp,
        deletedAt: null,
        status: { notIn: TERMINAL_SERVICE_STATUSES },
      },
      select: { id: true },
    })
    .catch(() => null)
  if (liveService) return

  // Same for an allocation still held against a live service. The allocation
  // this very order just took is excluded, or the repair would refuse to undo
  // the collision it exists to undo.
  const foreignOwner = input.vpsInstanceId ? { not: input.vpsInstanceId } : undefined
  const liveAllocation = await (prisma as any).ipAllocation
    .findFirst({
      where: {
        ipAddress: requestedIp,
        releasedAt: null,
        status: { in: ["assigned", "ASSIGNED", "used", "USED", "reserved", "RESERVED"] },
        vpsInstance: { deletedAt: null, status: { notIn: TERMINAL_SERVICE_STATUSES }, ...(foreignOwner ? { id: foreignOwner } : {}) },
      },
      select: { id: true },
    })
    .catch(() => null)
  if (liveAllocation) return

  const metadata = conflict.metadata && typeof conflict.metadata === "object" && !Array.isArray(conflict.metadata)
    ? conflict.metadata as Record<string, unknown>
    : {}
  await identityClient().update({
    where: { id: conflict.id },
    data: {
      publicIp: null,
      metadata: {
        ...metadata,
        publicIpReleasedAt: new Date().toISOString(),
        publicIpReleaseReason: "owning_service_deleted_and_address_unclaimed",
        releasedPublicIp: requestedIp,
      },
    },
  })
}

async function repairProvenStalePublicIp(input: { orderId: string; publicIp?: string | null; vpsInstanceId?: string | null }) {
  const requestedIp = String(input.publicIp || "").trim()
  if (!requestedIp) return

  const conflict = await identityClient().findUnique({
    where: { publicIp: requestedIp },
    include: {
      vpsInstance: {
        select: {
          id: true,
          ipAddress: true,
          status: true,
          deletedAt: true,
          ipAllocations: {
            where: {
              releasedAt: null,
              status: { in: ["assigned", "ASSIGNED", "used", "USED"] },
            },
            select: { ipAddress: true },
          },
        },
      },
    },
  }).catch(() => null)
  if (!conflict || conflict.orderId === input.orderId) return

  // The owning service is gone and nothing live holds the address: give it back
  // before anything can fail on the unique index.
  await releaseAbandonedPublicIp({ orderId: input.orderId, publicIp: requestedIp, vpsInstanceId: input.vpsInstanceId, conflict })

  const service = conflict.vpsInstance
  const currentIp = String(service?.ipAddress || "").trim()
  const serviceActive = !serviceIsGone(service)
  const allocationProvesCurrentIp = Boolean(currentIp && service?.ipAllocations?.some((allocation: { ipAddress?: string | null }) => allocation.ipAddress === currentIp))
  if (!serviceActive || !allocationProvesCurrentIp || currentIp === requestedIp) return

  const currentIpOwner = await identityClient().findUnique({ where: { publicIp: currentIp }, select: { id: true } }).catch(() => null)
  if (currentIpOwner && currentIpOwner.id !== conflict.id) return

  const metadata = conflict.metadata && typeof conflict.metadata === "object" && !Array.isArray(conflict.metadata)
    ? conflict.metadata as Record<string, unknown>
    : {}
  await identityClient().update({
    where: { id: conflict.id },
    data: {
      publicIp: currentIp,
      metadata: {
        ...metadata,
        publicIpRepairedAt: new Date().toISOString(),
        publicIpRepairReason: "active_service_and_allocation_evidence",
        previousPublicIp: requestedIp,
      },
    },
  })
}

export function newProvisionLeaseOwner(jobId: string) {
  return `${process.pid}:${jobId}:${crypto.randomUUID()}`
}

export async function ensureProvisioningIdentity(input: {
  orderId: string
  vpsInstanceId?: string | null
  vmUuid?: string | null
  proxmoxNodeId?: string | null
  vmid?: number | null
  publicIp?: string | null
  macAddress?: string | null
}) {
  await repairProvenStalePublicIp({ orderId: input.orderId, publicIp: input.publicIp, vpsInstanceId: input.vpsInstanceId })
  const existing = await identityClient().findUnique({ where: { orderId: input.orderId } })
  const vmUuid = String(input.vmUuid || input.vpsInstanceId || existing?.vmUuid || input.orderId)
  const nextVmid = Number(input.vmid || 0) > 0 ? Number(input.vmid) : null
  if (existing?.cloneIntentAt && nextVmid && existing.vmid && Number(existing.vmid) !== nextVmid) {
    throw new Error(`provisioning_identity_immutable_vmid: order ${input.orderId} is locked to VMID ${existing.vmid}`)
  }
  if (existing?.cloneIntentAt && input.proxmoxNodeId && existing.proxmoxNodeId && existing.proxmoxNodeId !== input.proxmoxNodeId) {
    throw new Error(`provisioning_identity_immutable_node: order ${input.orderId} is locked to node ${existing.proxmoxNodeId}`)
  }
  const data = {
    vpsInstanceId: input.vpsInstanceId || existing?.vpsInstanceId || null,
    vmUuid,
    proxmoxNodeId: input.proxmoxNodeId || existing?.proxmoxNodeId || null,
    vmid: nextVmid || existing?.vmid || null,
    publicIp: input.publicIp || existing?.publicIp || null,
    macAddress: input.macAddress || existing?.macAddress || null,
  }
  if (existing) return identityClient().update({ where: { id: existing.id }, data })
  return identityClient().create({ data: { orderId: input.orderId, ...data } })
}

export async function getProvisioningIdentity(orderId: string) {
  return identityClient().findUnique({ where: { orderId } })
}

export async function acquireOrderProvisionLease(input: {
  orderId: string
  jobId: string
  vpsInstanceId?: string | null
  vmUuid?: string | null
}) {
  const identity = await ensureProvisioningIdentity(input)
  const owner = newProvisionLeaseOwner(input.jobId)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ACTIVE_LEASE_MS)
  const claimed = await identityClient().updateMany({
    where: {
      id: identity.id,
      OR: [
        { leaseOwner: null },
        { leaseExpiresAt: null },
        { leaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      leaseOwner: owner,
      leaseHeartbeatAt: now,
      leaseExpiresAt: expiresAt,
      phase: identity.phase === "READY" ? "READY" : "LOCKED",
      lastError: null,
    },
  })
  if (!claimed.count) return { acquired: false as const, owner: null, identity: await getProvisioningIdentity(input.orderId) }
  return { acquired: true as const, owner, identity: await getProvisioningIdentity(input.orderId) }
}

export async function heartbeatOrderProvisionLease(orderId: string, owner: string) {
  const now = new Date()
  const result = await identityClient().updateMany({
    where: { orderId, leaseOwner: owner },
    data: { leaseHeartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + ACTIVE_LEASE_MS) },
  })
  if (!result.count) throw new Error("provisioning_order_lease_lost")
}

export async function releaseOrderProvisionLease(orderId: string, owner: string) {
  return identityClient().updateMany({
    where: { orderId, leaseOwner: owner },
    data: { leaseOwner: null, leaseHeartbeatAt: null, leaseExpiresAt: null },
  })
}

export async function setProvisioningPhase(input: {
  orderId: string
  jobId?: string | null
  phase: ProvisionPhase
  resumePhase?: ProvisionPhase | null
  owner?: string | null
  error?: string | null
  cloneUpid?: string | null
  cloneIntentAt?: Date | null
  cloneCompletedAt?: Date | null
}) {
  if (input.owner) await heartbeatOrderProvisionLease(input.orderId, input.owner)
  const identity = await getProvisioningIdentity(input.orderId)
  if (!identity) throw new Error("provisioning_identity_missing")
  const data: Record<string, unknown> = {
    phase: input.phase,
    resumePhase: input.resumePhase === undefined ? (input.phase === "FAILED" ? identity.resumePhase : input.phase) : input.resumePhase,
    lastError: input.error || null,
  }
  if (input.cloneUpid !== undefined) data.cloneUpid = input.cloneUpid
  if (input.cloneIntentAt !== undefined) data.cloneIntentAt = input.cloneIntentAt
  if (input.cloneCompletedAt !== undefined) data.cloneCompletedAt = input.cloneCompletedAt
  const updated = await identityClient().update({ where: { id: identity.id }, data })
  if (input.jobId) {
    await prisma.provisioningJob.update({
      where: { id: input.jobId },
      data: { canonicalPhase: input.phase, resumePhase: String(data.resumePhase || input.phase) },
    }).catch(() => undefined)
  }
  return updated
}

export async function recordCloneIntent(input: {
  orderId: string
  jobId: string
  owner: string
  proxmoxNodeId: string
  vmid: number
}) {
  const identity = await ensureProvisioningIdentity({ orderId: input.orderId, proxmoxNodeId: input.proxmoxNodeId, vmid: input.vmid })
  if (identity.cloneIntentAt && Number(identity.vmid) !== input.vmid) {
    throw new Error(`provisioning_identity_immutable_vmid: clone already intended for VMID ${identity.vmid}`)
  }
  return setProvisioningPhase({
    orderId: input.orderId,
    jobId: input.jobId,
    owner: input.owner,
    phase: "CLONING",
    resumePhase: "CLONING",
    cloneIntentAt: identity.cloneIntentAt || new Date(),
  })
}

export async function provisioningReplayState(orderId: string) {
  const [identity, job, order] = await Promise.all([
    getProvisioningIdentity(orderId),
    prisma.provisioningJob.findFirst({ where: { orderId, type: "provision" }, orderBy: { createdAt: "desc" } }),
    prisma.order.findUnique({ where: { id: orderId }, include: { vpsInstance: true } }),
  ])
  return {
    idempotentReplay: true,
    phase: identity?.phase || job?.canonicalPhase || "NEW",
    recoveryStatus: identity?.cloneIntentAt && identity?.phase !== "READY" ? "RESUMING" : identity?.phase === "READY" ? "READY" : "QUEUED",
    identity,
    job,
    vps: order?.vpsInstance || null,
  }
}
