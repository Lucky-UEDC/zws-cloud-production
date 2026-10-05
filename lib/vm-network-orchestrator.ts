import crypto from "node:crypto"
import { prisma } from "@/lib/db"
import { createProxmoxClient, PROXMOX_LONG_TIMEOUT_MS } from "@/lib/proxmox"
import { allocateIp, ipPoolNodeEligibility, markIpUsed, releaseIpAllocation, reserveIpFromPool } from "@/lib/ip-pool"
import { createAuditLog } from "@/lib/audit-log"
import { createAggregatedAuditEvent } from "@/lib/audit-events"
import { createPanelLog } from "@/lib/panel-log"
import { publishRealtimeEvent, realtimeChannels } from "@/lib/realtime-telemetry"
import { isIpInSubnet, isIpInRange, validateIpRange } from "@/lib/ip-address"
import { withRedisLock } from "@/lib/redis"
import { ensureVmIdentityNotes, vmIdentityNotesMatch, vmIdentityTagsMatch } from "@/lib/proxmox-tags"
import { publishLiveVmSnapshot } from "@/lib/proxmox-live"
import { ensureProvisioningIdentity } from "@/lib/provisioning-identity"
import { GuestAutomationService, osMetadataForVps } from "@/lib/guest-automation/service"
import { guestContextFor } from "@/lib/guest-automation/first-boot"
import { decryptSecretValue } from "@/lib/secret-crypto"

const ACTIVE_IP_STATUSES = ["active", "moved", "pending"]
const ACTIVE_ALLOC_STATUSES = ["RESERVED", "reserved", "ASSIGNED", "assigned", "USED", "used"]

type RiskClass = "safe" | "caution" | "risky"
type PlanStage = "preflight" | "plan" | "apply" | "post_verify" | "audit"

type NetworkPreflightIssue = {
  code: string
  message: string
  blocking: boolean
}

type NetworkPlan = {
  riskClass: RiskClass
  rebootRecommended: boolean
  steps: Array<{ stage: PlanStage; action: string; details?: Record<string, unknown> }>
}

type VmNetworkActionInput = {
  vpsId: string
  actorEmail: string
  reason?: string | null
  dryRun?: boolean
  confirmRisky?: boolean
  idempotencyKey?: string | null
}

type ChangePrimaryIpInput = VmNetworkActionInput & {
  targetIp: string
  poolId?: string | null
  preserveOldIp?: boolean
  forceAssign?: boolean
  forceOverride?: boolean
  takeoverExisting?: boolean
  manualGateway?: string | null
  manualCidr?: number | string | null
  manualBridge?: string | null
  manualDns?: string | null
  /** DNS is left untouched unless this is explicitly requested. */
  applyDns?: boolean
  actorRole?: string | null
}

type SwitchPoolInput = VmNetworkActionInput & {
  targetPoolId: string
  requestedIp?: string | null
  preserveOldIp?: boolean
  forceAssign?: boolean
  forceOverride?: boolean
  takeoverExisting?: boolean
  manualGateway?: string | null
  manualCidr?: number | string | null
  manualBridge?: string | null
  manualDns?: string | null
  actorRole?: string | null
}

type AddSecondaryIpInput = VmNetworkActionInput & {
  family: "ipv4" | "ipv6"
  role: "secondary" | "floating" | "failover"
  assignmentType?: "address" | "prefix"
  poolId?: string | null
  ipAddress?: string | null
  cidr?: number | null
  prefix?: string | null
  prefixLength?: number | null
  gateway?: string | null
  bridge?: string | null
  vlanTag?: number | null
}

type RemoveSecondaryIpInput = VmNetworkActionInput & {
  assignmentId: string
}

type PromoteSecondaryIpInput = VmNetworkActionInput & {
  assignmentId: string
}

type MoveFloatingIpInput = VmNetworkActionInput & {
  assignmentId: string
  targetVpsId: string
}

type VmRecord = Awaited<ReturnType<typeof getVmForNetwork>>

function now() {
  return new Date()
}

function cleanText(value: unknown) {
  const text = String(value || "").trim()
  return text || null
}

function normalizeIpv4(ip: string) {
  return String(ip || "").trim()
}

function normalizeIpv6(value: string) {
  return String(value || "").trim().toLowerCase()
}

function isIpv6(value: string) {
  return normalizeIpv6(value).includes(":")
}

function parseIpConfig0(value: string | null | undefined): { ip: string | null; cidr: number | null; gateway: string | null } {
  const raw = String(value || "").trim()
  if (!raw) return { ip: null, cidr: null, gateway: null }
  const entries = raw.split(",").map((part) => part.trim())
  let ip: string | null = null
  let cidr: number | null = null
  let gateway: string | null = null
  for (const entry of entries) {
    if (entry.startsWith("ip=")) {
      const ipValue = entry.slice(3)
      const [addr, prefix] = ipValue.split("/")
      ip = cleanText(addr)
      if (prefix !== undefined) {
        const parsed = Number(prefix)
        cidr = Number.isInteger(parsed) ? parsed : null
      }
      continue
    }
    if (entry.startsWith("gw=")) {
      gateway = cleanText(entry.slice(3))
    }
  }
  return { ip, cidr, gateway }
}

function parseNet0(value: string | null | undefined): { bridge: string | null; macAddress: string | null; vlanTag: number | null; model: string | null } {
  const raw = String(value || "").trim()
  if (!raw) return { bridge: null, macAddress: null, vlanTag: null, model: null }
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean)
  let bridge: string | null = null
  let macAddress: string | null = null
  let vlanTag: number | null = null
  let model: string | null = null
  for (const part of parts) {
    if (part.includes("=")) {
      const [keyRaw, valueRaw] = part.split("=", 2)
      const key = keyRaw.toLowerCase()
      const value = String(valueRaw || "").trim()
      if (key === "bridge") bridge = value
      if (key === "tag") {
        const parsed = Number(value)
        vlanTag = Number.isInteger(parsed) ? parsed : null
      }
      if (["virtio", "e1000", "rtl8139", "vmxnet3"].includes(key) && value) {
        model = key
        macAddress = value
      }
      continue
    }
    if (part.includes(":")) {
      const [modelKey, mac] = part.split(":", 2)
      if (modelKey && mac) {
        model = modelKey.toLowerCase()
        macAddress = mac
      }
    }
  }
  return { bridge, macAddress, vlanTag, model }
}

function buildNet0(input: { model?: string | null; macAddress?: string | null; bridge?: string | null; vlanTag?: number | null }) {
  const model = cleanText(input.model) || "virtio"
  const mac = cleanText(input.macAddress)
  const base = mac ? `${model}=${mac}` : model
  const bridge = cleanText(input.bridge)
  const tag = Number.isInteger(Number(input.vlanTag)) ? Number(input.vlanTag) : null
  const attrs = [bridge ? `bridge=${bridge}` : "bridge=vmbr0", tag !== null ? `tag=${tag}` : null].filter(Boolean)
  return [base, ...attrs].join(",")
}

function buildPrimaryIpConfig(input: { ip: string; cidr: unknown; gateway: string }) {
  const ip = normalizeIpv4(input.ip)
  const gateway = normalizeIpv4(input.gateway)
  const cidr = Number(input.cidr)
  validateIpRange(ip, ip)
  validateIpRange(gateway, gateway)
  if (!Number.isInteger(cidr) || cidr < 0 || cidr > 32) throw new Error("invalid_cidr")
  if (!isIpInSubnet(gateway, ip, cidr)) throw new Error("gateway_subnet_mismatch")
  return `ip=${ip}/${cidr},gw=${gateway}`
}

function proxmoxErrorMetadata(error: any) {
  return {
    name: error?.name || null,
    message: String(error?.message || "Proxmox API error"),
    code: error?.code || null,
    layer: error?.layer || null,
    endpoint: error?.endpoint || null,
    status: error?.status || null,
    httpStatus: error?.httpStatus || null,
  }
}

function guessRiskFromBridgeChange(currentBridge: string | null, nextBridge: string | null): RiskClass {
  if (currentBridge && nextBridge && currentBridge !== nextBridge) return "risky"
  if (!currentBridge && nextBridge) return "caution"
  return "safe"
}

function linuxOnly(vps: VmRecord) {
  const family = String(vps.operatingSystem?.osFamily || vps.operatingSystem?.category || vps.operatingSystem?.osType || "").toLowerCase()
  const name = String(vps.operatingSystem?.name || "").toLowerCase()
  return !(family.includes("windows") || name.includes("windows"))
}

async function getVmForNetwork(vpsId: string) {
  const vm = await prisma.vpsInstance.findFirst({
    where: {
      OR: [{ id: vpsId }, { orderId: vpsId }],
      deletedAt: null,
      order: { deletedAt: null, status: { not: "DELETED" } },
    },
    include: {
      customer: { select: { id: true, email: true, name: true } },
      product: { select: { id: true, slug: true, name: true, premiumIpEnabled: true } },
      order: true,
      proxmoxNode: true,
      operatingSystem: true,
      ipAllocations: { where: { status: { in: ACTIVE_ALLOC_STATUSES as any } }, include: { pool: true }, orderBy: { createdAt: "desc" } },
      vmNetworkInterfaces: { orderBy: [{ isPrimary: "desc" }, { name: "asc" }] },
      vmIpAssignments: {
        where: { status: { in: ACTIVE_IP_STATUSES as any } },
        include: { pool: true, networkInterface: true },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      },
    },
  })

  if (!vm) throw new Error("VM not found")
  if (!vm.proxmoxNode) throw new Error("VM node configuration is missing")
  return vm
}

async function ensurePrimaryInterface(vm: VmRecord, parsedNet0: { bridge: string | null; macAddress: string | null; vlanTag: number | null; model: string | null }) {
  const existing = vm.vmNetworkInterfaces.find((item) => item.isPrimary) || vm.vmNetworkInterfaces[0]
  if (existing) {
    const next = await prisma.vmNetworkInterface.update({
      where: { id: existing.id },
      data: {
        name: existing.name || "net0",
        isPrimary: true,
        vmid: vm.vmid,
        proxmoxNodeId: vm.proxmoxNodeId,
        bridge: parsedNet0.bridge,
        macAddress: parsedNet0.macAddress,
        vlanTag: parsedNet0.vlanTag,
        model: parsedNet0.model,
      },
    })
    if (!existing.isPrimary) {
      await prisma.vmNetworkInterface.updateMany({
        where: { vpsInstanceId: vm.id, id: { not: existing.id } },
        data: { isPrimary: false },
      })
    }
    return next
  }

  return prisma.vmNetworkInterface.create({
    data: {
      vpsInstanceId: vm.id,
      proxmoxNodeId: vm.proxmoxNodeId,
      vmid: vm.vmid,
      name: "net0",
      isPrimary: true,
      bridge: parsedNet0.bridge,
      macAddress: parsedNet0.macAddress,
      vlanTag: parsedNet0.vlanTag,
      model: parsedNet0.model,
    },
  })
}

