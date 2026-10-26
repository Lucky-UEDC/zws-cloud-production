import { NextRequest, NextResponse } from "next/server"
import crypto from "node:crypto"
import { prisma } from "@/lib/db"
import { getAdminFromCookies } from "@/lib/server-auth"
import { canAccessAdminApi } from "@/lib/admin-rbac"
import { createAuditLog } from "@/lib/audit-log"
import { createPanelLog } from "@/lib/panel-log"
import { createProxmoxClient, PROXMOX_LONG_TIMEOUT_MS } from "@/lib/proxmox"
import { encryptSecretValue } from "@/lib/secret-crypto"
import { lifecycleDates } from "@/lib/renewals"
import { publishLiveVmSnapshot } from "@/lib/proxmox-live"
import { GuestAutomationService, osMetadataForVps } from "@/lib/guest-automation/service"
import { guestContextFor } from "@/lib/guest-automation/first-boot"

function text(value: unknown) {
  return String(value ?? "").trim()
}

function positiveInt(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function dateOrUndefined(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) throw new Error("Billing date is invalid")
  return date
}

function normalizeMac(value: unknown) {
  const raw = text(value).toLowerCase()
  if (!raw) return undefined
  if (!/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(raw)) throw new Error("MAC address must use aa:bb:cc:dd:ee:ff format")
  return raw
}

function jsonRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {}
}

function parseNet0(value: unknown) {
  const parts = String(value || "").split(",").map((part) => part.trim()).filter(Boolean)
  let model = "virtio"
  let bridge = "vmbr0"
  for (const part of parts) {
    if (part.includes("=") && !part.startsWith("bridge=")) model = part.split("=")[0] || model
    if (part.startsWith("bridge=")) bridge = part.slice("bridge=".length) || bridge
  }
  return { model, bridge }
}

function buildNet0(current: unknown, mac: string) {
  const parsed = parseNet0(current)
  return `${parsed.model}=${mac},bridge=${parsed.bridge}`
}

