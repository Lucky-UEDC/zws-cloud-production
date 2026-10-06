import { prisma } from "@/lib/db"
import { createProxmoxClient, PROXMOX_METRICS_TIMEOUT_MS } from "@/lib/proxmox"

export const VM_STATUS_CACHE_TTL_MS = 30_000

export function normalizeProxmoxPowerState(value: unknown) {
  const state = String(value || "").trim().toLowerCase()
  if (["running", "started", "online"].includes(state)) return "running"
  if (["stopped", "stopped/suspended", "offline"].includes(state)) return "stopped"
  if (["paused", "suspended"].includes(state)) return state
  if (["starting", "stopping", "rebooting"].includes(state)) return state
  return state || "unknown"
}

export function dbStatusFromPowerState(value: unknown, fallback = "UNKNOWN") {
  const state = normalizeProxmoxPowerState(value)
  if (state === "running") return "ACTIVE"
  if (state === "stopped") return "STOPPED"
  if (state === "paused") return "PAUSED"
  if (state === "suspended") return "SUSPENDED"
  if (state === "starting") return "STARTING"
  if (state === "stopping") return "STOPPING"
  if (state === "rebooting") return "REBOOTING"
  return fallback
}

function shouldRefreshVps(vps: any) {
  const status = String(vps?.status || "").toLowerCase()
  const source = String(vps?.provisioningSource || "panel").toLowerCase()
  const ownershipStatus = String(vps?.ownershipStatus || "panel_owned").toLowerCase()
  return Boolean(vps?.proxmoxNode && vps?.vmid)
    && !vps?.deletedAt
    && !["deleted", "deleting", "terminated"].includes(status)
    && !["external", "manual"].includes(source)
    && !["external", "manual"].includes(ownershipStatus)
}

async function cacheRuntimeSnapshot(vps: any, runtime: any) {
  const now = new Date()
  const runtimeStatus = normalizeProxmoxPowerState(runtime?.status)
  const dbStatus = dbStatusFromPowerState(runtimeStatus, vps.status || "UNKNOWN")
  const staleAfter = new Date(now.getTime() + VM_STATUS_CACHE_TTL_MS)

  // Runtime counters report nothing about guest disk usage on most qemu
  // installations — the reported `disk`/`maxdisk` values are 0. Writing those
  // zeros clobbered real samples from the guest-agent disk collector and made
  // the UI show "Disk: Unavailable" / 0 for most of the time. Carry the last
  // real sample forward, or the runtime number only when it looks real.
  const runtimeDiskUsed = Math.max(0, Math.floor(Number(runtime?.disk || 0)))
  const runtimeDiskCap = Math.max(0, Math.floor(Number(runtime?.maxdisk || 0)))
  const diskTotalLooksReal = runtimeDiskCap > 0
    ? runtimeDiskCap >= runtimeDiskUsed && runtimeDiskCap > 1_000_000_000
    : false
  let lastDiskBytes: { diskUsedBytes: number; diskTotalBytes: number; diskFreeBytes?: number | null } | null = null
  try {
    const previous = await (prisma as any).vpsMetric.findFirst({
      where: { vpsInstanceId: vps.id, diskTotalBytes: { gt: BigInt(0) }, diskUsedBytes: { gt: BigInt(0) } },
      orderBy: { recordedAt: "desc" },
      select: { diskUsedBytes: true, diskTotalBytes: true, diskFreeBytes: true },
    })
    if (previous) {
      lastDiskBytes = {
        diskUsedBytes: Number(previous.diskUsedBytes || 0),
        diskTotalBytes: Number(previous.diskTotalBytes || 0),
        diskFreeBytes: Number(previous.diskFreeBytes || 0),
      }
    }
  } catch { /* best-effort fallback only; instrumentation must not crash the refresh */ }

  // A zero "used" from the runtime is never trustworthy, even when the capacity
  // looks real: qemu reports the block capacity but no guest usage, so
  // `diskTotalLooksReal` alone must not license `runtimeDiskUsed = 0` to
  // overwrite a real sample. Runtime values are used only when "used" is
  // actually positive; otherwise the last real guest sample is carried forward.
  const runtimeDiskIsReal = runtimeDiskUsed > 0 && diskTotalLooksReal
  const diskUsedBytes = runtimeDiskIsReal ? runtimeDiskUsed : lastDiskBytes?.diskUsedBytes ?? runtimeDiskUsed
  const diskTotalBytes = runtimeDiskIsReal
    ? runtimeDiskCap
    : lastDiskBytes?.diskTotalBytes ?? (runtimeDiskCap > 0 ? runtimeDiskCap : 0)
  const diskFreeBytes = runtimeDiskIsReal
    ? Math.max(0, runtimeDiskCap - runtimeDiskUsed)
    : Math.max(0, lastDiskBytes?.diskFreeBytes ?? (diskTotalBytes > 0 ? diskTotalBytes - diskUsedBytes : 0))

  await Promise.all([
    prisma.vpsInstance.update({
      where: { id: vps.id },
      data: { status: dbStatus },
    }).catch(() => null),
    (prisma as any).vpsMetric.create({
      data: {
        vpsInstanceId: vps.id,
        vmid: vps.vmid,
        runtimeStatus,
        cpuPercent: Number(runtime?.cpu || 0) * 100,
        ramUsedBytes: BigInt(Math.max(0, Math.floor(Number(runtime?.mem || 0)))),
        ramTotalBytes: BigInt(Math.max(0, Math.floor(Number(runtime?.maxmem || 0)))),
        diskUsedBytes: BigInt(diskUsedBytes),
        diskTotalBytes: BigInt(diskTotalBytes),
        diskReadBytes: BigInt(Math.max(0, Math.floor(Number(runtime?.diskread || 0)))),
        diskWriteBytes: BigInt(Math.max(0, Math.floor(Number(runtime?.diskwrite || 0)))),
        networkInBytes: BigInt(Math.max(0, Math.floor(Number(runtime?.netin || 0)))),
        networkOutBytes: BigInt(Math.max(0, Math.floor(Number(runtime?.netout || 0)))),
        recordedAt: now,
        metadata: { source: "admin_runtime_refresh", staleAfter: staleAfter.toISOString() },
      },
    }).catch(() => null),
    (prisma as any).vmRuntime?.upsert?.({
      where: { vpsInstanceId: vps.id },
      create: {
        vpsInstanceId: vps.id,
        customerId: vps.customerId,
        orderId: vps.orderId,
        proxmoxNodeId: vps.proxmoxNodeId || null,
        vmid: vps.vmid,
        hostname: vps.name,
        status: dbStatus,
        runtimeStatus,
        powerState: runtimeStatus,
        syncSource: "admin_runtime_refresh",
        lastSyncedAt: now,
        staleAfter,
      },
      update: {
        status: dbStatus,
        runtimeStatus,
        powerState: runtimeStatus,
        syncSource: "admin_runtime_refresh",
        lastSyncedAt: now,
        staleAfter,
      },
    }).catch(() => null),
  ])
  return { runtimeStatus, status: dbStatus, recordedAt: now.toISOString() }
}

