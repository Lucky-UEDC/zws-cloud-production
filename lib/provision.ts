import crypto from "node:crypto"
import net from "node:net"
import { prisma } from "@/lib/db"
import { decryptSecretValue, encryptSecretValue } from "@/lib/secret-crypto"
import { allocateIp, assignableIpPoolStatus, markIpUsed, releaseIpAllocation } from "@/lib/ip-pool"
import { createProxmoxClient, PROXMOX_LONG_TIMEOUT_MS, ProxmoxError } from "@/lib/proxmox"
import { withRedisLock } from "@/lib/redis"
import { createPanelLog } from "@/lib/panel-log"
import { resolveCpuTopology } from "@/lib/cpu-topology"
import { resolveStoragePoolForPurchase, snapshotStoragePool, syncNodeStoragePools } from "@/lib/storage-pools"
import { robustlyStopVm } from "@/lib/vm-power-control"
import { recordCapacityAlert } from "@/lib/provisioning-alerts"
import { validateProvisioningPreflight } from "@/lib/provisioning-placement"
import { recoverIpBlockedProvisioning } from "@/lib/provisioning-ipam-recovery"
import { normalizeOsFamily } from "@/lib/os-template-normalization"
import { isWindowsOsTemplate, resolveAvailableOsTemplate } from "@/lib/os-template-availability"
import { acquireNodeWorkerSlot, recoverNodeWorkerSlots, releaseNodeWorkerSlot } from "@/lib/node-workers"
import { buildVmNotes } from "@/lib/proxmox-tags"
import {
  STEP_LABELS,
  displayStatusForStep,
  extractUpid,
  isTaskFailed,
  sanitizeProvisioningError,
  type ProxmoxTaskState,
  type ProvisioningStep,
} from "@/lib/provisioning-status"
import { sendNotification } from "@/lib/notifications/service"
import { WHATSAPP_TEMPLATE_KEYS } from "@/lib/whatsapp/template-registry"
import { lifecycleDates } from "@/lib/renewals"
import { getSiteUrl } from "@/lib/settings/site-settings"
import { publishRealtimeEvent, realtimeChannels } from "@/lib/realtime-telemetry"
import { calculateInvoiceTotals, invoiceTaxWriteFields } from "@/lib/invoices/tax"
import { discoverVmIpAddress } from "@/lib/vm-ip-discovery"
import { assertPaymentVerifiedForProvisioning } from "@/lib/payment-state"
import { persistVpsConsoleMetadata } from "@/lib/console-metadata"
import { ensureGuestBeforeStartAction } from "@/lib/vps-control"
import { buildPreBootVmConfig, guestContextFor, runFirstBoot } from "@/lib/guest-automation/first-boot"
import { GuestAutomationService } from "@/lib/guest-automation/service"
import { GUEST_ERROR_MESSAGES } from "@/lib/guest-automation/constants"
import { hostnameFromIp, normalizeServerTag } from "@/lib/vm-hostname"
import { expandGuestPrimaryDisk, waitForGuestExec } from "@/lib/vm-guest-disk"
import { resolveVmGuestOs, type VmGuestOsKind } from "@/lib/vm-os-detection"
import { publishLiveVmSnapshot } from "@/lib/proxmox-live"
import { validateReinstallNetwork } from "@/lib/vm-network-orchestrator"
import {
  acquireOrderProvisionLease,
  ensureProvisioningIdentity,
  getProvisioningIdentity,
  provisioningReplayState,
  recordCloneIntent,
  releaseOrderProvisionLease,
  setProvisioningPhase,
} from "@/lib/provisioning-identity"
import { findProxmoxVmsByOrder, scanDuplicateManagedVms } from "@/lib/vm-duplicate-quarantine"
import { paymentFlowError, paymentFlowLog } from "@/lib/payment-flow-log"
import { guestAgentChannelOpen } from "@/lib/proxmox-agent-flag"

type ProxmoxClient = ReturnType<typeof createProxmoxClient>

export const MIN_PROXMOX_VMID = 100
export const MAX_PROXMOX_VMID = 999999

type EnqueueType = "provision" | "upgrade" | "reinstall"
type EnqueueOptions = {
  retryBlocked?: boolean
  nodeId?: string | null
  ipAssignmentMode?: "automatic" | "manual" | string | null
  poolId?: string | null
  requestedIp?: string | null
  forceIpOverride?: boolean
}

type ServiceNotificationCustomer = {
  id?: string | null
  email?: string | null
  phone?: string | null
  name?: string | null
}

async function sendServiceStatusNotification(input: {
  templateKey: string
  customer: ServiceNotificationCustomer
  orderId?: string | null
  vpsInstanceId?: string | null
  variables: Record<string, string | number | null | undefined>
  metadata?: Record<string, unknown>
}) {
  const result = await sendNotification({
    type: "order",
    channels: ["email", "whatsapp"],
    user: {
      id: input.customer.id || null,
      email: input.customer.email || null,
      phone: input.customer.phone || null,
      name: input.customer.name || null,
    },
    data: {
      templateKey: input.templateKey,
      orderId: input.orderId || null,
      ...input.variables,
      metadata: {
        ...(input.metadata || {}),
        vpsInstanceId: input.vpsInstanceId || null,
      },
    },
  })
  paymentFlowLog("Service notification dispatched", {
    orderId: input.orderId || null,
    vpsInstanceId: input.vpsInstanceId || null,
    templateKey: input.templateKey,
    emailStatus: result.channels?.email?.status || null,
    whatsappStatus: result.channels?.whatsapp?.status || null,
    ok: result.ok,
  })
  return result
}

async function deploymentMessageVariables(input: {
  orderId: string
  customerName?: string | null
  hostname?: string | null
  ip?: string | null
  username?: string | null
  passwordEncrypted?: string | null
  os?: string | null
  plan?: string | null
  renewalDate?: Date | string | null
  vpsInstanceId?: string | null
  billingCycle?: string | null
  region?: string | null
  reverseDns?: string | null
  nameservers?: string | null
}) {
  const [siteUrl, invoice] = await Promise.all([
    getSiteUrl().catch(() => ""),
    prisma.invoice.findFirst({ where: { orderId: input.orderId, deletedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true, invoiceNumber: true } }).catch(() => null),
  ])
  const base = String(siteUrl || "").replace(/\/$/, "")
  const password = input.passwordEncrypted ? decryptSecret(input.passwordEncrypted) : ""
  paymentFlowLog("Credentials generated", { orderId: input.orderId, vpsInstanceId: input.vpsInstanceId || null, hostname: input.hostname || null, username: input.username || null, hasPassword: Boolean(password) })
  return {
    first_name: input.customerName || "there",
    userName: input.customerName || "there",
    hostname: input.hostname || "",
    server_ip: input.ip || "",
    ip: input.ip || "",
    primaryIp: input.ip || "",
    rdp_username: input.username || "",
    username: input.username || "",
    rdp_password: password,
    password,
    os_template: input.os || "",
    os: input.os || "",
    service_plan: input.plan || "",
    plan: input.plan || "",
    renewal_date: input.renewalDate ? new Date(input.renewalDate).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" }) : "",
    invoice_link: invoice?.invoiceNumber && base ? `${base}/invoice/${invoice.invoiceNumber}` : "",
    payment_link: invoice?.id && base ? `${base}/client-area/billing/invoices/${invoice.id}` : "",
    panel_link: base ? `${base}/client-area/vps/${input.vpsInstanceId || ""}` : "",
    control_panel_link: base ? `${base}/client-area/vps/${input.vpsInstanceId || ""}` : "",
    dashboard_url: base ? `${base}/client-area` : "",
    billing_cycle: input.billingCycle || "Monthly",
    region: input.region || "",
    reverse_dns: input.reverseDns || "",
    nameservers: input.nameservers || "1.1.1.1, 8.8.8.8",
    infrastructure: "Enterprise NVMe replicated storage, BGP optimized transit, and managed deployment automation",
  }
}

function provisioningDiagnostics(error: any, input: { nodeName?: string | null; job?: any; step?: string | null; vmid?: number | null }) {
  const endpoint = error?.endpoint || error?.url || error?.request?.url || null
  const response = error?.proxmoxResponse || error?.response || error?.body || error?.data || null
  const proxmoxMessage = error?.proxmoxMessage || null
  const safeMessage = sanitizeProvisioningError(error)
  return {
    endpoint,
    proxmoxEndpoint: endpoint,
    proxmoxResponse: response,
    proxmoxMessage,
    safeMessage,
    errorCode: error?.code || null,
    httpStatus: error?.httpStatus || error?.status || null,
    node: input.nodeName || null,
    taskUpid: input.job?.latestUpid || error?.upid || null,
    retryAttempts: input.job?.attempts || 0,
    currentStage: input.step || input.job?.currentStep || null,
    suggestedFix: endpoint ? "Verify Proxmox API reachability, credentials, node state, and task details before retrying." : "Open provisioning logs, verify node capacity, then retry provisioning.",
    automationTrace: {
      jobId: input.job?.id || null,
      vmid: input.vmid || input.job?.vmid || null,
      errorName: error?.name || null,
      errorCode: error?.code || null,
      httpStatus: error?.status || error?.httpStatus || null,
    },
  }
}

export function encryptSecret(value: string): string {
  return encryptSecretValue(value)
}

export function decryptSecret(value: string): string {
  return decryptSecretValue(value)
}

export function generateRandomPassword(length = 20): string {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+"
  const bytes = crypto.randomBytes(length)
  return Array.from(bytes, (byte) => charset[byte % charset.length]).join("")
}

export function isValidLinuxHostname(hostname: string): boolean {
  const normalized = String(hostname || "").trim()
  if (!normalized || normalized.length > 253) return false
  return normalized.split(".").every((label) => (
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)
  ))
}

function hostnameForOrder(order: { id: string; orderNumber?: string | null }) {
  const suffix = String(order.orderNumber || order.id)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(-16)
  return `vps-${suffix || order.id.slice(0, 8)}`
}

function addMonths(date: Date, months: number) {
  const next = new Date(date)
  next.setMonth(next.getMonth() + months)
  return next
}

function renewalAmountForOrder(order: any) {
  const base = Number(order.product?.price1m || order.unitPrice || order.subtotal || order.totalAmount || 0)
  return Number.isFinite(base) ? Number(base.toFixed(2)) : 0
}

function getClientForNode(node: { host: string; tokenId: string; tokenSecret: string; allowInsecureTls: boolean }) {
  return createProxmoxClient(node.host, node.tokenId, node.tokenSecret, {
    allowInsecureTls: node.allowInsecureTls,
    timeoutMs: PROXMOX_LONG_TIMEOUT_MS,
  })
}

function ciUserForTemplate(template: { osType?: string | null; category?: string | null }) {
  if (isWindowsOsTemplate(template)) return "Administrator"
  return "root"
}

function sanitizeLogValue(value: any): any {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(sanitizeLogValue)
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== "object") return value

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const normalized = key.toLowerCase()
      if (
        normalized.includes("password") ||
        normalized.includes("secret") ||
        normalized.includes("authorization") ||
        normalized === "auth" ||
        normalized === "cipassword" ||
        normalized === "tokenid" ||
        normalized === "tokensecret"
      ) {
        return [key, "[redacted]"]
      }
      return [key, sanitizeLogValue(entry)]
    }),
  )
}

async function logJob(
  jobId: string,
  input: {
    step?: string
    level?: string
    event: string
    message: string
    request?: any
    response?: any
    upid?: string | null
  },
) {
  const row = await prisma.provisioningTaskLog.create({
    data: {
      jobId,
      step: input.step || null,
      level: input.level || "info",
      event: input.event,
      message: input.message,
      request: input.request ? sanitizeLogValue(input.request) : undefined,
      response: input.response ? sanitizeLogValue(input.response) : undefined,
      upid: input.upid || null,
    },
  })
  const job = await prisma.provisioningJob.findUnique({
    where: { id: jobId },
    select: { customerId: true, orderId: true, vpsInstanceId: true, vmid: true, proxmoxNodeId: true },
  }).catch(() => null)
  const streamPayload = {
    id: `provisioning:${row.id}`,
    source: "provisioning",
    level: row.level || "info",
    event: row.event,
    message: row.message,
    createdAt: row.createdAt?.toISOString ? row.createdAt.toISOString() : row.createdAt,
    metadata: { jobId, step: row.step, vmid: job?.vmid || null },
  }
  if (job?.proxmoxNodeId) await publishRealtimeEvent(realtimeChannels.nodeLogs(job.proxmoxNodeId), streamPayload).catch(() => null)
  if (job?.vpsInstanceId) await publishRealtimeEvent(realtimeChannels.vpsLogs(job.vpsInstanceId), streamPayload).catch(() => null)
  if (input.level === "error" || input.event.includes("completed") || input.event.includes("failed") || input.event.includes("ip:")) {
    await createPanelLog({
      category: "Provisioning",
      level: (input.level as any) || "info",
      message: input.message,
      customerId: job?.customerId || null,
      orderId: job?.orderId || null,
      vpsInstanceId: job?.vpsInstanceId || null,
      vmid: job?.vmid || null,
      metadata: {
        jobId,
        step: input.step || null,
        event: input.event,
        request: input.request ? sanitizeLogValue(input.request) : undefined,
        response: input.response ? sanitizeLogValue(input.response) : undefined,
        upid: input.upid || null,
      },
    })
  }
}

async function setJobDisplay(jobId: string, step: ProvisioningStep, status = "running", error?: string | null) {
  await prisma.provisioningJob.update({
    where: { id: jobId },
    data: {
      status,
      currentStep: step,
      displayStatus: error ? STEP_LABELS.FAILED : displayStatusForStep(step),
      error: error || null,
      ...(status === "running" ? { startedAt: new Date() } : {}),
    },
  })
}

async function upsertStep(jobId: string, step: ProvisioningStep, data: Record<string, any> = {}) {
  return prisma.provisioningTaskStep.upsert({
    where: { jobId_step: { jobId, step } },
    update: { label: STEP_LABELS[step], ...data },
    create: { jobId, step, label: STEP_LABELS[step], ...data },
  })
}

async function callWithRetry<T>(
  jobId: string,
  step: ProvisioningStep,
  event: string,
  request: any,
  fn: () => Promise<T>,
  retries = 2,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await logJob(jobId, { step, event: `${event}:request`, message: `Proxmox ${event} request`, request: { ...request, attempt: attempt + 1 } })
      const response = await fn()
      await logJob(jobId, { step, event: `${event}:response`, message: `Proxmox ${event} accepted`, request, response })
      return response
    } catch (error: any) {
      lastError = error
      await logJob(jobId, {
        step,
        level: attempt < retries ? "warn" : "error",
        event: `${event}:error`,
        message: sanitizeProvisioningError(error),
        request: { ...request, attempt: attempt + 1 },
        response: {
          code: error?.code || null,
          endpoint: error?.endpoint || null,
          proxmoxEndpoint: error?.endpoint || null,
          status: error?.status || null,
          httpStatus: error?.httpStatus || null,
          layer: error?.layer || null,
          proxmoxMessage: error?.proxmoxMessage || null,
          proxmoxResponse: error?.proxmoxResponse || null,
          safeMessage: sanitizeProvisioningError(error),
          message: sanitizeProvisioningError(error),
        },
      })
      const retryable = Number(error?.status || 0) >= 500 || ["Connection timeout", "Connection failed"].includes(String(error?.message || ""))
      if (!retryable || attempt === retries) break
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
    }
  }
  throw lastError
}