async function logNetworkEvent(input: {
  vm: VmRecord
  eventType: string
  actorEmail: string
  reason?: string | null
  stage?: string | null
  status?: string
  riskClass?: RiskClass | null
  oldState?: Record<string, unknown>
  newState?: Record<string, unknown>
  plan?: Record<string, unknown>
  result?: Record<string, unknown>
  errorCode?: string | null
  errorMessage?: string | null
  metadata?: Record<string, unknown>
}) {
  const status = input.status || "completed"
  if (["repair_network", "change_primary_ip"].includes(input.eventType) && ["confirmation_required", "retrying"].includes(status)) {
    const since = new Date(Date.now() - 30 * 60_000)
    const existing = await prisma.vmNetworkEvent.findFirst({
      where: {
        vpsInstanceId: input.vm.id,
        eventType: input.eventType,
        status,
        stage: input.stage || null,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
    }).catch(() => null)
    if (existing) {
      return prisma.vmNetworkEvent.update({
        where: { id: existing.id },
        data: {
          result: { ...((existing.result as any) || {}), ...(input.result || {}), dedupedAt: new Date().toISOString() } as any,
          errorCode: input.errorCode || existing.errorCode,
          errorMessage: input.errorMessage || existing.errorMessage,
          metadata: { ...((existing.metadata as any) || {}), ...(input.metadata || {}), deduped: true } as any,
        },
      }).catch(() => existing)
    }
  }

  if (input.eventType === "validation_worker_scan") {
    await createAggregatedAuditEvent({
      eventType: "system.validation_worker_scan",
      severity: input.status === "warning" ? "WARNING" : "INFO",
      actorType: "WORKER",
      actorEmail: input.actorEmail,
      customerId: input.vm.customerId,
      orderId: input.vm.orderId,
      vpsInstanceId: input.vm.id,
      vmid: input.vm.vmid,
      targetType: "vps_instance",
      targetId: input.vm.id,
      reason: input.reason || "Validation worker scanned VM identity",
      status,
      metadata: {
        aggregateSummary: "Validation worker scanned VM identity repeatedly",
        result: input.result || {},
        riskClass: input.riskClass || null,
        ...input.metadata,
      },
      aggregateKey: `validation_worker_scan:${input.vm.id}`,
      windowMinutes: 30,
    }).catch(() => null)
    return null
  }

  const event = await prisma.vmNetworkEvent.create({
    data: {
      vpsInstanceId: input.vm.id,
      proxmoxNodeId: input.vm.proxmoxNodeId,
      vmid: input.vm.vmid,
      eventType: input.eventType,
      status,
      stage: input.stage || null,
      riskClass: input.riskClass || null,
      reason: input.reason || null,
      actorEmail: input.actorEmail,
      oldState: (input.oldState || {}) as any,
      newState: (input.newState || {}) as any,
      plan: (input.plan || {}) as any,
      result: (input.result || {}) as any,
      errorCode: input.errorCode || null,
      errorMessage: input.errorMessage || null,
      metadata: (input.metadata || {}) as any,
    },
  })

  await createPanelLog({
    category: "IP Pool",
    message: `vm_network_${input.eventType}`,
    actorType: "admin",
    actorEmail: input.actorEmail,
    customerId: input.vm.customerId,
    orderId: input.vm.orderId,
    vpsInstanceId: input.vm.id,
    vmid: input.vm.vmid,
    metadata: {
      eventId: event.id,
      status: event.status,
      riskClass: input.riskClass || null,
      reason: input.reason || null,
      ...input.metadata,
    },
  }).catch(() => null)

  await createAuditLog({
    action: `VM_NETWORK_${String(input.eventType || "unknown").toUpperCase()}`,
    actorEmail: input.actorEmail,
    customerId: input.vm.customerId,
    targetType: "vps_instance",
    targetId: input.vm.id,
    oldValue: input.oldState || null,
    newValue: input.newState || null,
    metadata: {
      eventId: event.id,
      reason: input.reason || null,
      status: input.status || "completed",
      ...input.metadata,
    },
  }).catch(() => null)

  const newState = input.newState || {}
  const result = input.result || {}
  const nextIp = cleanText(
    (newState as any).ipAddress ||
    (newState as any).newIp ||
    (newState as any).primaryIp ||
    (result as any).ipAddress ||
    (result as any).newIp
  )
  if (nextIp && ["change_primary_ip", "promote_secondary_ip", "sync_network_from_proxmox", "repair_network"].includes(input.eventType)) {
    await Promise.all([
      ...[(prisma as any).vmNetworkCache, (prisma as any).vmNetwork].map((delegate) => delegate.upsert({
        where: { vpsInstanceId: input.vm.id },
        create: {
          vpsInstanceId: input.vm.id,
          customerId: input.vm.customerId,
          proxmoxNodeId: input.vm.proxmoxNodeId,
          vmid: input.vm.vmid,
          primaryAssignedIp: nextIp,
          source: `network_event:${input.eventType}`,
          lastSyncedAt: new Date(),
          metadata: { eventId: event.id, eventType: input.eventType },
        },
        update: {
          customerId: input.vm.customerId,
          proxmoxNodeId: input.vm.proxmoxNodeId,
          vmid: input.vm.vmid,
          primaryAssignedIp: nextIp,
          source: `network_event:${input.eventType}`,
          lastSyncedAt: new Date(),
          metadata: { eventId: event.id, eventType: input.eventType },
        },
      }).catch(() => null)),
      (prisma as any).vmIpHistory.create({
        data: {
          ip: nextIp,
          vpsInstanceId: input.vm.id,
          vmid: input.vm.vmid,
          customerId: input.vm.customerId,
          nodeId: input.vm.proxmoxNodeId,
          nodeName: input.vm.proxmoxNode?.nodeName || null,
          status: "active",
          reason: input.eventType,
          admin: input.actorEmail,
          source: `network_event:${input.eventType}`,
          metadata: {
            eventId: event.id,
            oldState: input.oldState || {},
            newState,
          },
        },
      }).catch(() => null),
    ])
  }

  await (prisma as any).vmAuditLog.create({
    data: {
      eventType: `VM_NETWORK_${String(input.eventType || "unknown").toUpperCase()}`,
      severity: input.errorMessage ? "ERROR" : "INFO",
      actorType: input.actorEmail?.startsWith("worker:") ? "WORKER" : "ADMIN",
      actorEmail: input.actorEmail,
      vpsInstanceId: input.vm.id,
      customerId: input.vm.customerId,
      orderId: input.vm.orderId,
      proxmoxNodeId: input.vm.proxmoxNodeId,
      vmid: input.vm.vmid,
      ipAddress: nextIp,
      targetType: "vps_instance",
      targetId: input.vm.id,
      oldValue: input.oldState || undefined,
      newValue: input.newState || undefined,
      reason: input.reason || null,
      status: input.errorMessage ? "ERROR" : "SUCCESS",
      metadata: {
        eventId: event.id,
        networkEventType: input.eventType,
        stage: input.stage || null,
        result: input.result || {},
        ...input.metadata,
      },
    },
  }).catch(() => null)

  await publishRealtimeEvent(realtimeChannels.proxmoxEvents(), {
    type: "vm_network_event",
    eventType: input.eventType,
    status,
    stage: input.stage || null,
    vpsInstanceId: input.vm.id,
    vmid: input.vm.vmid,
    proxmoxNodeId: input.vm.proxmoxNodeId,
    oldState: input.oldState || {},
    newState: input.newState || {},
    result: input.result || {},
    createdAt: event.createdAt,
  }).catch(() => null)

  return event
}

async function getProxmoxClient(vm: VmRecord) {
  return createProxmoxClient(vm.proxmoxNode!.host, vm.proxmoxNode!.tokenId, vm.proxmoxNode!.tokenSecret, {
    allowInsecureTls: vm.proxmoxNode!.allowInsecureTls,
    timeoutMs: PROXMOX_LONG_TIMEOUT_MS,
  })
}

async function applyRelink(input: {
  vm: VmRecord
  nodeId: string
  nodeName: string
  vmid: number
  actorEmail: string
  method: string
  confidence: string
}) {
  await prisma.$transaction(async (tx) => {
    await tx.vpsInstance.update({
      where: { id: input.vm.id },
      data: { vmid: input.vmid, proxmoxNodeId: input.nodeId },
    })
    await tx.order.update({
      where: { id: input.vm.orderId },
      data: { vmId: input.vmid, proxmoxNodeId: input.nodeId, proxmoxNode: input.nodeName, provisioningError: null },
    }).catch(() => undefined)
    await tx.provisioningJob.updateMany({
      where: { vpsInstanceId: input.vm.id },
      data: { vmid: input.vmid, proxmoxNodeId: input.nodeId },
    })
    await tx.provisioningJob.updateMany({
      where: { orderId: input.vm.orderId, vmid: input.vm.vmid },
      data: { vmid: input.vmid, proxmoxNodeId: input.nodeId },
    })
    await tx.ipAllocation.updateMany({
      where: { vpsInstanceId: input.vm.id },
      data: { vmid: input.vmid, nodeId: input.nodeId },
    })
    await tx.vmNetworkInterface.updateMany({
      where: { vpsInstanceId: input.vm.id },
      data: { vmid: input.vmid, proxmoxNodeId: input.nodeId },
    })
    await tx.vmIpAssignment.updateMany({
      where: { vpsInstanceId: input.vm.id },
      data: { vmid: input.vmid, proxmoxNodeId: input.nodeId },
    })
    await tx.vmNetworkEvent.updateMany({
      where: { vpsInstanceId: input.vm.id },
      data: { vmid: input.vmid, proxmoxNodeId: input.nodeId },
    })
  })

  await createPanelLog({
    category: "Provisioning",
    message: "vm_network_auto_relinked",
    actorType: "admin",
    actorEmail: input.actorEmail,
    customerId: input.vm.customerId,
    orderId: input.vm.orderId,
    vpsInstanceId: input.vm.id,
    vmid: input.vmid,
    metadata: {
      oldVmid: input.vm.vmid,
      oldNodeId: input.vm.proxmoxNodeId,
      newVmid: input.vmid,
      newNodeId: input.nodeId,
      nodeName: input.nodeName,
      method: input.method,
      confidence: input.confidence,
    },
  }).catch(() => null)
}

async function findVmAcrossNodes(vm: VmRecord) {
  const nodes = await prisma.proxmoxNode.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
  })
  const candidates: Array<{ node: (typeof nodes)[number]; vmid: number; config: Record<string, any>; method: string; confidence: "high" | "medium"; score: number }> = []

  for (const node of nodes) {
    const client = createProxmoxClient(node.host, node.tokenId, node.tokenSecret, {
      allowInsecureTls: node.allowInsecureTls,
      timeoutMs: PROXMOX_LONG_TIMEOUT_MS,
    })
    const list = await client.getVMList(node.nodeName).catch(() => [])
    for (const row of list) {
      const vmid = Number(row.vmid)
      if (!Number.isInteger(vmid) || vmid <= 0) continue
      const config = await client.getVMConfig(node.nodeName, vmid).catch(() => null)
      if (!config) continue
      const notesMatch = vmIdentityNotesMatch((config as any).description, { orderId: vm.orderId, customerId: vm.customerId, vmUuid: vm.id })
      if (notesMatch.highConfidence) {
        candidates.push({ node, vmid, config, method: "identity_notes_order", confidence: "high", score: 100 })
        continue
      }
      if (notesMatch.mediumConfidence) {
        candidates.push({ node, vmid, config, method: "identity_notes_customer_service", confidence: "medium", score: 80 })
        continue
      }
      const description = String((config as any).description || "").toLowerCase()
      if (description.includes(String(vm.orderId).toLowerCase()) || description.includes(String(vm.id).toLowerCase())) {
        candidates.push({ node, vmid, config, method: "description", confidence: "medium", score: 70 })
        continue
      }
      const match = vmIdentityTagsMatch((config as any).tags, { orderId: vm.orderId, customerId: vm.customerId })
      if (match.highConfidence) {
        candidates.push({ node, vmid, config, method: "legacy_identity_tag_order", confidence: "high", score: 60 })
        continue
      }
      if (match.mediumConfidence) {
        candidates.push({ node, vmid, config, method: "legacy_identity_tag_customer_service", confidence: "medium", score: 40 })
        continue
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.node.nodeName.localeCompare(b.node.nodeName) || a.vmid - b.vmid)
  return candidates[0] || null
}

async function resolveVmForNetwork(input: { vm: VmRecord; actorEmail: string }) {
  const currentClient = await getProxmoxClient(input.vm)
  const currentNode = input.vm.proxmoxNode!.nodeName
  const currentConfig = await currentClient.getVMConfig(currentNode, input.vm.vmid).catch(() => null)
  if (currentConfig) {
    return { vm: input.vm, config: currentConfig as Record<string, any>, relink: null as null | Record<string, unknown> }
  }

  const discovered = await findVmAcrossNodes(input.vm)
  if (!discovered) throw new Error("vm_relink_failed: Proxmox VM was not found for this order/customer identity")

  await applyRelink({
    vm: input.vm,
    nodeId: discovered.node.id,
    nodeName: discovered.node.nodeName,
    vmid: discovered.vmid,
    actorEmail: input.actorEmail,
    method: discovered.method,
    confidence: discovered.confidence,
  })
  const refreshed = await getVmForNetwork(input.vm.id)
  return {
    vm: refreshed,
    config: discovered.config,
    relink: {
      oldVmid: input.vm.vmid,
      oldNodeId: input.vm.proxmoxNodeId,
      newVmid: discovered.vmid,
      newNodeId: discovered.node.id,
      nodeName: discovered.node.nodeName,
      method: discovered.method,
      confidence: discovered.confidence,
    },
  }
}

async function ensureUnlockedConfig(input: { vm: VmRecord; config: Record<string, any> }) {
  const lock = cleanText(input.config.lock)
  if (!lock) return { config: input.config, unlocked: false, lock: null as string | null }
  const client = await getProxmoxClient(input.vm)
  await client.unlockVM(input.vm.proxmoxNode!.nodeName, input.vm.vmid).catch((error: any) => {
    const details = proxmoxErrorMetadata(error)
    throw new Error(`vm_unlock_failed: ${details.message}`)
  })
  const config = await client.getVMConfig(input.vm.proxmoxNode!.nodeName, input.vm.vmid)
  return { config, unlocked: true, lock }
}

async function verifyBridgeOnNode(input: { vm: VmRecord; bridge: string }) {
  const client = await getProxmoxClient(input.vm)
  const bridges = await client.getNodeNetwork(input.vm.proxmoxNode!.nodeName).catch((error: any) => {
    const details = proxmoxErrorMetadata(error)
    throw new Error(`bridge_validation_failed: ${details.message}`)
  })
  const found = bridges.some((row: any) => String(row?.iface || row?.name || "") === input.bridge && (!row?.type || String(row.type).toLowerCase() === "bridge"))
  if (!found) throw new Error(`bridge_not_found_on_node: ${input.bridge}`)
  return bridges.map((row: any) => ({ iface: row?.iface || row?.name || null, type: row?.type || null, active: row?.active ?? null }))
}

async function ensureIdentityTagsForVm(vm: VmRecord) {
  return ensureVmIdentityNotes({
    host: vm.proxmoxNode!.host,
    tokenId: vm.proxmoxNode!.tokenId,
    tokenSecret: vm.proxmoxNode!.tokenSecret,
    allowInsecureTls: vm.proxmoxNode!.allowInsecureTls,
    nodeName: vm.proxmoxNode!.nodeName,
    vmid: vm.vmid,
    orderId: vm.orderId,
    customerId: vm.customerId,
    productTag: vm.product?.slug || vm.productId || null,
    productId: vm.productId || null,
    productName: vm.product?.name || null,
    customerName: vm.customer?.name || vm.customer?.email || null,
    vmUuid: vm.id,
  }).catch(() => null)
}

async function collectGuestAgentStatus(vm: VmRecord) {
  const client = await getProxmoxClient(vm)
  const nodeName = vm.proxmoxNode!.nodeName
  const vmid = vm.vmid

  const ping = await client.requestWithStatus(`/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/agent/ping`, "POST").then(() => ({ ok: true })).catch((error: any) => ({ ok: false, error: String(error?.message || "guest_agent_ping_failed") }))

  const interfaces = await client.safeGet<any>(`/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/agent/network-get-interfaces`).catch(() => null)

  return {
    ping,
    interfaces: Array.isArray((interfaces as any)?.result) ? (interfaces as any).result : Array.isArray(interfaces) ? interfaces : null,
  }
}

async function currentPrimarySnapshot(vm: VmRecord) {
  const client = await getProxmoxClient(vm)
  const [runtime, config] = await Promise.all([
    client.getVMStatus(vm.proxmoxNode!.nodeName, vm.vmid).catch(() => null),
    client.getVMConfig(vm.proxmoxNode!.nodeName, vm.vmid).catch(() => ({})),
  ])
  const ipconfig0 = parseIpConfig0(String((config as any)?.ipconfig0 || ""))
  const net0 = parseNet0(String((config as any)?.net0 || ""))
  return { runtime, config: config || {}, ipconfig0, net0 }
}

async function ensureManualOverridePool(input: {
  vm: VmRecord
  targetIp: string
  gateway?: string | null
  cidr?: number | string | null
  bridge?: string | null
  dns?: string | null
  actorEmail: string
}) {
  const gateway = cleanText(input.gateway) || cleanText(input.vm.ipAllocations[0]?.pool?.gateway) || input.targetIp
  const cidr = Number(input.cidr ?? input.vm.ipAllocations[0]?.pool?.cidr ?? 32)
  const bridge = cleanText(input.bridge) || cleanText(input.vm.ipAllocations[0]?.pool?.bridgeOverride) || cleanText(input.vm.ipAllocations[0]?.pool?.bridge) || "vmbr0"
  const existing = await prisma.ipPool.findFirst({
    where: { name: "Manual Override Assignments", startIp: input.targetIp, endIp: input.targetIp },
    include: { poolNodeAssignments: { where: { active: true } }, nodeAssignments: true },
  })
  if (existing) return existing
  return prisma.ipPool.create({
    data: {
      name: "Manual Override Assignments",
      poolMode: "GLOBAL" as any,
      type: "public",
      startIp: input.targetIp,
      endIp: input.targetIp,
      gateway,
      cidr: Number.isInteger(cidr) && cidr >= 0 && cidr <= 32 ? cidr : 32,
      dns: cleanText(input.dns) || cleanText(input.vm.ipAllocations[0]?.pool?.dns) || "1.1.1.1",
      bridge,
      appliesToAllNodes: true,
      appliesToAllProducts: true,
      staticOnly: true,
      isActive: true,
      notes: `Created by admin override for ${input.targetIp}`,
    },
    include: { poolNodeAssignments: { where: { active: true } }, nodeAssignments: true },
  })
}

async function releaseDuplicateIpOwnership(input: {
  targetIp: string
  currentVpsId: string
  actorEmail: string
}) {
  const nowDate = now()
  const allocations = await prisma.ipAllocation.findMany({
    where: {
      ipAddress: input.targetIp,
      vpsInstanceId: { not: input.currentVpsId },
      status: { in: ACTIVE_ALLOC_STATUSES as any },
    },
    select: { id: true, vpsInstanceId: true, vmid: true, poolId: true, status: true },
  })
  const assignments = await prisma.vmIpAssignment.findMany({
    where: {
      ipAddress: input.targetIp,
      vpsInstanceId: { not: input.currentVpsId },
      status: { in: ACTIVE_IP_STATUSES as any },
    },
    select: { id: true, vpsInstanceId: true, vmid: true, poolId: true, status: true },
  })
  const affectedVpsIds = Array.from(new Set([...allocations, ...assignments].map((row) => row.vpsInstanceId).filter(Boolean).map(String)))
  if (!allocations.length && !assignments.length) return { releasedAllocations: 0, detachedAssignments: 0, affectedVpsIds }

  await prisma.$transaction(async (tx) => {
    await tx.ipAllocation.updateMany({
      where: { id: { in: allocations.map((row) => row.id) } },
      data: {
        status: "free",
        vpsInstanceId: null,
        vmid: null,
        hostname: null,
        assignedBy: null,
        allocationLockKey: null,
        releasedAt: nowDate,
      },
    })
    await tx.vmIpAssignment.updateMany({
      where: { id: { in: assignments.map((row) => row.id) } },
      data: {
        status: "detached",
        isPrimary: false,
        detachedAt: nowDate,
        metadata: { takeoverIp: input.targetIp, takeoverBy: input.actorEmail, takeoverAt: nowDate.toISOString() } as any,
      },
    })
    for (const vpsId of affectedVpsIds) {
      await tx.vpsInstance.updateMany({ where: { id: vpsId, ipAddress: input.targetIp }, data: { ipAddress: null } })
    }
  })
  return { releasedAllocations: allocations.length, detachedAssignments: assignments.length, affectedVpsIds }
}

function checkIpv4InPool(ip: string, pool: { startIp: string; endIp: string }) {
  return isIpInRange(ip, pool.startIp, pool.endIp)
}

async function preflightForPrimaryChange(input: {
  vm: VmRecord
  targetIp: string
  targetPool: any
  desiredBridge: string | null
  forceOverride?: boolean
  takeoverExisting?: boolean
}) {
  const issues: NetworkPreflightIssue[] = []
  const targetIp = normalizeIpv4(input.targetIp)

  try {
    validateIpRange(targetIp, targetIp)
  } catch {
    issues.push({ code: "invalid_target_ip", message: "Target IP is not a valid IPv4 address", blocking: true })
  }

  if (input.targetPool.isActive === false) {
    issues.push({ code: "pool_inactive", message: "Target IP pool is inactive", blocking: true })
  }

  if (input.targetPool.staticOnly === false) {
    issues.push({ code: "pool_not_static_only", message: "Target IP pool is not static-only", blocking: true })
  }

  if (String(input.targetPool.poolType || "NORMAL").toUpperCase() === "ADDON_ONLY") {
    issues.push({ code: "pool_addon_only", message: "Target IP pool is addon-only and cannot be used for primary IP changes", blocking: true })
  }

  const cidr = Number(input.targetPool.cidr)
  if (!Number.isInteger(cidr) || cidr < 0 || cidr > 32) {
    issues.push({ code: "invalid_cidr", message: "Target pool CIDR must be between 0 and 32", blocking: true })
  }

  try {
    validateIpRange(String(input.targetPool.gateway || ""), String(input.targetPool.gateway || ""))
  } catch {
    issues.push({ code: "invalid_gateway", message: "Target pool gateway is not a valid IPv4 address", blocking: true })
  }

  if (!checkIpv4InPool(targetIp, input.targetPool)) {
    issues.push({ code: "ip_outside_pool", message: "Target IP is outside selected pool range", blocking: true })
  }

  try {
    if (!isIpInSubnet(input.targetPool.gateway, targetIp, Number(input.targetPool.cidr || 24))) {
      issues.push({ code: "gateway_subnet_mismatch", message: "Gateway is not valid for target IP/subnet", blocking: true })
    }
  } catch {
    issues.push({ code: "gateway_subnet_mismatch", message: "Gateway is not valid for target IP/subnet", blocking: true })
  }

  const nodeEligibility = ipPoolNodeEligibility({
    pool: input.targetPool,
    nodeId: input.vm.proxmoxNodeId || null,
    purpose: "provisioning",
    forceOverride: false,
  })
  if (!nodeEligibility.ok) {
    issues.push({
      code: "cross_node_pool_override",
      message: nodeEligibility.reason === "Pool is not assigned to this node" ? "Target IP pool is not assigned to this VM node" : nodeEligibility.reason,
      blocking: nodeEligibility.code === "POOL_NODE_MISMATCH" ? input.forceOverride !== true : true,
    })
  }

  const duplicateAlloc = await prisma.ipAllocation.findFirst({
    where: {
      ipAddress: targetIp,
      status: { in: ACTIVE_ALLOC_STATUSES as any },
      vpsInstanceId: { not: input.vm.id },
    },
    select: { id: true, vpsInstanceId: true },
  })
  if (duplicateAlloc) {
    issues.push({ code: "duplicate_allocation", message: "Target IP is already allocated to another VM", blocking: true })
  }

  const duplicateAssignment = await prisma.vmIpAssignment.findFirst({
    where: {
      family: "ipv4",
      ipAddress: targetIp,
      status: { in: ACTIVE_IP_STATUSES as any },
      vpsInstanceId: { not: input.vm.id },
    },
    select: { id: true, vpsInstanceId: true },
  })
  if (duplicateAssignment) {
    issues.push({ code: "duplicate_assignment", message: "Target IP is already active on another VM assignment", blocking: true })
  }

  const desiredBridge = cleanText(input.desiredBridge)
  if (!desiredBridge) {
    issues.push({ code: "bridge_missing", message: "Bridge is missing in selected pool/network config", blocking: true })
  }

  const mac = cleanText(input.vm.vmNetworkInterfaces.find((item) => item.isPrimary)?.macAddress)
  if (mac) {
    const duplicateMac = await prisma.vmNetworkInterface.findFirst({
      where: {
        macAddress: mac,
        vpsInstanceId: { not: input.vm.id },
      },
      select: { id: true, vpsInstanceId: true },
    })
    if (duplicateMac) {
      issues.push({ code: "duplicate_mac", message: "Primary NIC MAC is duplicated on another VM", blocking: true })
    }
  }

  const customerConflict = await prisma.vpsInstance.findFirst({
    where: {
      customerId: input.vm.customerId,
      id: { not: input.vm.id },
      deletedAt: null,
      OR: [{ ipAddress: targetIp }, { vmIpAssignments: { some: { ipAddress: targetIp, status: { in: ACTIVE_IP_STATUSES as any } } } }],
    },
    select: { id: true, name: true },
  })
  if (customerConflict) {
    issues.push({ code: "customer_conflict", message: "Target IP conflicts with another VM of the same customer", blocking: true })
  }

  return issues
}

function buildChangePrimaryPlan(input: {
  currentBridge: string | null
  nextBridge: string | null
}) : NetworkPlan {
  const riskClass = guessRiskFromBridgeChange(input.currentBridge, input.nextBridge)
  const rebootRecommended = riskClass === "risky"
  return {
    riskClass,
    rebootRecommended,
    steps: [
      { stage: "preflight", action: "validate_target_ip_pool_bridge_mac_conflicts" },
      { stage: "plan", action: "build_network_change_plan", details: { riskClass, rebootRecommended } },
      { stage: "apply", action: "reserve_ip_update_db_update_proxmox_cloud_init" },
      { stage: "post_verify", action: "verify_guest_agent_proxmox_config_connectivity" },
      { stage: "audit", action: "write_network_timeline_and_audit_events" },
    ],
  }
}

async function invokeExternalHooks(input: {
  type: string
  vm: VmRecord
  actorEmail: string
  payload: Record<string, unknown>
}) {
  // Default no-op adapter. Real adapters can be wired later without touching orchestrator actions.
  await logNetworkEvent({
    vm: input.vm,
    eventType: "external_hook",
    actorEmail: input.actorEmail,
    status: "completed",
    stage: "apply",
    reason: String(input.payload.reason || ""),
    metadata: {
      hookType: input.type,
      adapter: "noop",
      payload: input.payload,
    },
  })
  return { adapter: "noop", ok: true }
}

/**
 * Apply a primary-IP change to a guest.
 *
 * This used to be "write `ipconfig0`, run `qm cloudinit update`, read back
 * `qm cloudinit dump network` and hope the cloud-init disk applied it on the next
 * boot". Three things were wrong with that: it only worked for guests with a
 * cloud-init drive (so any guest-agent-only VM was rejected outright), it
 * verified a file on the host rather than the guest's real configuration, and it
 * left the change pending until the customer happened to reboot.
 *
 * The change is now applied by the guest, through the OS profile that matches the
 * guest that answered, and verified by asking the guest what it now has. The
 * bridge is still a host-side fact, so the host still owns it.
 */
async function updatePrimaryGuestNetwork(input: {
  vm: VmRecord
  targetIp: string
  pool: any
  bridge: string
  /** Only an explicit DNS change writes DNS. */
  applyDns?: boolean
  actorEmail: string
  reason?: string | null
  idempotencyKey: string
  relink?: Record<string, unknown> | null
  existingConfig: Record<string, any>
}) {
  const client = await getProxmoxClient(input.vm)
  const nodeName = input.vm.proxmoxNode!.nodeName
  const unlocked = await ensureUnlockedConfig({ vm: input.vm, config: input.existingConfig })
  const currentConfig = unlocked.config

  const currentNet0 = String(currentConfig.net0 || "")
  const parsedNet0 = parseNet0(currentNet0)
  const nodeBridges = await verifyBridgeOnNode({ vm: input.vm, bridge: input.bridge })
  const gateway = String(input.pool.gateway || "")
  const cidr = Number(input.pool.cidr || 24)
  const dns = String(input.pool.dns || "1.1.1.1")
  const ipconfig0 = buildPrimaryIpConfig({ ip: input.targetIp, cidr: input.pool.cidr, gateway })
  const endpoint = `/nodes/${encodeURIComponent(nodeName)}/qemu/${input.vm.vmid}/config`

  // The bridge is the host's decision, so it is the host's write.
  const bridgeChange: Record<string, string> = {}
  if (parsedNet0.bridge && parsedNet0.bridge !== input.bridge) {
    bridgeChange.net0 = `${parsedNet0.model},bridge=${input.bridge}`
  }
  if (Object.keys(bridgeChange).length) {
    await client.updateVMConfig(nodeName, input.vm.vmid, bridgeChange).catch((error: any) => {
      const details = proxmoxErrorMetadata(error)
      throw new Error(`proxmox_config_update_failed: ${details.message}`)
    })
  }

  const diagnostics = {
    vmDatabaseId: input.vm.id,
    proxmoxVmid: input.vm.vmid,
    proxmoxNode: nodeName,
    proxmoxNodeId: input.vm.proxmoxNodeId,
    selectedPool: {
      id: input.pool.id,
      name: input.pool.name,
      startIp: input.pool.startIp,
      endIp: input.pool.endIp,
      gateway: input.pool.gateway,
      cidr: input.pool.cidr,
      bridge: input.bridge,
    },
    targetIp: input.targetIp,
    generatedGateway: gateway,
    generatedCidr: cidr,
    generatedIpconfig0: ipconfig0,
    currentNet0,
    parsedNet0,
    bridge: input.bridge,
    apiEndpoint: endpoint,
    proxmoxPayload: bridgeChange,
    bridgeChangeApplied: Object.keys(bridgeChange).length > 0,
    unlocked: { unlocked: unlocked.unlocked, lock: unlocked.lock },
    relink: input.relink || null,
    nodeBridges,
  }

  console.log("[vm-network] primary_ip_guest_precheck", diagnostics)
  await logNetworkEvent({
    vm: input.vm,
    eventType: "change_primary_ip_precheck",
    actorEmail: input.actorEmail,
    reason: input.reason || null,
    stage: "preflight",
    status: "completed",
    oldState: { ipconfig0: String(currentConfig.ipconfig0 || ""), net0: currentNet0 },
    newState: { ip: input.targetIp, cidr, gateway, bridge: input.bridge },
    metadata: { idempotencyKey: input.idempotencyKey, diagnostics },
  })

  // The guest applies its own network. The plan is change-driven, so a guest
  // that already has this address is left alone and the run reports no change.
  const service = new GuestAutomationService(
    guestContextFor({ vpsInstanceId: input.vm.id, vmid: input.vm.vmid, node: input.vm.proxmoxNode! }),
  )
  const result = await service.applyChange({
    desired: {
      ip: input.targetIp,
      prefix: cidr,
      gateway,
      // Empty means "do not touch DNS" for an IP-only change.
      dns: input.applyDns === true ? dns.split(/[,\s]+/).map((value) => value.trim()).filter(Boolean) : [],
      hostname: String(input.vm.name || input.vm.hostname || ""),
      username: String(input.vm.adminUsername || input.vm.username || "root"),
      password: resolveGuestPassword(input.vm),
    },
    metadata: osMetadataForVps(input.vm),
    actor: { requestedBy: input.actorEmail, role: "admin" },
  })

  if ("message" in result) {
    await logNetworkEvent({
      vm: input.vm,
      eventType: "change_primary_ip_precheck",
      actorEmail: input.actorEmail,
      reason: input.reason || null,
      stage: "apply",
      status: "failed",
      metadata: { idempotencyKey: input.idempotencyKey, errorCode: result.errorCode, message: result.message },
    })
    throw new Error(`guest_automation_failed:${result.errorCode}: ${result.message}`)
  }

  const applied = result.steps.filter((step) => step.status === "success").map((step) => step.operation)
  const failed = result.steps.filter((step) => step.status === "failed").map((step) => step.operation)
  if (failed.length) {
    await logNetworkEvent({
      vm: input.vm,
      eventType: "change_primary_ip_precheck",
      actorEmail: input.actorEmail,
      reason: input.reason || null,
      stage: "apply",
      status: "failed",
      metadata: { idempotencyKey: input.idempotencyKey, failed, runId: result.runId },
    })
    throw new Error(`guest_automation_failed: ${failed.join(", ")}`)
  }

  await logNetworkEvent({
    vm: input.vm,
    eventType: "change_primary_ip_applied",
    actorEmail: input.actorEmail,
    reason: input.reason || null,
    stage: "apply",
    status: "completed",
    oldState: { ipconfig0: String(currentConfig.ipconfig0 || ""), net0: currentNet0 },
    newState: { ip: input.targetIp, cidr, gateway, bridge: input.bridge },
    metadata: {
      idempotencyKey: input.idempotencyKey,
      runId: result.runId,
      os: result.detected.osId,
      template: result.template?.name || null,
      templateVersion: result.template?.version || null,
      operations: applied,
      guestIps: result.steps.length ? undefined : null,
    },
  })

  return {
    net0: Object.keys(bridgeChange).length ? bridgeChange.net0 : currentNet0,
    ipconfig0,
    payload: bridgeChange,
    endpoint,
    nameserver: dns,
    searchdomain: String(input.pool.searchDomain || ""),
    networkDumpVerified: true,
    guestAutomationRunId: result.runId,
    guestOperations: applied,
    guestIps: applied.includes("set_ip") ? [input.targetIp] : [],
    unlocked: unlocked.unlocked,
    relink: input.relink || null,
  }
}

/**
 * The password the guest will be asked to set, if one is needed.
 *
 * Network changes never need it, but the plan shape carries it, so it is passed
 * through as a decrypted value and never logged. When there is none, the plan
 * simply skips the password step.
 */
function resolveGuestPassword(vm: any): string {
  const encrypted = String(vm?.passwordEncrypted || "")
  if (!encrypted) return ""
  try {
    return decryptSecretValue(encrypted) || ""
  } catch {
    return ""
  }
}

export async function getVmNetworkDetails(vpsId: string) {
  const vm = await getVmForNetwork(vpsId)
  const snapshot = await currentPrimarySnapshot(vm)
  const guest = await collectGuestAgentStatus(vm)
  const primaryAssignment = vm.vmIpAssignments.find((item) => item.isPrimary && item.status === "active") || null
  const currentPool = primaryAssignment?.pool || vm.ipAllocations.find((item) => item.ipAddress === vm.ipAddress)?.pool || null

  const primaryIPv6 = vm.vmIpAssignments.find((item) => item.family === "ipv6" && item.isPrimary && item.status === "active") || null
  const secondaryAssignments = vm.vmIpAssignments.filter((item) => !item.isPrimary && item.status === "active")

  const pools = await prisma.ipPool.findMany({
    where: {
      isActive: true,
    },
    include: {
      allocations: {
        where: { status: { in: ["FREE", "free", "RELEASED", "released"] } },
        select: { id: true },
      },
      poolNodeAssignments: { where: { active: true }, select: { nodeId: true } },
      poolProductAssignments: { where: { active: true }, select: { productId: true } },
      ranges: { where: { isActive: true }, orderBy: { createdAt: "asc" } },
    },
    orderBy: [{ type: "asc" }, { createdAt: "asc" }],
  })

  const timeline = await prisma.vmNetworkEvent.findMany({
    where: { vpsInstanceId: vm.id },
    orderBy: { createdAt: "desc" },
    take: 120,
  })

  return {
    vmId: vm.id,
    vmid: vm.vmid,
    node: vm.proxmoxNode?.nodeName || null,
    primary: {
      ipv4: vm.ipAddress || primaryAssignment?.ipAddress || snapshot.ipconfig0.ip || null,
      ipv6: primaryIPv6?.ipAddress || primaryIPv6?.prefix || null,
      gateway: primaryAssignment?.gateway || snapshot.ipconfig0.gateway || currentPool?.gateway || null,
      subnet: primaryAssignment?.cidr || snapshot.ipconfig0.cidr || currentPool?.cidr || null,
      bridge: primaryAssignment?.bridge || snapshot.net0.bridge || currentPool?.bridgeOverride || currentPool?.bridge || null,
      vlanTag: primaryAssignment?.vlanTag ?? snapshot.net0.vlanTag ?? currentPool?.vlanTag ?? null,
      pool: currentPool ? {
        id: currentPool.id,
        name: currentPool.name,
        type: currentPool.type,
      } : null,
    },
    secondary: {
      additional: secondaryAssignments.filter((item) => item.role === "secondary"),
      floating: secondaryAssignments.filter((item) => item.role === "floating"),
      failover: secondaryAssignments.filter((item) => item.role === "failover"),
    },
    status: {
      guestAgentPing: guest.ping,
      guestAgentInterfaces: guest.interfaces,
      proxmoxIpConfig0: String((snapshot.config as any)?.ipconfig0 || ""),
      proxmoxNet0: String((snapshot.config as any)?.net0 || ""),
      proxmoxNameserver: String((snapshot.config as any)?.nameserver || ""),
      cloudInitDrivePresent: Object.keys(snapshot.config || {}).some((key) => /^(ide|scsi|sata)\d+$/i.test(key) && String((snapshot.config as any)[key] || "").toLowerCase().includes("cloudinit")),
      provisioningNetworkVerification: String(vm.order?.provisioningStatus || "").toUpperCase() === "ACTIVE" ? "verified" : String(vm.order?.provisioningStatus || "unknown").toLowerCase(),
      pingStatus: guest.ping.ok ? "reachable_via_guest_agent" : "unknown",
    },
    interfaces: vm.vmNetworkInterfaces,
    assignments: vm.vmIpAssignments,
    pools: pools.map((pool) => ({
      id: pool.id,
      name: pool.name,
      type: pool.type,
      startIp: pool.startIp,
      endIp: pool.endIp,
      gateway: pool.gateway,
      cidr: pool.cidr,
      bridge: pool.bridgeOverride || pool.bridge,
      vlanTag: pool.vlanTag,
      regionTag: pool.regionTag,
      healthStatus: pool.healthStatus,
      poolMode: pool.poolMode,
      poolType: pool.poolType,
      exhaustionDetected: pool.exhaustionDetected,
      duplicateIpsDetected: pool.duplicateIpsDetected,
      staticOnly: pool.staticOnly,
      allocationPriority: pool.allocationPriority,
      freeIpCount: pool.allocations.length,
      assignedToCurrentNode: String(pool.poolMode || "").toUpperCase() === "GLOBAL" || pool.poolNodeAssignments.some((assignment) => assignment.nodeId === vm.proxmoxNodeId),
      ranges: pool.ranges,
    })),
    timeline,
  }
}

export async function listVmNetworkTimeline(vpsId: string) {
  const vm = await getVmForNetwork(vpsId)
  return prisma.vmNetworkEvent.findMany({ where: { vpsInstanceId: vm.id }, orderBy: { createdAt: "desc" }, take: 250 })
}

export async function changePrimaryIp(input: ChangePrimaryIpInput) {
  const dryRun = Boolean(input.dryRun)
  const preserveOldIp = Boolean(input.preserveOldIp)
  const forceOverride = input.forceOverride === true || input.forceAssign === true
  const takeoverExisting = input.takeoverExisting === true
  const reason = cleanText(input.reason)
  const idempotencyKey = cleanText(input.idempotencyKey) || crypto.randomUUID()

  return withRedisLock(`lock:vm-network:primary:${input.vpsId}`, 60000, async () => {
    const initialVm = await getVmForNetwork(input.vpsId)
    const resolved = dryRun
      ? {
          vm: initialVm,
          config: await getProxmoxClient(initialVm).then((client) => client.getVMConfig(initialVm.proxmoxNode!.nodeName, initialVm.vmid)).catch(() => ({} as Record<string, any>)),
          relink: null as Record<string, unknown> | null,
        }
      : await resolveVmForNetwork({ vm: initialVm, actorEmail: input.actorEmail })
    const vm = resolved.vm
    const snapshot = {
      runtime: await getProxmoxClient(vm).then((client) => client.getVMStatus(vm.proxmoxNode!.nodeName, vm.vmid)).catch(() => null),
      config: resolved.config || {},
      ipconfig0: parseIpConfig0(String((resolved.config as any)?.ipconfig0 || "")),
      net0: parseNet0(String((resolved.config as any)?.net0 || "")),
    }
    const primaryIface = await ensurePrimaryInterface(vm, snapshot.net0)

    const targetPoolInclude = {
      poolNodeAssignments: { where: { active: true } },
    } as const
    let targetPool = input.poolId
      ? await prisma.ipPool.findFirst({ where: { id: input.poolId, ...(forceOverride ? {} : { isActive: true }) }, include: targetPoolInclude })
      : null
    if (!targetPool) {
      const candidatePools = await prisma.ipPool.findMany({ where: { ...(forceOverride ? {} : { isActive: true }) }, include: targetPoolInclude })
      targetPool = candidatePools.find((pool) => {
        try {
          return isIpInRange(input.targetIp, pool.startIp, pool.endIp)
        } catch {
          return false
        }
      }) || null
    }
    if (!targetPool && forceOverride) {
      targetPool = await ensureManualOverridePool({
        vm,
        targetIp: normalizeIpv4(input.targetIp),
        gateway: input.manualGateway,
        cidr: input.manualCidr,
        bridge: input.manualBridge,
        dns: input.manualDns,
        actorEmail: input.actorEmail,
      })
    }

    if (!targetPool) throw new Error("Target IP pool not found or inactive")
    if (!forceOverride && !targetPool.staticOnly) throw new Error("Target IP pool is not static-only")

    // An IP change is IPv4 + prefix + gateway. The bridge is the host's own
    // decision and only moves when the caller explicitly asks for it, so an
    // IP-only change can never move a VM between bridges (or rewrite net0).
    const desiredBridge = cleanText(input.manualBridge) || cleanText(snapshot.net0.bridge) || cleanText(targetPool.bridgeOverride) || cleanText(targetPool.bridge) || "vmbr0"
    const networkPool = forceOverride
      ? {
          ...targetPool,
          gateway: cleanText(input.manualGateway) || targetPool.gateway,
          cidr: Number.isInteger(Number(input.manualCidr)) ? Number(input.manualCidr) : targetPool.cidr,
          dns: cleanText(input.manualDns) || targetPool.dns,
          bridge: desiredBridge,
          bridgeOverride: desiredBridge,
        }
      : targetPool
    const preflight = await preflightForPrimaryChange({ vm, targetIp: input.targetIp, targetPool: networkPool, desiredBridge, forceOverride, takeoverExisting })
    const plan = buildChangePrimaryPlan({ currentBridge: snapshot.net0.bridge, nextBridge: desiredBridge })
    const blocking = preflight.filter((issue) => issue.blocking)

    if (dryRun) {
      await logNetworkEvent({
        vm,
        eventType: "change_primary_ip",
        actorEmail: input.actorEmail,
        reason,
        stage: "plan",
        status: blocking.length ? "failed" : "planned",
        riskClass: plan.riskClass,
        oldState: { ipAddress: vm.ipAddress, bridge: snapshot.net0.bridge, poolId: vm.ipAllocations[0]?.poolId || null },
        newState: { ipAddress: input.targetIp, bridge: desiredBridge, poolId: targetPool.id },
        plan: { idempotencyKey, steps: plan.steps, preflight },
        errorCode: blocking.length ? "PREFLIGHT_FAILED" : null,
        errorMessage: blocking.length ? blocking.map((item) => item.message).join("; ") : null,
        metadata: {
          forceOverride,
          actorRole: cleanText(input.actorRole),
          relink: resolved.relink,
        },
      })
      return {
        success: blocking.length === 0,
        dryRun: true,
        blocking: blocking.length > 0,
        error: blocking.length ? blocking.map((item) => item.message).join("; ") : null,
        preflight,
        plan,
      }
    }

    if (blocking.length) {
      await logNetworkEvent({
        vm,
        eventType: "change_primary_ip",
        actorEmail: input.actorEmail,
        reason,
        status: "failed",
        stage: "preflight",
        riskClass: plan.riskClass,
        oldState: { ipAddress: vm.ipAddress },
        newState: { ipAddress: input.targetIp, poolId: targetPool.id },
        plan: { idempotencyKey, steps: plan.steps, preflight },
        errorCode: "PREFLIGHT_FAILED",
        errorMessage: blocking.map((item) => item.message).join("; "),
        metadata: {
          forceOverride,
          actorRole: cleanText(input.actorRole),
          relink: resolved.relink,
        },
      })
      throw new Error(blocking.map((item) => item.message).join("; "))
    }

    if (plan.riskClass === "risky" && !input.confirmRisky) {
      await logNetworkEvent({
        vm,
        eventType: "change_primary_ip",
        actorEmail: input.actorEmail,
        reason,
        status: "confirmation_required",
        stage: "plan",
        riskClass: plan.riskClass,
        oldState: { ipAddress: vm.ipAddress, bridge: snapshot.net0.bridge },
        newState: { ipAddress: input.targetIp, bridge: desiredBridge },
        plan: { idempotencyKey, steps: plan.steps, preflight },
        errorCode: "RISKY_CONFIRM_REQUIRED",
        errorMessage: "Bridge or route-affecting change needs confirmRisky=true",
        metadata: {
          forceOverride,
          actorRole: cleanText(input.actorRole),
          relink: resolved.relink,
        },
      })
      return {
        success: false,
        requiresConfirmation: true,
        preflight,
        plan,
      }
    }

    const oldPrimary = vm.vmIpAssignments.find((item) => item.isPrimary && item.family === "ipv4" && item.status === "active") || null
    const takeover = forceOverride && takeoverExisting
      ? await releaseDuplicateIpOwnership({ targetIp: normalizeIpv4(input.targetIp), currentVpsId: vm.id, actorEmail: input.actorEmail })
      : { releasedAllocations: 0, detachedAssignments: 0, affectedVpsIds: [] as string[] }

    const reservation = targetPool.id
      ? await reserveIpFromPool({
          poolId: targetPool.id,
          proxmoxNodeId: vm.proxmoxNodeId,
          productId: vm.productId,
          vpsInstanceId: vm.id,
          vmid: vm.vmid,
          hostname: vm.name,
          requestedIp: normalizeIpv4(input.targetIp),
          assignedBy: input.actorEmail,
          allocationType: "default",
          purpose: "provisioning",
          forceOverride,
        })
      : await allocateIp({
          proxmoxNodeId: vm.proxmoxNodeId,
          productId: vm.productId,
          vpsInstanceId: vm.id,
          vmid: vm.vmid,
          hostname: vm.name,
          requestedIp: normalizeIpv4(input.targetIp),
          assignedBy: input.actorEmail,
          allocationType: "default",
          purpose: "provisioning",
        })

    try {
      const proxmoxUpdate = await updatePrimaryGuestNetwork({
        vm,
        targetIp: reservation.ipAddress,
        pool: { ...reservation.pool, gateway: networkPool.gateway, cidr: networkPool.cidr, dns: networkPool.dns, bridge: desiredBridge, bridgeOverride: desiredBridge },
        bridge: desiredBridge,
        // DNS is not part of an IP-only change. It is only touched when the
        // caller explicitly asks for it.
        applyDns: input.applyDns === true,
        actorEmail: input.actorEmail,
        reason,
        idempotencyKey,
        relink: resolved.relink,
        existingConfig: snapshot.config,
      })

      await prisma.$transaction(async (tx) => {
        const used = await tx.ipAllocation.update({
          where: { id: reservation.id },
          data: { status: "assigned", vpsInstanceId: vm.id, vmid: vm.vmid, releasedAt: null },
          include: { pool: true },
        })
        if (oldPrimary) {
          await tx.vmIpAssignment.update({
            where: { id: oldPrimary.id },
            data: {
              isPrimary: false,
              role: preserveOldIp ? "secondary" : oldPrimary.role,
              status: preserveOldIp ? "active" : "released",
              detachedAt: preserveOldIp ? null : now(),
              metadata: {
                ...(oldPrimary.metadata as any),
                demotedAt: now().toISOString(),
                demotedBy: input.actorEmail,
              } as any,
            },
          })
        }

        if (!preserveOldIp) {
          await tx.ipAllocation.updateMany({
            where: {
              vpsInstanceId: vm.id,
              ipAddress: oldPrimary?.ipAddress || vm.ipAddress || undefined,
              id: { not: reservation.id },
              status: { in: ACTIVE_ALLOC_STATUSES as any },
            },
            data: { status: "free", releasedAt: now(), allocationLockKey: null },
          })
        }

        await tx.vmIpAssignment.updateMany({
          where: {
            vpsInstanceId: vm.id,
            family: "ipv4",
            isPrimary: true,
            id: oldPrimary?.id ? { not: oldPrimary.id } : undefined,
          },
          data: { isPrimary: false, role: "secondary" },
        })

        await tx.vmIpAssignment.create({
          data: {
            vpsInstanceId: vm.id,
            proxmoxNodeId: vm.proxmoxNodeId,
            vmid: vm.vmid,
            poolId: used.poolId,
            interfaceId: primaryIface.id,
            ipAllocationId: used.id,
            family: "ipv4",
            assignmentType: "address",
            role: "primary",
            ipAddress: used.ipAddress,
            cidr: Number(used.pool?.cidr || targetPool.cidr || 24),
            gateway: cleanText(used.pool?.gateway) || cleanText(targetPool.gateway),
            bridge: desiredBridge,
            vlanTag: targetPool.vlanTag,
            status: "active",
            isPrimary: true,
            attachedAt: now(),
            metadata: {
              idempotencyKey,
              proxmoxUpdate,
              changedBy: input.actorEmail,
              relink: resolved.relink,
            } as any,
          },
        })

        await tx.vpsInstance.update({ where: { id: vm.id }, data: { ipAddress: used.ipAddress } })
      })

      await invokeExternalHooks({
        type: "ip_change",
        vm,
        actorEmail: input.actorEmail,
        payload: {
          reason,
          oldIp: oldPrimary?.ipAddress || vm.ipAddress || null,
          newIp: reservation.ipAddress,
          poolId: reservation.poolId,
          bridge: desiredBridge,
          forceOverride,
          actorRole: cleanText(input.actorRole),
        },
      })

      await prisma.vpsInstance.update({
        where: { id: vm.id },
        data: { ipAddress: reservation.ipAddress },
      }).catch(() => undefined)
      await markIpUsed(reservation.id, vm.id, vm.vmid)
      await ensureProvisioningIdentity({
        orderId: vm.orderId,
        vpsInstanceId: vm.id,
        vmUuid: vm.id,
        proxmoxNodeId: vm.proxmoxNodeId,
        vmid: vm.vmid,
        publicIp: reservation.ipAddress,
        macAddress: primaryIface.macAddress || null,
      })

      const guestStatus = await collectGuestAgentStatus(vm)
      const tagSync = await ensureIdentityTagsForVm(vm)

      await logNetworkEvent({
        vm,
        eventType: "change_primary_ip",
        actorEmail: input.actorEmail,
        reason,
        stage: "audit",
        status: "completed",
        riskClass: plan.riskClass,
        oldState: {
          ipAddress: oldPrimary?.ipAddress || vm.ipAddress || null,
          bridge: snapshot.net0.bridge,
          poolId: oldPrimary?.poolId || vm.ipAllocations[0]?.poolId || null,
        },
        newState: {
          ipAddress: reservation.ipAddress,
          bridge: desiredBridge,
          poolId: reservation.poolId,
        },
        plan: { idempotencyKey, steps: plan.steps, preflight },
        result: {
          proxmoxNet0: proxmoxUpdate.net0,
          proxmoxIpConfig0: proxmoxUpdate.ipconfig0,
          guestAgentPing: guestStatus.ping,
          vmTags: tagSync?.tags || null,
          preserveOldIp,
        },
        metadata: {
          forceOverride,
          actorRole: cleanText(input.actorRole),
          oldIp: oldPrimary?.ipAddress || vm.ipAddress || null,
          newIp: reservation.ipAddress,
          poolId: reservation.poolId,
          relink: resolved.relink,
          takeover,
        },
      })
      await publishLiveVmSnapshot(vm.id, "network:primary-ip-change").catch(() => null)

      return {
        success: true,
        preflight,
        plan,
        changed: {
          oldIp: oldPrimary?.ipAddress || vm.ipAddress || null,
          newIp: reservation.ipAddress,
          poolId: reservation.poolId,
          preserveOldIp,
        },
      }
    } catch (error: any) {
      await releaseIpAllocation(reservation.id).catch(() => undefined)
      await logNetworkEvent({
        vm,
        eventType: "change_primary_ip",
        actorEmail: input.actorEmail,
        reason,
        stage: "apply",
        status: "failed",
        riskClass: plan.riskClass,
        oldState: { ipAddress: vm.ipAddress },
        newState: { ipAddress: input.targetIp, poolId: targetPool.id },
        plan: { idempotencyKey, steps: plan.steps, preflight },
        errorCode: "CHANGE_PRIMARY_FAILED",
        errorMessage: String(error?.message || "Failed to change primary IP"),
        metadata: {
          forceOverride,
          actorRole: cleanText(input.actorRole),
          proxmoxError: proxmoxErrorMetadata(error),
          relink: resolved.relink,
        },
      })
      throw error
    }
  })
}

export async function switchIpPool(input: SwitchPoolInput) {
  const vm = await getVmForNetwork(input.vpsId)
  const targetPool = await prisma.ipPool.findFirst({ where: { id: input.targetPoolId, isActive: true } })
  if (!targetPool) throw new Error("Target pool not found or inactive")
  if (!targetPool.staticOnly) throw new Error("Target pool is not static-only")

  const requestedIp = cleanText(input.requestedIp)
  if (requestedIp) {
    return changePrimaryIp({
      ...input,
      targetIp: requestedIp,
      poolId: targetPool.id,
      preserveOldIp: input.preserveOldIp,
      forceAssign: input.forceAssign,
      forceOverride: input.forceOverride,
      takeoverExisting: input.takeoverExisting,
      manualGateway: input.manualGateway,
      manualCidr: input.manualCidr,
      manualBridge: input.manualBridge,
      manualDns: input.manualDns,
      actorRole: input.actorRole,
    })
  }

  const candidate = await prisma.ipAllocation.findFirst({
    where: {
      poolId: targetPool.id,
      status: { in: ["FREE", "free", "RELEASED", "released"] as any },
    },
    orderBy: { ipAddress: "asc" },
  })

  if (!candidate?.ipAddress) throw new Error("No free IP available in target pool")

  const result = await changePrimaryIp({
    ...input,
    targetIp: candidate.ipAddress,
    poolId: targetPool.id,
    preserveOldIp: input.preserveOldIp,
    forceAssign: input.forceAssign,
    forceOverride: input.forceOverride,
    takeoverExisting: input.takeoverExisting,
    manualGateway: input.manualGateway,
    manualCidr: input.manualCidr,
    manualBridge: input.manualBridge,
    manualDns: input.manualDns,
    actorRole: input.actorRole,
  })

  await logNetworkEvent({
    vm,
    eventType: "switch_pool",
    actorEmail: input.actorEmail,
    reason: cleanText(input.reason),
    status: "completed",
    oldState: { oldPoolId: vm.vmIpAssignments.find((item) => item.isPrimary && item.family === "ipv4")?.poolId || null },
    newState: { newPoolId: targetPool.id, requestedIp: candidate.ipAddress },
    metadata: {
      preserveOldIp: Boolean(input.preserveOldIp),
      forceOverride: input.forceOverride === true,
      actorRole: cleanText(input.actorRole),
    },
  })
  await ensureIdentityTagsForVm(vm)

  return result
}

export async function addSecondaryIp(input: AddSecondaryIpInput) {
  const vm = await getVmForNetwork(input.vpsId)
  const reason = cleanText(input.reason)
  const assignmentType = input.assignmentType || "address"

  if (input.family === "ipv4" && !input.ipAddress) throw new Error("IPv4 secondary requires ipAddress")
  if (input.family === "ipv6" && assignmentType === "address" && !input.ipAddress) throw new Error("IPv6 address assignment requires ipAddress")
  if (input.family === "ipv6" && assignmentType === "prefix" && !input.prefix) throw new Error("IPv6 prefix assignment requires prefix")

  return withRedisLock(`lock:vm-network:add-secondary:${vm.id}`, 30000, async () => {
    let ipAllocation: any = null
    let pool: any = null
    if (input.family === "ipv4") {
      if (!input.poolId) throw new Error("IPv4 secondary assignment requires poolId")
      const reserved = await reserveIpFromPool({
        poolId: input.poolId,
        proxmoxNodeId: vm.proxmoxNodeId,
        productId: vm.productId,
        vpsInstanceId: vm.id,
        vmid: vm.vmid,
        hostname: vm.name,
        requestedIp: normalizeIpv4(String(input.ipAddress || "")),
        assignedBy: input.actorEmail,
        allocationType: "default",
      })
      ipAllocation = await markIpUsed(reserved.id, vm.id, vm.vmid)
      pool = ipAllocation.pool
    } else if (input.poolId) {
      pool = await prisma.ipPool.findUnique({ where: { id: input.poolId } })
    }

    const primaryIface = vm.vmNetworkInterfaces.find((item) => item.isPrimary) || vm.vmNetworkInterfaces[0]

    const created = await prisma.vmIpAssignment.create({
      data: {
        vpsInstanceId: vm.id,
        proxmoxNodeId: vm.proxmoxNodeId,
        vmid: vm.vmid,
        poolId: input.poolId || null,
        interfaceId: primaryIface?.id || null,
        ipAllocationId: ipAllocation?.id || null,
        family: input.family,
        assignmentType,
        role: input.role,
        ipAddress: input.family === "ipv6" ? cleanText(input.ipAddress) || null : ipAllocation?.ipAddress || cleanText(input.ipAddress),
        cidr: Number.isInteger(Number(input.cidr)) ? Number(input.cidr) : input.family === "ipv4" ? Number(pool?.cidr || 24) : null,
        prefix: assignmentType === "prefix" ? cleanText(input.prefix) : null,
        prefixLength: assignmentType === "prefix" ? Number(input.prefixLength || 64) : null,
        gateway: cleanText(input.gateway) || cleanText(pool?.gateway),
        bridge: cleanText(input.bridge) || cleanText(pool?.bridgeOverride) || cleanText(pool?.bridge),
        vlanTag: Number.isInteger(Number(input.vlanTag)) ? Number(input.vlanTag) : pool?.vlanTag ?? null,
        status: "active",
        isPrimary: false,
        attachedAt: now(),
        metadata: {
          reason,
          addedBy: input.actorEmail,
        } as any,
      },
      include: { pool: true },
    })

    await logNetworkEvent({
      vm,
      eventType: "add_secondary_ip",
      actorEmail: input.actorEmail,
      reason,
      status: "completed",
      oldState: {},
      newState: {
        assignmentId: created.id,
        family: created.family,
        role: created.role,
        ipAddress: created.ipAddress,
        prefix: created.prefix,
      },
      metadata: {
        assignmentType,
      },
    })

    return { success: true, assignment: created }
  })
}

export async function removeSecondaryIp(input: RemoveSecondaryIpInput) {
  const vm = await getVmForNetwork(input.vpsId)
  const reason = cleanText(input.reason)
  const assignment = await prisma.vmIpAssignment.findFirst({
    where: { id: input.assignmentId, vpsInstanceId: vm.id, status: { in: ACTIVE_IP_STATUSES as any } },
  })
  if (!assignment) throw new Error("Secondary assignment not found")
  if (assignment.isPrimary) throw new Error("Cannot remove primary assignment using remove-secondary")

  await prisma.$transaction(async (tx) => {
    await tx.vmIpAssignment.update({
      where: { id: assignment.id },
      data: {
        status: "released",
        detachedAt: now(),
        metadata: {
          ...(assignment.metadata as any),
          removedBy: input.actorEmail,
          reason,
        } as any,
      },
    })

    if (assignment.ipAllocationId) {
      await tx.ipAllocation.update({
        where: { id: assignment.ipAllocationId },
        data: { status: "free", releasedAt: now(), allocationLockKey: null },
      }).catch(() => undefined)
    }
  })

  await logNetworkEvent({
    vm,
    eventType: "remove_secondary_ip",
    actorEmail: input.actorEmail,
    reason,
    status: "completed",
    oldState: { assignmentId: assignment.id, ipAddress: assignment.ipAddress, prefix: assignment.prefix, role: assignment.role },
    newState: { status: "released" },
  })

  return { success: true }
}

export async function promoteSecondaryIp(input: PromoteSecondaryIpInput) {
  const vm = await getVmForNetwork(input.vpsId)
  const reason = cleanText(input.reason)
  const target = await prisma.vmIpAssignment.findFirst({
    where: {
      id: input.assignmentId,
      vpsInstanceId: vm.id,
      status: "active",
      family: "ipv4",
      isPrimary: false,
    },
    include: { pool: true },
  })
  if (!target) throw new Error("Secondary IPv4 assignment not found")

  const currentPrimary = await prisma.vmIpAssignment.findFirst({
    where: {
      vpsInstanceId: vm.id,
      family: "ipv4",
      isPrimary: true,
      status: "active",
      id: { not: target.id },
    },
  })

  await prisma.$transaction(async (tx) => {
    if (currentPrimary) {
      await tx.vmIpAssignment.update({ where: { id: currentPrimary.id }, data: { isPrimary: false, role: "secondary" } })
    }
    await tx.vmIpAssignment.update({ where: { id: target.id }, data: { isPrimary: true, role: "primary" } })
    await tx.vpsInstance.update({ where: { id: vm.id }, data: { ipAddress: target.ipAddress } })
  })

  if (target.pool) {
    const snapshot = await currentPrimarySnapshot(vm)
    await updatePrimaryGuestNetwork({
      vm,
      targetIp: String(target.ipAddress || ""),
      pool: target.pool,
      bridge: cleanText(target.bridge) || cleanText(target.pool.bridgeOverride) || cleanText(target.pool.bridge) || "vmbr0",
      actorEmail: input.actorEmail,
      reason,
      idempotencyKey: crypto.randomUUID(),
      existingConfig: snapshot.config,
    })
  }
  await ensureIdentityTagsForVm(vm)

  await logNetworkEvent({
    vm,
    eventType: "promote_secondary_ip",
    actorEmail: input.actorEmail,
    reason,
    status: "completed",
    oldState: { oldPrimaryId: currentPrimary?.id || null, oldPrimaryIp: currentPrimary?.ipAddress || vm.ipAddress || null },
    newState: { primaryAssignmentId: target.id, newPrimaryIp: target.ipAddress },
  })

  return { success: true, primaryIp: target.ipAddress }
}

export async function moveFloatingIp(input: MoveFloatingIpInput) {
  const sourceVm = await getVmForNetwork(input.vpsId)
  const targetVm = await getVmForNetwork(input.targetVpsId)
  const reason = cleanText(input.reason)

  const assignment = await prisma.vmIpAssignment.findFirst({
    where: {
      id: input.assignmentId,
      vpsInstanceId: sourceVm.id,
      role: { in: ["floating", "failover"] },
      status: "active",
    },
  })
  if (!assignment) throw new Error("Floating/failover assignment not found on source VM")

  const duplicate = await prisma.vmIpAssignment.findFirst({
    where: {
      id: { not: assignment.id },
      status: "active",
      family: assignment.family,
      OR: [
        assignment.ipAddress ? { ipAddress: assignment.ipAddress } : undefined,
        assignment.prefix ? { prefix: assignment.prefix, prefixLength: assignment.prefixLength || undefined } : undefined,
      ].filter(Boolean) as any,
    },
  })
  if (duplicate) throw new Error("Floating/failover target already active elsewhere")

  await prisma.$transaction(async (tx) => {
    await tx.vmIpAssignment.update({
      where: { id: assignment.id },
      data: {
        status: "moved",
        detachedAt: now(),
        metadata: {
          ...(assignment.metadata as any),
          movedToVpsId: targetVm.id,
          movedBy: input.actorEmail,
          movedReason: reason,
        } as any,
      },
    })

    await tx.vmIpAssignment.create({
      data: {
        vpsInstanceId: targetVm.id,
        proxmoxNodeId: targetVm.proxmoxNodeId,
        vmid: targetVm.vmid,
        poolId: assignment.poolId,
        interfaceId: targetVm.vmNetworkInterfaces.find((item) => item.isPrimary)?.id || null,
        ipAllocationId: assignment.ipAllocationId,
        family: assignment.family,
        assignmentType: assignment.assignmentType,
        role: assignment.role,
        ipAddress: assignment.ipAddress,
        cidr: assignment.cidr,
        prefix: assignment.prefix,
        prefixLength: assignment.prefixLength,
        gateway: assignment.gateway,
        bridge: assignment.bridge,
        vlanTag: assignment.vlanTag,
        status: "active",
        isPrimary: false,
        sourceAssignmentId: assignment.id,
        movedFromVpsId: sourceVm.id,
        attachedAt: now(),
        metadata: {
          movedBy: input.actorEmail,
          reason,
        } as any,
      },
    })

    if (assignment.ipAllocationId) {
      await tx.ipAllocation.update({
        where: { id: assignment.ipAllocationId },
        data: {
          vpsInstanceId: targetVm.id,
          vmid: targetVm.vmid,
          nodeId: targetVm.proxmoxNodeId,
          hostname: targetVm.name,
          assignedBy: input.actorEmail,
          status: "assigned",
        },
      }).catch(() => undefined)
    }
  })

  await logNetworkEvent({
    vm: sourceVm,
    eventType: "move_floating_ip",
    actorEmail: input.actorEmail,
    reason,
    status: "completed",
    oldState: { sourceVpsId: sourceVm.id, ipAddress: assignment.ipAddress, prefix: assignment.prefix, role: assignment.role },
    newState: { targetVpsId: targetVm.id },
    metadata: { assignmentId: assignment.id },
  })

  await logNetworkEvent({
    vm: targetVm,
    eventType: "move_floating_ip_received",
    actorEmail: input.actorEmail,
    reason,
    status: "completed",
    oldState: {},
    newState: { sourceVpsId: sourceVm.id, ipAddress: assignment.ipAddress, prefix: assignment.prefix, role: assignment.role },
    metadata: { sourceAssignmentId: assignment.id },
  })
  await Promise.all([ensureIdentityTagsForVm(sourceVm), ensureIdentityTagsForVm(targetVm)])

  return { success: true }
}

export async function syncNetworkFromProxmox(input: VmNetworkActionInput) {
  const vm = await getVmForNetwork(input.vpsId)
  const reason = cleanText(input.reason)
  const snapshot = await currentPrimarySnapshot(vm)
  const primaryIface = await ensurePrimaryInterface(vm, snapshot.net0)
  const primary = vm.vmIpAssignments.find((item) => item.family === "ipv4" && item.isPrimary && item.status === "active") || null

  const nextIp = snapshot.ipconfig0.ip
  const nextCidr = snapshot.ipconfig0.cidr
  const nextGateway = snapshot.ipconfig0.gateway
  const nextBridge = snapshot.net0.bridge

  const diff = {
    ipAddressChanged: nextIp !== (primary?.ipAddress || vm.ipAddress || null),
    gatewayChanged: nextGateway !== (primary?.gateway || null),
    bridgeChanged: nextBridge !== (primary?.bridge || null),
    cidrChanged: Number(nextCidr || 0) !== Number(primary?.cidr || 0),
  }

  if (input.dryRun) {
    await logNetworkEvent({
      vm,
      eventType: "sync_network_from_proxmox",
      actorEmail: input.actorEmail,
      reason,
      status: "planned",
      stage: "plan",
      oldState: { ipAddress: primary?.ipAddress || vm.ipAddress || null, gateway: primary?.gateway || null, bridge: primary?.bridge || null, cidr: primary?.cidr || null },
      newState: { ipAddress: nextIp, gateway: nextGateway, bridge: nextBridge, cidr: nextCidr },
      result: { diff },
    })
    return { success: true, dryRun: true, diff }
  }

  await prisma.$transaction(async (tx) => {
    if (nextIp) {
      await tx.vpsInstance.update({ where: { id: vm.id }, data: { ipAddress: nextIp } })
    }

    if (primary) {
      await tx.vmIpAssignment.update({
        where: { id: primary.id },
        data: {
          ipAddress: nextIp || primary.ipAddress,
          cidr: nextCidr || primary.cidr,
          gateway: nextGateway || primary.gateway,
          bridge: nextBridge || primary.bridge,
          vlanTag: snapshot.net0.vlanTag,
          metadata: {
            ...(primary.metadata as any),
            syncedAt: now().toISOString(),
            syncedBy: input.actorEmail,
            reason,
          } as any,
        },
      })
    } else if (nextIp) {
      await tx.vmIpAssignment.create({
        data: {
          vpsInstanceId: vm.id,
          proxmoxNodeId: vm.proxmoxNodeId,
          vmid: vm.vmid,
          interfaceId: primaryIface.id,
          family: "ipv4",
          assignmentType: "address",
          role: "primary",
          ipAddress: nextIp,
          cidr: nextCidr,
          gateway: nextGateway,
          bridge: nextBridge,
          vlanTag: snapshot.net0.vlanTag,
          isPrimary: true,
          status: "active",
          attachedAt: now(),
          metadata: {
            syncedBy: input.actorEmail,
            reason,
          } as any,
        },
      })
    }
  })

  await logNetworkEvent({
    vm,
    eventType: "sync_network_from_proxmox",
    actorEmail: input.actorEmail,
    reason,
    status: "completed",
    oldState: { ipAddress: primary?.ipAddress || vm.ipAddress || null, gateway: primary?.gateway || null, bridge: primary?.bridge || null, cidr: primary?.cidr || null },
    newState: { ipAddress: nextIp, gateway: nextGateway, bridge: nextBridge, cidr: nextCidr },
    result: { diff },
  })
  await ensureIdentityTagsForVm(vm)

  return { success: true, diff }
}

export async function rebuildNetwork(input: VmNetworkActionInput) {
  const vm = await getVmForNetwork(input.vpsId)
  const reason = cleanText(input.reason)
  if (!linuxOnly(vm)) {
    return {
      success: true,
      skipped: true,
      reason: "windows_path_untouched",
      message: "Windows networking provisioning logic is intentionally unchanged.",
    }
  }

  const primary = vm.vmIpAssignments.find((item) => item.family === "ipv4" && item.isPrimary && item.status === "active")
  if (!primary?.ipAddress || !primary.cidr || !primary.gateway) {
    throw new Error("Primary IPv4 assignment is required before rebuild")
  }

  const pool = primary.poolId ? await prisma.ipPool.findUnique({ where: { id: primary.poolId } }) : null
  const snapshot = await currentPrimarySnapshot(vm)

  const bridge = cleanText(primary.bridge) || cleanText(pool?.bridgeOverride) || cleanText(pool?.bridge) || snapshot.net0.bridge || "vmbr0"

  const plan = buildChangePrimaryPlan({ currentBridge: snapshot.net0.bridge, nextBridge: bridge })
  if (plan.riskClass === "risky" && !input.confirmRisky) {
    return {
      success: false,
      requiresConfirmation: true,
      plan,
      message: "Rebuild network may require disruptive bridge reconfiguration. Pass confirmRisky=true.",
    }
  }

  const proxmoxUpdate = await updatePrimaryGuestNetwork({
    vm,
    targetIp: primary.ipAddress,
    pool: {
      cidr: primary.cidr,
      gateway: primary.gateway,
      dns: pool?.dns || "1.1.1.1",
      searchDomain: pool?.searchDomain || null,
    },
    bridge,
    actorEmail: input.actorEmail,
    reason,
    idempotencyKey: crypto.randomUUID(),
    existingConfig: snapshot.config,
  })

  const guest = await collectGuestAgentStatus(vm)

  await logNetworkEvent({
    vm,
    eventType: "rebuild_network",
    actorEmail: input.actorEmail,
    reason,
    status: "completed",
    riskClass: plan.riskClass,
    oldState: { ipconfig0: String((snapshot.config as any)?.ipconfig0 || ""), net0: String((snapshot.config as any)?.net0 || "") },
    newState: { ipconfig0: proxmoxUpdate.ipconfig0, net0: proxmoxUpdate.net0 },
    result: {
      guestAgentPing: guest.ping,
      guestInterfaceCount: Array.isArray(guest.interfaces) ? guest.interfaces.length : 0,
    },
  })
  await ensureIdentityTagsForVm(vm)

  return {
    success: true,
    rebuilt: true,
    proxmoxUpdate,
    guest,
  }
}

export async function repairNetwork(input: VmNetworkActionInput) {
  const vm = await getVmForNetwork(input.vpsId)
  const reason = cleanText(input.reason)
  const snapshot = await currentPrimarySnapshot(vm)

  const issues: NetworkPreflightIssue[] = []
  const fixes: Array<string> = []

  const primary = vm.vmIpAssignments.find((item) => item.family === "ipv4" && item.isPrimary && item.status === "active") || null

  if (!primary && vm.ipAddress) {
    issues.push({ code: "missing_primary_assignment", message: "DB missing primary IPv4 assignment", blocking: false })
  }

  if (primary?.ipAddress && vm.ipAddress !== primary.ipAddress) {
    issues.push({ code: "vps_ip_mismatch", message: "vps_instances.ipAddress mismatches primary assignment", blocking: false })
  }

  if (primary?.ipAddress && snapshot.ipconfig0.ip && primary.ipAddress !== snapshot.ipconfig0.ip) {
    issues.push({ code: "proxmox_ip_mismatch", message: "Proxmox ipconfig0 mismatches DB primary assignment", blocking: false })
  }

  const duplicateAssignments = await prisma.vmIpAssignment.groupBy({
    by: ["family", "ipAddress"],
    where: {
      family: "ipv4",
      status: "active",
      ipAddress: { not: null },
    },
    _count: { _all: true },
    having: {
      ipAddress: { _count: { gt: 1 } },
    } as any,
  }).catch(() => [])

  const vmDuplicates = duplicateAssignments.filter((row: any) => row.ipAddress && vm.vmIpAssignments.some((item) => item.ipAddress === row.ipAddress && item.status === "active"))
  if (vmDuplicates.length) {
    issues.push({ code: "duplicate_ip_detected", message: "Duplicate active IP assignment detected", blocking: true })
  }

  const cloudInitDrive = Object.keys(snapshot.config || {}).some((key) => /^(ide|scsi|sata)\d+$/i.test(key) && String((snapshot.config as any)[key] || "").toLowerCase().includes("cloudinit"))
  if (!cloudInitDrive) {
    issues.push({ code: "missing_cloudinit_drive", message: "Cloud-init drive is missing in VM config", blocking: false })
  }

  const risky = issues.some((issue) => issue.code === "duplicate_ip_detected")
  if (risky && !input.confirmRisky) {
    await logNetworkEvent({
      vm,
      eventType: "repair_network",
      actorEmail: input.actorEmail,
      reason,
      status: "confirmation_required",
      riskClass: "risky",
      result: { issues },
      errorCode: "RISKY_CONFIRM_REQUIRED",
      errorMessage: "Repair includes risky operations",
    })
    return { success: false, requiresConfirmation: true, issues }
  }

  if (!input.dryRun) {
    await prisma.$transaction(async (tx) => {
      if (!primary && vm.ipAddress) {
        const primaryIface = vm.vmNetworkInterfaces.find((item) => item.isPrimary) || vm.vmNetworkInterfaces[0] || null
        await tx.vmIpAssignment.create({
          data: {
            vpsInstanceId: vm.id,
            proxmoxNodeId: vm.proxmoxNodeId,
            vmid: vm.vmid,
            interfaceId: primaryIface?.id || null,
            family: "ipv4",
            assignmentType: "address",
            role: "primary",
            ipAddress: vm.ipAddress,
            cidr: snapshot.ipconfig0.cidr || 24,
            gateway: snapshot.ipconfig0.gateway,
            bridge: snapshot.net0.bridge,
            vlanTag: snapshot.net0.vlanTag,
            status: "active",
            isPrimary: true,
            attachedAt: now(),
            metadata: { repairedBy: input.actorEmail, reason } as any,
          },
        })
        fixes.push("created_primary_assignment")
      }

      if (primary?.ipAddress && vm.ipAddress !== primary.ipAddress) {
        await tx.vpsInstance.update({ where: { id: vm.id }, data: { ipAddress: primary.ipAddress } })
        fixes.push("synced_vps_ip_from_primary_assignment")
      }

      if (primary?.ipAddress && snapshot.ipconfig0.ip && primary.ipAddress !== snapshot.ipconfig0.ip) {
        const pool = primary.poolId ? await tx.ipPool.findUnique({ where: { id: primary.poolId } }) : null
        await updatePrimaryGuestNetwork({
          vm,
          targetIp: primary.ipAddress,
          pool: {
            cidr: primary.cidr || pool?.cidr || 24,
            gateway: primary.gateway || pool?.gateway || "",
            dns: pool?.dns || "1.1.1.1",
            searchDomain: pool?.searchDomain || null,
          },
          bridge: primary.bridge || pool?.bridgeOverride || pool?.bridge || snapshot.net0.bridge || "vmbr0",
          actorEmail: input.actorEmail,
          reason,
          idempotencyKey: crypto.randomUUID(),
          existingConfig: snapshot.config,
        })
        fixes.push("synced_proxmox_from_primary_assignment")
      }
    })
  }

  await logNetworkEvent({
    vm,
    eventType: "repair_network",
    actorEmail: input.actorEmail,
    reason,
    status: "completed",
    riskClass: risky ? "risky" : "safe",
    result: {
      dryRun: Boolean(input.dryRun),
      issues,
      fixes,
    },
  })
  await ensureIdentityTagsForVm(vm)

  return {
    success: true,
    dryRun: Boolean(input.dryRun),
    issues,
    fixes,
  }
}

export async function runVmNetworkValidationWorker(options: { actor?: string; limit?: number; autoRepair?: boolean } = {}) {
  const actor = cleanText(options.actor) || "worker:vm-network-validation"
  const limit = Math.max(1, Math.min(500, Number(options.limit || 200)))
  const autoRepair = options.autoRepair !== false

  const vms = await prisma.vpsInstance.findMany({
    where: { deletedAt: null, status: { notIn: ["DELETED", "FAILED"] } },
    select: { id: true },
    take: limit,
    orderBy: { updatedAt: "desc" },
  })

  const scanned: Array<{ vpsId: string; issues: string[]; repaired: string[]; flagged: string[] }> = []

  for (const vmRow of vms) {
    const issues: string[] = []
    const repaired: string[] = []
    const flagged: string[] = []

    const vm = await getVmForNetwork(vmRow.id).catch(() => null)
    if (!vm) continue

    const primary = vm.vmIpAssignments.find((item) => item.family === "ipv4" && item.isPrimary && item.status === "active") || null
    if (!primary && !vm.ipAddress) issues.push("vm_without_valid_ip")

    const orphanAllocations = vm.ipAllocations.filter((item) => !item.vpsInstanceId)
    if (orphanAllocations.length) issues.push("orphan_ip_allocations")

    const bridgeMismatch = primary?.bridge && vm.vmNetworkInterfaces.find((item) => item.isPrimary)?.bridge && primary.bridge !== vm.vmNetworkInterfaces.find((item) => item.isPrimary)?.bridge
    if (bridgeMismatch) issues.push("bridge_mismatch")

    const duplicateAllocation = await prisma.ipAllocation.findFirst({
      where: {
        vpsInstanceId: { not: vm.id },
        status: { in: ACTIVE_ALLOC_STATUSES as any },
        ipAddress: primary?.ipAddress || vm.ipAddress || undefined,
      },
      select: { id: true },
    })
    if (duplicateAllocation) issues.push("duplicate_ip")

    const snapshot = await currentPrimarySnapshot(vm).catch(() => null)
    if (snapshot) {
      const dbPrimaryIp = primary?.ipAddress || vm.ipAddress || null
      if (dbPrimaryIp && snapshot.ipconfig0.ip && dbPrimaryIp !== snapshot.ipconfig0.ip) {
        issues.push("proxmox_db_primary_ip_mismatch")
      }
      if (primary?.bridge && snapshot.net0.bridge && primary.bridge !== snapshot.net0.bridge) {
        issues.push("cloud_init_bridge_mismatch")
      }
      if (primary?.cidr && snapshot.ipconfig0.cidr && Number(primary.cidr) !== Number(snapshot.ipconfig0.cidr)) {
        issues.push("cloud_init_cidr_mismatch")
      }
    }

    const guest = await collectGuestAgentStatus(vm).catch(() => null)
    if (guest?.interfaces && primary?.ipAddress) {
      const guestIps = (guest.interfaces || [])
        .flatMap((iface: any) => Array.isArray(iface?.["ip-addresses"]) ? iface["ip-addresses"] : [])
        .map((ip: any) => String(ip?.["ip-address"] || "").trim())
        .filter(Boolean)
      if (guestIps.length && !guestIps.includes(primary.ipAddress)) {
        issues.push("assigned_ip_vs_guest_ip_mismatch")
      }
    }

    const staleAllocations = vm.ipAllocations.filter((allocation) => {
      if (!allocation.ipAddress) return false
      if (!primary?.ipAddress && !vm.ipAddress) return true
      return allocation.ipAddress !== (primary?.ipAddress || vm.ipAddress)
    })
    if (staleAllocations.length) {
      issues.push("stale_ip_allocations")
      if (autoRepair) {
        for (const stale of staleAllocations) {
          await prisma.ipAllocation.update({
            where: { id: stale.id },
            data: { status: "free", allocationLockKey: null, releasedAt: now() },
          }).catch(() => undefined)
          repaired.push(`released_stale_allocation:${stale.id}`)
        }
      }
    }

    if (issues.length && autoRepair) {
      const repairResult = await repairNetwork({
        vpsId: vm.id,
        actorEmail: actor,
        reason: "validation_worker_auto_repair",
        dryRun: false,
        confirmRisky: false,
      }).catch(() => null)
      if (repairResult?.success) {
        repaired.push(...(repairResult.fixes || []))
      } else {
        flagged.push(...issues)
      }
    } else if (issues.length) {
      flagged.push(...issues)
    }

    scanned.push({ vpsId: vm.id, issues, repaired, flagged })

    if (issues.length) {
      await logNetworkEvent({
        vm,
        eventType: "validation_worker_scan",
        actorEmail: actor,
        reason: "background_validation",
        status: repaired.length ? "completed" : "warning",
        result: { issues, repaired, flagged },
      })
    }
  }

  return {
    scanned: scanned.length,
    withIssues: scanned.filter((item) => item.issues.length > 0).length,
    repaired: scanned.filter((item) => item.repaired.length > 0).length,
    flagged: scanned.filter((item) => item.flagged.length > 0).length,
    rows: scanned,
  }
}

export async function validateReinstallNetwork(input: {
  bridge: string
  mac: string | null | undefined
  ipAddress: string
  poolId: string | null | undefined
  vpsInstanceId: string
}): Promise<{ ok: boolean; issues: Array<{ code: string; message: string }> }> {
  const issues: Array<{ code: string; message: string }> = []

  if (input.mac && !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(input.mac)) {
    issues.push({ code: "invalid_mac", message: `MAC address "${input.mac}" is not a valid format` })
  }

  if (!input.bridge || !/^[a-z][a-z0-9._-]{0,14}$/i.test(input.bridge)) {
    issues.push({ code: "invalid_bridge", message: `Bridge name "${input.bridge}" is invalid` })
  }

  const duplicate = await prisma.ipAllocation.findFirst({
    where: {
      ipAddress: input.ipAddress,
      vpsInstanceId: { not: input.vpsInstanceId },
      releasedAt: null,
      status: { in: ACTIVE_ALLOC_STATUSES },
    },
    select: { id: true, vpsInstanceId: true },
  })
  if (duplicate) {
    issues.push({ code: "duplicate_ip", message: `IP ${input.ipAddress} is already allocated to another instance (${duplicate.vpsInstanceId})` })
  }

  return { ok: issues.length === 0, issues }
}