export async function refreshOneVmRuntimeStatusById(vpsId: string, _actor?: string | null, options: { force?: boolean } = {}) {
  void options
  const vps = await prisma.vpsInstance.findFirst({
    where: { OR: [{ id: vpsId }, { orderId: vpsId }] },
    include: { proxmoxNode: true },
  })
  if (!vps) return { refreshed: false, reason: "vm_not_found" }
  if (!shouldRefreshVps(vps)) return { refreshed: false, reason: "vm_not_refreshable" }
  const node = vps.proxmoxNode
  if (!node) return { refreshed: false, reason: "node_unavailable" }
  const client = createProxmoxClient(node.host, node.tokenId, node.tokenSecret, {
    allowInsecureTls: node.allowInsecureTls,
    timeoutMs: PROXMOX_METRICS_TIMEOUT_MS,
  })
  const runtime = await client.getVMStatus(node.nodeName, vps.vmid).catch((error: any) => ({
    __error: true,
    message: error?.message || String(error),
    code: error?.code || error?.statusCode || "proxmox_unavailable",
  }))
  if ((runtime as any)?.__error) {
    console.warn("[vm-runtime] VM state refresh failed", { vpsId: vps.id, vmid: vps.vmid, reason: (runtime as any).code })
    return { refreshed: false, reason: "proxmox_unavailable", error: (runtime as any).message, code: (runtime as any).code }
  }
  console.log("[vm-runtime] VM state refreshed", { vpsId: vps.id, vmid: vps.vmid, status: (runtime as any)?.status })
  return { refreshed: true, ...(await cacheRuntimeSnapshot(vps, runtime)) }
}

export async function refreshRecentAdminVmRuntimeStatuses(limit = 50) {
  const rows = await prisma.vpsInstance.findMany({
    where: { deletedAt: null, proxmoxNodeId: { not: null } },
    include: { proxmoxNode: true },
    orderBy: { updatedAt: "desc" },
    take: Math.max(1, Math.min(100, Math.floor(Number(limit || 50)))),
  })
  const results = await Promise.allSettled(rows.filter(shouldRefreshVps).map((vps) => refreshOneVmRuntimeStatusById(vps.id)))
  return {
    checked: rows.length,
    refreshed: results.filter((result) => result.status === "fulfilled" && (result.value as any)?.refreshed).length,
    failed: results.filter((result) => result.status === "rejected").length,
  }
}