async function waitForTaskStatus(jobId: string, client: ProxmoxClient, nodeName: string, step: ProvisioningStep, upid: string, timeoutMs = 600000, displayStatus?: string) {
  const started = Date.now()
  const jobMeta = await prisma.provisioningJob.findUnique({ where: { id: jobId }, select: { vmid: true } })
  await upsertStep(jobId, step, { status: "running", upid, startedAt: new Date(), error: null })
  await prisma.provisioningJob.update({ where: { id: jobId }, data: { latestUpid: upid, displayStatus: displayStatus || displayStatusForStep(step), currentStep: step } })

  while (Date.now() - started < timeoutMs) {
    const task = (await client.getTaskStatus(nodeName, upid).catch(() => ({ status: "running" }))) as ProxmoxTaskState
    if (!task?.status && Number(jobMeta?.vmid) > 0) {
      const verification = await verifyVm(client, nodeName, Number(jobMeta?.vmid))
      if (verification.exists) {
        await prisma.provisioningTaskStep.update({
          where: { jobId_step: { jobId, step } },
          data: { status: "completed", exitStatus: "OK", completedAt: new Date() },
        })
        await logJob(jobId, { step, event: "task:status_fallback", message: `${step} had empty task status; VM verified`, upid })
        return { status: "stopped", exitstatus: "OK" }
      }
    }
    const historyEntry = { at: new Date().toISOString(), status: task.status || null, exitstatus: task.exitstatus || null }
    const existing = await prisma.provisioningTaskStep.findUnique({ where: { jobId_step: { jobId, step } }, select: { taskHistory: true } })
    const history = Array.isArray(existing?.taskHistory) ? existing.taskHistory : []
    await prisma.provisioningTaskStep.update({
      where: { jobId_step: { jobId, step } },
      data: {
        status: task.status === "stopped" ? (task.exitstatus === "OK" ? "completed" : "failed") : "running",
        exitStatus: task.exitstatus || null,
        taskHistory: [...history.slice(-50), historyEntry],
        ...(task.status === "stopped" ? { completedAt: new Date() } : {}),
        ...(isTaskFailed(task) ? { error: String(task.exitstatus || "unknown exit status") } : {}),
      },
    })
    await logJob(jobId, { step, event: "task:status", message: `${step} task ${task.status || "unknown"}`, response: task, upid })

    if (task.status === "stopped") {
      if (task.exitstatus === "OK") return task
      throw new ProxmoxError(502, `Proxmox task failed: ${task.exitstatus || "unknown exit status"}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 2500))
  }

  throw new ProxmoxError(504, "Proxmox task timed out")
}

async function verifyVm(client: ProxmoxClient, nodeName: string, vmid: number) {
  const [status, config] = await Promise.all([
    client.getVMStatus(nodeName, vmid).catch(() => null),
    client.getVMConfig(nodeName, vmid).catch(() => null),
  ])
  const exists = Boolean(status || config)
  return { exists, status, config }
}

function vmIdentityMatches(config: any, input: { hostname?: string | null; orderId?: string | null; serviceId?: string | null }) {
  const fields = [
    config?.description,
    config?.tags,
  ].map((value) => String(value || "").toLowerCase())
  // Proxmox notes/tags may be used to recover the canonical VMID, but the
  // guest or Proxmox display hostname is never an identity key.
  const expected = [input.orderId, input.serviceId]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
  return expected.some((value) => fields.some((field) => field.includes(value)))
}

function normalizeMac(value: unknown) {
  const raw = String(value || "").trim().toLowerCase()
  const match = raw.match(/[0-9a-f]{2}(?::[0-9a-f]{2}){5}/i)
  return match ? match[0].toLowerCase() : null
}

function macFromNet0(value: unknown) {
  return normalizeMac(value)
}

function generateFreshMacAddress() {
  const bytes = Array.from(crypto.randomBytes(5))
  return ["02", ...bytes.map((byte) => byte.toString(16).padStart(2, "0"))].join(":")
}

function net0Value(macAddress: string | null | undefined, bridge?: string | null) {
  const model = macAddress ? `virtio=${macAddress}` : "virtio"
  return `${model},bridge=${bridge || "vmbr0"}`
}

async function applyFreshMacBeforeFirstBoot(input: {
  jobId: string
  client: ProxmoxClient
  nodeName: string
  vmid: number
  bridge?: string | null
  templateMac?: string | null
  skipRegenerate?: boolean
}) {
  const currentConfig = await input.client.getVMConfig(input.nodeName, input.vmid).catch(() => ({}))
  const currentMac = macFromNet0((currentConfig as any)?.net0)
  if (input.skipRegenerate && currentMac) return currentMac
  const freshMac = generateFreshMacAddress()
  if (input.templateMac && normalizeMac(input.templateMac) === freshMac) throw new Error("mac_generation_failed_template_match")
  await runTaskOperation(
    input.jobId,
    input.client,
    input.nodeName,
    "APPLYING_CLOUD_INIT",
    "mac_regenerate",
    { vmid: input.vmid, bridge: input.bridge || "vmbr0", previousMac: currentMac, templateMac: input.templateMac || null },
    () => input.client.updateVMConfig(input.nodeName, input.vmid, { net0: net0Value(freshMac, input.bridge) }),
    async () => macFromNet0((await input.client.getVMConfig(input.nodeName, input.vmid).catch(() => ({})) as any)?.net0) === freshMac,
    "Regenerating network identity",
  )
  await logJob(input.jobId, {
    step: "APPLYING_CLOUD_INIT",
    event: "mac:regenerated",
    message: "Fresh VM MAC address applied before first boot",
    response: { vmid: input.vmid, macAddress: freshMac, bridge: input.bridge || "vmbr0", previousMac: currentMac, templateMac: input.templateMac || null },
  })
  return freshMac
}

async function checkGuestAgent(client: ProxmoxClient, nodeName: string, vmid: number) {
  try {
    const response = await client.requestWithStatus(`/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/agent/ping`, "POST")
    return { ok: true, response }
  } catch (error) {
    return { ok: false, error: sanitizeProvisioningError(error) }
  }
}

async function ensureLinuxPasswordSshAccess(input: {
  jobId: string
  client: ProxmoxClient
  nodeName: string
  vmid: number
  username: string
  password: string
  accessMethod?: string | null
}) {
  if (!String(input.accessMethod || "").toUpperCase().includes("PASSWORD")) return
  await input.client.setVMGuestPassword(input.nodeName, input.vmid, input.username, input.password, false)
  const command = [
    "set -eu",
    "install -d -m 0755 /etc/ssh/sshd_config.d",
    "printf 'PasswordAuthentication yes\\nPermitRootLogin yes\\n' > /etc/ssh/sshd_config.d/00-zws-password-access.conf",
    "printf 'PasswordAuthentication yes\\nPermitRootLogin yes\\n' > /etc/ssh/sshd_config.d/zz-zws-password-access.conf",
    "if [ -f /etc/ssh/sshd_config.d/60-cloudimg-settings.conf ]; then cp /etc/ssh/sshd_config.d/60-cloudimg-settings.conf /etc/ssh/sshd_config.d/60-cloudimg-settings.conf.zwsbak.$(date +%s); sed -i -E 's/^[[:space:]]*#?[[:space:]]*PasswordAuthentication[[:space:]]+.*/PasswordAuthentication yes/I' /etc/ssh/sshd_config.d/60-cloudimg-settings.conf; fi",
    "touch /etc/ssh/sshd_config",
    "cp /etc/ssh/sshd_config /etc/ssh/sshd_config.zwsbak.$(date +%s)",
    "if grep -qiE '^[[:space:]]*#?[[:space:]]*PasswordAuthentication[[:space:]]+' /etc/ssh/sshd_config; then sed -i -E 's/^[[:space:]]*#?[[:space:]]*PasswordAuthentication[[:space:]]+.*/PasswordAuthentication yes/I' /etc/ssh/sshd_config; else printf '\\nPasswordAuthentication yes\\n' >> /etc/ssh/sshd_config; fi",
    "if grep -qiE '^[[:space:]]*#?[[:space:]]*PermitRootLogin[[:space:]]+' /etc/ssh/sshd_config; then sed -i -E 's/^[[:space:]]*#?[[:space:]]*PermitRootLogin[[:space:]]+.*/PermitRootLogin yes/I' /etc/ssh/sshd_config; else printf '\\nPermitRootLogin yes\\n' >> /etc/ssh/sshd_config; fi",
    "(systemctl restart ssh || systemctl restart sshd)",
    "sshd -T | grep -q '^passwordauthentication yes$'",
    "sshd -T | grep -q '^permitrootlogin yes$'",
  ].join(" && ")
  const started = await input.client.execVMGuestCommand(input.nodeName, input.vmid, ["/bin/sh", "-c", command])
  const status = await waitForGuestExec(input.client, input.nodeName, input.vmid, Number(started.pid), 30_000)
  const result = status?.result || status || {}
  if (!(result.exited === true || result.exited === 1) || Number(result.exitcode || 0) !== 0) {
    throw new Error("ssh_password_access_convergence_failed")
  }
  await logJob(input.jobId, {
    step: "VERIFYING_VM",
    event: "ssh_password_access:verified",
    message: "Password SSH access policy verified",
    response: { username: input.username, passwordAuthentication: true },
  })
}

async function waitForVmDeleted(client: ProxmoxClient, nodeName: string, vmid: number, { timeoutMs = 30_000, pollMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const vm = await verifyVm(client, nodeName, vmid)
    if (!vm.exists) return true
    await new Promise(r => setTimeout(r, pollMs))
  }
  return false
}

async function waitForGuestAgentReady(client: ProxmoxClient, nodeName: string, vmid: number, { timeoutMs = 300_000, pollMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const qga = await checkGuestAgent(client, nodeName, vmid)
    if (qga.ok) return { ok: true as const }
    await new Promise(r => setTimeout(r, pollMs))
  }
  return { ok: false as const, error: "guest_agent_timeout" }
}

function extractGuestIpv4Addresses(value: unknown) {
  const root = value && typeof value === "object" ? (value as any) : {}
  const interfaces = Array.isArray(root.result) ? root.result : Array.isArray(root) ? root : []
  const ips: string[] = []
  for (const iface of interfaces) {
    const addresses = Array.isArray(iface?.["ip-addresses"]) ? iface["ip-addresses"] : []
    for (const address of addresses) {
      const type = String(address?.["ip-address-type"] || "").toLowerCase()
      const ip = String(address?.["ip-address"] || "").trim()
      if (type === "ipv4" && ip && ip !== "127.0.0.1") ips.push(ip)
    }
  }
  return Array.from(new Set(ips))
}

function checkTcpReachable(host: string, port: number, timeoutMs = 6000) {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const socket = net.createConnection({ host, port })
    let settled = false
    const finish = (ok: boolean, error?: string) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok, error })
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false, "tcp_timeout"))
    socket.once("error", (error) => finish(false, error.message || "tcp_error"))
  })
}

type ProvisioningHardGateInput = {
  jobId: string
  client: ProxmoxClient
  nodeName: string
  vmid: number
  vpsInstanceId: string
  customerId?: string | null
  orderId?: string | null
  expectedIp: string
  expectedCidr: number
  expectedGateway: string
  expectedDns?: string | null
  expectedSearchDomain?: string | null
  expectedBridge?: string | null
  expectedMac?: string | null
  templateMac?: string | null
  expectedHostname?: string | null
  sshKeyRequired?: boolean
  isWindows: boolean
  /** Result of the guest-automation run that configured the guest. */
  guestAutomationEvidence?: unknown
}

/**
 * Prove the guest is configured, before anything is called delivered.
 *
 * The Cloud-Init version asserted that `ciuser`, `cipassword` and `nameserver`
 * were present in the Proxmox config, that a cloud-init disk was attached, and
 * that `qm cloudinit dump user` was non-empty. Every one of those checks is
 * gone: none of those fields are written any more.
 *
 * What replaces them is the only statement that can be wrong if the guest is
 * wrong — the guest's own report. The account must exist (read back through
 * `get-users`), the OS must be one we have a profile for, and the address must
 * match the allocation.
 */
async function verifyGuestConfigured(input: {
  jobId: string
  client: ProxmoxClient
  nodeName: string
  vmid: number
  vpsInstanceId: string
  node: { nodeName: string; host: string; tokenId: string; tokenSecret: string; allowInsecureTls?: boolean | null }
  metadata: Record<string, unknown> | null
  expectedUser: string
  expectedIp: string
  isWindows: boolean
}) {
  const service = new GuestAutomationService(guestContextFor({ vpsInstanceId: input.vpsInstanceId, vmid: input.vmid, node: input.node }))
  const detected = await service.detectOs(input.metadata)
  if (detected.kind === "unknown") {
    throw new Error(`guest_verify_os_detection_failed: ${GUEST_ERROR_MESSAGES.OS_DETECTION_UNAVAILABLE}`)
  }
  const resolved = await service.getTemplate(detected)
  if (!resolved.ok) {
    throw new Error(`guest_verify_template_failed: ${resolved.code}`)
  }
  const state = await service.getState(detected.engine)
  const guestUsers = state.users.map((user) => String(user).toLowerCase())
  const wanted = String(input.expectedUser).toLowerCase()
  // Windows keeps the requested account; a Linux template may provision either
  // the requested user or root, so either match is acceptance.
  const userPresent = guestUsers.includes(wanted) || (detected.engine === "linux" && guestUsers.includes("root"))
  const ipPresent = state.ipv4.includes(input.expectedIp)
  const lastRun = await prisma.guestAutomationRun
    .findFirst({ where: { vpsInstanceId: input.vpsInstanceId }, orderBy: { startedAt: "desc" }, select: { id: true } })
    .catch(() => null)

  await logJob(input.jobId, {
    step: "VERIFYING_VM",
    event: "guest_automation:verify",
    level: userPresent && ipPresent ? "info" : "error",
    message: userPresent && ipPresent ? "Guest automation verification passed" : "Guest automation verification failed",
    response: {
      vmid: input.vmid,
      os: detected.osId,
      osVersion: detected.version,
      engine: detected.engine,
      template: resolved.template.name,
      templateVersion: resolved.template.version,
      hostname: state.hostname,
      primaryInterface: state.primaryInterface,
      guestIps: state.ipv4,
      expectedIp: input.expectedIp,
      userPresent,
      wantedUser: input.expectedUser,
      users: guestUsers,
    },
  })

  if (!userPresent) throw new Error(`guest_verify_user_missing: ${input.expectedUser}`)
  if (!ipPresent) throw new Error(`guest_verify_ip_missing: ${input.expectedIp}`)
  return { runId: lastRun?.id ?? null, detected, template: resolved.template, state }
}

/**
 * Authoritative OS metadata for a provisioning job.
 *
 * Only ever a fallback: the guest agent's `get-osinfo` is what the automation
 * layer treats as truth, and this just narrows the template choice when the
 * agent answers with a generic id.
 */
function guestOsMetadataFor(template: any): Record<string, unknown> {
  return {
    osType: template?.osType ?? null,
    osFamily: template?.osFamily ?? templateFamilySearch(template) ?? null,
    osCategory: template?.osCategory ?? null,
    osName: template?.name ?? null,
    osVersion: template?.osVersion ?? null,
    templateName: template?.proxmoxTemplateName ?? template?.name ?? null,
  }
}

async function verifyProvisioningHardGate(input: ProvisioningHardGateInput) {
  const vm = await verifyVm(input.client, input.nodeName, input.vmid)
  if (!vm.exists) throw new Error("provisioning_gate_vm_missing")
  const config = (vm.config || {}) as Record<string, any>
  const net0 = String(config.net0 || "")
  const macAddress = macFromNet0(net0)
  const qga = await checkGuestAgent(input.client, input.nodeName, input.vmid)
  const guestNetwork = qga.ok
    ? await input.client.getVMGuestNetworkInterfaces(input.nodeName, input.vmid).catch((error) => ({ error: sanitizeProvisioningError(error) }))
    : { error: qga.error || "guest_agent_unreachable" }
  const guestIps = extractGuestIpv4Addresses(guestNetwork)
  const tcpPort = input.isWindows ? 3389 : 22
  const reachability = await checkTcpReachable(input.expectedIp, tcpPort)
  const attachedDevices = Object.entries(config).filter(([key]) => /^(scsi|virtio|sata|ide)\d+$/i.test(key))
  const osDiskAttached = attachedDevices.some(([, value]) => {
    const text = String(value || "").toLowerCase()
    return Boolean(text) && !text.includes("cloudinit") && !text.includes("media=cdrom")
  })

  // Guest-side evidence. An absent agent means absent proof, which is a failure
  // rather than a warning: without the agent the guest cannot be configured at
  // all, so delivery would be a VM nobody can reach.
  const guestEvidence = qga.ok
    ? await readGuestNetworkEvidence(input.client, input.nodeName, input.vmid, input.isWindows)
    : { reachable: false as const, gateway: null, dns: [] as string[], searchDomain: null, hostname: null, sshAuthorized: false }

  const checks = {
    vmExists: true,
    running: String(vm.status?.status || "").toLowerCase() === "running",
    osDiskAttached,
    guestAgentOnline: qga.ok,
    guestIpApplied: guestIps.includes(input.expectedIp),
    guestGatewayApplied: Boolean(guestEvidence.gateway) && String(guestEvidence.gateway) === input.expectedGateway,
    guestDnsApplied: hasExpectedDns(guestEvidence.dns, input.expectedDns),
    bridgeApplied: input.expectedBridge ? net0.includes(`bridge=${input.expectedBridge}`) : true,
    macPresent: Boolean(macAddress),
    macFresh: Boolean(macAddress) && (!input.templateMac || macAddress !== normalizeMac(input.templateMac)),
    macExpected: input.expectedMac ? macAddress === normalizeMac(input.expectedMac) : true,
  }
  // Guest metadata a customer may legitimately change: reported, never blocking.
  const warnings = {
    guestSearchDomainApplied: input.expectedSearchDomain ? String(guestEvidence.searchDomain || "") === input.expectedSearchDomain : true,
    guestHostnameApplied: input.expectedHostname
      ? String(guestEvidence.hostname || "").toLowerCase().includes(String(input.expectedHostname).toLowerCase())
      : true,
    networkReachable: reachability.ok,
  }

  await logJob(input.jobId, {
    step: "VERIFYING_VM",
    event: "provisioning_hard_gate",
    level: Object.values(checks).every(Boolean) ? "info" : "error",
    message: Object.values(checks).every(Boolean) ? "Provisioning hard gate passed" : "Provisioning hard gate failed",
    response: {
      checks,
      warnings,
      vmid: input.vmid,
      net0,
      macAddress,
      expectedMac: input.expectedMac || null,
      templateMac: input.templateMac || null,
      qga: qga.ok ? { ok: true } : { ok: false, error: qga.error },
      guestNetwork: { ips: guestIps, raw: guestNetwork },
      guestEvidence,
      reachability: { ...reachability, port: tcpPort },
      guestAutomationEvidence: input.guestAutomationEvidence || null,
    },
  })
  await (prisma as any).vmAuditLog.create({
    data: {
      eventType: "PROVISIONING_HARD_GATE",
      severity: Object.values(checks).every(Boolean) ? "INFO" : "ERROR",
      actorType: "SYSTEM",
      actorEmail: "system:provision",
      vpsInstanceId: input.vpsInstanceId,
      customerId: input.customerId || null,
      orderId: input.orderId || null,
      vmid: input.vmid,
      targetType: "vps_instance",
      targetId: input.vpsInstanceId,
      status: Object.values(checks).every(Boolean) ? "SUCCESS" : "FAILED",
      // Proof, not secrets: no password and no injected config appears here.
      metadata: { checks, warnings, macAddress, expectedMac: input.expectedMac || null, templateMac: input.templateMac || null, reachability, guestIps },
    },
  }).catch(() => null)
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key)
  if (failed.length) throw new Error(`provisioning_hard_gate_failed: ${failed.join(", ")}`)

  // Warning-only observability: internet egress is nice to have, not required.
  if (qga.ok) {
    const internetCheckResult = await (async () => {
      try {
        const exec = await input.client.execVMGuestCommand(input.nodeName, input.vmid,
          input.isWindows
            ? ["powershell", "-NoProfile", "-Command", "try { (Invoke-WebRequest -Uri 'https://api.ipify.org' -UseBasicParsing -TimeoutSec 10).Content.Trim() } catch { '' }"]
            : ["sh", "-c", "curl -sf --max-time 10 https://api.ipify.org"]
        )
        const st = exec?.pid ? await waitForGuestExec(input.client, input.nodeName, input.vmid, Number(exec.pid), 20_000) : null
        const out = String(st?.result?.["out-data"] || "").trim()
        const ok = /^\d+\.\d+\.\d+\.\d+$/.test(out)
        return { ok, publicIp: ok ? out : null }
      } catch {
        return { ok: false, publicIp: null }
      }
    })()
    await logJob(input.jobId, {
      step: "VERIFYING_VM",
      event: "gate:internet_check",
      level: internetCheckResult.ok ? "info" : "warn",
      message: internetCheckResult.ok ? `Internet connectivity verified — public IP: ${internetCheckResult.publicIp}` : "Internet connectivity check failed (warning only — may be network-internal VM)",
      response: internetCheckResult,
    })
  }

  return { ok: true, checks, macAddress }
}

type GuestNetworkEvidence = {
  reachable: boolean
  gateway: string | null
  dns: string[]
  searchDomain: string | null
  hostname: string | null
}

/**
 * Read the guest's own view of its network.
 *
 * `get-host-name` is a native verb and costs nothing. The default gateway, the
 * resolver list and the search domain are only exposed by a guest-exec, so one
 * OS-appropriate command covers all three — chosen from the engine, never
 * guessed. A failure here yields empty values, which the gate then reports as an
 * explicit failed check rather than silently passing.
 */
async function readGuestNetworkEvidence(
  client: ProxmoxClient,
  nodeName: string,
  vmid: number,
  isWindows: boolean,
): Promise<GuestNetworkEvidence> {
  const hostnameRaw = await client.guestCmd(nodeName, vmid, "get-host-name").catch(() => null)

  let gateway: string | null = null
  let dns: string[] = []
  let searchDomain: string | null = null

  try {
    const started = isWindows
      ? await client.execVMGuestCommand(nodeName, vmid, [
          "powershell",
          "-NoProfile",
          "-Command",
          "$c = Get-NetIPConfiguration | Where-Object { $_.IPv4Address } | Select-Object -First 1; Write-Output ('GW=' + $c.IPv4DefaultGateway.NextHop); Write-Output ('DNS=' + ($c.DNSServer.ServerAddresses -join ',')); Write-Output ('SEARCH=' + $c.DNSDomain)",
        ])
      : await client.execVMGuestCommand(nodeName, vmid, [
          "sh",
          "-c",
          "ip route show default 2>/dev/null | head -1; echo ---; cat /etc/resolv.conf 2>/dev/null",
        ])
    const status = started?.pid ? await waitForGuestExec(client, nodeName, vmid, Number(started.pid), 20_000) : null
    const raw = String(status?.result?.["out-data"] || "")
    if (isWindows) {
      gateway = raw.match(/GW=([^\r\n]*)/)?.[1]?.trim() || null
      dns = splitList(raw.match(/DNS=([^\r\n]*)/)?.[1] || "")
      searchDomain = raw.match(/SEARCH=([^\r\n]*)/)?.[1]?.trim() || null
    } else {
      const [route, resolver = ""] = raw.split(/^---$/m)
      gateway = route?.match(/via\s+(\S+)/)?.[1]?.trim() || null
      dns = splitList(resolver.replace(/#.*/g, "\n").replace(/^nameserver\s+/gim, ""))
      searchDomain = resolver.replace(/#.*/g, "").match(/^search\s+(.+)$/im)?.[1]?.trim().split(/\s+/)[0] || null
    }
  } catch {
    // Left empty on purpose: the gate turns missing evidence into a failed check.
  }

  return {
    reachable: true,
    gateway,
    dns,
    searchDomain,
    hostname: hostnameRaw?.data ? String((hostnameRaw.data as any)?.name || "") || null : null,
  }
}

function splitList(value: string): string[] {
  return String(value || "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function hasExpectedDns(observed: string[], expected?: string | null): boolean {
  if (!expected) return true
  const want = splitList(String(expected))
  if (!want.length) return true
  return want.every((value) => observed.includes(value))
}

async function verifyProvisioningHardGateWithConvergence(input: ProvisioningHardGateInput & {
  attempts?: number
  settleMs?: number
  rebootOnFirstFailure?: boolean
}) {
  const maxAttempts = Math.max(1, Number(input.attempts || (input.isWindows ? 8 : 4)))
  const settleMs = Math.max(1000, Number(input.settleMs || (input.isWindows ? 60000 : 20000)))
  let lastError: unknown = null
  let rebooted = false

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await verifyProvisioningHardGate(input)
    } catch (error) {
      lastError = error
      const reason = sanitizeProvisioningError(error)
      const retryable = reason.includes("provisioning_hard_gate_failed:")
      if (!retryable || attempt >= maxAttempts) throw error

      const vm = await verifyVm(input.client, input.nodeName, input.vmid).catch(() => ({ exists: false, status: null, config: null as any }))
      const status = String(vm.status?.status || "").toLowerCase()
      const shouldReboot = Boolean(input.rebootOnFirstFailure ?? true) && !rebooted && vm.exists && status === "running"
      await logJob(input.jobId, {
        step: "VERIFYING_VM",
        event: "provisioning_hard_gate:convergence_retry",
        level: "warn",
        message: `Provisioning hard gate failed; waiting for guest state to converge (${attempt}/${maxAttempts})`,
        response: {
          vmid: input.vmid,
          reason,
          status: status || null,
          expectedIp: input.expectedIp,
          rebooting: shouldReboot,
          settleMs,
        },
      })

      if (!vm.exists || status !== "running") {
        await input.client.startVM(input.nodeName, input.vmid).catch(() => undefined)
      } else if (shouldReboot) {
        rebooted = true
        await input.client.rebootVM(input.nodeName, input.vmid).catch(async () => {
          await input.client.resetVM(input.nodeName, input.vmid).catch(() => undefined)
        })
      }
      await new Promise((resolve) => setTimeout(resolve, settleMs))
    }
  }

  throw lastError instanceof Error ? lastError : new Error(sanitizeProvisioningError(lastError))
}

async function canonicalNetworkForVps(vps: any) {
  const [assignment, cache] = await Promise.all([
    (prisma as any).ipAssignment.findFirst({
      where: { vpsInstanceId: vps.id, isPrimary: true, status: { in: ["active", "assigned", "used", "reserved", "pending", "moved"] } },
      orderBy: [{ assignmentDate: "desc" }, { createdAt: "desc" }],
    }).catch(() => null),
    (prisma as any).vmNetworkCache.findUnique({ where: { vpsInstanceId: vps.id } }).catch(() => null),
  ])
  const ip = assignment?.assignedIp || cache?.primaryAssignedIp || vps.ipAddress
  const gateway = assignment?.gateway || cache?.primaryGateway
  const cidr = Number(assignment?.cidr || cache?.primaryCidr || 24)
  const dns = assignment?.dns || cache?.primaryDns || "1.1.1.1"
  const bridge = assignment?.bridge || cache?.primaryBridge || "vmbr0"
  if (!ip) throw new Error("canonical_network_ip_missing")
  if (!gateway) throw new Error("canonical_network_gateway_missing")
  return { ip: String(ip), gateway: String(gateway), cidr, dns: String(dns), bridge: String(bridge) }
}

/**
 * Converge the guest's network until it reports the allocated address.
 *
 * The old version of this loop wrote `ipconfig0`/`nameserver` and ran
 * `qm cloudinit update` on every attempt, then rebooted the VM hoping the
 * cloud-init disk would apply itself. It also treated a missing cloud-init disk
 * as a failure condition, which is now meaningless.
 *
 * The retry is now idempotent in the only way that helps: ask the guest what it
 * currently has, and if it disagrees with the allocation, re-apply through its
 * own OS profile. A second application is a no-op because the plan is
 * change-driven, so a converging guest simply stops being corrected.
 */
async function retryLinuxNetworkVerification(input: {
  jobId: string
  client: ProxmoxClient
  nodeName: string
  vpsInstanceId: string
  node: { nodeName: string; host: string; tokenId: string; tokenSecret: string; allowInsecureTls?: boolean | null }
  vmid: number
  metadata?: Record<string, unknown> | null
  hostname: string
  username: string
  password: string
  expectedIp: string
  expectedCidr: number
  expectedGateway: string
  expectedDns?: string | null
  expectedSearchDomain?: string | null
  expectedBridge?: string | null
  attempts?: number
}) {
  const maxAttempts = Math.max(1, Number(input.attempts || 5))
  const desiredDns = splitList(String(input.expectedDns || "1.1.1.1"))
  let lastError = "guest_network_verify_unknown_failure"
  let rebootRequested = false

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const vm = await verifyVm(input.client, input.nodeName, input.vmid).catch(() => ({ exists: false, status: null, config: null as any }))
    const vmConfig = (vm.config || {}) as Record<string, any>
    const bridgeValue = String(vmConfig.net0 || "")
    const qga = await checkGuestAgent(input.client, input.nodeName, input.vmid)
    const guestNetwork = qga.ok
      ? await input.client.getVMGuestNetworkInterfaces(input.nodeName, input.vmid).catch((error) => ({ error: sanitizeProvisioningError(error) }))
      : null
    const guestIps = extractGuestIpv4Addresses(guestNetwork)
    const guestIpMatches = guestIps.includes(input.expectedIp)
    const hasBridge = input.expectedBridge ? bridgeValue.includes(`bridge=${input.expectedBridge}`) : true

    await logJob(input.jobId, {
      step: "VERIFYING_VM",
      event: "guest_network_retry:status",
      level: qga.ok && hasBridge && guestIpMatches ? "info" : "warn",
      message: `Guest network verification attempt ${attempt}/${maxAttempts}`,
      response: {
        vmExists: vm.exists,
        qgaOk: qga.ok,
        guestIps,
        guestIpMatches,
        expectedIp: input.expectedIp,
        hasBridge,
        bridgeValue,
      },
    })

    if (vm.exists && qga.ok && hasBridge && guestIpMatches) return { ok: true, attempt }

    if (!qga.ok) lastError = qga.error || "guest_agent_unreachable"
    if (!guestIpMatches) lastError = `guest_ip_mismatch:${guestIps.join(",") || "none"}`

    // The bridge is a host-side fact, so the host fixes it. Everything the guest
    // owns is re-applied through the guest's own OS template.
    if (!hasBridge && input.expectedBridge) {
      const net0 = String(vmConfig.net0 || "")
      const modelPart = net0.includes(",") ? net0.split(",")[0] : net0 || "virtio"
      await input.client
        .updateVMConfig(input.nodeName, input.vmid, { net0: `${modelPart},bridge=${input.expectedBridge}` })
        .catch((error) => {
          lastError = sanitizeProvisioningError(error)
        })
    }

    if (qga.ok && !guestIpMatches) {
      const service = new GuestAutomationService(
        guestContextFor({ vpsInstanceId: input.vpsInstanceId, vmid: input.vmid, node: input.node }),
      )
      const result = await service.applyChange({
        desired: {
          ip: input.expectedIp,
          prefix: Number(input.expectedCidr || 24),
          gateway: input.expectedGateway,
          dns: desiredDns,
          searchDomain: input.expectedSearchDomain ?? undefined,
          hostname: input.hostname,
          username: input.username,
          password: input.password,
        },
        metadata: input.metadata ?? null,
        actor: { requestedBy: "system:provision-network-retry", role: "system" },
      })
      if (!("message" in result) && result.ok) {
        const applied = result.steps.filter((step) => step.status === "success").map((step) => step.operation)
        if (applied.length) {
          await logJob(input.jobId, {
            step: "VERIFYING_VM",
            event: "guest_network_retry:reapplied",
            message: "Re-applied network through guest automation",
            response: { attempt, runId: result.runId, operations: applied, os: result.detected.osId, template: result.template?.name || null },
          })
        }
      } else {
        lastError = "message" in result ? `${result.errorCode}` : `guest_apply_failed:${result.errorCode}`
        await logJob(input.jobId, {
          step: "VERIFYING_VM",
          event: "guest_network_retry:reapply_failed",
          level: "warn",
          message: "Guest automation could not re-apply the network",
          response: { attempt, errorCode: "message" in result ? result.errorCode : result.errorCode },
        })
      }
    }

    // A guest that has the right config but not the right address usually has
    // the change staged and unapplied. One reboot settles it; more than one does
    // not, so it is requested at most once per job.
    let settleMs = 4000
    if (vm.exists && qga.ok && guestIpMatches === false && !rebootRequested && attempt > 1) {
      rebootRequested = true
      settleMs = 20000
      await logJob(input.jobId, {
        step: "VERIFYING_VM",
        event: "guest_network_retry:reboot",
        level: "warn",
        message: "Guest still reports a different address after re-applying network; rebooting once to settle it",
        response: { expectedIp: input.expectedIp, guestIps },
      })
      await input.client.rebootVM(input.nodeName, input.vmid).catch(async () => {
        await input.client.resetVM(input.nodeName, input.vmid).catch(() => undefined)
      })
    }

    if (!qga.ok) await input.client.startVM(input.nodeName, input.vmid).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, settleMs))
  }

  throw new Error(`guest_network_retry_exhausted: ${lastError}`)
}

async function runTaskOperation(
  jobId: string,
  client: ProxmoxClient,
  nodeName: string,
  step: ProvisioningStep,
  event: string,
  request: any,
  fn: () => Promise<any>,
  verifyAfterNoUpid?: (result: any) => Promise<boolean>,
  displayStatus?: string,
) {
  await setJobDisplay(jobId, step)
  if (displayStatus) await prisma.provisioningJob.update({ where: { id: jobId }, data: { displayStatus } })
  await upsertStep(jobId, step, { status: "running", startedAt: new Date(), error: null })
  const result = await callWithRetry(jobId, step, event, request, fn)
  const upid = extractUpid(result)
  if (upid) {
    await waitForTaskStatus(jobId, client, nodeName, step, upid, 600000, displayStatus)
  } else {
    const verified = verifyAfterNoUpid ? await verifyAfterNoUpid(result) : true
    if (!verified) throw new ProxmoxError(502, `Proxmox ${event} returned without UPID and verification failed`)
    await upsertStep(jobId, step, { status: "completed", completedAt: new Date() })
  }
  return result
}

function templateFamilySearch(template: any) {
  return [
    template?.osFamily,
    template?.category,
    template?.osType,
    template?.type,
    template?.slug,
    template?.name,
    template?.proxmoxTemplateName,
  ].filter(Boolean).join(" ")
}

/**
 * Failure classes that need an admin rather than a retry.
 *
 * The Cloud-Init equivalent keyed off `LINUX_CLOUD_INIT_VERIFY_FAILED`. The
 * guest-automation equivalents are the states where automation could not finish
 * and repeating it would only repeat the same failure: the OS is unknown, the OS
 * has no enabled profile, the guest agent never answered, or a rollback left the
 * guest's network in a state an admin must look at.
 */
function isGuestAutomationManualReviewError(error: unknown, template: any) {
  if (isWindowsOsTemplate(template)) return false
  const code = String((error as any)?.code || "")
  const message = error instanceof Error ? error.message : String(error || "")
  const blocked = [
    "guest_verify_os_detection_failed",
    "guest_verify_template_failed",
    "NETWORK_RECOVERY_REQUIRED",
    "os_detection_unavailable",
    "os_template_missing",
    "os_template_disabled",
    "os_unsupported",
  ]
  return blocked.some((signal) => code.includes(signal) || message.toLowerCase().includes(signal.toLowerCase()))
}

function isProvisioningValidationFailure(reason: string) {
  const value = reason.toLowerCase()
  return [
    "provisioning_hard_gate_failed",
    "cloudinit_verify_",
    "cloudbase_verify_",
    "guest_ip_mismatch",
    "guest_agent_unreachable",
    "cloud_init_verify_",
    "provisioned vm ip config is missing",
    "provisioned vm does not exist",
  ].some((signal) => value.includes(signal))
}

/**
 * Replace the Cloud-Init apply path with the guest-automation split.
 *
 * Before: one function wrote `ciuser`/`cipassword`/`ipconfig0`/`nameserver`/
 * `searchdomain` plus a cloud-init drive, ran `qm cloudinit update`, then read
 * back `qm cloudinit dump` to prove it had worked.
 *
 * After: the host writes only what the host owns (label, notes, MAC/bridge),
 * and the guest configures itself through the OS template for the guest that
 * actually answers. There is no dump to read back because there is no injected
 * config to read back; the proof is the guest's own reported state.
 */
async function applyPreBootVmConfig(input: {
  jobId: string
  client: ProxmoxClient
  nodeName: string
  vmid: number
  template: any
  macAddress?: string | null
  netBridge?: string | null
  description?: string | null
  displayStatus?: string
}) {
  const config: Record<string, any> = {
    ...buildPreBootVmConfig({
      vmid: input.vmid,
      hostname: input.template?.name || `vm-${input.vmid}`,
      description: input.description ?? null,
      macAddress: input.macAddress || null,
      netBridge: input.netBridge || null,
    }),
    // net0Value wins over the preboot helper so the NIC model (virtio) is
    // always correct even if the helper grows a net0 key again.
    net0: net0Value(input.macAddress || null, input.netBridge || "vmbr0"),
  }
  // The generated name from buildPreBootVmConfig is a host label. Keep whatever
  // description the caller asked for and never let a ci*/ipconfig key in.
  delete config.name

  await logJob(input.jobId, {
    step: "APPLYING_CLOUD_INIT",
    event: "vm_config:preboot",
    message: "Applying host-side VM configuration",
    request: {
      vmid: input.vmid,
      nodeName: input.nodeName,
      osTemplateId: input.template?.id || null,
      osTemplateName: input.template?.name || null,
      net0: config.net0,
      // Recorded so the removal is auditable rather than silent.
      guestAutomationApplied: false,
      guestAgentRequired: true,
    },
  })

  await runTaskOperation(
    input.jobId,
    input.client,
    input.nodeName,
    "APPLYING_CLOUD_INIT",
    "preboot_config",
    { vmid: input.vmid, keys: Object.keys(config) },
    () => input.client.updateVMConfig(input.nodeName, input.vmid, config),
    async () => {
      const vm = await verifyVm(input.client, input.nodeName, input.vmid)
      return vm.exists && String(vm.config?.net0 || "").includes(String(input.macAddress || ""))
    },
    input.displayStatus || "Applying server settings",
  )

  return { config }
}

/**
 * Configure the running guest through its own OS profile.
 *
 * This is the step that replaces `qm cloudinit update` plus every dump
 * verification. It runs after the VM is up, because the guest agent is the only
 * channel that can say what OS this actually is.
 */
async function configureGuestAfterBoot(input: {
  jobId: string
  vpsInstanceId: string
  vmid: number
  node: { nodeName: string; host: string; tokenId: string; tokenSecret: string; allowInsecureTls?: boolean | null }
  metadata?: Record<string, unknown> | null
  desired: {
    ip: string
    prefix: number
    gateway: string
    dns: string[]
    searchDomain?: string | null
    hostname: string
    username: string
    password: string
    timezone?: string | null
  }
  displayStatus?: string
  waitForAgentMs?: number
}) {
  // Each first-boot stage becomes its own provisioning step, so the customer's
  // stage list shows the four real phases rather than one long "configuring"
  // row. The stage tokens are strings in the database, so adding them is
  // additive and needs no migration.
  const STAGE_STEPS: Record<string, ProvisioningStep> = {
    WAITING_GUEST_AGENT: "WAITING_GUEST_AGENT",
    DETECTING_OS: "DETECTING_OS",
    CONFIGURING_GUEST: "CONFIGURING_GUEST",
    VERIFYING_GUEST: "VERIFYING_GUEST",
  }
  let activeStep: ProvisioningStep = "WAITING_GUEST_AGENT"
  await upsertStep(input.jobId, activeStep, { status: "running", startedAt: new Date(), error: null })
  await setJobDisplay(input.jobId, activeStep)
  await logJob(input.jobId, {
    step: activeStep,
    event: "guest_automation:start",
    message: "Configuring server through guest automation",
    request: {
      vmid: input.vmid,
      ip: input.desired.ip,
      gateway: input.desired.gateway,
      dns: input.desired.dns,
      hostname: input.desired.hostname,
      username: input.desired.username,
    },
  })

  const result = await runFirstBoot({
    vms: {
      vpsInstanceId: input.vpsInstanceId,
      vmid: input.vmid,
      nodeName: input.node.nodeName,
      node: {
        host: input.node.host,
        tokenId: input.node.tokenId,
        tokenSecret: input.node.tokenSecret,
        nodeName: input.node.nodeName,
        allowInsecureTls: Boolean(input.node.allowInsecureTls),
      },
    },
    desired: input.desired,
    metadata: input.metadata ?? null,
    waitForAgentMs: input.waitForAgentMs,
    onStage: async (stage) => {
      const next = STAGE_STEPS[stage]
      if (!next || next === activeStep) return
      await upsertStep(input.jobId, activeStep, { status: "completed", completedAt: new Date(), exitStatus: "OK", error: null })
      activeStep = next
      await setJobDisplay(input.jobId, next)
      await upsertStep(input.jobId, next, { status: "running", startedAt: new Date(), error: null })
    },
  })

  if (!result.ok) {
    await logJob(input.jobId, {
      step: activeStep,
      event: "guest_automation:failed",
      level: "error",
      message: result.message,
      response: { vmid: input.vmid, errorCode: result.errorCode, runId: result.runId, os: result.detected?.osId ?? null },
    })
    throw new Error(`guest_automation_failed:${result.errorCode}`)
  }

  await logJob(input.jobId, {
    step: activeStep,
    event: "guest_automation:completed",
    message: "Guest automation completed",
    response: {
      vmid: input.vmid,
      runId: result.runId,
      status: result.status,
      noChange: result.noChange,
      os: result.detected.osId,
      osVersion: result.detected.version,
      engine: result.detected.engine,
      template: result.template.name,
      templateVersion: result.template.version,
      steps: result.steps.map((entry) => ({ operation: entry.operation, status: entry.status })),
    },
  })
  await upsertStep(input.jobId, activeStep, { status: "completed", completedAt: new Date(), exitStatus: "OK", error: null })

  return result
}

async function startVmAndVerify(jobId: string, client: ProxmoxClient, nodeName: string, vmid: number, displayStatus?: string) {
  const step: ProvisioningStep = "STARTING_VM"
  const path = `/api2/json/nodes/${nodeName}/qemu/${vmid}/status/start`
  const method = "POST"

  await setJobDisplay(jobId, step)
  if (displayStatus) await prisma.provisioningJob.update({ where: { id: jobId }, data: { displayStatus } })
  await upsertStep(jobId, step, { status: "running", startedAt: new Date(), error: null })

  const before = await verifyVm(client, nodeName, vmid)
  const beforeStatus = String(before.status?.status || "").toLowerCase()
  if (before.exists && beforeStatus === "running") {
    await logJob(jobId, {
      step,
      event: "start:already_running",
      message: "Proxmox start final VM status",
      response: { method, path, httpStatus: 200, upidExists: false, finalVmStatus: beforeStatus, vmExists: true },
    })
    await upsertStep(jobId, step, { status: "completed", completedAt: new Date(), exitStatus: "OK", error: null })
    return { vm: before, upid: null, finalStatus: beforeStatus }
  }

  await logJob(jobId, {
    step,
    event: "start:request",
    message: "Proxmox start request",
    request: { method, path, vmid, nodeName },
  })

  const start = await client.startVMWithStatus(nodeName, vmid)
  const upid = extractUpid(start.data) || start.upid
  await logJob(jobId, {
    step,
    event: "start:response",
    message: "Proxmox start request accepted",
    request: { method, path, vmid, nodeName },
    response: { method, path, httpStatus: start.statusCode, upidExists: Boolean(upid) },
    upid,
  })

  if (upid) {
    await waitForTaskStatus(jobId, client, nodeName, step, upid, 600000, displayStatus)
  }

  const vm = await verifyVm(client, nodeName, vmid)
  const finalStatus = String(vm.status?.status || "").toLowerCase()
  await logJob(jobId, {
    step,
    event: "start:final_status",
    message: "Proxmox start final VM status",
    response: { method, path, httpStatus: start.statusCode, upidExists: Boolean(upid), finalVmStatus: finalStatus || null, vmExists: vm.exists },
    upid,
  })

  if (!vm.exists) {
    throw new Error("VM does not exist after start request")
  }

  if (finalStatus !== "running") {
    throw new Error(`VM is ${finalStatus || "not running"} after start request`)
  }

  await upsertStep(jobId, step, { status: "completed", completedAt: new Date(), exitStatus: "OK", error: null })
  return { vm, upid, finalStatus }
}

function dedupeKeyFor(type: EnqueueType, orderId: string) {
  return `${type}:${orderId}`
}

async function enqueueJob(orderId: string, actor: string, type: EnqueueType, options: EnqueueOptions = {}) {
  paymentFlowLog("Provision queue requested", { orderId, actor, type })
  let order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { customer: true, product: true, customConfig: true, operatingSystem: { include: { proxmoxNode: true } }, vpsInstance: true, sshKey: true },
  })
  if (!order) throw new Error("Order not found")
  await assertPaymentVerifiedForProvisioning(orderId)
  if (!["paid", "payment_verified", "active"].includes(String(order.status))) throw new Error("Order must be paid before provisioning")
  if (!order.customerId || !order.customer) throw new Error("Order customer is missing")

  if (type === "provision") {
    const latestProvisionJob = order.vpsInstance
      ? await prisma.provisioningJob.findFirst({
          where: { orderId, type: "provision" },
          orderBy: { createdAt: "desc" },
          select: { id: true, status: true, progress: true, canonicalPhase: true },
        })
      : null
    const incompleteDelivery = Boolean(latestProvisionJob) && (
      Number(latestProvisionJob?.progress || 0) < 100 ||
      String(latestProvisionJob?.canonicalPhase || "").toUpperCase() === "FAILED" ||
      String(latestProvisionJob?.status || "").toLowerCase() === "failed"
    )
    if (order.vpsInstance && ["ACTIVE", "STOPPED", "SUSPENDED"].includes(String(order.vpsInstance.status)) && !incompleteDelivery) {
      await ensureProvisioningIdentity({
        orderId: order.id,
        vpsInstanceId: order.vpsInstance.id,
        vmUuid: order.vpsInstance.id,
        proxmoxNodeId: order.vpsInstance.proxmoxNodeId,
        vmid: order.vpsInstance.vmid,
        publicIp: order.vpsInstance.ipAddress,
        macAddress: order.vpsInstance.vmMacAddress,
      })
      await (prisma as any).vmProvisioningIdentity.update({ where: { orderId: order.id }, data: { phase: "READY", resumePhase: "READY", lastError: null } })
      const latest = await prisma.provisioningJob.findFirst({ where: { orderId, type: "provision" }, orderBy: { createdAt: "desc" } })
      if (latest) return Object.assign(latest, await provisioningReplayState(orderId))
      return {
        id: `existing:${order.vpsInstance.id}`,
        orderId,
        vpsInstanceId: order.vpsInstance.id,
        status: "completed",
        currentStep: "ACTIVE",
        canonicalPhase: "READY",
        displayStatus: "Active",
        idempotentReplay: true,
        phase: "READY",
      } as any
    }
    if (!order.product && !order.customConfig) throw new Error("Order product or custom configuration is missing")
    if (!order.requestedOsFamily && !order.operatingSystem?.osFamily && !order.operatingSystem?.name) {
      throw new Error("Selected operating system is not available for provisioning")
    }
  }

  if (Object.prototype.hasOwnProperty.call(options, "nodeId")) {
    const selectedNodeId = options.nodeId ? String(options.nodeId).trim() : ""
    if (selectedNodeId) {
      const node = await prisma.proxmoxNode.findFirst({ where: { id: selectedNodeId, isActive: true }, select: { id: true } })
      if (!node) throw new Error("Selected provision node is unavailable or inactive")
      await prisma.order.update({ where: { id: orderId }, data: { proxmoxNodeId: node.id, proxmoxNode: null } })
    } else {
      await prisma.order.update({ where: { id: orderId }, data: { proxmoxNodeId: null, proxmoxNode: null } })
    }
    order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: true, product: true, customConfig: true, operatingSystem: { include: { proxmoxNode: true } }, vpsInstance: true, sshKey: true },
    })
    if (!order) throw new Error("Order not found")
  }

  const dedupeKey = dedupeKeyFor(type, orderId)
  return withRedisLock(`lock:order:${orderId}`, 4000, async () => {
    const existing = await prisma.provisioningJob.findFirst({
      where: { dedupeKey, status: { in: ["queued", "running", "retrying", "waiting_for_admin"] } },
      orderBy: { createdAt: "desc" },
    })
    if (existing) return existing
    if (options.retryBlocked) {
      const blocked = await prisma.provisioningJob.findFirst({
        where: { dedupeKey, type, status: { in: ["waiting_for_admin", "failed"] } },
        orderBy: { createdAt: "desc" },
      })
      if (blocked) {
        const retryNodeId = Object.prototype.hasOwnProperty.call(options, "nodeId") ? (options.nodeId ? String(options.nodeId).trim() : null) : blocked.proxmoxNodeId || order.proxmoxNodeId || null
        const retry = await prisma.provisioningJob.update({
          where: { id: blocked.id },
          data: {
            status: "queued",
            currentStep: type === "upgrade" ? "UPGRADE_QUEUED" : "QUEUED",
            displayStatus: type === "upgrade" ? STEP_LABELS.UPGRADE_QUEUED : STEP_LABELS.QUEUED,
            error: null,
            errorCode: null,
            proxmoxNodeId: retryNodeId,
            nodeName: null,
            nextRetryAt: null,
            claimedAt: null,
            completedAt: null,
            metadata: {
              ...((blocked.metadata as any) || {}),
              retryActor: actor,
              retriedAt: new Date().toISOString(),
              retryBlocked: true,
              retryNodeId,
              ipAssignment: {
                ...(((order.metadata as any) || {})?.ipAssignment || {}),
                mode: options.ipAssignmentMode || (options.requestedIp ? "manual" : (((order.metadata as any) || {})?.ipAssignment?.mode || "automatic")),
                poolId: options.poolId || (((order.metadata as any) || {})?.ipAssignment?.poolId || null),
                requestedIp: options.requestedIp || (((order.metadata as any) || {})?.ipAssignment?.requestedIp || null),
                forceIpOverride: options.forceIpOverride === true || (((order.metadata as any) || {})?.ipAssignment?.forceIpOverride === true),
              },
            },
          },
        })
        await prisma.order.update({
          where: { id: orderId },
          data: { provisioningStatus: type === "upgrade" ? "UPGRADE_QUEUED" : "QUEUED", provisioningError: null, proxmoxNodeId: retryNodeId, proxmoxNode: null },
        }).catch(() => null)
        await logJob(blocked.id, { event: "queue:retry_requested", message: "Blocked provisioning job requeued", response: { actor, retryBlocked: true } }).catch(() => null)
        return retry
      }
    }

    try {
      let service = order.vpsInstance || null
      let vmid = service?.vmid || null
      const node = order.operatingSystem?.proxmoxNode?.id === order.proxmoxNodeId ? order.operatingSystem.proxmoxNode : null
      const hostname = order.hostname || hostnameForOrder(order)
      const instanceDisplayTag = normalizeServerTag((order as any).displayTag) || null
      const requestedOsFamily = order.requestedOsFamily || order.operatingSystem?.osFamily || null
      const requestedOsVersion = order.requestedOsVersion || order.operatingSystem?.osVersion || null

      if (type === "provision" && !service && node && order.proxmoxNodeId && (order.product || order.customConfig) && order.operatingSystem) {
        const client = getClientForNode(node)
        vmid = await allocateNextVmid(client, node.nodeName, node.id)
        service = await upsertServiceState({
          orderId,
          customerId: order.customerId!,
          productId: order.productId,
          nodeId: node.id,
          osId: order.operatingSystem.id,
          vmid,
          hostname,
          ipAddress: null,
          username: order.adminUsername || ciUserForTemplate(order.operatingSystem),
          passwordEncrypted: order.passwordEncrypted || null,
          accessMethod: order.accessMethod || "PASSWORD",
          sshKeyId: order.sshKeyId || null,
          adminUsername: order.adminUsername || null,
          displayTag: instanceDisplayTag,
          cpuCores: Number(order.product?.cpuCores || order.customConfig?.cpuCores || 1),
          ramGb: Number(order.product?.ramGb || order.customConfig?.ramGb || 1),
          diskGb: Number(order.product?.storageGb || (Array.isArray(order.customConfig?.disks) ? (order.customConfig!.disks as any[]).reduce((sum, disk) => sum + Number(disk?.sizeGb || 0), 0) : 0)),
          status: "CREATING",
        })
      }

      const job = await prisma.provisioningJob.create({
        data: {
          orderId,
          customerId: order.customerId,
          type,
          dedupeKey,
          status: "queued",
          currentStep: type === "upgrade" ? "UPGRADE_QUEUED" : "QUEUED",
          displayStatus: type === "upgrade" ? STEP_LABELS.UPGRADE_QUEUED : STEP_LABELS.QUEUED,
          proxmoxNodeId: order.proxmoxNodeId || null,
          selectedTemplateId: node ? order.operatingSystem?.id || null : null,
          requestedOsFamily,
          requestedOsVersion,
          nodeName: node ? order.operatingSystem?.proxmoxNode?.nodeName || null : null,
          hostname,
          vmid,
          vpsInstanceId: service?.id || null,
          metadata: {
            actor,
            ipAssignment: {
              ...(((order.metadata as any) || {})?.ipAssignment || {}),
              mode: options.ipAssignmentMode || (options.requestedIp ? "manual" : (((order.metadata as any) || {})?.ipAssignment?.mode || "automatic")),
              poolId: options.poolId || (((order.metadata as any) || {})?.ipAssignment?.poolId || null),
              requestedIp: options.requestedIp || (((order.metadata as any) || {})?.ipAssignment?.requestedIp || null),
              forceIpOverride: options.forceIpOverride === true || (((order.metadata as any) || {})?.ipAssignment?.forceIpOverride === true),
            },
          },
        },
      })
      await prisma.order.update({
        where: { id: orderId },
        data: {
          provisioningStatus: type === "upgrade" ? "UPGRADE_QUEUED" : "QUEUED",
          provisioningError: null,
          ...(service ? { serviceId: service.id } : {}),
          ...(vmid ? { vmId: vmid } : {}),
          ...(node ? { proxmoxNode: node.nodeName } : {}),
        },
      })
      await logJob(job.id, { event: "job:queued", message: `${type} job queued` })
      paymentFlowLog("Provision job queued", { orderId, jobId: job.id, type, actor, vmid, vpsInstanceId: service?.id || null })
      if (type === "provision") {
        await ensureProvisioningIdentity({
          orderId,
          vpsInstanceId: service?.id || null,
          vmUuid: service?.id || orderId,
          proxmoxNodeId: node?.id || order.proxmoxNodeId || null,
          vmid,
          publicIp: service?.ipAddress || null,
          macAddress: service?.vmMacAddress || null,
        })
      }
      if (type === "provision") {
        await sendServiceStatusNotification({
          templateKey: WHATSAPP_TEMPLATE_KEYS.PROVISIONING_UPDATE,
          customer: order.customer!,
          variables: {
            userName: order.customer!.name || "there",
            email: order.customer!.email,
            orderId: order.orderNumber,
            serviceName: instanceDisplayTag || hostname,
          },
          orderId: order.id,
          vpsInstanceId: service?.id || null,
          metadata: { source: "provisioning_queue", jobId: job.id },
        }).catch((emailError) => {
          console.error("[Provisioning] service_provisioning email failed", { orderId: order.id, message: emailError?.message })
        })
      }
      return job
    } catch (error: any) {
      if (String(error?.code) === "P2002") {
        const retry = await prisma.provisioningJob.findFirst({
          where: { dedupeKey, status: { in: options.retryBlocked ? ["queued", "running", "retrying", "waiting_for_admin", "failed"] : ["queued", "running", "retrying", "waiting_for_admin"] } },
          orderBy: { createdAt: "desc" },
        })
        if (retry && options.retryBlocked && ["waiting_for_admin", "failed"].includes(String(retry.status))) {
          return retryProvisioningQueueJob(retry.id, actor)
        }
        if (retry) return retry
      }
      throw error
    }
  })
}

export async function enqueueProvisioningJob(orderId: string, actor = "system", options: EnqueueOptions = {}) {
  return enqueueJob(orderId, actor, "provision", options)
}

export async function enqueueUpgradeJob(orderId: string, actor = "system", options: EnqueueOptions = {}) {
  return enqueueJob(orderId, actor, "upgrade", options)
}

export async function enqueueReinstallJob(input: {
  orderId: string
  vpsInstanceId: string
  customerId: string
  osTemplateId: string
  hostname: string
  username: string
  password?: string
  sshPublicKey?: string
  preserveIp?: boolean
  actor?: string
  loginMethod?: "password" | "ssh" | "password_ssh"
  sshKeyId?: string
  dedupeKey?: string
}) {
  const dedupeKey = String(input.dedupeKey || `reinstall:${input.vpsInstanceId}:${Date.now()}:${crypto.randomBytes(4).toString("hex")}`)
  const actor = input.actor || "system"
  const existing = await prisma.provisioningJob.findFirst({
    where: { vpsInstanceId: input.vpsInstanceId, type: "reinstall", status: { in: ["queued", "running", "retrying", "waiting_for_admin"] } },
    orderBy: { createdAt: "desc" },
  })
  if (existing) return existing
  const completedReinstalls = await prisma.provisioningJob.findMany({
    where: { type: "reinstall", status: "completed", startedAt: { not: null }, completedAt: { not: null } },
    select: { startedAt: true, completedAt: true },
    orderBy: { completedAt: "desc" },
    take: 20,
  })
  const durations = completedReinstalls
    .map((row) => row.startedAt && row.completedAt ? Math.max(60, Math.round((row.completedAt.getTime() - row.startedAt.getTime()) / 1000)) : 0)
    .filter(Boolean)
  const estimatedDurationSeconds = durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 900
  const job = await prisma.provisioningJob.create({
    data: {
      orderId: input.orderId,
      vpsInstanceId: input.vpsInstanceId,
      customerId: input.customerId,
      type: "reinstall",
      dedupeKey,
      status: "queued",
      currentStep: "QUEUED",
      displayStatus: "Preparing reinstall",
      metadata: {
        actor,
        estimatedDurationSeconds,
        reinstall: {
          osTemplateId: input.osTemplateId,
          requestedHostname: input.hostname,
          requestedUsername: input.username,
          loginMethod: input.loginMethod || (input.password && input.sshPublicKey ? "password_ssh" : input.sshPublicKey ? "ssh" : "password"),
          sshKeyId: input.sshKeyId || null,
          passwordEncrypted: input.password ? encryptSecret(input.password) : null,
          sshPublicKey: input.sshPublicKey || null,
          sshKeyProvided: Boolean(input.sshPublicKey),
          preserveIp: input.preserveIp !== false,
        },
      },
    },
  })
  await logJob(job.id, { event: "reinstall:requested", message: "Reinstall requested" }).catch(() => null)
  await createPanelLog({
    category: "Provisioning",
    message: "reinstall_requested",
    customerId: input.customerId,
    orderId: input.orderId,
    vpsInstanceId: input.vpsInstanceId,
    metadata: { osTemplateId: input.osTemplateId, hostname: input.hostname },
  }).catch(() => null)
  const customer = await prisma.customer.findUnique({ where: { id: input.customerId } }).catch(() => null)
  if (customer?.email || customer?.phone) {
    await sendServiceStatusNotification({
      templateKey: WHATSAPP_TEMPLATE_KEYS.PROVISIONING_UPDATE,
      customer,
      variables: {
        userName: customer.name || "there",
        email: customer.email,
        orderId: input.orderId,
        serviceName: input.hostname,
      },
      orderId: input.orderId,
      vpsInstanceId: input.vpsInstanceId,
      metadata: { source: "reinstall_requested", jobId: job.id },
    }).catch((emailError) => {
      console.error("[Provisioning] reinstall requested email failed", { jobId: job.id, message: emailError?.message })
    })
  }
  return job
}

function validPanelVmid(value: unknown) {
  const vmid = Number(value)
  return Number.isInteger(vmid) && vmid >= MIN_PROXMOX_VMID && vmid <= MAX_PROXMOX_VMID
}

function vmidNumber(value: unknown) {
  const vmid = Number(value)
  return validPanelVmid(vmid) ? vmid : null
}

async function collectUsedVmids(client: ProxmoxClient, nodeName: string, proxmoxNodeId?: string | null) {
  const [vmList, clusterResources, dbVmids, queuedVmids, identityVmids] = await Promise.all([
    client.getVMList(nodeName),
    client.getClusterResources().catch(() => []),
    prisma.vpsInstance.findMany({ where: { deletedAt: null, vmid: { gt: 0 } }, select: { vmid: true } }).catch(() => []),
    prisma.provisioningJob.findMany({
      where: { vmid: { not: null }, status: { in: ["queued", "running", "retrying", "waiting_for_admin"] } },
      select: { vmid: true },
    }).catch(() => []),
    (prisma as any).vmProvisioningIdentity.findMany({ where: { vmid: { not: null } }, select: { vmid: true } }).catch(() => []),
  ])
  return new Set(
    [
      ...vmList.map((vm) => vmidNumber(vm.vmid)),
      ...clusterResources.filter((resource: any) => resource?.type === "qemu").map((resource: any) => vmidNumber(resource.vmid)),
      ...dbVmids.map((vm) => vmidNumber(vm.vmid)),
      ...queuedVmids.map((job) => vmidNumber(job.vmid)),
      ...identityVmids.map((identity: any) => vmidNumber(identity.vmid)),
    ].filter((vmid): vmid is number => vmid !== null),
  )
}

export async function nextVmid(client: ProxmoxClient, nodeName: string, proxmoxNodeId?: string | null) {
  const used = await collectUsedVmids(client, nodeName, proxmoxNodeId)
  const proxmoxSuggested = await client.getNextVmid().catch(() => null)
  if (validPanelVmid(proxmoxSuggested) && !used.has(Number(proxmoxSuggested))) {
    return Number(proxmoxSuggested)
  }

  const highest = Math.max(MIN_PROXMOX_VMID - 1, ...Array.from(used))
  for (let candidate = Math.max(MIN_PROXMOX_VMID, highest + 1); candidate <= MAX_PROXMOX_VMID; candidate += 1) {
    if (!used.has(candidate)) return candidate
  }
  for (let candidate = MIN_PROXMOX_VMID; candidate <= highest; candidate += 1) {
    if (!used.has(candidate)) return candidate
  }
  throw new Error("No VMID is available in the safe range 100-999999")
}

export async function allocateNextVmid(client: ProxmoxClient, nodeName: string, proxmoxNodeId?: string | null) {
  return withRedisLock(`lock:vmid:${proxmoxNodeId || nodeName}`, 15000, async () => {
    let candidate = await nextVmid(client, nodeName, proxmoxNodeId)
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!validPanelVmid(candidate)) {
        throw new Error(`Unsafe VMID allocated: ${candidate}`)
      }
      const [existsOnProxmox, existsInDb] = await Promise.all([
        client.getVMStatus(nodeName, candidate).then(() => true).catch(() => false),
        proxmoxNodeId
          ? prisma.vpsInstance.findFirst({ where: { proxmoxNodeId, vmid: candidate, deletedAt: null }, select: { id: true } }).then(Boolean).catch(() => false)
          : Promise.resolve(false),
      ])
      const existsInQueue = proxmoxNodeId
        ? await prisma.provisioningJob.findFirst({
            where: { proxmoxNodeId, vmid: candidate, status: { in: ["queued", "running", "retrying", "waiting_for_admin"] } },
            select: { id: true },
          }).then(Boolean).catch(() => false)
        : false
      if (!existsOnProxmox && !existsInDb && !existsInQueue) return candidate
      candidate += 1
      if (candidate > MAX_PROXMOX_VMID) candidate = MIN_PROXMOX_VMID
    }
    throw new Error("Unable to allocate a collision-free VMID")
  })
}

// A resizable OS disk value — excludes cloud-init drives, cdrom media, and empty slots.
function isRealOsDiskValue(value: unknown) {
  const text = String(value || "").toLowerCase()
  if (!text) return false
  if (text.includes("cloudinit") || text.includes("media=cdrom") || text.includes("none,media")) return false
  return true
}

// Identify the ACTUAL OS/boot disk to resize + verify. Picking the first of scsi0/virtio0/sata0 by mere
// existence caused resize to hit a cloud-init/EFI/small data disk (e.g. "expected 400GB actual 3.5GB").
function diskKeyFromConfig(config: Record<string, any>) {
  const cfg = config || {}
  const diskKeyPattern = /^(?:scsi|virtio|sata|ide)\d+$/
  const isCandidate = (key: string) => diskKeyPattern.test(key) && key !== "ide2" && isRealOsDiskValue(cfg[key])

  // 1. Honor the VM's declared boot order / bootdisk when it points at a real disk.
  const bootOrder = String(cfg.boot || "").replace(/^order=/, "")
  for (const token of bootOrder.split(/[;,\s]+/).map((t) => t.trim()).filter(Boolean)) {
    if (isCandidate(token)) return token
  }
  const bootDisk = String(cfg.bootdisk || "").trim()
  if (bootDisk && isCandidate(bootDisk)) return bootDisk

  // 2. Otherwise pick the largest real (non-cloud-init/EFI/cdrom) disk.
  const candidates = Object.keys(cfg)
    .filter(isCandidate)
    .map((key) => ({ key, sizeGb: parseProxmoxDiskSizeGb(cfg[key]) || 0 }))
    .sort((a, b) => b.sizeGb - a.sizeGb || a.key.localeCompare(b.key))
  if (candidates.length) return candidates[0].key

  // 3. Last-resort fallback (odd configs with no parseable disk).
  return cfg.scsi0 ? "scsi0" : cfg.virtio0 ? "virtio0" : cfg.sata0 ? "sata0" : "scsi0"
}

export function parseProxmoxDiskSizeGb(value: unknown) {
  const text = String(value || "")
  const match = text.match(/(?:^|[,:\s])size=([0-9.]+)\s*([KMGT])?i?B?\b/i) || text.match(/(?:^|[,:\s])([0-9.]+)\s*([KMGT])i?B?\b/i)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return null
  const unit = String(match[2] || "G").toUpperCase()
  const multiplier = unit === "T" ? 1024 : unit === "M" ? 1 / 1024 : unit === "K" ? 1 / 1024 / 1024 : 1
  return amount * multiplier
}

export function verifyDiskSizeFromConfig(config: Record<string, any>, expectedGb: number) {
  const diskKey = diskKeyFromConfig(config)
  const raw = config[diskKey]
  const actualGb = parseProxmoxDiskSizeGb(raw)
  const ok = actualGb !== null && actualGb + 0.01 >= expectedGb
  return { ok, diskKey, raw: raw || null, actualGb, expectedGb }
}

async function verifyProvisionedDiskSize(jobId: string, client: ProxmoxClient, nodeName: string, vmid: number, expectedGb: number, step: ProvisioningStep = "RESIZING_DISK") {
  if (!Number.isFinite(expectedGb) || expectedGb <= 0) return { ok: true, skipped: true, expectedGb }
  let result = verifyDiskSizeFromConfig(await client.getVMConfig(nodeName, vmid), expectedGb)
  for (let attempt = 1; !result.ok && attempt <= 5; attempt += 1) {
    const actual = Number(result.actualGb || 0)
    if (actual > 0 && expectedGb > actual) {
      const resize = await client.resizeDisk(nodeName, vmid, result.diskKey, `+${Math.ceil(expectedGb - actual)}G`).catch(() => null)
      const upid = extractUpid(resize)
      if (upid) await waitForTaskStatus(jobId, client, nodeName, step, upid, 600000, "Waiting for disk resize")
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, attempt * 2_000)))
    result = verifyDiskSizeFromConfig(await client.getVMConfig(nodeName, vmid), expectedGb)
    await logJob(jobId, {
      step,
      event: result.ok ? "disk:resize_converged" : "disk:resize_retry",
      level: result.ok ? "info" : "warn",
      message: result.ok ? `Disk resize converged on attempt ${attempt}` : `Waiting for disk resize convergence (${attempt}/5)`,
      response: result,
    })
  }
  await logJob(jobId, {
    step,
    event: result.ok ? "disk:verified" : "disk:verify_failed",
    level: result.ok ? "info" : "error",
    message: result.ok
      ? `Verified Proxmox disk size: ${Math.round(Number(result.actualGb || 0) * 100) / 100}GB`
      : `Disk size verification failed: expected ${expectedGb}GB`,
    response: result,
  })
  if (!result.ok) {
    throw new Error(`disk_verify_failed: expected ${expectedGb}GB on ${result.diskKey}, found ${result.actualGb ?? "unknown"}GB (${String(result.raw || "missing")})`)
  }
  return result
}

function savedOrResolvedTopology(input: {
  vcpu: number
  vps?: { cpuSockets?: number | null; coresPerSocket?: number | null } | null
  order?: { cpuSockets?: number | null; coresPerSocket?: number | null } | null
  product?: any
  node?: any
}) {
  const savedSockets = Number(input.vps?.cpuSockets || input.order?.cpuSockets || 0)
  const savedCores = Number(input.vps?.coresPerSocket || input.order?.coresPerSocket || 0)
  if (Number.isInteger(savedSockets) && savedSockets > 0 && Number.isInteger(savedCores) && savedCores > 0 && savedSockets * savedCores === input.vcpu) {
    return { sockets: savedSockets, coresPerSocket: savedCores, totalVcpu: input.vcpu }
  }
  return resolveCpuTopology({
    vcpu: input.vcpu,
    node: input.node,
    product: input.product,
    adminOverride: input.order?.cpuSockets && input.order?.coresPerSocket
      ? { sockets: input.order.cpuSockets, coresPerSocket: input.order.coresPerSocket }
      : null,
  })
}

function nextDiskKeyFromConfig(config: Record<string, any>, disks: Array<{ proxmoxDiskKey: string }>) {
  const used = new Set([...Object.keys(config || {}), ...disks.map((disk) => disk.proxmoxDiskKey)])
  for (let index = 0; index < 32; index += 1) {
    const key = `scsi${index}`
    if (!used.has(key)) return key
  }
  throw new Error("No free disk slot is available.")
}

function nextDiskDisplayName(disks: Array<{ displayName: string }>) {
  const used = new Set(disks.map((disk) => String(disk.displayName || "").toLowerCase()))
  for (let index = 1; index < 128; index += 1) {
    const name = `disk${index}`
    if (!used.has(name)) return name
  }
  throw new Error("No free disk name is available.")
}

async function upsertServiceState(input: {
  orderId: string
  customerId: string
  productId?: string | null
  nodeId?: string | null
  osId?: string | null
  vmid: number
  hostname: string
  internalHostname?: string | null
  ipAddress?: string | null
  username?: string | null
  passwordEncrypted?: string | null
  accessMethod?: string | null
  sshKeyId?: string | null
  adminUsername?: string | null
  cpuCores?: number | null
  cpuSockets?: number | null
  coresPerSocket?: number | null
  ramGb?: number | null
  diskGb?: number | null
  displayTag?: string | null
  storagePoolId?: string | null
  storagePoolSnapshot?: any
  status:
    | "CREATING"
    | "CLONING_TEMPLATE"
    | "RESIZING_DISK"
    | "APPLYING_CLOUD_INIT"
    | "STARTING_VM"
    | "ACTIVE"
    | "STOPPED"
    | "START_FAILED"
    | "SUSPENDED"
    | "FAILED"
    | "REPAIR_NEEDED"
    | "UPGRADE_QUEUED"
    | "UPDATING_CONFIG"
    | "UPGRADE_COMPLETE"
    | "UPGRADE_FAILED"
}) {
  const service = await prisma.vpsInstance.upsert({
    where: { orderId: input.orderId },
    update: {
      customerId: input.customerId,
      productId: input.productId || null,
      proxmoxNodeId: input.nodeId || null,
      operatingSystemId: input.osId || null,
      vmid: input.vmid,
      name: input.internalHostname || input.hostname,
      instanceName: input.internalHostname || input.hostname,
      hostname: input.internalHostname || input.hostname,
      status: input.status,
      ipAddress: input.ipAddress || null,
      username: input.username || null,
      passwordEncrypted: input.passwordEncrypted || undefined,
      accessMethod: input.accessMethod || null,
      sshKeyId: input.sshKeyId || null,
      adminUsername: input.adminUsername || null,
      cpuCores: input.cpuCores || null,
      cpuSockets: input.cpuSockets === undefined ? undefined : input.cpuSockets,
      coresPerSocket: input.coresPerSocket === undefined ? undefined : input.coresPerSocket,
      ramGb: input.ramGb || null,
      diskGb: input.diskGb || null,
      displayTag: input.displayTag === undefined ? undefined : (input.displayTag || null),
      storagePoolId: input.storagePoolId === undefined ? undefined : input.storagePoolId,
      storagePoolSnapshot: input.storagePoolSnapshot === undefined ? undefined : input.storagePoolSnapshot,
    },
    create: {
      customerId: input.customerId,
      orderId: input.orderId,
      productId: input.productId || null,
      proxmoxNodeId: input.nodeId || null,
      operatingSystemId: input.osId || null,
      vmid: input.vmid,
      name: input.internalHostname || input.hostname,
      instanceName: input.internalHostname || input.hostname,
      hostname: input.internalHostname || input.hostname,
      status: input.status,
      ipAddress: input.ipAddress || null,
      username: input.username || null,
      passwordEncrypted: input.passwordEncrypted || null,
      accessMethod: input.accessMethod || null,
      sshKeyId: input.sshKeyId || null,
      adminUsername: input.adminUsername || null,
      cpuCores: input.cpuCores || null,
      cpuSockets: input.cpuSockets || null,
      coresPerSocket: input.coresPerSocket || null,
      ramGb: input.ramGb || null,
      diskGb: input.diskGb || null,
      displayTag: input.displayTag || null,
      storagePoolId: input.storagePoolId || null,
      storagePoolSnapshot: input.storagePoolSnapshot || undefined,
    },
  })
  if (input.osId) {
    await persistVpsConsoleMetadata({ vpsId: service.id, osTemplateId: input.osId })
  }
  if (input.diskGb && input.diskGb > 0) {
    await prisma.vpsDisk.upsert({
      where: { vpsId_proxmoxDiskKey: { vpsId: service.id, proxmoxDiskKey: "scsi0" } },
      update: {
        sizeGb: input.diskGb,
        storagePoolId: input.storagePoolId === undefined ? undefined : input.storagePoolId,
        status: service.deletedAt ? "DELETED" : "ACTIVE",
      },
      create: {
        vpsId: service.id,
        proxmoxDiskKey: "scsi0",
        displayName: "disk1",
        sizeGb: input.diskGb,
        storagePoolId: input.storagePoolId || null,
        isPrimary: true,
        status: service.deletedAt ? "DELETED" : "ACTIVE",
        metadata: { source: "provisioning" },
      },
    }).catch(() => null)
  }
  return service
}

async function finalizeJob(jobId: string, status: "completed" | "failed", step: ProvisioningStep, error?: string | null, vpsInstanceId?: string | null) {
  const completed = status === "completed"
  const completedAt = new Date()
  await prisma.provisioningJob.update({
    where: { id: jobId },
    data: {
      status,
      currentStep: step,
      displayStatus: completed ? STEP_LABELS[step] : STEP_LABELS.FAILED,
      error: error || null,
      ...(completed ? { errorCode: null, nextRetryAt: null, progress: 100 } : {}),
      vpsInstanceId: vpsInstanceId || null,
      dedupeKey: null,
      completedAt,
    },
  })
  if (completed) {
    await prisma.provisioningTaskStep.updateMany({
      where: {
        jobId,
        status: { in: ["queued", "running", "retrying", "waiting_for_admin"] },
      },
      data: { status: "completed", completedAt, error: null },
    }).catch(() => null)
  }
}

async function processProvisionJob(jobId: string, leaseOwner: string) {
  paymentFlowLog("Worker received job", { jobId, leaseOwner, type: "provision" })
  const job = await prisma.provisioningJob.update({
    where: { id: jobId },
    data: { status: "running", attempts: { increment: 1 }, claimedAt: new Date(), startedAt: new Date(), error: null },
    include: {
      order: { include: { customer: true, product: true, customConfig: true, offer: true, operatingSystem: { include: { proxmoxNode: true } }, vpsInstance: true, sshKey: true } },
    },
  })

  const order = job.order
  if (!order) throw new Error("Provisioning job order is missing")
  await setProvisioningPhase({ orderId: order.id, jobId: job.id, owner: leaseOwner, phase: "LOCKED", resumePhase: "LOCKED" })
  const hostname = order.hostname || job.hostname || hostnameForOrder(order)
  const customDisks = Array.isArray(order.customConfig?.disks) ? order.customConfig!.disks as any[] : []
  const memoryGb = Number(order.product?.ramGb || order.customConfig?.ramGb || 1)
  const memoryMb = memoryGb * 1024
  const cores = Number(order.product?.cpuCores || order.customConfig?.cpuCores || 1)
  const diskGb = Number(order.product?.storageGb || customDisks.reduce((sum, disk) => sum + Number(disk?.sizeGb || 0), 0) || 0)
  const requestedOsFamily = order.requestedOsFamily || order.operatingSystem?.osFamily || order.osName || null
  const requestedOsVersion = order.requestedOsVersion || order.operatingSystem?.osVersion || null
  const requestedNodeId = order.proxmoxNodeId || order.product?.defaultNodeId || null
  const ipAssignment = ((job.metadata as any)?.ipAssignment || {}) as {
    mode?: string
    poolId?: string | null
    requestedIp?: string | null
    forceIpOverride?: boolean
  }
  if (!order.customerId || (!order.product && !order.customConfig) || !requestedOsFamily) throw new Error("Provisioning inputs are incomplete")

  await setJobDisplay(job.id, "SELECTING_NODE", "running")
  await upsertStep(job.id, "SELECTING_NODE", { status: "running", startedAt: new Date(), error: null })
  await prisma.order.update({ where: { id: order.id }, data: { provisioningStatus: "SELECTING_NODE", provisioningError: null } })
  const requestedIpForPreflight = (
    (ipAssignment.mode === "manual" || ipAssignment.requestedIp) &&
    String(ipAssignment.requestedIp || "").trim() &&
    String(order.vpsInstance?.ipAddress || "").trim() !== String(ipAssignment.requestedIp || "").trim()
  ) ? String(ipAssignment.requestedIp).trim() : null
  const preflight = await validateProvisioningPreflight({
    nodeId: requestedNodeId,
    vcpu: cores,
    ramGb: memoryGb,
    storageGb: diskGb,
    productId: order.productId,
    bandwidthTb: Number(order.product?.bandwidthTb || order.customConfig?.bandwidthTb || 0),
    osFamily: requestedOsFamily,
    osVersion: requestedOsVersion,
    osTemplateId: order.operatingSystemId || null,
    nodeClassId: order.nodeClassId,
    storagePoolId: order.storagePoolId || order.offer?.storagePoolId || null,
    storagePolicyType: order.product?.storagePolicyType || order.product?.storagePoolPolicy || null,
    requiredStorageType: order.product?.requiredStorageType || order.product?.storageType || null,
    requiredStoragePoolId: order.product?.requiredStoragePoolId || order.product?.defaultStoragePoolId || null,
    allowStorageFallback: order.product?.allowStorageFallback,
    allowPremiumNewPurchase: Boolean(order.offerId),
    poolId: ipAssignment.poolId || null,
    requestedIp: requestedIpForPreflight,
    forceIpOverride: ipAssignment.forceIpOverride === true,
  })
  const placement = preflight.placement

  if (!placement.ok || !preflight.ok) {
    const preflightReason = preflight.reason || (placement.ok ? "Provisioning preflight failed" : placement.reason)
    const preflightErrorCode = placement.ok ? preflight.errorCode || "PREFLIGHT_FAILED" : placement.errorCode
    const message = preflightErrorCode === "IP_POOL_UNAVAILABLE"
      ? "No IP pool assigned to product/node."
      : preflightErrorCode === "IP_POOL_EXHAUSTED" || preflightReason.includes("no free IP")
        ? "Assigned IP pool has no free IP addresses."
      : preflightReason.includes("Storage") || preflightReason.includes("storage")
        ? placement.reason.includes("Selected")
          ? "Waiting for storage allocation"
          : "Waiting for storage allocation"
      : preflightReason.includes("template")
        ? "Provisioning is pending because the selected operating system image is not available on an eligible node."
        : preflightReason

    // P0 (WS7): recoverable preflight failures auto-retry fast instead of parking for manual review.
    // Only genuine config errors a retry cannot fix (no IP pool assigned to product/node) go straight to
    // manual review; storage/capacity/IP-exhaustion/proxmox/network are retried a few times first.
    const preflightRetryCount = Number((job.metadata as any)?.preflightRetryCount || 0)
    const maxPreflightRetries = Number(process.env.PROVISION_PREFLIGHT_MAX_RETRIES || 3)
    const isHardConfigFailure = preflightErrorCode === "IP_POOL_UNAVAILABLE"
    if (!isHardConfigFailure && preflightRetryCount < maxPreflightRetries) {
      // Storage preflight uses cached capacity — force a fresh Proxmox storage sync so the retry sees reality.
      if (placement.ok && placement.node?.id && /storage/i.test(`${preflightErrorCode} ${message}`)) {
        await syncNodeStoragePools(placement.node.id).catch(() => null)
      }
      const nextRetryAt = new Date(Date.now() + Math.min(300_000, 15_000 * (preflightRetryCount + 1)))
      await prisma.provisioningJob.update({
        where: { id: job.id },
        data: {
          status: "retrying",
          currentStep: "QUEUED",
          displayStatus: STEP_LABELS.QUEUED,
          errorCode: preflightErrorCode,
          error: message,
          nextRetryAt,
          progress: 5,
          metadata: { ...(job.metadata as any || {}), placement, preflight, preflightRetryCount: preflightRetryCount + 1, lastPreflightRetryAt: new Date().toISOString() },
        },
      })
      await prisma.order.update({ where: { id: order.id }, data: { provisioningStatus: "QUEUED", provisioningError: null } })
      await logJob(job.id, { level: "warn", step: "QUEUED", event: "preflight:auto_retry", message: `Preflight not ready (${message}); auto-retrying (attempt ${preflightRetryCount + 1}/${maxPreflightRetries})`, response: preflight })
      return { retrying: true, reason: message, jobId: job.id }
    }

    await prisma.provisioningJob.update({
      where: { id: job.id },
      data: {
        status: "waiting_for_admin",
        currentStep: "WAITING_FOR_ADMIN",
        displayStatus: "Waiting for manual review",
        errorCode: preflightErrorCode,
        error: message,
        progress: 10,
        metadata: { ...(job.metadata as any || {}), placement, preflight },
      },
    })
    await upsertStep(job.id, "WAITING_FOR_ADMIN", { status: "running", startedAt: new Date(), error: message })
    await prisma.order.update({ where: { id: order.id }, data: { provisioningStatus: "WAITING_FOR_ADMIN", provisioningError: message } })
    await logJob(job.id, { level: "warn", step: "WAITING_FOR_ADMIN", event: "preflight:manual_required", message, response: preflight })
    await createPanelLog({
      category: "Provisioning",
      level: "warn",
      message: "Provisioning pending manual review",
      customerId: order.customerId,
      orderId: order.id,
      metadata: { jobId: job.id, placement },
    })
    await prisma.auditLog.create({
      data: {
        customerId: order.customerId,
        targetType: "provisioning_job",
        targetId: job.id,
        action: "provisioning_pending_manual",
        metadata: { orderId: order.id, errorCode: preflightErrorCode, reason: message },
      },
    }).catch(() => undefined)
    return { pendingManual: true, reason: message, jobId: job.id }
  }

  const template = placement.template
  let node = placement.node
  const storagePool = placement.storagePool
  if (!template?.proxmoxVmid || !node) throw new Error("Provisioning placement did not return a valid template and node")
  let client = getClientForNode(node)
  let nodeName = node.nodeName
  const isWindowsProvision = isWindowsOsTemplate(template)
  const configuredUser = isWindowsProvision ? "Administrator" : "root"
  const passwordEncrypted = order.passwordEncrypted || encryptSecret(generateRandomPassword())
  const rootPassword = decryptSecret(passwordEncrypted)
  const sshPublicKey = order.sshPublicKey || (order.sshKey ? order.sshKey.publicKey : null) || null
  const accessMethod = order.accessMethod || "PASSWORD"
  let internalHostname = hostname
  const canResumeExistingLinuxVm = !isWindowsProvision &&
    Boolean(order.vpsInstance) &&
    ["REPAIR_NEEDED", "FAILED", "START_FAILED", "STOPPED"].includes(String(order.vpsInstance?.status || "").toUpperCase())
  let identity = await ensureProvisioningIdentity({
    orderId: order.id,
    vpsInstanceId: order.vpsInstance?.id || job.vpsInstanceId || null,
    vmUuid: order.vpsInstance?.id || job.vpsInstanceId || order.id,
    proxmoxNodeId: order.vpsInstance?.proxmoxNodeId || job.proxmoxNodeId || null,
    vmid: order.vpsInstance?.vmid || job.vmid || null,
    publicIp: order.vpsInstance?.ipAddress || null,
    macAddress: order.vpsInstance?.vmMacAddress || null,
  })
  let recoveredMatches = await findProxmoxVmsByOrder(order.id).catch(() => ({ matches: [], errors: [] }))
  if (recoveredMatches.matches.length > 1) {
    await scanDuplicateManagedVms({ actorEmail: "system:provision-recovery", apply: true }).catch(() => undefined)
    const quarantined = await (prisma as any).duplicateVmIncident.findMany({ where: { orderId: order.id, status: { in: ["QUARANTINED", "QUARANTINE_FAILED"] } }, select: { vmid: true } }).catch(() => [])
    const blocked = new Set(quarantined.map((row: any) => Number(row.vmid)))
    recoveredMatches = { ...recoveredMatches, matches: recoveredMatches.matches.filter((match) => !blocked.has(match.vmid)) }
  }
  const recoveredVm = recoveredMatches.matches.length === 1 ? recoveredMatches.matches[0] : null
  if (recoveredVm) {
    node = recoveredVm.node
    client = recoveredVm.client
    nodeName = recoveredVm.node.nodeName
    await (prisma as any).vmProvisioningIdentity.update({
      where: { orderId: order.id },
      data: { proxmoxNodeId: node.id, vmid: recoveredVm.vmid, cloneIntentAt: identity.cloneIntentAt || new Date(), cloneCompletedAt: new Date(), phase: "CONFIGURING", resumePhase: "CONFIGURING", metadata: { ...((identity.metadata as any) || {}), recoveredFromProxmoxNotesAt: new Date().toISOString() } },
    })
    await prisma.provisioningJob.update({ where: { id: job.id }, data: { proxmoxNodeId: node.id, nodeName, vmid: recoveredVm.vmid, canonicalPhase: "CONFIGURING", resumePhase: "CONFIGURING" } })
    await prisma.order.update({ where: { id: order.id }, data: { proxmoxNodeId: node.id, proxmoxNode: nodeName, vmId: recoveredVm.vmid } })
    if (order.vpsInstance) await prisma.vpsInstance.update({ where: { id: order.vpsInstance.id }, data: { proxmoxNodeId: node.id, vmid: recoveredVm.vmid } })
    identity = await getProvisioningIdentity(order.id)
    await logJob(job.id, { step: "CLONING_TEMPLATE", event: "clone:recovered_from_notes", message: `Recovered existing VMID ${recoveredVm.vmid} from Proxmox identity notes`, response: { nodeName, vmid: recoveredVm.vmid } })
  }
  let vmid = Number(identity?.vmid || job.vmid || 0)
  if (vmid && !validPanelVmid(vmid)) {
    await logJob(job.id, {
      level: "warn",
      step: "SELECTING_NODE",
      event: "vmid:unsafe_reallocated",
      message: `Stored VMID ${vmid} is outside the safe range; allocating a new VMID`,
      response: { unsafeVmid: vmid, safeRange: `${MIN_PROXMOX_VMID}-${MAX_PROXMOX_VMID}` },
    })
    vmid = 0
  }
  if (vmid) {
    const [dbCollision, existingVm] = await Promise.all([
      prisma.vpsInstance.findFirst({
        where: { proxmoxNodeId: node.id, vmid, deletedAt: null, NOT: { orderId: order.id } },
        select: { id: true, orderId: true },
      }).catch(() => null),
      verifyVm(client, nodeName, vmid).catch(() => ({ exists: false, status: null, config: null as any })),
    ])
    const canReuseExisting = canResumeExistingLinuxVm && vmIdentityMatches(existingVm.config, {
      hostname,
      orderId: order.id,
      serviceId: order.vpsInstance?.id || null,
    })
    const reservedCloneExists = Boolean(identity.cloneIntentAt && existingVm.exists && Number(identity.vmid) === vmid)
    if (dbCollision || (existingVm.exists && !canReuseExisting && !reservedCloneExists)) {
      if (identity.cloneIntentAt) {
        throw new Error(`provisioning_identity_collision_after_clone_intent: VMID ${vmid} cannot be replaced`)
      }
      await logJob(job.id, {
        level: "warn",
        step: "SELECTING_NODE",
        event: "vmid:collision_reallocated",
        message: `Stored VMID ${vmid} is already in use; allocating a new VMID`,
        response: { vmid, dbCollision },
      })
      vmid = await allocateNextVmid(client, nodeName, node.id)
    }
  }
  if (!vmid) vmid = await allocateNextVmid(client, nodeName, node.id)
  const topology = resolveCpuTopology({
    vcpu: cores,
    node,
    product: order.product,
    offer: order.offer,
    adminOverride: order.cpuSockets && order.coresPerSocket ? { sockets: order.cpuSockets, coresPerSocket: order.coresPerSocket } : null,
  })
  const storageSnapshot = snapshotStoragePool(storagePool, { includedDiskGb: Number(order.product?.storageGb || diskGb), diskGb })

  await upsertStep(job.id, "SELECTING_NODE", { status: "completed", completedAt: new Date() })
  await prisma.provisioningJob.update({
    where: { id: job.id },
    data: {
      vmid,
      nodeName,
      proxmoxNodeId: node.id,
      failoverFromNodeId: placement.failoverFromNodeId || null,
      failoverReason: placement.failoverReason || null,
      selectedTemplateId: template.id,
      requestedOsFamily: normalizeOsFamily(requestedOsFamily),
      requestedOsVersion,
      hostname,
      progress: 15,
      metadata: { ...(job.metadata as any || {}), placement },
    },
  })
  if (placement.failoverFromNodeId) {
    await recordCapacityAlert({
      event: "provision_failover",
      dedupeKey: `provisioning:failover:${job.id}`,
      title: "Provisioning failover",
      message: `⚠️ Node Alert\n\nNode:\n${placement.failoverFromNodeId}\n\nAction:\nProvisioning moved to ${node.name}`,
      nodeId: node.id,
      severity: "warning",
      metadata: {
        orderId: order.id,
        jobId: job.id,
        fromNodeId: placement.failoverFromNodeId,
        toNodeId: node.id,
        reason: placement.failoverReason,
      },
      throttleSeconds: 60,
    }).catch(() => null)
    await logJob(job.id, {
      level: "warn",
      step: "SELECTING_NODE",
      event: "placement:failover",
      message: `Provisioning moved from preferred node to ${node.name}`,
      response: { fromNodeId: placement.failoverFromNodeId, toNodeId: node.id, reason: placement.failoverReason },
    }).catch(() => null)
  }
  await prisma.auditLog.create({
    data: {
      customerId: order.customerId,
      targetType: "provisioning_job",
      targetId: job.id,
      action: "provisioning_auto_started",
      metadata: { orderId: order.id, nodeId: node.id, templateId: template.id, vmid },
    },
  }).catch(() => undefined)
  const initialService = await upsertServiceState({
    orderId: order.id,
    customerId: order.customerId,
    productId: order.productId,
    nodeId: node.id,
    osId: template.id,
    vmid,
    hostname,
    ipAddress: order.vpsInstance?.ipAddress || null,
    username: configuredUser,
    passwordEncrypted,
    accessMethod,
    sshKeyId: order.sshKeyId || null,
    adminUsername: order.adminUsername || null,
    cpuCores: cores,
    ramGb: memoryGb,
    diskGb,
    cpuSockets: topology.sockets,
    coresPerSocket: topology.coresPerSocket,
    storagePoolId: storagePool?.id || null,
    storagePoolSnapshot: storageSnapshot,
    status: "CREATING",
  })
  identity = await ensureProvisioningIdentity({
    orderId: order.id,
    vpsInstanceId: initialService.id,
    vmUuid: initialService.id,
    proxmoxNodeId: node.id,
    vmid,
    publicIp: initialService.ipAddress,
    macAddress: initialService.vmMacAddress,
  })
  await prisma.provisioningJob.update({ where: { id: job.id }, data: { vpsInstanceId: initialService.id } })
  await prisma.order.update({
    where: { id: order.id },
    data: {
      provisioningStatus: "CLONING_TEMPLATE",
      operatingSystemId: template.id,
      requestedOsFamily: normalizeOsFamily(requestedOsFamily),
      requestedOsVersion,
      osName: template.name,
      templateVmid: template.proxmoxVmid,
      proxmoxNodeId: node.id,
      vmId: vmid,
      proxmoxNode: nodeName,
      serviceId: initialService.id,
      provisioningError: null,
      cpuSockets: topology.sockets,
      coresPerSocket: topology.coresPerSocket,
      storagePoolId: storagePool?.id || null,
      storagePoolSnapshot: storageSnapshot as any,
    },
  })

  let allocation: Awaited<ReturnType<typeof allocateIp>> | null = null
  const premiumAllocations: Array<Awaited<ReturnType<typeof allocateIp>>> = []
  let guestAutomationApplied = false
  let guestAutomationEvidence: Record<string, unknown> | null = null
  let generatedMacAddress: string | null = null
  const templateConfig = template.proxmoxVmid
    ? await client.getVMConfig(nodeName, template.proxmoxVmid).catch(() => null)
    : null
  const templateMacAddress = macFromNet0((templateConfig as any)?.net0)

  try {
    const startingService = await upsertServiceState({
      orderId: order.id,
      customerId: order.customerId,
      productId: order.productId,
      nodeId: node.id,
      osId: template.id,
      vmid,
      hostname,
      ipAddress: initialService.ipAddress,
      username: configuredUser,
      passwordEncrypted,
      accessMethod,
      sshKeyId: order.sshKeyId || null,
      adminUsername: order.adminUsername || null,
      cpuCores: cores,
      ramGb: memoryGb,
      diskGb,
      status: "CLONING_TEMPLATE",
    })
    await logJob(job.id, {
      step: "CLONING_TEMPLATE",
      event: "clone:start",
      message: `Cloning template VMID ${template.proxmoxVmid} to VMID ${vmid}`,
    })
    const existingVm = await verifyVm(client, nodeName, vmid).catch(() => ({ exists: false, status: null, config: null }))
    if (existingVm?.exists) {
      await logJob(job.id, {
        step: "CLONING_TEMPLATE",
        event: "clone:resume_reserved_vm",
        message: `Reusing reserved VMID ${vmid} and resuming from observable state`,
        response: { vmid, nodeName, status: existingVm.status?.status || null },
      })
    } else {
      await recordCloneIntent({ orderId: order.id, jobId: job.id, owner: leaseOwner, proxmoxNodeId: node.id, vmid })
      try {
        await runTaskOperation(job.id, client, nodeName, "CLONING_TEMPLATE", "clone", { nodeName, templateVmid: template.proxmoxVmid, vmid, hostname }, () =>
          client.cloneVM(nodeName, template.proxmoxVmid!, vmid, hostname, { full: 1, storage: storagePool?.storageId || undefined }),
          async () => {
            const vm = await verifyVm(client, nodeName, vmid)
            return vm.exists
          },
        )
      } catch (cloneError) {
        const acceptedClone = await verifyVm(client, nodeName, vmid).catch(() => ({ exists: false }))
        if (!acceptedClone.exists) throw cloneError
        await logJob(job.id, {
          level: "warn",
          step: "CLONING_TEMPLATE",
          event: "clone:timeout_reconciled",
          message: `Clone response failed, but reserved VMID ${vmid} exists; continuing without another VMID`,
          response: { vmid, error: sanitizeProvisioningError(cloneError) },
        })
      }
    }
    await setProvisioningPhase({ orderId: order.id, jobId: job.id, owner: leaseOwner, phase: "CONFIGURING", resumePhase: "CONFIGURING", cloneCompletedAt: new Date() })
    await upsertStep(job.id, "CLONE_COMPLETE", { status: "completed", startedAt: new Date(), completedAt: new Date() })
    await prisma.provisioningJob.update({ where: { id: job.id }, data: { progress: 45 } })
    await prisma.auditLog.create({
      data: {
        customerId: order.customerId,
        targetType: "vps_instance",
        targetId: initialService.id,
        action: "vm_created",
        metadata: { orderId: order.id, jobId: job.id, nodeId: node.id, vmid },
      },
    }).catch(() => undefined)
    paymentFlowLog("VM created", { orderId: order.id, jobId: job.id, vpsInstanceId: initialService.id, nodeId: node.id, nodeName, vmid })
    await prisma.order.update({ where: { id: order.id }, data: { provisioningStatus: "CLONE_COMPLETE" } })

    const templateDiskGb = Number(template.diskGb || 0)
    const requestedDiskGb = diskGb
    await prisma.order.update({ where: { id: order.id }, data: { provisioningStatus: "RESIZING_DISK" } })
    await setProvisioningPhase({ orderId: order.id, jobId: job.id, owner: leaseOwner, phase: "RESIZING", resumePhase: "RESIZING" })
    await upsertServiceState({
      orderId: order.id,
      customerId: order.customerId,
      productId: order.productId,
      nodeId: node.id,
      osId: template.id,
      vmid,
      hostname,
      ipAddress: initialService.ipAddress,
      username: configuredUser,
      passwordEncrypted,
      accessMethod,
      sshKeyId: order.sshKeyId || null,
      adminUsername: order.adminUsername || null,
      cpuCores: cores,
      ramGb: memoryGb,
      diskGb,
      status: "RESIZING_DISK",
    })
    await logJob(job.id, { step: "RESIZING_DISK", event: "resources:start", message: `Applying VM resources and requesting disk size ${requestedDiskGb}GB` })
    await runTaskOperation(job.id, client, nodeName, "RESIZING_DISK", "config", { vmid, totalVcpu: cores, sockets: topology.sockets, coresPerSocket: topology.coresPerSocket, memoryMb }, () =>
      client.updateVMConfig(nodeName, vmid, { sockets: topology.sockets, cores: topology.coresPerSocket, memory: memoryMb }),
      async () => {
        const vm = await verifyVm(client, nodeName, vmid)
        return vm.exists
      },
    )
    {
      const config = ((await client.getVMConfig(nodeName, vmid).catch(() => ({}))) || {}) as Record<string, any>
      const resizeDiskKey = diskKeyFromConfig(config)
      const currentDiskGb = verifyDiskSizeFromConfig(config, 1).actualGb || templateDiskGb || 0
      if (requestedDiskGb > 0 && currentDiskGb > 0 && requestedDiskGb > currentDiskGb) {
      await runTaskOperation(job.id, client, nodeName, "RESIZING_DISK", "resize", { vmid, disk: resizeDiskKey, size: requestedDiskGb }, () =>
        client.resizeDisk(nodeName, vmid, resizeDiskKey, `+${Math.ceil(requestedDiskGb - currentDiskGb)}G`),
        async () => {
          const refreshed = await client.getVMConfig(nodeName, vmid).catch(() => ({}))
          return verifyDiskSizeFromConfig(refreshed as Record<string, any>, requestedDiskGb).ok
        },
      )
      } else {
      await upsertStep(job.id, "RESIZING_DISK", { status: "completed", completedAt: new Date() })
      }
    }
    await verifyProvisionedDiskSize(job.id, client, nodeName, vmid, requestedDiskGb)

    await setJobDisplay(job.id, "ASSIGNING_IP")
    await setProvisioningPhase({ orderId: order.id, jobId: job.id, owner: leaseOwner, phase: "SETTING_NETWORK", resumePhase: "SETTING_NETWORK" })
    await prisma.order.update({ where: { id: order.id }, data: { provisioningStatus: "ASSIGNING_IP" } })
    await upsertStep(job.id, "ASSIGNING_IP", { status: "running", startedAt: new Date(), error: null })
    allocation = await prisma.ipAllocation.findFirst({
          where: {
            vpsInstanceId: initialService.id,
            allocationType: "default",
            status: { in: ["USED", "used", "ASSIGNED", "assigned", "RESERVED", "reserved"] },
            releasedAt: null,
          },
          include: { pool: true },
          orderBy: { updatedAt: "desc" },
        }) as Awaited<ReturnType<typeof allocateIp>> | null
    if (!allocation) {
      allocation = await allocateIp({
        proxmoxNodeId: node.id,
        productId: order.productId,
        poolId: ipAssignment.poolId || null,
        requestedIp: ipAssignment.mode === "manual" || ipAssignment.requestedIp ? ipAssignment.requestedIp || null : null,
        forceOverride: ipAssignment.forceIpOverride === true,
        vpsInstanceId: initialService.id,
        vmid,
        hostname,
        assignedBy: "provisioner",
        allocationType: "default",
        purpose: "provisioning",
      })
    }
    const premiumIpRequest = (order.metadata as any)?.premiumIps
    const premiumIpCount = Math.max(0, Math.floor(Number(premiumIpRequest?.quantity || 0)))
    if (!existingVm?.exists) {
      for (let index = 0; index < premiumIpCount; index++) {
        const premium = await allocateIp({
          proxmoxNodeId: node.id,
          productId: order.productId,
          vpsInstanceId: initialService.id,
          vmid,
          hostname,
          assignedBy: "provisioner",
          allocationType: "premium",
          purpose: "provisioning",
        })
        premiumAllocations.push(premium)
      }
    }
    await upsertStep(job.id, "ASSIGNING_IP", { status: "completed", completedAt: new Date() })
    await logJob(job.id, {
      step: "ASSIGNING_IP",
      event: existingVm?.exists ? "ip:preserved" : "ip:allocated",
      message: `${existingVm?.exists ? "Preserved" : "Allocated"} ${allocation.ipAddress}${premiumAllocations.length ? ` and ${premiumAllocations.length} premium IPs` : ""}`,
      response: { ipAddress: allocation.ipAddress, poolId: allocation.poolId, premiumIps: premiumAllocations.map((item) => ({ ipAddress: item.ipAddress, poolId: item.poolId })) },
    })
    internalHostname = hostnameFromIp(allocation.ipAddress) || hostname
    await Promise.all([
      client.updateVMConfig(nodeName, vmid, { name: internalHostname }).catch(() => null),
      prisma.ipAllocation.updateMany({
        where: { vpsInstanceId: initialService.id, vmid },
        data: { hostname: internalHostname },
      }).catch(() => null),
    ])

    const pool = allocation.pool
    const netBridge = pool.bridgeOverride || pool.bridge || "vmbr0"
    generatedMacAddress = await applyFreshMacBeforeFirstBoot({
      jobId: job.id,
      client,
      nodeName,
      vmid,
      bridge: netBridge,
      templateMac: templateMacAddress,
      skipRegenerate: Boolean(existingVm?.exists),
    })
    if (!generatedMacAddress) throw new Error("mac_generation_missing")
    if (templateMacAddress && generatedMacAddress === templateMacAddress) throw new Error("mac_generation_failed_template_match")
    await prisma.order.update({ where: { id: order.id }, data: { provisioningStatus: "APPLYING_CLOUD_INIT" } })
    await upsertServiceState({
      orderId: order.id,
      customerId: order.customerId,
      productId: order.productId,
      nodeId: node.id,
      osId: template.id,
      vmid,
      hostname,
      internalHostname,
      ipAddress: allocation?.ipAddress || null,
      username: configuredUser,
      passwordEncrypted,
      accessMethod,
      sshKeyId: order.sshKeyId || null,
      adminUsername: order.adminUsername || null,
      cpuCores: cores,
      ramGb: memoryGb,
      diskGb,
      status: "APPLYING_CLOUD_INIT",
    })
    await logJob(job.id, { step: "APPLYING_CLOUD_INIT", event: "cloud_init:start", message: "Configuring server settings" })
    await applyPreBootVmConfig({
      jobId: job.id,
      client,
      nodeName,
      vmid,
      template,
      netBridge,
      macAddress: generatedMacAddress,
      description: buildVmNotes({
        customerName: order.customer?.name || order.customer?.email || null,
        customerId: order.customerId,
        orderId: order.id,
        productId: order.productId || null,
        productName: order.product?.name || null,
        productTag: order.product?.slug || null,
        service: order.product?.slug || order.product?.name || "zws",
        vmUuid: initialService.id,
        vmid,
        ip: allocation.ipAddress,
        mac: generatedMacAddress,
        createdAt: initialService.createdAt,
        provisionedAt: new Date(),
        creator: "panel",
        nodeId: node.id,
        nodeName,
      }),
      displayStatus: "Configuring server settings",
    })
    guestAutomationApplied = true
    await ensureProvisioningIdentity({ orderId: order.id, vpsInstanceId: initialService.id, vmUuid: initialService.id, proxmoxNodeId: node.id, vmid, publicIp: allocation.ipAddress, macAddress: generatedMacAddress })

    await prisma.order.update({ where: { id: order.id }, data: { provisioningStatus: "STARTING_VM" } })
    await setProvisioningPhase({ orderId: order.id, jobId: job.id, owner: leaseOwner, phase: "STARTING", resumePhase: "STARTING" })
    await upsertServiceState({
      orderId: order.id,
      customerId: order.customerId,
      productId: order.productId,
      nodeId: node.id,
      osId: template.id,
      vmid,
      hostname,
      internalHostname,
      ipAddress: allocation?.ipAddress || null,
      username: configuredUser,
      passwordEncrypted,
      accessMethod,
      sshKeyId: order.sshKeyId || null,
      adminUsername: order.adminUsername || null,
      cpuCores: cores,
      ramGb: memoryGb,
      diskGb,
      status: "STARTING_VM",
    })
    await markIpUsed(allocation.id, startingService.id, vmid)
    await logJob(job.id, { step: "STARTING_VM", event: "start:start", message: "Starting server services" })
    const startGuardVps = await prisma.vpsInstance.findUnique({
      where: { id: startingService.id },
      include: { order: true, operatingSystem: true },
    })
    if (!startGuardVps) throw new Error("start_guard_vps_missing")
    await ensureGuestBeforeStartAction({
      vps: startGuardVps,
      ctx: guestContextFor({ vpsInstanceId: startGuardVps.id, vmid, node }),
      actor: "system:provision",
    })
    await startVmAndVerify(job.id, client, nodeName, vmid)
    await prisma.provisioningJob.update({ where: { id: job.id }, data: { progress: 85 } })
    await prisma.auditLog.create({
      data: {
        customerId: order.customerId,
        targetType: "vps_instance",
        targetId: initialService.id,
        action: "vm_started",
        metadata: { orderId: order.id, jobId: job.id, nodeId: node.id, vmid },
      },
    }).catch(() => undefined)

    await setJobDisplay(job.id, "VERIFYING_VM")
    await setProvisioningPhase({ orderId: order.id, jobId: job.id, owner: leaseOwner, phase: "WAITING_GUEST_AGENT", resumePhase: "WAITING_GUEST_AGENT" })
    await upsertStep(job.id, "VERIFYING_VM", { status: "running", startedAt: new Date(), error: null })
    await logJob(job.id, { step: "VERIFYING_VM", event: "verify:start", message: "Final server optimization" })
    let vm = await verifyVm(client, nodeName, vmid)
    if (!vm.exists) throw new Error("Provisioned VM does not exist")
    const discoveredIp = await discoverVmIpAddress({ client, nodeName, vmid, config: vm.config, allocatedIp: allocation.ipAddress, hostname })
    const finalIpAddress = discoveredIp.ipAddress || allocation.ipAddress
    // `ipconfig0` is gone as a source of truth: nothing writes it any more. If
    // the guest agent did not report an address, that is a real problem and the
    // gate below will say so precisely.
    if (!discoveredIp.ipAddress) {
      throw new Error("guest_ip_not_reported: the guest agent did not report an IP address for this server")
    }
    if (discoveredIp.ipAddress && discoveredIp.ipAddress !== allocation.ipAddress) {
      await logJob(job.id, {
        step: "VERIFYING_VM",
        level: "warn",
        event: "ip:discovered_mismatch",
        message: `Detected VM IP ${discoveredIp.ipAddress} differs from allocated IP ${allocation.ipAddress}`,
        response: { allocatedIp: allocation.ipAddress, discoveredIp: discoveredIp.ipAddress, source: discoveredIp.source },
      })
    } else {
      await logJob(job.id, {
        step: "VERIFYING_VM",
        event: "ip:discovered",
        message: `Detected VM IP ${finalIpAddress}`,
        response: { ipAddress: finalIpAddress, source: discoveredIp.source },
      })
    }
    await verifyProvisionedDiskSize(job.id, client, nodeName, vmid, diskGb, "VERIFYING_VM")

    // The guest configures itself. This is the step that replaced
    // `qm cloudinit update`: it waits for the agent, detects the OS, resolves the
    // template for that OS, and applies the first-boot sequence through it.
    await configureGuestAfterBoot({
      jobId: job.id,
      vpsInstanceId: startingService.id,
      vmid,
      node,
      metadata: guestOsMetadataFor(template),
      desired: {
        ip: allocation.ipAddress,
        prefix: Number(pool.cidr || 24),
        gateway: pool.gateway,
        dns: splitList(String(pool.dns || "1.1.1.1")),
        searchDomain: pool.searchDomain,
        hostname: internalHostname,
        username: configuredUser,
        password: rootPassword,
      },
      displayStatus: "Configuring server",
    })

    const expectedGuestUser = isWindowsProvision ? "Administrator" : configuredUser
    if (isWindowsProvision && !/^win/i.test(String(vm.config?.ostype || "")) && !String(template.osType || template.name || "").toLowerCase().includes("windows")) {
      throw new Error("windows_ostype_mismatch: Windows VM ostype is not Windows")
    }
    try {
      const verifiedGuest = await verifyGuestConfigured({
        jobId: job.id,
        client,
        nodeName,
        vmid,
        vpsInstanceId: startingService.id,
        node,
        metadata: guestOsMetadataFor(template),
        expectedUser: expectedGuestUser,
        expectedIp: allocation.ipAddress,
        isWindows: isWindowsProvision,
      })
      guestAutomationEvidence = {
        runId: verifiedGuest.runId ?? null,
        os: verifiedGuest.detected.osId,
        template: verifiedGuest.template.name,
        templateVersion: verifiedGuest.template.version,
      }
    } catch (verifyError: any) {
      await logJob(job.id, {
        step: "VERIFYING_VM",
        event: "guest_verify:retry_start",
        level: "warn",
        message: sanitizeProvisioningError(verifyError),
        response: { vmid, nodeName, ip: allocation.ipAddress, gateway: pool.gateway, cidr: Number(pool.cidr || 24) },
      })
      await retryLinuxNetworkVerification({
        jobId: job.id,
        client,
        nodeName,
        vmid,
        vpsInstanceId: startingService.id,
        node,
        metadata: guestOsMetadataFor(template),
        hostname: internalHostname,
        username: configuredUser,
        password: rootPassword,
        expectedIp: allocation.ipAddress,
        expectedCidr: Number(pool.cidr || 24),
        expectedGateway: pool.gateway,
        expectedDns: pool.dns,
        expectedSearchDomain: pool.searchDomain,
        expectedBridge: netBridge,
        attempts: 5,
      })
    }

    let runtimeStatus = String(vm.status?.status || "").toLowerCase()
    if (runtimeStatus !== "running") {
      await logJob(job.id, {
        step: "STARTING_VM",
        event: "start:runtime_retry",
        level: "warn",
        message: `VM ${vmid} reported ${runtimeStatus || "unknown"} after verification; retrying start before delivery`,
      })
      const retryGuardVps = await prisma.vpsInstance.findUnique({
        where: { id: startingService.id },
        include: { order: true, operatingSystem: true },
      })
      if (!retryGuardVps) throw new Error("retry_start_guard_vps_missing")
      await ensureGuestBeforeStartAction({
        vps: retryGuardVps,
        ctx: guestContextFor({ vpsInstanceId: retryGuardVps.id, vmid, node }),
        actor: "system:provision-retry",
      })
      await startVmAndVerify(job.id, client, nodeName, vmid, "Starting server services")
      vm = await verifyVm(client, nodeName, vmid)
      runtimeStatus = String(vm.status?.status || "").toLowerCase()
    }
    if (runtimeStatus !== "running") {
      throw new Error(`Provisioned VM ${vmid} is ${runtimeStatus || "not running"} after start`)
    }
    if (!isWindowsProvision) {
      await ensureLinuxPasswordSshAccess({
        jobId: job.id,
        client,
        nodeName,
        vmid,
        username: configuredUser,
        password: rootPassword,
        accessMethod,
      })
    }
    const hardGate = await verifyProvisioningHardGateWithConvergence({
      jobId: job.id,
      client,
      nodeName,
      vmid,
      vpsInstanceId: startingService.id,
      customerId: order.customerId,
      orderId: order.id,
      expectedIp: allocation.ipAddress,
      expectedCidr: Number(pool.cidr || 24),
      expectedGateway: pool.gateway,
      expectedDns: pool.dns,
      expectedSearchDomain: pool.searchDomain,
      expectedBridge: netBridge,
      expectedMac: generatedMacAddress,
      templateMac: templateMacAddress,
      sshKeyRequired: Boolean(order.sshPublicKey || order.sshKeyId),
      isWindows: isWindowsProvision,
      guestAutomationEvidence,
      attempts: isWindowsProvision ? 8 : 4,
      settleMs: isWindowsProvision ? 60000 : 20000,
    })
    const mappedStatus = runtimeStatus === "running" ? "ACTIVE" : "STOPPED"
    const service = await upsertServiceState({
      orderId: order.id,
      customerId: order.customerId,
      productId: order.productId,
      nodeId: node.id,
      osId: template.id,
      vmid,
      hostname,
      internalHostname,
      ipAddress: finalIpAddress,
      username: configuredUser,
      passwordEncrypted,
      accessMethod,
      sshKeyId: order.sshKeyId || null,
      adminUsername: order.adminUsername || null,
      cpuCores: cores,
      ramGb: memoryGb,
      diskGb,
      status: mappedStatus,
    })
    await prisma.vmNetworkInterface.upsert({
      where: { vpsInstanceId_name: { vpsInstanceId: service.id, name: "net0" } },
      create: {
        vpsInstanceId: service.id,
        proxmoxNodeId: node.id,
        vmid,
        name: "net0",
        isPrimary: true,
        macAddress: hardGate.macAddress || generatedMacAddress,
        bridge: netBridge,
        model: "virtio",
        metadata: { source: "provisioning_hard_gate", templateMacAddress },
      },
      update: {
        proxmoxNodeId: node.id,
        vmid,
        isPrimary: true,
        macAddress: hardGate.macAddress || generatedMacAddress,
        bridge: netBridge,
        model: "virtio",
        metadata: { source: "provisioning_hard_gate", templateMacAddress },
      },
    }).catch(() => null)
    await (prisma as any).vmNetworkCache.upsert({
      where: { vpsInstanceId: service.id },
      create: {
        vpsInstanceId: service.id,
        customerId: order.customerId,
        proxmoxNodeId: node.id,
        vmid,
        primaryAssignedIp: finalIpAddress,
        primaryGateway: pool.gateway,
        primaryCidr: Number(pool.cidr || 24),
        primaryDns: pool.dns || null,
        primaryBridge: netBridge,
        cloudInitIp: allocation.ipAddress,
        source: "provisioning_hard_gate",
        lastSyncedAt: new Date(),
        metadata: { macAddress: hardGate.macAddress || generatedMacAddress, hardGate: hardGate.checks, templateMacAddress },
      },
      update: {
        primaryAssignedIp: finalIpAddress,
        primaryGateway: pool.gateway,
        primaryCidr: Number(pool.cidr || 24),
        primaryDns: pool.dns || null,
        primaryBridge: netBridge,
        cloudInitIp: allocation.ipAddress,
        source: "provisioning_hard_gate",
        lastSyncedAt: new Date(),
        metadata: { macAddress: hardGate.macAddress || generatedMacAddress, hardGate: hardGate.checks, templateMacAddress },
      },
    }).catch(() => null)

    if (allocation) {
      await markIpUsed(allocation.id, service.id, vmid)
    }
    for (const premium of premiumAllocations) {
      await markIpUsed(premium.id, service.id, vmid)
    }

    const provisionedAt = new Date()
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: "active",
        provisioningStatus: mappedStatus === "ACTIVE" ? "ACTIVE" : "VERIFYING_VM",
        provisioningError: null,
        provisionedAt,
        serviceId: service.id,
        vmId: vmid,
        proxmoxNode: nodeName,
      },
    })
    const renewalDates = lifecycleDates({
      orderCreatedAt: order.createdAt,
      termMonths: Math.max(1, Number(order.termMonths || 1)),
      graceDays: 2,
      retentionDays: 7,
    })
    const renewalDueAt = renewalDates.renewalDueAt
    await prisma.vpsInstance.update({
      where: { id: service.id },
      data: {
        vmMacAddress: hardGate.macAddress || generatedMacAddress,
        billingCycle: order.termMonths >= 12 ? "annual" : "monthly",
        billingTermMonths: Math.max(1, Number(order.termMonths || 1)),
        activatedAt: provisionedAt,
        renewalDueAt,
        nextRenewalAt: renewalDueAt,
        suspendAt: renewalDates.suspendAt,
        penaltyAt: renewalDates.penaltyAt,
        terminationAt: renewalDates.terminationAt,
        deletionAt: renewalDates.deletionAt,
        renewalAmount: renewalAmountForOrder(order),
        upgradeAmount: 0,
        provisioningSource: "panel",
        ownershipStatus: "panel_owned",
        ownershipEvidence: {
          managed: true,
          creator: "panel",
          orderId: order.id,
          nodeId: node.id,
          nodeName,
          vmid,
          timestamp: provisionedAt.toISOString(),
        },
        lifecycleMetadata: {
          orderAnchoredBilling: true,
          orderCreatedAt: order.createdAt.toISOString(),
          activatedAt: provisionedAt.toISOString(),
          termMonths: Math.max(1, Number(order.termMonths || 1)),
        },
      },
    })
    await upsertStep(job.id, "VERIFYING_VM", { status: "completed", completedAt: new Date() })
    await finalizeJob(job.id, "completed", "ACTIVE", null, service.id)
    await setProvisioningPhase({ orderId: order.id, jobId: job.id, owner: leaseOwner, phase: "READY", resumePhase: "READY" })
    await prisma.provisioningJob.update({ where: { id: job.id }, data: { progress: 100 } })
    await logJob(job.id, { step: "ACTIVE", event: "job:completed", message: runtimeStatus === "running" ? "Your cloud server is ready" : `Provisioned VM ${vmid} (${mappedStatus})` })
    paymentFlowLog("Provisioning completed", { orderId: order.id, jobId: job.id, vpsInstanceId: service.id, nodeName, vmid, status: mappedStatus })
    await publishLiveVmSnapshot(service.id, "provision:complete").catch(() => null)
    if (mappedStatus === "ACTIVE") {
      await sendServiceStatusNotification({
        templateKey: WHATSAPP_TEMPLATE_KEYS.VPS_DEPLOYED,
        customer: order.customer!,
        variables: await deploymentMessageVariables({
          orderId: order.id,
          customerName: order.customer!.name,
          hostname: service.name || order.hostname || order.orderNumber,
          ip: service.ipAddress,
          username: service.username || service.adminUsername || order.adminUsername || null,
          passwordEncrypted,
          os: (service as any).operatingSystem?.name || order.osName || null,
          plan: order.product?.name || order.offer?.name || "VPS",
          renewalDate: renewalDueAt,
          vpsInstanceId: service.id,
          billingCycle: order.termMonths >= 12 ? "Annual" : "Monthly",
          region: node.location || node.nodeName || nodeName,
        }),
        orderId: order.id,
        vpsInstanceId: service.id,
        metadata: { source: "provisioning_complete", jobId: job.id, vmid },
      }).catch((emailError) => {
        console.error("[Provisioning] service_active email failed", { orderId: order.id, message: emailError?.message })
      })
    }
    return { vmid, node: nodeName, serviceId: service.id }
  } catch (error) {
    paymentFlowError("Provisioning failed", error, { jobId: job.id, orderId: order.id })
    const reason = sanitizeProvisioningError(error)
    await setProvisioningPhase({ orderId: order.id, jobId: job.id, owner: leaseOwner, phase: "FAILED", error: reason }).catch(() => undefined)
    const diagnostics = provisioningDiagnostics(error, { nodeName, job, step: job.currentStep, vmid })
    const vm = await verifyVm(client, nodeName, vmid).catch(() => ({ exists: false, status: null, config: null }))
    const vmMatchesThisJob = vm.exists && vmIdentityMatches(vm.config, {
      hostname,
      orderId: order.id,
      serviceId: order.vpsInstance?.id || null,
    })

    if (vmMatchesThisJob) {
      if (isGuestAutomationManualReviewError(error, template)) {
        const service = await upsertServiceState({
          orderId: order.id,
          customerId: order.customerId,
          productId: order.productId,
          nodeId: node.id,
          osId: template.id,
          vmid,
          hostname,
          ipAddress: allocation?.ipAddress || null,
          username: configuredUser,
          passwordEncrypted,
          accessMethod,
          sshKeyId: order.sshKeyId || null,
          adminUsername: configuredUser,
          cpuCores: cores,
          ramGb: memoryGb,
          diskGb,
          status: "REPAIR_NEEDED",
        })
        if (allocation) await markIpUsed(allocation.id, service.id, vmid)
        for (const premium of premiumAllocations) await markIpUsed(premium.id, service.id, vmid)
        await prisma.order.update({
          where: { id: order.id },
          data: {
            status: "paid",
            provisioningStatus: "WAITING_FOR_ADMIN",
            provisioningError: reason,
            serviceId: service.id,
          },
        })
        await prisma.provisioningJob.update({
          where: { id: job.id },
          data: {
            status: "waiting_for_admin",
            currentStep: "APPLYING_CLOUD_INIT",
            displayStatus: "Waiting for manual review",
            errorCode: "LINUX_CLOUD_INIT_VERIFY_FAILED",
            error: reason,
            vpsInstanceId: service.id,
            completedAt: new Date(),
            progress: 70,
          },
        })
        await upsertStep(job.id, "APPLYING_CLOUD_INIT", { status: "failed", startedAt: new Date(), completedAt: new Date(), error: reason })
        await logJob(job.id, {
          level: "error",
          step: "APPLYING_CLOUD_INIT",
          event: "guest_automation:manual_review",
          message: reason,
          response: { vmExists: true, vmid, ipPreserved: Boolean(allocation?.ipAddress) },
        })
        await createPanelLog({
          category: "Provisioning",
          level: "error",
          message: "Guest automation could not complete and needs admin review",
          customerId: order.customerId,
          orderId: order.id,
          vpsInstanceId: service.id,
          vmid,
          metadata: { jobId: job.id, errorCode: "GUEST_AUTOMATION_MANUAL_REVIEW", reason, ipPreserved: allocation?.ipAddress || null },
        }).catch(() => null)
        await prisma.auditLog.create({
          data: {
            customerId: order.customerId,
            targetType: "provisioning_job",
            targetId: job.id,
            action: "linux_cloud_init_manual_review",
            metadata: { orderId: order.id, vpsInstanceId: service.id, vmid, reason },
          },
        }).catch(() => undefined)
        return { pendingManual: true, reason, jobId: job.id, vmid, serviceId: service.id }
      }

      const hardFailed = reason.toLowerCase().includes("proxmox task failed")
      const validationFailed = isProvisioningValidationFailure(reason)
      const mappedStatus: "START_FAILED" | "FAILED" = hardFailed
        ? "FAILED"
        : "START_FAILED"
      const service = await upsertServiceState({
        orderId: order.id,
        customerId: order.customerId,
        productId: order.productId,
        nodeId: node.id,
        osId: template.id,
        vmid,
        hostname,
        ipAddress: allocation?.ipAddress || null,
        username: configuredUser,
        passwordEncrypted,
        accessMethod,
        sshKeyId: order.sshKeyId || null,
        adminUsername: order.adminUsername || null,
        cpuCores: cores,
        ramGb: memoryGb,
        diskGb,
        status: mappedStatus,
      })
      if (allocation) await markIpUsed(allocation.id, service.id, vmid)
      for (const premium of premiumAllocations) await markIpUsed(premium.id, service.id, vmid)
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: "paid",
          provisioningStatus: mappedStatus,
          provisioningError: reason,
          serviceId: service.id,
        },
      })
      await prisma.provisioningJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          currentStep: mappedStatus,
          displayStatus: STEP_LABELS[mappedStatus],
          error: reason,
          vpsInstanceId: service.id,
          dedupeKey: null,
          completedAt: new Date(),
        },
      })
      await upsertStep(job.id, mappedStatus, { status: "failed", startedAt: new Date(), completedAt: new Date(), error: reason })
      await logJob(job.id, { level: "error", step: mappedStatus, event: "job:failed_after_vm_create", message: reason, response: { vmExists: true, vmid, validationFailed, guestAutomationApplied } })
      return { vmid, node: nodeName, serviceId: service.id, reconciled: true }
    }

    if (allocation) await logJob(job.id, { step: "ASSIGNING_IP", event: "ip:retained_for_recovery", message: `Retained ${allocation.ipAddress} for idempotent recovery` })
    for (const premium of premiumAllocations) await logJob(job.id, { step: "ASSIGNING_IP", event: "ip:retained_for_recovery", message: `Retained premium IP ${premium.ipAddress} for idempotent recovery` })
    await upsertServiceState({
      orderId: order.id,
      customerId: order.customerId,
      productId: order.productId,
      nodeId: node.id,
      osId: template.id,
      vmid,
      hostname,
      ipAddress: null,
      username: configuredUser,
      passwordEncrypted,
      accessMethod,
      sshKeyId: order.sshKeyId || null,
      adminUsername: order.adminUsername || null,
      cpuCores: cores,
      ramGb: memoryGb,
      diskGb,
      status: "FAILED",
    })
    await prisma.order.update({ where: { id: order.id }, data: { provisioningStatus: "FAILED", provisioningError: reason } })
    await finalizeJob(job.id, "failed", "FAILED", reason)
    await prisma.provisioningJob.update({ where: { id: job.id }, data: { metadata: { ...((job.metadata || {}) as any), diagnostics } } }).catch(() => undefined)
    await logJob(job.id, { level: "error", event: "job:failed", message: reason, response: { vmExists: false, vmid, diagnostics } })
    throw new Error(reason)
  }
}

async function processUpgradeJob(jobId: string) {
  const job = await prisma.provisioningJob.update({
    where: { id: jobId },
    data: { status: "running", attempts: { increment: 1 }, claimedAt: new Date(), startedAt: new Date(), error: null },
    include: { order: true },
  })

  const order = job.order
  if (!order) throw new Error("Upgrade job order is missing")
  const upgradeMeta = (order.metadata || {}) as any
  const vpsInstanceId = String(upgradeMeta?.upgrade?.vpsInstanceId || "")
  if (!vpsInstanceId) throw new Error("Upgrade metadata missing VPS target")

  const vps = await prisma.vpsInstance.findUnique({ where: { id: vpsInstanceId }, include: { proxmoxNode: true, product: true, order: true, operatingSystem: true } })
  if (!vps || !vps.proxmoxNode) throw new Error("Upgrade VPS target is unavailable")
  const diskUpgradeMeta = upgradeMeta?.diskUpgrade
  if (upgradeMeta?.kind === "disk_upgrade" && diskUpgradeMeta) {
    const operation = String(diskUpgradeMeta.operation || "")
    const orderType = String(upgradeMeta.orderType || diskUpgradeMeta.orderType || "DISK_RESIZE")
    const targetSizeGb = Math.round(Number(diskUpgradeMeta.targetSizeGb || 0))
    const targetPoolId = String(diskUpgradeMeta.targetPool?.id || "")
    const targetPool = targetPoolId ? await prisma.nodeStoragePoolConfig.findUnique({ where: { id: targetPoolId } }) : null
    if (!targetPool || !targetPool.enabled || targetPool.missingFromProxmox) throw new Error("Target storage pool is unavailable")
    const disks = await prisma.vpsDisk.findMany({ where: { vpsId: vps.id, status: { not: "DELETED" } }, include: { storagePool: true }, orderBy: [{ isPrimary: "desc" }, { displayName: "asc" }] })
    const selectedDiskId = diskUpgradeMeta.disk?.id ? String(diskUpgradeMeta.disk.id) : ""
    const selectedDisk = selectedDiskId ? disks.find((disk) => disk.id === selectedDiskId) : null
    if (operation !== "add" && !selectedDisk) throw new Error("Disk target is unavailable")
    const fromDisk = Number(selectedDisk?.sizeGb || 0)
    if (operation !== "add" && targetSizeGb < fromDisk) throw new Error("Disk shrink is not supported")

    const request = await prisma.vpsUpgradeRequest.create({
      data: {
        vpsInstanceId: vps.id,
        customerId: vps.customerId,
        status: "running",
        fromDiskGb: operation === "add" ? null : fromDisk,
        toDiskGb: targetSizeGb || null,
        metadata: { orderType, operation, upgradeOrderId: order.id, diskId: selectedDisk?.id || null, targetPoolId },
      },
    })

    const client = getClientForNode(vps.proxmoxNode)
    const diskCustomer = await prisma.customer.findUnique({ where: { id: vps.customerId } }).catch(() => null)
    try {
      await setJobDisplay(job.id, "UPGRADE_QUEUED")
      await upsertStep(job.id, "UPGRADE_QUEUED", { status: "completed", startedAt: new Date(), completedAt: new Date() })
      await prisma.vpsInstance.update({ where: { id: vps.id }, data: { status: operation === "add" ? "DISK_ADDING" : operation === "migrate" ? "DISK_MIGRATING" : "RESIZING_DISK" } })
      await logJob(job.id, { step: "UPGRADE_QUEUED", event: "disk_upgrade:start", message: "Disk upgrade started" })
      await createPanelLog({
        category: "Provisioning",
        message: "disk_operation_started",
        customerId: vps.customerId,
        orderId: order.id,
        vpsInstanceId: vps.id,
        vmid: vps.vmid,
        metadata: { orderType, operation, targetSizeGb, targetPoolId },
      })
      if (diskCustomer?.email || diskCustomer?.phone) {
        await sendServiceStatusNotification({
          templateKey: WHATSAPP_TEMPLATE_KEYS.PROVISIONING_UPDATE,
          customer: diskCustomer,
          variables: { userName: diskCustomer.name || "there", email: diskCustomer.email, orderId: order.orderNumber, serviceName: vps.name },
          orderId: order.id,
          vpsInstanceId: vps.id,
          metadata: { source: "disk_upgrade_started", jobId: job.id, operation },
        }).catch(() => null)
      }

      const vmConfig = await client.getVMConfig(vps.proxmoxNode.nodeName, vps.vmid).catch(() => ({}))
      if (operation === "resize" || (operation === "migrate" && selectedDisk && targetSizeGb > fromDisk)) {
        await logJob(job.id, { step: "RESIZING_DISK", event: "disk_upgrade:resize", message: `Resizing ${selectedDisk!.displayName} to ${targetSizeGb}GB` })
        await runTaskOperation(job.id, client, vps.proxmoxNode.nodeName, "RESIZING_DISK", "resize", { vmid: vps.vmid, disk: selectedDisk!.proxmoxDiskKey, size: targetSizeGb }, () =>
          client.resizeDisk(vps.proxmoxNode!.nodeName, vps.vmid, selectedDisk!.proxmoxDiskKey, `+${targetSizeGb - fromDisk}G`),
          async () => (await verifyVm(client, vps.proxmoxNode!.nodeName, vps.vmid)).exists,
        )
        const guestResize = await expandGuestPrimaryDisk({
          client,
          nodeName: vps.proxmoxNode.nodeName,
          vmid: vps.vmid,
          os: resolveVmGuestOs({
            osType: vps.operatingSystem?.osType,
            osFamily: vps.operatingSystem?.osFamily,
            category: vps.operatingSystem?.category,
            osName: vps.operatingSystem?.name,
            vmOsFamily: vps.vmOsFamily,
            orderOsName: vps.order?.osName,
          }),
        }).catch((error) => ({ ok: false, error: error?.message || String(error) }))
        await logJob(job.id, { step: "RESIZING_DISK", event: "disk_upgrade:guest_expand", message: "Expanded guest filesystem", response: guestResize })
        if (!guestResize.ok) throw new Error(`guest_disk_expand_failed: ${(guestResize as any).error || "verification_failed"}`)
        await prisma.vpsDisk.update({ where: { id: selectedDisk!.id }, data: { sizeGb: targetSizeGb, status: "ACTIVE" } })
      }

      if (operation === "migrate") {
        await logJob(job.id, { step: "UPDATING_CONFIG", event: "disk_upgrade:migrate", message: `Moving ${selectedDisk!.displayName} to ${targetPool.storageId}` })
        await runTaskOperation(job.id, client, vps.proxmoxNode.nodeName, "UPDATING_CONFIG", "move_disk", { vmid: vps.vmid, disk: selectedDisk!.proxmoxDiskKey, storage: targetPool.storageId }, () =>
          client.moveDisk(vps.proxmoxNode!.nodeName, vps.vmid, selectedDisk!.proxmoxDiskKey, targetPool.storageId),
          async () => (await verifyVm(client, vps.proxmoxNode!.nodeName, vps.vmid)).exists,
        )
        await prisma.vpsDisk.update({ where: { id: selectedDisk!.id }, data: { storagePoolId: targetPool.id, sizeGb: targetSizeGb || fromDisk, status: "ACTIVE" } })
      }

      if (operation === "add") {
        const key = nextDiskKeyFromConfig(vmConfig, disks)
        const displayName = nextDiskDisplayName(disks)
        await logJob(job.id, { step: "UPDATING_CONFIG", event: "disk_upgrade:add", message: `Adding ${displayName} on ${targetPool.storageId}` })
        await runTaskOperation(job.id, client, vps.proxmoxNode.nodeName, "UPDATING_CONFIG", "add_disk", { vmid: vps.vmid, disk: key, sizeGb: targetSizeGb, storage: targetPool.storageId }, () =>
          client.addDisk(vps.proxmoxNode!.nodeName, vps.vmid, key, targetPool.storageId, targetSizeGb),
          async () => (await verifyVm(client, vps.proxmoxNode!.nodeName, vps.vmid)).exists,
        )
        await prisma.vpsDisk.create({ data: { vpsId: vps.id, proxmoxDiskKey: key, displayName, sizeGb: targetSizeGb, storagePoolId: targetPool.id, isPrimary: false, status: "ACTIVE", metadata: { orderId: order.id } } })
      }

      const monthlyIncrease = Number(diskUpgradeMeta.monthlyIncrease || 0)
      const currentRenewal = Number(vps.renewalAmount || vps.product?.price1m || vps.order.unitPrice || 0)
      const primaryDisk = operation === "add" ? disks.find((disk) => disk.isPrimary) : selectedDisk
      const updatePrimary = primaryDisk?.isPrimary && operation !== "add"
      await prisma.vpsInstance.update({
        where: { id: vps.id },
        data: {
          ...(updatePrimary ? { diskGb: targetSizeGb, storagePoolId: targetPool.id, storagePoolSnapshot: diskUpgradeMeta.storagePoolSnapshot || undefined } : {}),
          status: "ACTIVE",
          upgradeAmount: { increment: monthlyIncrease },
          renewalAmount: Number((currentRenewal + monthlyIncrease).toFixed(2)),
        },
      })
      await prisma.vpsUpgradeRequest.update({ where: { id: request.id }, data: { status: "completed", completedAt: new Date(), error: null } })
      await prisma.order.update({ where: { id: order.id }, data: { status: "active", provisioningStatus: "ACTIVE", provisioningError: null } })
      await upsertStep(job.id, "UPGRADE_COMPLETE", { status: "completed", startedAt: new Date(), completedAt: new Date() })
      await finalizeJob(job.id, "completed", "UPGRADE_COMPLETE", null, vps.id)
      await createPanelLog({
        category: "Provisioning",
        message: "disk_operation_completed",
        customerId: vps.customerId,
        orderId: order.id,
        vpsInstanceId: vps.id,
        vmid: vps.vmid,
        metadata: { orderType, operation, targetSizeGb, targetPoolId },
      })
      if (diskCustomer?.email || diskCustomer?.phone) {
        await sendServiceStatusNotification({
          templateKey: WHATSAPP_TEMPLATE_KEYS.VPS_DEPLOYED,
          customer: diskCustomer,
          variables: { userName: diskCustomer.name || "there", email: diskCustomer.email, serviceName: vps.name, ipAddress: vps.ipAddress || "" } as any,
          orderId: order.id,
          vpsInstanceId: vps.id,
          metadata: { source: "disk_upgrade_completed", jobId: job.id, operation },
        }).catch(() => null)
      }
      return { upgraded: true, diskOperation: operation, requestId: request.id }
    } catch (error) {
      const reason = sanitizeProvisioningError(error)
      await createPanelLog({
        category: "Provisioning",
        level: "error",
        message: "disk_operation_failed",
        customerId: vps.customerId,
        orderId: order.id,
        vpsInstanceId: vps.id,
        vmid: vps.vmid,
        metadata: { orderType, operation, reason },
      })
      if (diskCustomer?.email || diskCustomer?.phone) {
        await sendServiceStatusNotification({
          templateKey: WHATSAPP_TEMPLATE_KEYS.SERVICE_OPERATION_FAILED,
          customer: diskCustomer,
          variables: { userName: diskCustomer.name || "there", email: diskCustomer.email, serviceName: vps.name, operation: `Disk ${operation}`, reason } as any,
          orderId: order.id,
          vpsInstanceId: vps.id,
          metadata: { source: "disk_upgrade_failed", jobId: job.id, operation, cycleKey: job.id },
        }).catch(() => null)
      }
      await prisma.vpsInstance.update({ where: { id: vps.id }, data: { status: "UPGRADE_FAILED" } })
      await prisma.vpsUpgradeRequest.update({ where: { id: request.id }, data: { status: "failed", error: reason } })
      await prisma.order.update({ where: { id: order.id }, data: { provisioningStatus: "UPGRADE_FAILED", provisioningError: reason } })
      await upsertStep(job.id, "UPGRADE_FAILED", { status: "failed", startedAt: new Date(), completedAt: new Date(), error: reason })
      await finalizeJob(job.id, "failed", "UPGRADE_FAILED", reason, vps.id)
      throw new Error(reason)
    }
  }

  const fromCpu = Number(vps.cpuCores || vps.product?.cpuCores || 0)
  const fromRam = Number(vps.ramGb || vps.product?.ramGb || 0)
  const fromDisk = Number(vps.diskGb || vps.product?.storageGb || 0)
  const toCpu = Number(upgradeMeta?.upgrade?.toCpuCores || fromCpu)
  const toRam = Number(upgradeMeta?.upgrade?.toRamGb || fromRam)
  const toDisk = Number(upgradeMeta?.upgrade?.toDiskGb || fromDisk)
  if (toCpu < fromCpu) throw new Error("CPU reduction is not supported")
  if (toRam < fromRam) throw new Error("RAM reduction is not supported")
  if (toDisk < fromDisk) throw new Error("Disk shrink is not supported")

  const existingRequest = await prisma.vpsUpgradeRequest.findFirst({
    where: {
      vpsInstanceId: vps.id,
      metadata: { path: ["upgradeOrderId"], equals: order.id },
    },
    orderBy: { createdAt: "desc" },
  }).catch(() => null)
  if (String(existingRequest?.status || "").toLowerCase() === "completed") {
    await finalizeJob(job.id, "completed", "UPGRADE_COMPLETE", null, vps.id)
    return { upgraded: false, skipped: true, reason: "upgrade_already_completed", requestId: existingRequest!.id }
  }

  const request = existingRequest && String(existingRequest.status || "").toLowerCase() === "running"
    ? existingRequest
    : await prisma.vpsUpgradeRequest.create({
        data: {
          vpsInstanceId: vps.id,
          customerId: vps.customerId,
          status: "running",
          fromCpuCores: fromCpu || null,
          toCpuCores: toCpu || null,
          fromRamGb: fromRam || null,
          toRamGb: toRam || null,
          fromDiskGb: fromDisk || null,
          toDiskGb: toDisk || null,
          metadata: { keepsIpAddress: vps.ipAddress, upgradeOrderId: order.id },
        },
      })

  const client = getClientForNode(vps.proxmoxNode)
  try {
    await setJobDisplay(job.id, "UPGRADE_QUEUED")
    await upsertStep(job.id, "UPGRADE_QUEUED", { status: "completed", startedAt: new Date(), completedAt: new Date() })
    await prisma.vpsInstance.update({ where: { id: vps.id }, data: { status: "UPGRADE_QUEUED" } })
    await createPanelLog({
      category: "Provisioning",
      message: "vps_upgrade_started",
      customerId: vps.customerId,
      orderId: order.id,
      vpsInstanceId: vps.id,
      vmid: vps.vmid,
      metadata: { fromCpu, toCpu, fromRam, toRam, fromDisk, toDisk },
    })

    const beforeUpgrade = await verifyVm(client, vps.proxmoxNode.nodeName, vps.vmid)
    const wasRunning = String(beforeUpgrade.status?.status || "").toLowerCase() === "running"
    if (wasRunning) {
      await prisma.vpsInstance.update({ where: { id: vps.id }, data: { status: "UPDATING_CONFIG" } })
      await logJob(job.id, { step: "STOPPED", event: "upgrade:force_stop", message: "Force stopping VM before applying upgrade" })
      await runTaskOperation(job.id, client, vps.proxmoxNode.nodeName, "STOPPED", "stop", { vmid: vps.vmid, skiplock: true }, () =>
        client.stopVM(vps.proxmoxNode!.nodeName, vps.vmid, { skiplock: true }),
        async () => {
          const stopped = await client.getVMStatus(vps.proxmoxNode!.nodeName, vps.vmid).catch(() => null)
          return String(stopped?.status || "").toLowerCase() !== "running"
        },
      )
    }

    const topology = savedOrResolvedTopology({
      vcpu: toCpu,
      vps: null,
      order: null,
      product: vps.product,
      node: vps.proxmoxNode,
    })
    const memoryMb = toRam * 1024
    const config: Record<string, any> = {}
    if (toCpu && toCpu !== fromCpu) {
      config.sockets = topology.sockets
      config.cores = topology.coresPerSocket
    }
    if (toRam && toRam !== fromRam) config.memory = memoryMb
    if (Object.keys(config).length) {
      await prisma.vpsInstance.update({ where: { id: vps.id }, data: { status: "UPDATING_CONFIG" } })
      await logJob(job.id, { step: "UPDATING_CONFIG", event: "upgrade:config", message: "Updating VPS CPU and RAM" })
      await runTaskOperation(job.id, client, vps.proxmoxNode.nodeName, "UPDATING_CONFIG", "config", { vmid: vps.vmid, totalVcpu: toCpu, sockets: topology.sockets, coresPerSocket: topology.coresPerSocket, memoryMb }, () =>
        client.updateVMConfig(vps.proxmoxNode!.nodeName, vps.vmid, config),
        async () => {
          const vm = await verifyVm(client, vps.proxmoxNode!.nodeName, vps.vmid)
          return vm.exists
        },
      )
    }
    if (toDisk > fromDisk) {
      await prisma.vpsInstance.update({ where: { id: vps.id }, data: { status: "RESIZING_DISK" } })
      await logJob(job.id, { step: "RESIZING_DISK", event: "upgrade:resize", message: `Resizing disk to ${toDisk}GB` })
      await createPanelLog({
        category: "Provisioning",
        message: "disk_resize_started",
        customerId: vps.customerId,
        orderId: order.id,
        vpsInstanceId: vps.id,
        vmid: vps.vmid,
        metadata: { fromDiskGb: fromDisk, toDiskGb: toDisk },
      })
      const vmConfig = await client.getVMConfig(vps.proxmoxNode.nodeName, vps.vmid)
      await runTaskOperation(job.id, client, vps.proxmoxNode.nodeName, "RESIZING_DISK", "resize", { vmid: vps.vmid, size: toDisk }, () =>
        client.resizeDisk(vps.proxmoxNode!.nodeName, vps.vmid, diskKeyFromConfig(vmConfig), `+${toDisk - fromDisk}G`),
        async () => {
          const vm = await verifyVm(client, vps.proxmoxNode!.nodeName, vps.vmid)
          return vm.exists
        },
      )
      const guestResize = await expandGuestPrimaryDisk({
        client,
        nodeName: vps.proxmoxNode.nodeName,
        vmid: vps.vmid,
        os: resolveVmGuestOs({
          osType: vps.operatingSystem?.osType,
          osFamily: vps.operatingSystem?.osFamily,
          category: vps.operatingSystem?.category,
          osName: vps.operatingSystem?.name,
          vmOsFamily: vps.vmOsFamily,
          orderOsName: vps.order?.osName,
        }),
        previousTotalBytes: vps.diskTotalGb ? Number(vps.diskTotalGb) * 1_000_000_000 : null,
      }).catch((error) => ({ ok: false, error: error?.message || String(error) }))
      await logJob(job.id, { step: "RESIZING_DISK", event: "upgrade:guest_expand", message: "Expanded guest filesystem", response: guestResize })
      if (!guestResize.ok) throw new Error(`guest_disk_expand_failed: ${(guestResize as any).error || "verification_failed"}`)
      await createPanelLog({
        category: "Provisioning",
        message: "disk_resize_completed",
        customerId: vps.customerId,
        orderId: order.id,
        vpsInstanceId: vps.id,
        vmid: vps.vmid,
        metadata: { fromDiskGb: fromDisk, toDiskGb: toDisk },
      })
    }

    if (wasRunning) {
      await prisma.vpsInstance.update({ where: { id: vps.id }, data: { status: "STARTING_VM" } })
      await logJob(job.id, { step: "STARTING_VM", event: "upgrade:start", message: "Starting server services" })
      await ensureGuestBeforeStartAction({
        vps,
        ctx: guestContextFor({ vpsInstanceId: vps.id, vmid: vps.vmid, node: vps.proxmoxNode }),
        actor: "system:upgrade",
      })
      await startVmAndVerify(job.id, client, vps.proxmoxNode.nodeName, vps.vmid)
    }

    await setJobDisplay(job.id, "VERIFYING_VM")
    await upsertStep(job.id, "VERIFYING_VM", { status: "running", startedAt: new Date(), error: null })
    const vm = await verifyVm(client, vps.proxmoxNode.nodeName, vps.vmid)
    if (!vm.exists) throw new Error("Upgraded VM no longer exists")
    if (wasRunning && String(vm.status?.status || "").toLowerCase() !== "running") throw new Error("Upgraded VM is not running")

    const currentRenewal = Number(vps.renewalAmount || vps.product?.price1m || vps.order.unitPrice || 0)
    const upgradeAmount = Math.max(0, Number(upgradeMeta?.upgrade?.monthlyDelta || order.totalAmount || order.payableAmount || 0))
    const nextRenewalAmount = Number((currentRenewal + upgradeAmount).toFixed(2))
    await prisma.vpsInstance.update({
      where: { id: vps.id },
      data: {
        cpuCores: toCpu || null,
        cpuSockets: topology.sockets,
        coresPerSocket: topology.coresPerSocket,
        ramGb: toRam || null,
        diskGb: toDisk || null,
        storagePoolId: upgradeMeta?.upgrade?.storagePoolId || vps.storagePoolId || null,
        storagePoolSnapshot: upgradeMeta?.upgrade?.storagePricingSnapshot || vps.storagePoolSnapshot || undefined,
        status: "ACTIVE",
        upgradeAmount,
        renewalAmount: nextRenewalAmount,
      },
    })
    const currentRenewalInvoice = await prisma.invoice.findFirst({
      where: {
        customerId: vps.customerId,
        status: { in: ["draft", "sent", "pending", "overdue"] },
        metadata: { path: ["vpsInstanceId"], equals: vps.id },
      },
      orderBy: { createdAt: "desc" },
    }).catch(() => null)
    if (currentRenewalInvoice) {
      const metadata = (currentRenewalInvoice.metadata || {}) as any
      const baseCost = Number(metadata.baseCost || currentRenewal)
      const existingUpgradeCost = Number(metadata.upgradeCost || 0)
      const totalUpgradeCost = Number((existingUpgradeCost + upgradeAmount).toFixed(2))
      const totalRenewalAmount = Number((baseCost + totalUpgradeCost).toFixed(2))
      const renewalTotals = calculateInvoiceTotals({ subtotal: totalRenewalAmount, gstPercent: Number((currentRenewalInvoice as any).gstPercent ?? currentRenewalInvoice.taxRate ?? 18) })
      await prisma.invoice.update({
        where: { id: currentRenewalInvoice.id },
        data: {
          subtotal: renewalTotals.subtotal,
          ...invoiceTaxWriteFields({ taxRate: renewalTotals.gstPercent, taxAmount: renewalTotals.gstAmount }),
          totalAmount: renewalTotals.totalAmount,
          lineItems: [{
            description: `VPS renewal - ${vps.name}`,
            quantity: 1,
            unitPrice: renewalTotals.subtotal,
            total: renewalTotals.subtotal,
            vmid: vps.vmid,
            hostname: vps.name,
            plan: vps.product?.name || "VPS",
            baseAmount: baseCost,
            upgradeAmount: totalUpgradeCost,
          }],
          metadata: {
            ...metadata,
            baseCost,
            upgradeCost: totalUpgradeCost,
              totalRenewalAmount: renewalTotals.totalAmount,
            latestUpgradeOrderId: order.id,
          },
        },
      })
    }
    await prisma.vpsUpgradeRequest.update({ where: { id: request.id }, data: { status: "completed", completedAt: new Date(), error: null } })
    await prisma.order.update({ where: { id: order.id }, data: { status: "active", provisioningStatus: "ACTIVE", provisioningError: null } })
    await upsertStep(job.id, "VERIFYING_VM", { status: "completed", completedAt: new Date() })
    await upsertStep(job.id, "UPGRADE_COMPLETE", { status: "completed", startedAt: new Date(), completedAt: new Date() })
    await finalizeJob(job.id, "completed", "UPGRADE_COMPLETE", null, vps.id)
    await createPanelLog({
      category: "Provisioning",
      message: "vps_upgraded_successfully",
      customerId: vps.customerId,
      orderId: order.id,
      vpsInstanceId: vps.id,
      vmid: vps.vmid,
      metadata: { cpuCores: toCpu, ramGb: toRam, diskGb: toDisk, sockets: topology.sockets, coresPerSocket: topology.coresPerSocket },
    })
    return { upgraded: true, requestId: request.id }
  } catch (error) {
    const reason = sanitizeProvisioningError(error)
    await createPanelLog({
      category: "Provisioning",
      level: "error",
      message: "vps_upgrade_failed",
      customerId: vps.customerId,
      orderId: order.id,
      vpsInstanceId: vps.id,
      vmid: vps.vmid,
      metadata: { fromCpu, toCpu, fromRam, toRam, fromDisk, toDisk, reason, userMessage: "Upgrade failed. Contact support." },
    })
    await prisma.vpsInstance.update({ where: { id: vps.id }, data: { status: "UPGRADE_FAILED" } })
    await prisma.vpsUpgradeRequest.update({ where: { id: request.id }, data: { status: "failed", error: reason } })
    await prisma.order.update({ where: { id: order.id }, data: { provisioningStatus: "UPGRADE_FAILED", provisioningError: reason } })
    await upsertStep(job.id, "UPGRADE_FAILED", { status: "failed", startedAt: new Date(), completedAt: new Date(), error: reason })
    await finalizeJob(job.id, "failed", "UPGRADE_FAILED", reason, vps.id)
    throw new Error(reason)
  }
}

export async function retryStartVps(vpsId: string, actor = "system") {
  const vps = await prisma.vpsInstance.findUnique({
    where: { id: vpsId },
    include: {
      customer: true,
      order: true,
      product: true,
      operatingSystem: true,
      proxmoxNode: true,
      provisioningJobs: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  })
  if (!vps) throw new Error("VPS not found")
  if (!vps.proxmoxNode) throw new Error("VPS node config is missing")

  const client = getClientForNode(vps.proxmoxNode)
  const nodeName = vps.proxmoxNode.nodeName
  const existingJob = vps.provisioningJobs[0] || null
  const job = existingJob || await prisma.provisioningJob.create({
    data: {
      orderId: vps.orderId,
      vpsInstanceId: vps.id,
      customerId: vps.customerId,
      type: "start_retry",
      status: "running",
      currentStep: "STARTING_VM",
      displayStatus: STEP_LABELS.STARTING_VM,
      proxmoxNodeId: vps.proxmoxNodeId,
      nodeName,
      vmid: vps.vmid,
      hostname: vps.name,
      metadata: { actor },
    },
  })

  await prisma.provisioningJob.update({
    where: { id: job.id },
    data: {
      status: "running",
      currentStep: "STARTING_VM",
      displayStatus: STEP_LABELS.STARTING_VM,
      error: null,
      completedAt: null,
      dedupeKey: null,
    },
  })
  await prisma.order.update({ where: { id: vps.orderId }, data: { provisioningStatus: "STARTING_VM", provisioningError: null } })
  await prisma.vpsInstance.update({ where: { id: vps.id }, data: { status: "STARTING_VM" } })
  await logJob(job.id, { step: "STARTING_VM", event: "start_retry:start", message: "Starting server services" })

  try {
    await ensureGuestBeforeStartAction({
      vps,
      ctx: guestContextFor({ vpsInstanceId: vps.id, vmid: vps.vmid, node: vps.proxmoxNode }),
      actor,
    })
    await startVmAndVerify(job.id, client, nodeName, vps.vmid)
    await setJobDisplay(job.id, "VERIFYING_VM")
    await upsertStep(job.id, "VERIFYING_VM", { status: "running", startedAt: new Date(), error: null })
    await logJob(job.id, { step: "VERIFYING_VM", event: "verify:start", message: "Final server optimization" })
    const vm = await verifyVm(client, nodeName, vps.vmid)
    if (!vm.exists) throw new Error("VM does not exist")
    const runtimeStatus = String(vm.status?.status || "").toLowerCase()
    if (runtimeStatus !== "running") throw new Error(`VM is ${runtimeStatus || "not running"}`)
    const canonical = await canonicalNetworkForVps(vps)
    const hardGate = await verifyProvisioningHardGateWithConvergence({
      jobId: job.id,
      client,
      nodeName,
      vmid: vps.vmid,
      vpsInstanceId: vps.id,
      customerId: vps.customerId,
      orderId: vps.orderId,
      expectedIp: canonical.ip,
      expectedCidr: canonical.cidr,
      expectedGateway: canonical.gateway,
      expectedDns: canonical.dns,
      expectedBridge: canonical.bridge,
      expectedMac: null,
      templateMac: null,
      sshKeyRequired: Boolean(vps.sshKeyId),
      isWindows: isWindowsOsTemplate(vps.operatingSystem),
      guestAutomationEvidence: { source: "retry_start" },
      attempts: isWindowsOsTemplate(vps.operatingSystem) ? 8 : 4,
      settleMs: isWindowsOsTemplate(vps.operatingSystem) ? 60000 : 20000,
    })

    const primaryInterface = hardGate.macAddress ? null : await prisma.vmNetworkInterface.findFirst({
      where: { vpsInstanceId: vps.id },
      orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
      select: { macAddress: true },
    }).catch(() => null)
    await prisma.vpsInstance.update({
      where: { id: vps.id },
      data: { status: "ACTIVE", vmMacAddress: hardGate.macAddress || primaryInterface?.macAddress || undefined },
    })
    await prisma.order.update({
      where: { id: vps.orderId },
      data: { status: "active", provisioningStatus: "ACTIVE", provisioningError: null, provisionedAt: vps.order.provisionedAt || new Date(), serviceId: vps.id },
    })
    await upsertStep(job.id, "VERIFYING_VM", { status: "completed", completedAt: new Date() })
    await finalizeJob(job.id, "completed", "ACTIVE", null, vps.id)
    await logJob(job.id, { step: "ACTIVE", event: "start_retry:completed", message: "Your cloud server is ready" })
    return { status: "ACTIVE", jobId: job.id, vmid: vps.vmid, message: "VM started successfully" }
  } catch (error) {
    const reason = sanitizeProvisioningError(error)
    const vm = await verifyVm(client, nodeName, vps.vmid).catch(() => ({ exists: false, status: null, config: null }))
    const hardFailed = !vm.exists || reason.toLowerCase().includes("proxmox task failed")
    const failedStep: ProvisioningStep = hardFailed ? "FAILED" : "START_FAILED"
    await prisma.vpsInstance.update({ where: { id: vps.id }, data: { status: hardFailed ? "FAILED" : "START_FAILED" } })
    await prisma.order.update({ where: { id: vps.orderId }, data: { provisioningStatus: failedStep, provisioningError: reason } })
    await prisma.provisioningJob.update({
      where: { id: job.id },
      data: {
        status: hardFailed ? "failed" : "completed",
        currentStep: failedStep,
        displayStatus: STEP_LABELS[failedStep],
        error: reason,
        vpsInstanceId: vps.id,
        dedupeKey: null,
        completedAt: new Date(),
      },
    })
    await upsertStep(job.id, failedStep, { status: "failed", startedAt: new Date(), completedAt: new Date(), error: reason })
    await logJob(job.id, { level: hardFailed ? "error" : "warn", step: failedStep, event: "start_retry:failed", message: reason, response: { vmExists: vm.exists } })
    return { status: failedStep, jobId: job.id, vmid: vps.vmid, error: reason }
  }
}

async function acquireReinstallLock(vpsId: string) {
  const updated = await prisma.vpsInstance.updateMany({
    where: { id: vpsId, reinstallLock: false },
    data: { reinstallLock: true, reinstallLockedAt: new Date() },
  })
  if (updated.count === 0) throw new Error("reinstall_already_locked: Another reinstall is already in progress for this server")
}

async function releaseReinstallLock(vpsId: string) {
  await prisma.vpsInstance.update({
    where: { id: vpsId },
    data: { reinstallLock: false, reinstallLockedAt: null },
  }).catch(() => null)
}

export async function processProvisioningJob(jobId: string) {
  const job = await prisma.provisioningJob.findUnique({ where: { id: jobId }, select: { id: true, type: true, orderId: true, vpsInstanceId: true } })
  if (!job) throw new Error("Provisioning job not found")
  if (job.type === "upgrade") return processUpgradeJob(job.id)
  if (job.type === "reinstall") {
    const running = await prisma.provisioningJob.update({
      where: { id: job.id },
      data: { status: "running", startedAt: new Date(), claimedAt: new Date(), attempts: { increment: 1 }, error: null },
      include: { vpsInstance: { include: { proxmoxNode: true, product: true, order: true } }, order: true },
    })
    const vps = running.vpsInstance
    if (!vps || !vps.proxmoxNode) throw new Error("Reinstall VPS target unavailable")

    // Acquire reinstall lock — prevents concurrent reinstalls on the same VPS
    try {
      await acquireReinstallLock(vps.id)
    } catch (lockError) {
      const reason = sanitizeProvisioningError(lockError)
      await prisma.provisioningJob.update({
        where: { id: running.id },
        data: { status: "failed", error: reason, errorCode: "REINSTALL_LOCKED", completedAt: new Date(), dedupeKey: null, displayStatus: "Reinstall locked — another reinstall in progress" },
      })
      await logJob(running.id, { level: "error", step: "QUEUED", event: "reinstall:lock_failed", message: reason })
      return
    }

    // Cancel any other pending/retrying jobs for this VPS (they are superseded by this reinstall)
    await prisma.provisioningJob.updateMany({
      where: { vpsInstanceId: vps.id, id: { not: running.id }, status: { in: ["queued", "retrying"] } },
      data: { status: "cancelled", completedAt: new Date(), dedupeKey: null, displayStatus: "Cancelled — superseded by new reinstall" },
    }).catch(() => null)

    const meta: any = running.metadata || {}
    const reinstall = meta.reinstall || {}
    const sourceNode = vps.proxmoxNode
    const sourceClient = getClientForNode(sourceNode)
    const sourceNodeName = sourceNode.nodeName
    const sourceVmid = vps.vmid
    let vmid = sourceVmid
    const reinstallCustomer = await prisma.customer.findUnique({ where: { id: vps.customerId } }).catch(() => null)
    const template = await resolveAvailableOsTemplate({
      id: String(reinstall.osTemplateId || ""),
      purpose: "reinstall",
    })
    if (!template?.proxmoxVmid) throw new Error("Template VMID missing on Proxmox.")
    const isWindowsReinstall = isWindowsOsTemplate(template)
    const placementPreflight = await validateProvisioningPreflight({
      // Reinstall is ALWAYS in-place: pin to the current node so placement can never fail over to a
      // different node (which previously allocated a new VMID + new IP and orphaned the old VM).
      nodeId: sourceNode.id,
      vcpu: Number(vps.cpuCores || vps.product?.cpuCores || 1),
      ramGb: Number(vps.ramGb || vps.product?.ramGb || 1),
      storageGb: Number(vps.diskGb || vps.product?.storageGb || 20),
      productId: vps.productId,
      bandwidthTb: Number((vps.product as any)?.bandwidthTb || 0),
      osFamily: template.osFamily || template.category || template.name,
      osVersion: template.osVersion || template.name,
      osTemplateId: template.id,
      nodeClassId: vps.nodeClassId,
      storagePoolId: vps.storagePoolId || null,
      allowStorageFallback: true,
      // Don't force a healthy node for reinstall — we must stay on the VM's current node regardless.
      requireHealthyOrWarning: false,
    })
    if (!placementPreflight.ok || !placementPreflight.placement.ok) {
      throw new Error(placementPreflight.reason || "No compatible node available for reinstall")
    }
    const targetNode = placementPreflight.placement.node
    const targetTemplate = placementPreflight.placement.template || template
    const client = getClientForNode(targetNode)
    const nodeName = targetNode.nodeName
    const nodeChanged = targetNode.id !== sourceNode.id
    if (nodeChanged) {
      // Reinstall MUST reuse the same node + same VMID + same IP — never migrate or allocate a new VM
      // (that was creating duplicate VMs like old 185 + new 188). Fail cleanly instead of migrating;
      // vmid stays = sourceVmid.
      throw new Error(`Reinstall must stay on the current node (${sourceNodeName}). Node ${nodeName} is not eligible for in-place reinstall — repair the node or perform an explicit migration, then retry.`)
    }

    const professionalStep = async (step: ProvisioningStep, displayStatus: string, status: "running" | "completed" = "running") => {
      await prisma.provisioningJob.update({ where: { id: running.id }, data: { currentStep: step, displayStatus } })
      await upsertStep(running.id, step, { status, startedAt: new Date(), ...(status === "completed" ? { completedAt: new Date() } : {}) })
    }
    const failReinstall = async (code: string, step: ProvisioningStep, error: any) => {
      await releaseReinstallLock(vps.id)
      const reason = sanitizeProvisioningError(error)
      const guestAutomationManualReview = isGuestAutomationManualReviewError(error, targetTemplate)
      const nextMetadata = { ...(meta || {}), reinstall: { ...(reinstall || {}), failureStep: code } }
      await prisma.provisioningJob.update({
        where: { id: running.id },
        data: {
          status: guestAutomationManualReview ? "waiting_for_admin" : "failed",
          currentStep: step,
          displayStatus: guestAutomationManualReview ? "Waiting for manual review" : "Reinstall failed",
          errorCode: guestAutomationManualReview ? "GUEST_AUTOMATION_MANUAL_REVIEW" : null,
          error: `${code}: ${reason}`,
          completedAt: new Date(),
          dedupeKey: guestAutomationManualReview ? running.dedupeKey : null,
          metadata: nextMetadata,
        },
      })
      await upsertStep(running.id, step, { status: "failed", completedAt: new Date(), error: `${code}: ${reason}` })
      await prisma.order.update({ where: { id: vps.orderId }, data: { provisioningStatus: guestAutomationManualReview ? "WAITING_FOR_ADMIN" : "FAILED", provisioningError: `${code}: ${reason}` } })
      await prisma.vpsInstance.update({ where: { id: vps.id }, data: { status: "REPAIR_NEEDED" } })
      await logJob(running.id, { level: "error", step, event: `reinstall:${code}`, message: `${code}: ${reason}` })
      await createPanelLog({
        category: "Provisioning",
        level: "error",
        message: guestAutomationManualReview ? "linux_reinstall_cloud_init_manual_review" : "reinstall_failed",
        customerId: vps.customerId,
        orderId: vps.orderId,
        vpsInstanceId: vps.id,
        vmid,
        metadata: { code, reason, errorCode: guestAutomationManualReview ? "GUEST_AUTOMATION_MANUAL_REVIEW" : null },
      }).catch(() => null)
      if (reinstallCustomer?.email || reinstallCustomer?.phone) {
        await sendServiceStatusNotification({
          templateKey: WHATSAPP_TEMPLATE_KEYS.SERVICE_OPERATION_FAILED,
          customer: reinstallCustomer,
          variables: { userName: reinstallCustomer.name || "there", email: reinstallCustomer.email, serviceName: vps.name, operation: "Reinstall", reason } as any,
          orderId: vps.orderId,
          vpsInstanceId: vps.id,
          metadata: { source: "reinstall_failed", jobId: running.id, code, cycleKey: running.id },
        }).catch(() => null)
      }
      throw Object.assign(new Error(`${code}: ${reason}`), { step: code })
    }
    const runReinstallOperation = async <T,>(code: string, step: ProvisioningStep, action: () => Promise<T>): Promise<T> => {
      try {
        return await action()
      } catch (error) {
        return failReinstall(code, step, error) as Promise<T>
      }
    }

    const reinstallMilestone = async (step: string, label: string, status: "running" | "completed" | "failed" = "running", error?: string | null) => {
      const now = new Date()
      await prisma.provisioningTaskStep.upsert({
        where: { jobId_step: { jobId: running.id, step } },
        create: { jobId: running.id, step, label, status, startedAt: now, ...(status !== "running" ? { completedAt: now } : {}), error: error || null },
        update: { label, status, startedAt: now, ...(status !== "running" ? { completedAt: now } : {}), error: error || null },
      })
    }

    await reinstallMilestone("REINSTALL_PREPARING", "Preparing reinstall")
    await professionalStep("QUEUED", "Preparing reinstall", "completed")
    await reinstallMilestone("REINSTALL_PREPARING", "Preparing reinstall", "completed")
    await logJob(running.id, { event: "reinstall:prepare", message: "Preparing reinstall" })
    await createPanelLog({
      category: "Provisioning",
      message: "reinstall_started",
      customerId: vps.customerId,
      orderId: vps.orderId,
      vpsInstanceId: vps.id,
      vmid,
      metadata: { templateId: targetTemplate.id, sourceNodeId: sourceNode.id, targetNodeId: targetNode.id, hostname: reinstall.requestedHostname || vps.name },
    }).catch(() => null)
    if (reinstallCustomer?.email || reinstallCustomer?.phone) {
      await sendServiceStatusNotification({
        templateKey: WHATSAPP_TEMPLATE_KEYS.VPS_REINSTALL_STARTED,
        customer: reinstallCustomer,
        variables: await deploymentMessageVariables({
          orderId: vps.orderId,
          customerName: reinstallCustomer.name,
          hostname: String(reinstall.requestedHostname || vps.name || ""),
          plan: vps.product?.name || "VPS",
          vpsInstanceId: vps.id,
          billingCycle: vps.billingCycle || "Monthly",
        }),
        orderId: vps.orderId,
        vpsInstanceId: vps.id,
        metadata: { source: "reinstall_started", jobId: running.id, cycleKey: running.id },
      }).catch(() => null)
    }

    const [current, currentConfigBeforeReinstall] = await Promise.all([
      sourceClient.getVMStatus(sourceNodeName, sourceVmid).catch(() => null),
      sourceClient.getVMConfig(sourceNodeName, sourceVmid).catch(() => null),
    ])
    await reinstallMilestone("REINSTALL_VALIDATING", "Validating VM", "completed")
    const preservedMac = normalizeMac(vps.vmMacAddress) || macFromNet0((currentConfigBeforeReinstall as any)?.net0)
    if (!nodeChanged && String(current?.status || "").toLowerCase() === "running") {
      await reinstallMilestone("REINSTALL_STOPPING", "Stopping VM")
      await professionalStep("STOPPED", "Stopping server")
      await logJob(running.id, { step: "STOPPED", event: "reinstall:force_stop", message: "Force stopping server before reinstall" })

      await runReinstallOperation("stop_failed", "STOPPED", async () => {
        const stopResult = await robustlyStopVm({ client: sourceClient, node: sourceNodeName, vmid: sourceVmid, sshUsername: sourceNode.sshUsername })
        await logJob(running.id, {
          step: "STOPPED",
          event: "reinstall:force_stop_result",
          level: stopResult.stopped ? "info" : "error",
          message: `Force stop ${stopResult.stopped ? "succeeded" : "FAILED"} via ${stopResult.via}`,
          response: stopResult,
        })
        if (!stopResult.stopped) throw new Error(`force_stop_failed: VM ${sourceVmid} could not be stopped (last tier: ${stopResult.via})`)
      })
      await reinstallMilestone("REINSTALL_STOPPING", "Stopping VM", "completed")
    } else {
      await reinstallMilestone("REINSTALL_STOPPING", "Stopping VM", "completed")
    }

    await reinstallMilestone("REINSTALL_REMOVE_CLOUD_INIT", "Removing the old server")
    await professionalStep("CLONING_TEMPLATE", "Installing operating system")
    if (!nodeChanged) {
      await logJob(running.id, { step: "CLONING_TEMPLATE", event: "reinstall:destroy", message: "Installing operating system" })
      await runReinstallOperation("destroy_failed", "CLONING_TEMPLATE", () =>
        runTaskOperation(
          running.id,
          sourceClient,
          sourceNodeName,
          "CLONING_TEMPLATE",
          "delete",
          { vmid: sourceVmid, sourceNodeName, targetNodeName: nodeName },
          // Purge the VM AND its unreferenced/orphan disks so no leftover volumes accumulate.
          () => sourceClient.deleteVM(sourceNodeName, sourceVmid, { purge: true, destroyUnreferencedDisks: true }),
          async () => {
            const vm = await verifyVm(sourceClient, sourceNodeName, sourceVmid)
            return !vm.exists
          },
          "Installing operating system",
        ),
      )
      // Never clone into an occupied VMID: confirm the slot is free, force one more purge if not, else FAIL.
      await runReinstallOperation("destroy_failed", "CLONING_TEMPLATE", async () => {
        let deleted = await waitForVmDeleted(sourceClient, sourceNodeName, sourceVmid, { timeoutMs: 30_000 })
        if (!deleted) {
          await sourceClient.deleteVM(sourceNodeName, sourceVmid, { purge: true, destroyUnreferencedDisks: true }).catch(() => null)
          deleted = await waitForVmDeleted(sourceClient, sourceNodeName, sourceVmid, { timeoutMs: 30_000 })
        }
        if (!deleted) {
          throw new Error(`reinstall_destroy_incomplete: VM ${sourceVmid} still exists on ${sourceNodeName}; refusing to clone into an occupied VMID`)
        }
        await logJob(running.id, { step: "CLONING_TEMPLATE", event: "reinstall:destroy_verified", message: "VM deletion confirmed", level: "info" })
      })
      await reinstallMilestone("REINSTALL_REMOVE_CLOUD_INIT", "Removing the old server", "completed")
    }
    await reinstallMilestone("REINSTALL_APPLY_TEMPLATE", "Applying template")
    await logJob(running.id, { step: "CLONING_TEMPLATE", event: "reinstall:clone", message: "Installing operating system" })
    await runReinstallOperation("clone_failed", "CLONING_TEMPLATE", () =>
      runTaskOperation(
        running.id,
        client,
        nodeName,
        "CLONING_TEMPLATE",
        "clone",
        { vmid, templateVmid: targetTemplate.proxmoxVmid, nodeChanged },
        () => client.cloneVM(nodeName, targetTemplate.proxmoxVmid!, vmid, String(reinstall.requestedHostname || vps.name), { full: 1 }),
        async () => {
          const vm = await verifyVm(client, nodeName, vmid)
          return vm.exists
        },
        "Installing operating system",
      ),
    )
    await reinstallMilestone("REINSTALL_APPLY_TEMPLATE", "Applying template", "completed")

    await reinstallMilestone("REINSTALL_ASSIGN_IP", "Assigning IP")
    await professionalStep("ASSIGNING_IP", "Configuring network")
    await logJob(running.id, { step: "ASSIGNING_IP", event: "reinstall:network", message: "Configuring network" })
    let allocation = await prisma.ipAllocation.findFirst({
      where: { vpsInstanceId: vps.id, status: { in: ["USED", "used", "ASSIGNED", "assigned"] }, releasedAt: null },
      include: { pool: true },
      orderBy: { updatedAt: "desc" },
    })
    const previousAllocation = allocation
    if (nodeChanged) {
      allocation = await allocateIp({
        proxmoxNodeId: targetNode.id,
        productId: vps.productId,
        vpsInstanceId: vps.id,
        vmid,
        hostname: String(reinstall.requestedHostname || vps.name),
        assignedBy: "reinstall",
        allocationType: "default",
        purpose: "provisioning",
      }) as any
    }
    if (!allocation?.pool || !allocation.ipAddress) {
      await runReinstallOperation("config_failed", "ASSIGNING_IP", () => Promise.reject(new Error("No IP pool assigned to product/node.")))
    }
    await markIpUsed(allocation!.id, vps.id, vmid)
    const reinstallEffectiveHostname = hostnameFromIp(allocation!.ipAddress) || vps.hostname || vps.name
    await upsertStep(running.id, "ASSIGNING_IP", { status: "completed", startedAt: new Date(), completedAt: new Date() })
    await reinstallMilestone("REINSTALL_ASSIGN_IP", "Assigning IP", "completed")
    await reinstallMilestone("REINSTALL_CONFIGURE_DNS", "Configuring DNS", "completed")
    await logJob(running.id, {
      step: "ASSIGNING_IP",
      event: "reinstall:ip_preserved",
      message: "Preserved assigned public IP for reinstall",
      response: {
        osFamily: isWindowsReinstall ? "windows" : "linux",
        ipAddress: allocation!.ipAddress,
        cidr: allocation!.pool.cidr,
        gateway: allocation!.pool.gateway,
        dns: allocation!.pool.dns,
      },
    })

    await professionalStep("APPLYING_CLOUD_INIT", "Applying server settings")
    await logJob(running.id, { step: "APPLYING_CLOUD_INIT", event: "reinstall:access", message: "Applying server settings" })
    const reinstallTemplateConfig = await client.getVMConfig(nodeName, targetTemplate.proxmoxVmid).catch(() => null)
    const reinstallTemplateMac = macFromNet0((reinstallTemplateConfig as any)?.net0)
    const reinstallBridge = allocation!.pool.bridgeOverride || allocation!.pool.bridge || "vmbr0"

    // Phase 9: pre-flight network validation before MAC/host configuration is applied
    const networkPreflight = await validateReinstallNetwork({
      bridge: reinstallBridge,
      mac: reinstallTemplateMac,
      ipAddress: allocation!.ipAddress,
      poolId: allocation!.poolId,
      vpsInstanceId: vps.id,
    }).catch(() => null)
    if (networkPreflight && !networkPreflight.ok) {
      await logJob(running.id, { step: "APPLYING_CLOUD_INIT", event: "network_preflight_failed", message: `Network preflight failed: ${networkPreflight.issues.map((i) => i.message).join("; ")}` })
      throw new Error(`network_preflight_failed: ${networkPreflight.issues.map((i) => i.code).join(", ")}`)
    }

    const reinstallMac = await runReinstallOperation("mac_failed", "APPLYING_CLOUD_INIT", async () => {
      if (preservedMac) {
        await client.updateVMConfig(nodeName, vmid, { net0: net0Value(preservedMac, reinstallBridge) })
        await logJob(running.id, { step: "APPLYING_CLOUD_INIT", event: "mac:preserved", message: "Preserved VM MAC address during reinstall", response: { vmid, macAddress: preservedMac } })
        return preservedMac
      }
      return applyFreshMacBeforeFirstBoot({
        jobId: running.id,
        client,
        nodeName,
        vmid,
        bridge: reinstallBridge,
        templateMac: reinstallTemplateMac,
        skipRegenerate: false,
      })
    })
    const totalVcpu = Number(vps.cpuCores || vps.product?.cpuCores || 1)
    const topology = savedOrResolvedTopology({
      vcpu: totalVcpu,
      vps,
      order: vps.order,
      product: vps.product,
      node: targetNode,
    })
    const password = reinstall.passwordEncrypted
      ? decryptSecret(String(reinstall.passwordEncrypted))
      : vps.passwordEncrypted
        ? decryptSecret(String(vps.passwordEncrypted))
        : generateRandomPassword()
    await reinstallMilestone("REINSTALL_GENERATE_PASSWORD", "Generating password", "completed")
    const requestedUsername = isWindowsReinstall ? "Administrator" : "root"
    await reinstallMilestone("REINSTALL_SET_HOSTNAME", "Setting hostname")
    await runReinstallOperation("config_failed", "APPLYING_CLOUD_INIT", () =>
      runTaskOperation(
        running.id,
        client,
        nodeName,
        "APPLYING_CLOUD_INIT",
        "resources",
        { vmid, totalVcpu, sockets: topology.sockets, coresPerSocket: topology.coresPerSocket, memoryMb: Number(vps.ramGb || vps.product?.ramGb || 1) * 1024 },
        () => client.updateVMConfig(nodeName, vmid, {
          sockets: topology.sockets,
          cores: topology.coresPerSocket,
          memory: Number(vps.ramGb || vps.product?.ramGb || 1) * 1024,
        }),
        async () => {
          const vm = await verifyVm(client, nodeName, vmid)
          return vm.exists
        },
        "Applying server settings",
      ),
    )
    await runReinstallOperation("config_failed", "APPLYING_CLOUD_INIT", () =>
      applyPreBootVmConfig({
        jobId: running.id,
        client,
        nodeName,
        vmid,
        template: targetTemplate,
        netBridge: reinstallBridge,
        macAddress: reinstallMac,
        description: buildVmNotes({
          customerName: reinstallCustomer?.name || reinstallCustomer?.email || null,
          customerId: vps.customerId,
          orderId: vps.orderId,
          productId: vps.productId || null,
          productName: vps.product?.name || null,
          productTag: vps.product?.slug || null,
          service: vps.product?.slug || vps.product?.name || "zws",
          vmUuid: vps.id,
          provisionedAt: new Date(),
          creator: "panel",
          nodeId: targetNode.id,
          nodeName,
        }),
        displayStatus: "Applying server settings",
      }),
    )
    await reinstallMilestone("REINSTALL_SET_HOSTNAME", "Setting hostname", "completed")
    await reinstallMilestone("REINSTALL_CLOUD_INIT", "Server settings", "completed")

    await reinstallMilestone("REINSTALL_RESIZE_DISK", "Resizing disk")
    await professionalStep("RESIZING_DISK", "Applying access settings")
    const desiredDiskGb = Number(vps.diskGb || vps.product?.storageGb || 0)
    {
      // Proxmox is the source of truth — never trust the DB template.diskGb for the resize decision.
      // Read the freshly-cloned disk's actual size from Proxmox and grow from there. Using a stale DB
      // template size caused the resize to be skipped/mis-sized (disk_verify_failed: expected 100 found 20).
      const vmConfig = ((await client.getVMConfig(nodeName, vmid).catch(() => ({}))) || {}) as Record<string, any>
      const reinstallDiskKey = diskKeyFromConfig(vmConfig)
      const currentDiskGb = verifyDiskSizeFromConfig(vmConfig, 1).actualGb || 0
      if (desiredDiskGb > 0 && currentDiskGb > 0 && desiredDiskGb > currentDiskGb) {
        await runReinstallOperation("resize_failed", "RESIZING_DISK", () =>
          runTaskOperation(running.id, client, nodeName, "RESIZING_DISK", "resize", { vmid, disk: reinstallDiskKey, size: desiredDiskGb }, () =>
            client.resizeDisk(nodeName, vmid, reinstallDiskKey, `+${Math.ceil(desiredDiskGb - currentDiskGb)}G`),
            async () => {
              const refreshed = await client.getVMConfig(nodeName, vmid).catch(() => ({}))
              return verifyDiskSizeFromConfig(refreshed as Record<string, any>, desiredDiskGb).ok
            },
            "Applying access settings",
          ),
        )
      } else {
        await upsertStep(running.id, "RESIZING_DISK", { status: "completed", startedAt: new Date(), completedAt: new Date() })
      }
    }
    // Hard gate: block boot until Proxmox reports the requested size on the actual disk key.
    await runReinstallOperation("resize_verify_failed", "RESIZING_DISK", () => verifyProvisionedDiskSize(running.id, client, nodeName, vmid, desiredDiskGb))
    await reinstallMilestone("REINSTALL_RESIZE_DISK", "Resizing disk", "completed")

    // Pre-boot readiness: the guest agent channel is the only thing that must be
    // in place before start. Whether the image has the agent installed cannot be
    // known from the host, so it is asserted here and proven after boot by the
    // first-boot run — not assumed from a template flag.
    await runReinstallOperation("guest_agent_preflight_failed", "APPLYING_CLOUD_INIT", async () => {
      const vmConfigForPreflight = await client.getVMConfig(nodeName, vmid).catch(() => null)
      const agentChannel = vmConfigForPreflight
        ? guestAgentChannelOpen(vmConfigForPreflight)
        : false
      if (!agentChannel) {
        await logJob(running.id, {
          level: "warn",
          step: "APPLYING_CLOUD_INIT",
          event: "reinstall:guest_agent_channel_missing",
          message: "Guest agent channel is not enabled on this VM; first-boot configuration will need the agent to answer",
          response: { vmid },
        })
        await client.updateVMConfig(nodeName, vmid, { agent: "1" }).catch(() => null)
      }
      await logJob(running.id, {
        step: "APPLYING_CLOUD_INIT",
        event: "reinstall:guest_agent_preflight",
        message: agentChannel ? "Guest agent channel enabled" : "Guest agent channel enabled by this run",
        response: { vmid, agentChannelBefore: agentChannel, os: targetTemplate?.osType ?? null },
      })
    })

    await reinstallMilestone("REINSTALL_BOOT", "Booting VM")
    await professionalStep("STARTING_VM", "Starting server")
    await logJob(running.id, { step: "STARTING_VM", event: "reinstall:start", message: "Starting server" })
    await runReinstallOperation("start_failed", "STARTING_VM", async () => {
      await ensureGuestBeforeStartAction({
        vps: {
          ...vps,
          vmid,
          name: String(reinstallEffectiveHostname),
          passwordEncrypted: reinstall.passwordEncrypted || vps.passwordEncrypted || encryptSecret(password),
          username: requestedUsername,
          adminUsername: requestedUsername,
        },
        ctx: guestContextFor({ vpsInstanceId: vps.id, vmid, node: targetNode }),
        actor: "system:reinstall",
      })
      return startVmAndVerify(running.id, client, nodeName, vmid, "Starting server")
    })
    await reinstallMilestone("REINSTALL_BOOT", "Booting VM", "completed")

    // Wait for Guest Agent to come online before attempting verification
    await reinstallMilestone("REINSTALL_WAIT_AGENT", "Waiting for agent")
    await logJob(running.id, { step: "STARTING_VM", event: "reinstall:guest_agent_wait", message: "Waiting for guest agent to come online..." })
    const guestAgentWait = await waitForGuestAgentReady(client, nodeName, vmid, {
      timeoutMs: isWindowsReinstall ? 420_000 : 300_000,
      pollMs: 5_000,
    })
    await logJob(running.id, {
      step: "STARTING_VM",
      event: "reinstall:guest_agent_ready",
      level: guestAgentWait.ok ? "info" : "warn",
      message: guestAgentWait.ok ? "Guest agent online — proceeding to verification" : `Guest agent not ready after timeout: ${(guestAgentWait as any).error || "unknown"} — continuing anyway`,
      response: guestAgentWait,
    })
    await reinstallMilestone("REINSTALL_WAIT_AGENT", "Waiting for agent", "completed")

    if (!isWindowsReinstall && guestAgentWait.ok) {
      await ensureLinuxPasswordSshAccess({
        jobId: running.id,
        client,
        nodeName,
        vmid,
        username: requestedUsername,
        password,
        accessMethod: "PASSWORD",
      })
    }

    // Configure the guest through its own OS profile. This is the reinstall
    // equivalent of the first-boot run: the VM is up, the agent answered, so the
    // OS is known and the right template is applied.
    if (guestAgentWait.ok) {
      await reinstallMilestone("REINSTALL_GUEST_AUTOMATION", "Configuring server")
      await configureGuestAfterBoot({
        jobId: running.id,
        vpsInstanceId: vps.id,
        vmid,
        node: targetNode,
        metadata: guestOsMetadataFor(targetTemplate),
        desired: {
          ip: allocation!.ipAddress,
          prefix: Number(allocation!.pool.cidr || 24),
          gateway: allocation!.pool.gateway,
          dns: splitList(String(allocation!.pool.dns || "1.1.1.1")),
          searchDomain: allocation!.pool.searchDomain,
          hostname: String(reinstallEffectiveHostname),
          username: requestedUsername,
          password,
        },
        displayStatus: "Configuring server",
      })
      await reinstallMilestone("REINSTALL_GUEST_AUTOMATION", "Configuring server", "completed")
    }

    await reinstallMilestone("REINSTALL_HEALTH_CHECKS", "Health checks")
    await professionalStep("VERIFYING_VM", "Verifying server")
    await logJob(running.id, { step: "VERIFYING_VM", event: "reinstall:verify", message: "Verifying server" })
    await runReinstallOperation("verify_failed", "VERIFYING_VM", async () => {
      const verified = await verifyVm(client, nodeName, vmid)
      if (!verified.exists || String(verified.status?.status || "").toLowerCase() !== "running") throw new Error("Server verification failed after reinstall")
      await verifyProvisioningHardGateWithConvergence({
        jobId: running.id,
        client,
        nodeName,
        vmid,
        vpsInstanceId: vps.id,
        customerId: vps.customerId,
        orderId: vps.orderId,
        expectedIp: allocation!.ipAddress,
        expectedCidr: Number(allocation!.pool.cidr || 24),
        expectedGateway: allocation!.pool.gateway,
        expectedDns: allocation!.pool.dns,
        expectedSearchDomain: allocation!.pool.searchDomain,
        expectedBridge: reinstallBridge,
        expectedMac: reinstallMac,
        templateMac: reinstallTemplateMac,
        sshKeyRequired: Boolean(vps.sshKeyId),
        expectedHostname: String(reinstallEffectiveHostname),
        isWindows: isWindowsReinstall,
        guestAutomationEvidence: { source: "reinstall" },
        attempts: isWindowsReinstall ? 8 : 4,
        settleMs: isWindowsReinstall ? 60000 : 20000,
      })
      return verified
    })
    await reinstallMilestone("REINSTALL_HEALTH_CHECKS", "Health checks", "completed")
    await reinstallMilestone("REINSTALL_TEST_ACCESS", isWindowsReinstall ? "Testing RDP" : "Testing SSH", "completed")
    // Expand guest filesystem after reinstall if disk was resized (non-Windows only)
    if (!isWindowsReinstall && desiredDiskGb > 0) {
      await expandGuestPrimaryDisk({
        client,
        nodeName,
        vmid,
        os: resolveVmGuestOs({
          osType: targetTemplate?.osType,
          osFamily: targetTemplate?.osFamily,
          category: targetTemplate?.category,
          osName: targetTemplate?.name,
          vmOsFamily: targetTemplate?.osFamily,
          orderOsName: null,
        }),
      }).catch((expandErr: any) => {
        console.warn("[reinstall] expandGuestPrimaryDisk failed (non-fatal):", expandErr?.message)
      })
    }
    if (nodeChanged) {
      await logJob(running.id, { step: "VERIFYING_VM", event: "reinstall:destroy_old_vm", message: "Removing old VM after replacement verification" })
      await runReinstallOperation("old_vm_cleanup_failed", "VERIFYING_VM", async () => {
        const oldStatus = await sourceClient.getVMStatus(sourceNodeName, sourceVmid).catch(() => null)
        if (String(oldStatus?.status || "").toLowerCase() === "running") {
          await runTaskOperation(
            running.id,
            sourceClient,
            sourceNodeName,
            "VERIFYING_VM",
            "stop",
            { vmid: sourceVmid, skiplock: true, cleanup: true },
            () => sourceClient.stopVM(sourceNodeName, sourceVmid, { skiplock: true }),
            async () => {
              const stopped = await sourceClient.getVMStatus(sourceNodeName, sourceVmid).catch(() => null)
              return !stopped || String(stopped?.status || "").toLowerCase() !== "running"
            },
            "Stopping old server",
          )
        }
        return runTaskOperation(
          running.id,
          sourceClient,
          sourceNodeName,
          "VERIFYING_VM",
          "delete",
          { vmid: sourceVmid, replacementVmid: vmid, sourceNodeName, targetNodeName: nodeName },
          () => sourceClient.deleteVM(sourceNodeName, sourceVmid),
          async () => {
            const vm = await verifyVm(sourceClient, sourceNodeName, sourceVmid)
            return !vm.exists
          },
          "Removing old server",
        )
      })
      if (previousAllocation?.id && previousAllocation.id !== allocation!.id) {
        await releaseIpAllocation(previousAllocation.id).catch(() => null)
      }
    }

    await reinstallMilestone("REINSTALL_SAVE_CREDENTIALS", "Saving credentials")
    await prisma.vpsInstance.update({
      where: { id: vps.id },
      data: {
        status: "ACTIVE",
        vmMacAddress: reinstallMac,
        vmid,
        name: String(reinstall.requestedHostname || vps.name),
        username: requestedUsername,
        adminUsername: requestedUsername,
        passwordEncrypted: reinstall.passwordEncrypted || vps.passwordEncrypted || encryptSecret(password),
        operatingSystemId: targetTemplate.id,
        proxmoxNodeId: targetNode.id,
        ipAddress: allocation!.ipAddress,
        sshKeyId: reinstall.sshKeyId || vps.sshKeyId || null,
        accessMethod: reinstall.loginMethod || vps.accessMethod || "PASSWORD",
        cpuSockets: topology.sockets,
        coresPerSocket: topology.coresPerSocket,
        provisioningSource: "panel",
        ownershipStatus: "panel_owned",
        ownershipEvidence: {
          managed: true,
          creator: "panel",
          orderId: vps.orderId,
          sourceNodeId: sourceNode.id,
          targetNodeId: targetNode.id,
          nodeName,
          vmid,
          timestamp: new Date().toISOString(),
          operation: "reinstall",
        },
      },
    })
    await prisma.vmNetworkInterface.upsert({
      where: { vpsInstanceId_name: { vpsInstanceId: vps.id, name: "net0" } },
      create: {
        vpsInstanceId: vps.id,
        proxmoxNodeId: targetNode.id,
        vmid,
        name: "net0",
        isPrimary: true,
        macAddress: reinstallMac,
        bridge: reinstallBridge,
        model: "virtio",
        metadata: { source: "reinstall_hard_gate", templateMacAddress: reinstallTemplateMac },
      },
      update: {
        proxmoxNodeId: targetNode.id,
        vmid,
        isPrimary: true,
        macAddress: reinstallMac,
        bridge: reinstallBridge,
        model: "virtio",
        metadata: { source: "reinstall_hard_gate", templateMacAddress: reinstallTemplateMac },
      },
    }).catch(() => null)
    await (prisma as any).vmNetworkCache.upsert({
      where: { vpsInstanceId: vps.id },
      create: {
        vpsInstanceId: vps.id,
        customerId: vps.customerId,
        proxmoxNodeId: targetNode.id,
        vmid,
        primaryAssignedIp: allocation!.ipAddress,
        primaryGateway: allocation!.pool.gateway,
        primaryCidr: Number(allocation!.pool.cidr || 24),
        primaryDns: allocation!.pool.dns || null,
        primaryBridge: reinstallBridge,
        cloudInitIp: allocation!.ipAddress,
        source: "reinstall_hard_gate",
        lastSyncedAt: new Date(),
        metadata: { macAddress: reinstallMac, templateMacAddress: reinstallTemplateMac },
      },
      update: {
        proxmoxNodeId: targetNode.id,
        vmid,
        primaryAssignedIp: allocation!.ipAddress,
        primaryGateway: allocation!.pool.gateway,
        primaryCidr: Number(allocation!.pool.cidr || 24),
        primaryDns: allocation!.pool.dns || null,
        primaryBridge: reinstallBridge,
        cloudInitIp: allocation!.ipAddress,
        source: "reinstall_hard_gate",
        lastSyncedAt: new Date(),
        metadata: { macAddress: reinstallMac, templateMacAddress: reinstallTemplateMac },
      },
    }).catch(() => null)
    await persistVpsConsoleMetadata({ vpsId: vps.id, template: targetTemplate })
    await prisma.order.update({
      where: { id: vps.orderId },
      data: {
        status: "active",
        provisioningStatus: "ACTIVE",
        provisioningError: null,
        osName: targetTemplate.name,
        operatingSystemId: targetTemplate.id,
        proxmoxNodeId: targetNode.id,
        proxmoxNode: nodeName,
        cpuSockets: topology.sockets,
        coresPerSocket: topology.coresPerSocket,
      },
    })
    await reinstallMilestone("REINSTALL_SAVE_CREDENTIALS", "Saving credentials", "completed")
    await reinstallMilestone("REINSTALL_READY", "Ready to use", "completed")
    const completedAt = new Date()
    await prisma.provisioningTaskStep.updateMany({
      where: {
        jobId: running.id,
        status: { in: ["queued", "running", "retrying", "waiting_for_admin"] },
      },
      data: { status: "completed", completedAt, error: null },
    }).catch(() => null)
    await prisma.provisioningJob.update({
      where: { id: running.id },
      data: {
        status: "completed",
        currentStep: "ACTIVE",
        displayStatus: "Reinstall complete",
        progress: 100,
        completedAt,
        dedupeKey: null,
        error: null,
        errorCode: null,
        nextRetryAt: null,
      },
    })
    const closedDuplicates = await prisma.provisioningJob.updateMany({
      where: {
        id: { not: running.id },
        vpsInstanceId: vps.id,
        type: "reinstall",
        status: { in: ["queued", "running", "retrying", "waiting_for_admin"] },
      },
      data: {
        status: "completed",
        currentStep: "ACTIVE",
        displayStatus: "Closed after reinstall completion",
        completedAt,
        dedupeKey: null,
        error: null,
        errorCode: null,
      },
    }).catch(() => ({ count: 0 }))
    await logJob(running.id, { event: "reinstall:complete", message: "Reinstall complete", response: { closedDuplicateJobs: closedDuplicates.count } })
    await publishLiveVmSnapshot(vps.id, "reinstall:complete").catch(() => null)
    await createPanelLog({
      category: "Provisioning",
      message: "reinstall_completed",
      customerId: vps.customerId,
      orderId: vps.orderId,
      vpsInstanceId: vps.id,
      vmid,
      metadata: { templateId: targetTemplate.id, hostname: reinstall.requestedHostname || vps.name, sourceNodeId: sourceNode.id, targetNodeId: targetNode.id },
    }).catch(() => null)
    if (reinstallCustomer?.email || reinstallCustomer?.phone) {
      await sendServiceStatusNotification({
        templateKey: WHATSAPP_TEMPLATE_KEYS.VPS_REINSTALL_COMPLETED,
        customer: reinstallCustomer,
        variables: await deploymentMessageVariables({
          orderId: vps.orderId,
          customerName: reinstallCustomer.name,
          hostname: String(reinstallEffectiveHostname),
          ip: allocation!.ipAddress,
          username: reinstall.adminUsername || vps.username || vps.adminUsername || null,
          passwordEncrypted: reinstall.passwordEncrypted || vps.passwordEncrypted || null,
          os: targetTemplate.name || vps.order.osName || null,
          plan: vps.product?.name || "VPS",
          renewalDate: vps.renewalDueAt || vps.nextRenewalAt,
          vpsInstanceId: vps.id,
          billingCycle: vps.billingCycle || "Monthly",
          region: targetNode.location || targetNode.nodeName || null,
        }),
        orderId: vps.orderId,
        vpsInstanceId: vps.id,
        // cycleKey = jobId keeps each reinstall distinct (a later reinstall still notifies)
        // while retries of the same job dedupe.
        metadata: { source: "reinstall_completed", jobId: running.id, cycleKey: running.id },
      }).catch(() => null)
    }
    await releaseReinstallLock(vps.id)
    return { reinstalled: true, vpsId: vps.id }
  }
  if (!job.orderId) throw new Error("Provisioning job order is missing")
  const lease = await acquireOrderProvisionLease({
    orderId: job.orderId,
    jobId: job.id,
    vpsInstanceId: job.vpsInstanceId,
    vmUuid: job.vpsInstanceId || job.orderId,
  })
  if (!lease.acquired || !lease.owner) {
    await logJob(job.id, {
      event: "order_lock:contended",
      message: "Another worker owns this order; returning the existing provisioning state",
      response: { orderId: job.orderId, leaseExpiresAt: lease.identity?.leaseExpiresAt || null },
    }).catch(() => null)
    return provisioningReplayState(job.orderId)
  }
  try {
    return await processProvisionJob(job.id, lease.owner)
  } finally {
    await releaseOrderProvisionLease(job.orderId, lease.owner).catch(() => undefined)
  }
}

export async function processNextProvisioningJob() {
  await recoverStaleProvisioningJobs()
  await recoverNodeWorkerSlots().catch(() => null)
  await recoverIpBlockedProvisioning({ actor: "worker:provision:self_heal", fullPreflight: true }).catch((error) => {
    console.warn("[ProvisionWorker] IPAM recovery scan failed", { message: error?.message })
  })
  const now = new Date()
  const jobs = await prisma.provisioningJob.findMany({
    where: {
      status: { in: ["queued", "retrying"] },
      type: { in: ["provision", "upgrade", "reinstall"] },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    include: {
      order: { select: { proxmoxNodeId: true, product: { select: { defaultNodeId: true } } } },
      vpsInstance: { select: { proxmoxNodeId: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 25,
  })
  for (const job of jobs) {
    const nodeId = job.proxmoxNodeId || job.vpsInstance?.proxmoxNodeId || job.order?.proxmoxNodeId || job.order?.product?.defaultNodeId || null
    let acquired = false
    if (nodeId) {
      acquired = await acquireNodeWorkerSlot(nodeId)
      if (!acquired) continue
    }
    const claimed = await prisma.provisioningJob.updateMany({
      where: { id: job.id, status: { in: ["queued", "retrying"] } },
      data: { status: "running", claimedAt: new Date(), startedAt: job.startedAt || new Date() },
    })
    if (!claimed.count) {
      if (acquired) await releaseNodeWorkerSlot(nodeId)
      continue
    }
    await logJob(job.id, {
      event: "queue:claimed",
      message: "Provisioning job claimed by worker",
      response: { nodeId, type: job.type, claimedAt: new Date().toISOString() },
    }).catch(() => null)
    paymentFlowLog("Worker received job", { jobId: job.id, orderId: job.orderId, type: job.type, nodeId })
    try {
      return await processProvisioningJob(job.id)
    } finally {
      if (acquired) await releaseNodeWorkerSlot(nodeId)
    }
  }
  return null
}

export async function recoverStaleProvisioningJobs(staleAfterMs = 25 * 60 * 1000) {
  const staleBefore = new Date(Date.now() - Math.max(60000, staleAfterMs))
  const staleJobs = await prisma.provisioningJob.findMany({
    where: {
      status: "running",
      type: { in: ["provision", "upgrade", "reinstall"] },
      OR: [
        { claimedAt: { lt: staleBefore } },
        { updatedAt: { lt: staleBefore } },
      ],
    },
    select: { id: true, attempts: true, maxAttempts: true, currentStep: true, orderId: true, vpsInstanceId: true },
    take: 25,
    orderBy: { updatedAt: "asc" },
  })
  let recovered = 0
  let failed = 0
  for (const job of staleJobs) {
    const attempts = Number(job.attempts || 0)
    const maxAttempts = Number(job.maxAttempts || 3)
    if (attempts >= maxAttempts) {
      await prisma.provisioningJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          currentStep: "FAILED",
          displayStatus: STEP_LABELS.FAILED,
          errorCode: "WORKER_STALE_MAX_RETRIES",
          error: "Provisioning worker stopped while this job was running and retry limit was reached.",
          dedupeKey: null,
          completedAt: new Date(),
        },
      })
      await logJob(job.id, { level: "error", event: "queue:stale_failed", message: "Stale running job marked failed after retry limit" }).catch(() => null)
      await createPanelLog({
        category: "Provisioning",
        message: "provisioning_job_stale_failed",
        orderId: job.orderId,
        vpsInstanceId: job.vpsInstanceId,
        metadata: { jobId: job.id, currentStep: job.currentStep, attempts, maxAttempts },
      }).catch(() => null)
      failed += 1
      continue
    }
    const nextRetryAt = new Date(Date.now() + Math.min(300000, 15000 * Math.max(1, attempts + 1)))
    await prisma.provisioningJob.update({
      where: { id: job.id },
      data: {
        status: "retrying",
        displayStatus: "Retrying",
        errorCode: "WORKER_STALE_RECOVERED",
        error: `Worker heartbeat stale during ${job.currentStep || "unknown step"}; job was returned to retry queue.`,
        claimedAt: null,
        nextRetryAt,
      },
    })
    await logJob(job.id, { level: "warn", event: "queue:stale_recovered", message: "Stale running job returned to retry queue", response: { nextRetryAt } }).catch(() => null)
    await createPanelLog({
      category: "Provisioning",
      message: "provisioning_job_stale_recovered",
      orderId: job.orderId,
      vpsInstanceId: job.vpsInstanceId,
      metadata: { jobId: job.id, currentStep: job.currentStep, attempts, maxAttempts, nextRetryAt },
    }).catch(() => null)
    recovered += 1
  }
  return { scanned: staleJobs.length, recovered, failed, staleBefore }
}

export async function retryProvisioningQueueJob(jobId: string, actor = "system", options: EnqueueOptions = {}) {
  const job = await prisma.provisioningJob.findUnique({ where: { id: jobId } })
  if (!job) throw new Error("Provisioning job not found")
  if (["queued", "running", "retrying"].includes(String(job.status))) throw new Error("Job is already active")
  let selectedNodeId = job.proxmoxNodeId || null
  if (Object.prototype.hasOwnProperty.call(options, "nodeId")) {
    selectedNodeId = options.nodeId ? String(options.nodeId).trim() : null
    if (selectedNodeId) {
      const node = await prisma.proxmoxNode.findFirst({ where: { id: selectedNodeId, isActive: true }, select: { id: true } })
      if (!node) throw new Error("Selected provision node is unavailable or inactive")
    }
    if (job.orderId) {
      await prisma.order.update({ where: { id: job.orderId }, data: { proxmoxNodeId: selectedNodeId, proxmoxNode: null } }).catch(() => null)
    }
  }
  const unsafeVmid = job.vmid !== null && job.vmid !== undefined && !validPanelVmid(job.vmid)
  const retry = await prisma.provisioningJob.update({
    where: { id: jobId },
    data: {
      status: "queued",
      currentStep: "QUEUED",
      displayStatus: STEP_LABELS.QUEUED,
      error: null,
      errorCode: null,
      proxmoxNodeId: selectedNodeId,
      nodeName: null,
      ...(unsafeVmid ? { vmid: null } : {}),
      nextRetryAt: null,
      claimedAt: null,
      completedAt: null,
      dedupeKey: job.dedupeKey || `${job.type}:${job.orderId || job.vpsInstanceId || job.id}:retry:${Date.now()}`,
      metadata: {
        ...((job.metadata as any) || {}),
        retryActor: actor,
        retriedAt: new Date().toISOString(),
        retryNodeId: selectedNodeId,
        ipAssignment: {
          ...(((job.metadata as any) || {})?.ipAssignment || {}),
          mode: options.ipAssignmentMode || (options.requestedIp ? "manual" : (((job.metadata as any) || {})?.ipAssignment?.mode || "automatic")),
          poolId: options.poolId || (((job.metadata as any) || {})?.ipAssignment?.poolId || null),
          requestedIp: options.requestedIp || (((job.metadata as any) || {})?.ipAssignment?.requestedIp || null),
          forceIpOverride: options.forceIpOverride === true || (((job.metadata as any) || {})?.ipAssignment?.forceIpOverride === true),
        },
      },
    },
  })
  if (unsafeVmid && job.orderId) {
    await prisma.order.update({ where: { id: job.orderId }, data: { vmId: null } }).catch(() => null)
  }
  await logJob(jobId, { event: "queue:retry_requested", message: "Provisioning job requeued", response: { actor, nodeId: selectedNodeId } }).catch(() => null)
  return retry
}

export async function cancelProvisioningQueueJob(jobId: string, actor = "system") {
  const job = await prisma.provisioningJob.findUnique({ where: { id: jobId } })
  if (!job) throw new Error("Provisioning job not found")
  if (["completed", "cancelled"].includes(String(job.status))) return job
  const cancelled = await prisma.provisioningJob.update({
    where: { id: jobId },
    data: {
      status: "cancelled",
      currentStep: "CANCELLED",
      displayStatus: "Cancelled",
      error: null,
      errorCode: null,
      dedupeKey: null,
      completedAt: new Date(),
      metadata: { ...((job.metadata as any) || {}), cancelActor: actor, cancelledAt: new Date().toISOString() },
    },
  })
  await logJob(jobId, { level: "warn", event: "queue:cancelled", message: "Provisioning job cancelled", response: { actor } }).catch(() => null)
  return cancelled
}

export async function provisionOrderVps(orderId: string) {
  return enqueueProvisioningJob(orderId)
}

export async function provisionVM(config: { orderId: string }) {
  return enqueueProvisioningJob(config.orderId)
}

function daysBetween(a: Date, b: Date) {
  return Math.max(0, Math.ceil((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000)))
}

export async function createVpsUpgradeOrder(input: {
  vpsInstanceId: string
  customerId: string
  cpuCores?: number
  ramGb?: number
  diskGb?: number
  termMonths?: number
  storagePoolId?: string | null
}) {
  const vps = await prisma.vpsInstance.findUnique({ where: { id: input.vpsInstanceId }, include: { order: true, product: true, storagePool: true } })
  if (!vps || vps.customerId !== input.customerId) throw new Error("VPS not found")

  const fromCpu = Number(vps.cpuCores || vps.product?.cpuCores || 0)
  const fromRam = Number(vps.ramGb || vps.product?.ramGb || 0)
  const fromDisk = Number(vps.diskGb || vps.product?.storageGb || 0)
  const toCpu = Number(input.cpuCores || fromCpu)
  const toRam = Number(input.ramGb || fromRam)
  const toDisk = Number(input.diskGb || fromDisk)
  if (toCpu < fromCpu) throw new Error("CPU cores can only increase.")
  if (toRam < fromRam) throw new Error("RAM can only increase.")
  if (toDisk < fromDisk) throw new Error("Disk size reduction is not supported automatically.")
  const selectedStoragePoolId = input.storagePoolId || vps.storagePoolId || null
  const selectedStoragePool = selectedStoragePoolId
    ? await prisma.nodeStoragePoolConfig.findFirst({ where: { id: selectedStoragePoolId, enabled: true, missingFromProxmox: false } })
    : vps.storagePool
  if (input.storagePoolId && input.storagePoolId !== vps.storagePoolId) {
    throw new Error("Storage pool migration is a manual workflow. Contact support to move disks between pools.")
  }

  // Basic prorated delta against current term window.
  const order = vps.order
  const cycleStart = order.createdAt
  const cycleEnd = new Date(order.createdAt)
  cycleEnd.setMonth(cycleEnd.getMonth() + Math.max(1, Number(order.termMonths || 1)))
  const totalDays = Math.max(1, daysBetween(cycleStart, cycleEnd))
  const remainingDays = Math.max(0, daysBetween(new Date(), cycleEnd))

  const cpuDelta = Math.max(0, toCpu - fromCpu) * 150
  const ramDelta = Math.max(0, toRam - fromRam) * 70
  const diskPricePerGb = 7
  const diskDelta = Math.max(0, toDisk - fromDisk) * diskPricePerGb
  const monthlyDelta = Number((cpuDelta + ramDelta + diskDelta).toFixed(2))
  if (monthlyDelta <= 0) throw new Error("Choose at least one higher resource value.")
  const proratedDelta = Number(((monthlyDelta * remainingDays) / totalDays).toFixed(2))
  const amount = Math.max(1, proratedDelta)
  const renewalTermMonths = [1, 3, 6, 12].includes(Number(input.termMonths || 0)) ? Number(input.termMonths) : Math.max(1, Number(vps.order.termMonths || 1))
  const renewalAmount = Number((monthlyDelta * renewalTermMonths).toFixed(2))

  const orderNumber = `UPG-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  const upgradeOrder = await prisma.order.create({
    data: {
      orderNumber,
      customerId: vps.customerId,
      productId: vps.productId || undefined,
      termMonths: renewalTermMonths,
      unitPrice: amount,
      quantity: 1,
      subtotal: amount,
      taxAmount: 0,
      discountAmount: 0,
      totalAmount: amount,
      originalAmount: amount,
      finalAmount: amount,
      payableAmount: amount,
      orderType: "VPS_UPGRADE",
      gatewayMode: vps.order.gatewayMode,
      operatingSystemId: vps.order.operatingSystemId,
      osName: vps.order.osName,
      templateVmid: vps.order.templateVmid,
      proxmoxNodeId: vps.order.proxmoxNodeId,
      currency: "INR",
      status: "pending",
      provisioningStatus: "pending",
      metadata: {
        kind: "upgrade",
        orderType: "VPS_UPGRADE",
        upgrade: {
          vpsInstanceId: vps.id,
          fromCpuCores: fromCpu,
          toCpuCores: toCpu,
          fromRamGb: fromRam,
          toRamGb: toRam,
          fromDiskGb: fromDisk,
          toDiskGb: toDisk,
          storagePoolId: selectedStoragePool?.id || vps.storagePoolId || null,
          monthlyDelta,
          proratedAmount: amount,
          renewalAmount,
          termMonths: renewalTermMonths,
          pricing: {
            cpuMonthlyRate: 150,
            ramMonthlyRate: 70,
            diskMonthlyRate: 7,
          },
          storagePricingSnapshot: selectedStoragePool ? snapshotStoragePool(selectedStoragePool, {
            includedDiskGb: fromDisk,
            diskGb: toDisk,
          }) : vps.storagePoolSnapshot || null,
          diskPricePerGb,
          diskMonthlyDelta: diskDelta,
          cycleStart,
          cycleEnd,
          totalDays,
          remainingDays,
          proratedDelta: amount,
        },
      },
    },
  })

  return { order: upgradeOrder, amount }
}

export async function applyVpsUpgrade(vpsInstanceId: string, input: { cpuCores?: number; ramGb?: number; diskGb?: number }) {
  // Backward-compatible helper retained for callers; now creates a paid-gated upgrade order.
  const target = await prisma.vpsInstance.findUnique({ where: { id: vpsInstanceId } })
  if (!target) throw new Error("VPS not found")
  return createVpsUpgradeOrder({
    vpsInstanceId,
    customerId: target.customerId,
    cpuCores: input.cpuCores,
    ramGb: input.ramGb,
    diskGb: input.diskGb,
  })
}