function parseIpConfig0(value: unknown) {
  const raw = String(value || "")
  const ip = raw.match(/(?:^|,)ip=([^,/]+)/)?.[1] || null
  const cidr = Number(raw.match(/(?:^|,)ip=[^,/]+\/(\d+)/)?.[1] || 24)
  const gateway = raw.match(/(?:^|,)gw=([^,\s]+)/)?.[1] || null
  return { ip, cidr: Number.isInteger(cidr) ? cidr : 24, gateway }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await getAdminFromCookies()
  if (!admin?.email || !canAccessAdminApi(admin.role)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const vps = await prisma.vpsInstance.findFirst({
      where: { OR: [{ id }, { orderId: id }], deletedAt: null },
      include: {
        order: true,
        proxmoxNode: true,
        ipAllocations: { where: { status: { in: ["RESERVED", "reserved", "ASSIGNED", "assigned", "USED", "used"] } }, include: { pool: true }, orderBy: { updatedAt: "desc" }, take: 1 },
        vmNetworkInterfaces: { orderBy: [{ isPrimary: "desc" }, { name: "asc" }], take: 1 },
      },
    })
    if (!vps) return NextResponse.json({ success: false, error: "VM not found" }, { status: 404 })

    const oldValue = {
      cpuCores: vps.cpuCores,
      ramGb: vps.ramGb,
      diskGb: vps.diskGb,
      proxmoxNodeId: vps.proxmoxNodeId,
      ipAddress: vps.ipAddress,
      username: vps.username,
      hostname: vps.name,
      vmMacAddress: vps.vmMacAddress,
      renewalDueAt: vps.renewalDueAt,
    }

    const cpuCores = positiveInt(body.cpuCores ?? body.cpu, "CPU")
    const ramGb = positiveInt(body.ramGb ?? body.ram, "RAM")
    const diskGb = positiveInt(body.diskGb ?? body.disk, "Disk")
    const nodeId = text(body.nodeId ?? body.proxmoxNodeId) || undefined
    const ipAddress = text(body.ipAddress ?? body.ip) || undefined
    const hostname = text(body.hostname) || undefined
    const username = text(body.username) || undefined
    const password = text(body.password) || undefined
    const macAddress = normalizeMac(body.macAddress ?? body.vmMacAddress)
    const renewalDueAt = dateOrUndefined(body.renewalDueAt ?? body.billingDate)
    const reason = text(body.reason) || "Admin VM edit"
    const targetNode = nodeId ? await prisma.proxmoxNode.findUnique({ where: { id: nodeId } }) : vps.proxmoxNode
    if (nodeId && !targetNode) throw new Error("Selected node was not found")
    if (nodeId && nodeId !== vps.proxmoxNodeId) throw new Error("Move this VM with the migration action; VM edit cannot change its node")
    if (diskGb && vps.diskGb && diskGb < vps.diskGb) throw new Error("Disk size cannot be reduced")

    const changingIp = Boolean(ipAddress && ipAddress !== vps.ipAddress)
    const ipReservationKey = changingIp ? `vm-edit:${vps.id}:${crypto.randomUUID()}` : null
    let targetAllocation: { id: string; poolId: string; ipAddress: string } | null = null
    if (changingIp) {
      targetAllocation = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string; poolId: string; ipAddress: string; status: string; vpsInstanceId: string | null }>>`
          SELECT id, "poolId", "ipAddress", status, "vpsInstanceId"
          FROM ip_allocations
          WHERE "ipAddress" = ${ipAddress}
          FOR UPDATE
        `
        if (!rows.length) throw new Error("Selected IP does not exist in an IP pool")
        const available = rows.find((row) => row.vpsInstanceId === vps.id || ["free", "available", "released"].includes(String(row.status).toLowerCase()))
        if (!available) throw new Error("Selected IP is already assigned to another active VM")
        await tx.ipAllocation.update({
          where: { id: available.id },
          data: { status: "reserved", vpsInstanceId: vps.id, vmid: vps.vmid, allocationLockKey: ipReservationKey, releasedAt: null },
        })
        return { id: available.id, poolId: available.poolId, ipAddress: available.ipAddress }
      }, { isolationLevel: "Serializable" })
    }

    let proxmoxPatch: Record<string, any> = {}
    let currentConfig: any = null
    const managed = Boolean(vps.vmid && targetNode?.host && targetNode?.tokenId && targetNode?.tokenSecret)
    const client = managed
      ? createProxmoxClient(targetNode!.host, targetNode!.tokenId, targetNode!.tokenSecret, { allowInsecureTls: targetNode!.allowInsecureTls, timeoutMs: PROXMOX_LONG_TIMEOUT_MS })
      : null
    if (client) currentConfig = await client.getVMConfig(targetNode!.nodeName, vps.vmid).catch(() => null)

    // Host-owned fields go to the VM config. Guest-owned fields (password, IP,
    // DNS) are NOT written here any more: they are applied inside the guest by
    // its OS template and verified there. `ciuser`/`cipassword`/`ipconfig0`/
    // `nameserver` are no longer part of any write path.
    let guestChange: { kind: "password" | "network"; payload: Record<string, unknown> } | null = null
    if (cpuCores) {
      proxmoxPatch.sockets = 1
      proxmoxPatch.cores = cpuCores
    }
    if (ramGb) proxmoxPatch.memory = ramGb * 1024
    if (hostname) proxmoxPatch.name = hostname
    if (macAddress) {
      const cachedNet0 = jsonRecord(vps.vmNetworkInterfaces[0]?.metadata).net0
      proxmoxPatch.net0 = buildNet0(currentConfig?.net0 || cachedNet0 || "", macAddress)
    }
    if (changingIp && ipAddress) {
      const currentIp = parseIpConfig0(currentConfig?.ipconfig0)
      const allocation = vps.ipAllocations[0]
      const pool = allocation?.pool
      const cidr = Number(body.cidr || pool?.cidr || currentIp.cidr || 24)
      const gateway = text(body.gateway || pool?.gateway || currentIp.gateway)
      if (!gateway) throw new Error("Gateway is required when editing IP")
      guestChange = {
        kind: "network",
        payload: {
          ip: ipAddress,
          prefix: cidr,
          gateway,
          dns: text(body.dns || pool?.dns) || "1.1.1.1",
          hostname: text(hostname || vps.hostname || vps.name || ""),
          username: text(username || vps.adminUsername || vps.username || "root"),
        },
      }
    }
    if (password) {
      guestChange = {
        kind: "password",
        payload: { username: text(username || vps.adminUsername || vps.username || "root"), password },
      }
    }

    try {
      if (client && Object.keys(proxmoxPatch).length) {
        await client.updateVMConfig(targetNode!.nodeName, vps.vmid, proxmoxPatch)
      }
      if (guestChange && targetNode) {
        const service = new GuestAutomationService(
          guestContextFor({ vpsInstanceId: vps.id, vmid: vps.vmid, node: targetNode }),
        )
        const actor = { requestedBy: String(admin.email), role: "admin" as const }
        const metadata = osMetadataForVps(vps)
        if (guestChange.kind === "password") {
          const result = await service.setPassword({ ...(guestChange.payload as any), metadata, actor })
          if (!result.ok) throw new Error(`guest_automation_failed:${result.errorCode}`)
        } else {
          const payload = guestChange.payload as any
          const changed = await service.setIP({
            ip: payload.ip,
            prefix: payload.prefix,
            gateway: payload.gateway,
            dns: String(payload.dns || "").split(/[,\s]+/).map((value: string) => value.trim()).filter(Boolean),
            metadata,
            actor,
          })
          if (!changed.ok) throw new Error(`guest_automation_failed:${changed.errorCode}`)
        }
      }
      if (client && diskGb && diskGb > Number(vps.diskGb || 0)) {
        const diskKey = Object.keys(currentConfig || {}).find((key) => /^(scsi|virtio|sata|ide)\d+$/.test(key) && !String(currentConfig?.[key] || "").includes("cloudinit"))
        if (!diskKey) throw new Error("VM operating-system disk was not found")
        await client.resizeDisk(targetNode!.nodeName, vps.vmid, diskKey, `${diskGb}G`)
      }
    } catch (error) {
      if (targetAllocation && ipReservationKey) {
        await prisma.ipAllocation.updateMany({ where: { id: targetAllocation.id, allocationLockKey: ipReservationKey }, data: { status: "free", vpsInstanceId: null, vmid: null, allocationLockKey: null, releasedAt: new Date() } }).catch(() => undefined)
      }
      throw error
    }

    const lifecycle = renewalDueAt ? lifecycleDates({
      renewalDueAt,
      graceDays: vps.graceDays,
      penaltyWindowDays: (vps as any).penaltyWindowDays,
      terminationWindowDays: (vps as any).terminationWindowDays,
      retentionDays: vps.retentionDays,
    }) : null
    const passwordEncrypted = password ? encryptSecretValue(password) : undefined
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.vpsInstance.update({
        where: { id: vps.id },
        data: {
          ...(cpuCores ? { cpuCores } : {}),
          ...(ramGb ? { ramGb } : {}),
          ...(diskGb ? { diskGb } : {}),
          ...(nodeId ? { proxmoxNodeId: nodeId } : {}),
          ...(ipAddress ? { ipAddress } : {}),
          ...(hostname ? { name: hostname } : {}),
          ...(username ? { username, adminUsername: username } : {}),
          ...(passwordEncrypted ? { passwordEncrypted } : {}),
          ...(macAddress ? { vmMacAddress: macAddress } : {}),
          ...(renewalDueAt ? {
            renewalDueAt,
            nextRenewalAt: renewalDueAt,
            suspendAt: lifecycle?.suspendAt || null,
            penaltyAt: lifecycle?.penaltyAt || null,
            terminationAt: lifecycle?.terminationAt || null,
            deletionAt: lifecycle?.deletionAt || null,
            manualExpiryOverride: true,
            renewalAtManual: renewalDueAt,
          } : {}),
          editedAt: new Date(),
          editReason: reason,
        },
      })
      await tx.order.update({
        where: { id: vps.orderId },
        data: {
          ...(nodeId ? { proxmoxNodeId: nodeId, proxmoxNode: targetNode?.nodeName || null } : {}),
          ...(hostname ? { hostname } : {}),
          ...(username ? { adminUsername: username } : {}),
          ...(passwordEncrypted ? { passwordEncrypted } : {}),
        },
      })
      if (macAddress) {
        await tx.vmNetworkInterface.upsert({
          where: { vpsInstanceId_name: { vpsInstanceId: vps.id, name: "net0" } },
          create: { vpsInstanceId: vps.id, proxmoxNodeId: nodeId || vps.proxmoxNodeId, vmid: vps.vmid, name: "net0", isPrimary: true, macAddress, bridge: parseNet0(proxmoxPatch.net0 || currentConfig?.net0).bridge, model: "virtio" },
          update: { proxmoxNodeId: nodeId || vps.proxmoxNodeId, vmid: vps.vmid, isPrimary: true, macAddress, bridge: parseNet0(proxmoxPatch.net0 || currentConfig?.net0).bridge, model: "virtio" },
        })
      }
      if (ipAddress) {
        if (targetAllocation) {
          await tx.ipAllocation.update({ where: { id: targetAllocation.id }, data: { status: "assigned", vpsInstanceId: vps.id, vmid: vps.vmid, hostname: hostname || vps.name, allocationLockKey: null, releasedAt: null } })
          await tx.ipAllocation.updateMany({ where: { vpsInstanceId: vps.id, id: { not: targetAllocation.id } }, data: { status: "free", vpsInstanceId: null, vmid: null, hostname: null, allocationLockKey: null, releasedAt: new Date() } })
        }
        await (tx as any).ipAssignment.updateMany({ where: { vpsInstanceId: vps.id, isPrimary: true }, data: { assignedIp: ipAddress, billingIp: ipAddress } })
        await tx.vmIpAssignment.updateMany({ where: { vpsInstanceId: vps.id, isPrimary: true }, data: { ipAddress } })
        await (tx as any).vmNetworkCache.updateMany({ where: { vpsInstanceId: vps.id }, data: { primaryAssignedIp: ipAddress, cloudInitIp: ipAddress, lastSyncedAt: new Date() } })
      }
      if (renewalDueAt) {
        await (tx as any).vmAddon.updateMany({ where: { vpsInstanceId: vps.id, addonType: "ip", status: "active" }, data: { expiresAt: renewalDueAt } })
      }
      return row
    }).catch(async (error) => {
      if (client && currentConfig && Object.keys(proxmoxPatch).length) {
        const rollbackPatch = Object.fromEntries(Object.keys(proxmoxPatch)
          .filter((key) => currentConfig[key] !== undefined && key !== "cipassword")
          .map((key) => [key, currentConfig[key]]))
        if (Object.keys(rollbackPatch).length) await client.updateVMConfig(targetNode!.nodeName, vps.vmid, rollbackPatch).catch(() => undefined)
      }
      if (targetAllocation && ipReservationKey) {
        await prisma.ipAllocation.updateMany({ where: { id: targetAllocation.id, allocationLockKey: ipReservationKey }, data: { status: "free", vpsInstanceId: null, vmid: null, allocationLockKey: null, releasedAt: new Date() } }).catch(() => undefined)
      }
      throw error
    })

    const newValue = {
      cpuCores: updated.cpuCores,
      ramGb: updated.ramGb,
      diskGb: updated.diskGb,
      proxmoxNodeId: updated.proxmoxNodeId,
      ipAddress: updated.ipAddress,
      username: updated.username,
      hostname: updated.name,
      vmMacAddress: updated.vmMacAddress,
      renewalDueAt: updated.renewalDueAt,
      proxmoxPatch: Object.keys(proxmoxPatch),
    }
    await Promise.all([
      createAuditLog({ action: "ADMIN_VM_EDIT", actorEmail: String(admin.email), customerId: vps.customerId, targetType: "vps_instance", targetId: vps.id, oldValue, newValue, metadata: { reason, vmid: vps.vmid } }),
      createPanelLog({ category: "Provisioning", message: "admin_vm_edited", actorType: "admin", actorEmail: String(admin.email), customerId: vps.customerId, orderId: vps.orderId, vpsInstanceId: vps.id, vmid: vps.vmid, metadata: { reason, changed: Object.keys(newValue) } }),
      publishLiveVmSnapshot(vps.id, ipAddress ? "admin-edit:ip-change" : "admin-edit:complete"),
    ]).catch(() => null)

    return NextResponse.json({ success: true, vps: updated, changed: newValue })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || "Unable to edit VM" }, { status: 400 })
  }
}
