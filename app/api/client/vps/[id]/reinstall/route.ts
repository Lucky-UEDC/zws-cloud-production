import { NextRequest, NextResponse } from "next/server"
import { getClientFromCookies } from "@/lib/server-auth"
import { prisma } from "@/lib/db"
import { enqueueReinstallJob } from "@/lib/provision"
import { hostnameFromIp } from "@/lib/vm-hostname"
import { createPanelLog } from "@/lib/panel-log"
import { parseSshPublicKey } from "@/lib/ssh-keys"
import { isWindowsOsTemplate, osTemplateUnavailableReason, resolveAvailableOsTemplate, resolvedOsTemplateDefaultUsername } from "@/lib/os-template-availability"
import { persistVpsConsoleMetadata } from "@/lib/console-metadata"
import { consumeReinstallAllowanceForVps, getReinstallAllowanceForVps } from "@/lib/reinstall-allowance"

type LoginMethod = "password" | "ssh" | "password_ssh"

/**
 * A reinstall runs far longer than this on a real guest (Windows clones are
 * slow), but a lock older than this with no live reinstall job is a crashed
 * run, not a running one. Set well above any legitimate reinstall window so a
 * healthy run is never stolen mid-flight.
 */
const STALE_REINSTALL_LOCK_MS = 6 * 60 * 60 * 1000
type ReinstallStep =
  | "validation_failed"
  | "template_not_found"
  | "vps_not_found"
  | "stop_failed"
  | "destroy_failed"
  | "clone_failed"
  | "resize_failed"
  | "config_failed"
  | "start_failed"
  | "verify_failed"

function fail(step: ReinstallStep, error: string, status = 400) {
  return NextResponse.json({ success: false, step, error }, { status })
}

/**
 * Customer reinstall allowance.
 *
 * Read-only: the reinstall page uses it to show what is left before the
 * customer commits to a destructive operation.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const customer = await getClientFromCookies()
  const customerId = String(customer?.sub || "")
  if (!customerId) return fail("validation_failed", "Unauthorized", 401)
  const { id } = await params
  const vps = await prisma.vpsInstance.findFirst({
    where: { OR: [{ id }, { orderId: id }], customerId, deletedAt: null },
    select: { id: true, orderId: true },
  })
  if (!vps) return fail("vps_not_found", "Instance not found", 404)
  const allowance = await getReinstallAllowanceForVps({ customerId, orderId: vps.orderId })
  return NextResponse.json({ success: true, allowance: allowance.customer })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const customer = await getClientFromCookies()
  const customerId = String(customer?.sub || "")
  if (!customerId) return fail("validation_failed", "Unauthorized", 401)

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const templateId = String(body?.templateId || body?.osTemplateId || "")
  const adminUsername = String(body?.adminUsername || body?.username || "").trim()
  const loginMethod = String(body?.loginMethod || "") as LoginMethod
  const password = String(body?.password || "")
  const confirmPassword = String(body?.confirmPassword || "")
  const savedSshKeyId = String(body?.savedSshKeyId || body?.sshKeyId || "")
  const sshPublicKey = String(body?.sshPublicKey || "").trim()
  const saveSshKey = Boolean(body?.saveSshKey)
  const preserveIp = body?.preserveIp === undefined ? true : Boolean(body.preserveIp)
  const confirmation = String(body?.confirmation || "").trim()

  if (!templateId) return fail("validation_failed", "Operating system template is required")
  if (!["password", "ssh", "password_ssh"].includes(loginMethod)) return fail("validation_failed", "Invalid login method")

  const needsPassword = loginMethod === "password" || loginMethod === "password_ssh"
  const needsSsh = loginMethod === "ssh" || loginMethod === "password_ssh"
  if (needsPassword && password.length < 12) return fail("validation_failed", "Password must be at least 12 characters")
  if (needsPassword && confirmPassword && password !== confirmPassword) return fail("validation_failed", "Password confirmation does not match")

  const vps = await prisma.vpsInstance.findFirst({
    where: {
      OR: [{ id }, { orderId: id }],
      customerId,
      deletedAt: null,
      status: { in: ["ACTIVE", "SUSPENDED", "STOPPED", "REINSTALLING", "active", "suspended", "stopped"] },
      order: { deletedAt: null, status: { not: "DELETED" } },
    },
    include: { order: true },
  })
  if (!vps?.order) return fail("vps_not_found", "Instance not found", 404)
  if ((vps as any).reinstallLock) {
    // A reinstall that crashed or was abandoned mid-run used to leave the lock
    // held forever, permanently blocking the customer from reinstalling their
    // own server. The lock is only a concurrency guard, so a lock older than
    // the job budget, with no reinstall job still running, is reclaimed.
    const lockedAt = (vps as any).reinstallLockedAt ? new Date((vps as any).reinstallLockedAt).getTime() : 0
    const staleAfterMs = STALE_REINSTALL_LOCK_MS
    const isStale = !Number.isFinite(lockedAt) || Date.now() - lockedAt > staleAfterMs
    const activeReinstall = isStale
      ? await prisma.provisioningJob.findFirst({
          where: {
            vpsInstanceId: vps.id,
            type: "reinstall",
            status: { in: ["queued", "running", "retrying"] },
            updatedAt: { gt: new Date(Date.now() - staleAfterMs) },
          },
          select: { id: true },
        }).catch(() => null)
      : null
    if (activeReinstall) {
      return fail("validation_failed", "A reinstall is already in progress for this server. Please wait for it to complete.", 409)
    }
    await prisma.vpsInstance.update({
      where: { id: vps.id },
      data: { reinstallLock: false, reinstallLockedAt: null },
    }).catch(() => null)
    await createPanelLog({
      category: "Provisioning",
      message: "reinstall_lock_reclaimed_stale",
      customerId,
      orderId: vps.orderId,
      vpsInstanceId: vps.id,
      metadata: { lockedAt: (vps as any).reinstallLockedAt || null, staleAfterMs },
    }).catch(() => null)
  }
  const orderMetadata = vps.order.metadata && typeof vps.order.metadata === "object" && !Array.isArray(vps.order.metadata) ? vps.order.metadata as Record<string, any> : {}
  const currentHostname = String(vps.name || orderMetadata.hostname || "").trim()
  // IP-only policy: reinstall always reuses the canonical IP-derived hostname; never a user-supplied name.
  const hostname = hostnameFromIp(vps.ipAddress) || String(vps.hostname || vps.name || "").trim() || `vps-${vps.id.slice(0, 8)}`
  if (confirmation !== "REINSTALL" && (!currentHostname || confirmation !== currentHostname)) {
    return fail("validation_failed", "Confirmation must match instance name or REINSTALL")
  }

  const template = await resolveAvailableOsTemplate({ id: templateId, purpose: "reinstall" })
  if (!template) {
    const rawTemplate = await prisma.osTemplate.findUnique({ where: { id: templateId } }).catch(() => null)
    const reason = rawTemplate
      ? osTemplateUnavailableReason(rawTemplate, { purpose: "reinstall" }) || "Selected operating system is unavailable"
      : "Selected operating system is unavailable."
    return fail("template_not_found", reason, 404)
  }
  const isWindows = isWindowsOsTemplate(template)
  const finalAdminUsername = isWindows ? "Administrator" : adminUsername || resolvedOsTemplateDefaultUsername(template)
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(finalAdminUsername)) return fail("validation_failed", "Admin username is required and must be valid")

  let finalSshKey: string | undefined
  let finalSshKeyId: string | undefined

  if (needsSsh && isWindows) {
    return fail("validation_failed", "SSH key login is not supported for Windows reinstall. Use Administrator password.")
  }

  if (needsSsh) {
    if (savedSshKeyId) {
      const key = await prisma.sshKey.findFirst({ where: { id: savedSshKeyId, customerId } })
      if (!key) return fail("validation_failed", "Saved SSH key not found")
      finalSshKey = key.publicKey
      finalSshKeyId = key.id
      await prisma.sshKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    } else if (sshPublicKey) {
      let parsed
      try {
        parsed = parseSshPublicKey(sshPublicKey)
      } catch (error: any) {
        return fail("validation_failed", error?.message || "Invalid SSH public key")
      }
      finalSshKey = parsed.publicKey
      if (saveSshKey) {
        const existing = await prisma.sshKey.findFirst({ where: { customerId, fingerprint: parsed.fingerprint } })
        const row = existing || await prisma.sshKey.create({ data: { customerId, label: "Reinstall Key", publicKey: parsed.publicKey, fingerprint: parsed.fingerprint, type: parsed.type, source: "uploaded" } })
        finalSshKeyId = row.id
        await prisma.sshKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      }
    } else {
      return fail("validation_failed", "SSH key is required for selected login method")
    }
  }

  try {
    // Monthly allowance is consumed only when the reinstall is actually
    // accepted, and consumption is idempotent on `operationId`, so a retried
    // submit cannot cost the customer two reinstalls.
    const operationId = String(body?.operationId || body?.idempotencyKey || "").trim() || `${vps.id}:${template.id}:${Date.now()}:${Math.floor(Math.random() * 1e6)}`
    const decision = await consumeReinstallAllowanceForVps({ customerId, orderId: vps.orderId, operationId })
    if (!decision.allowed) return fail("validation_failed", decision.reason || "Monthly reinstall limit reached.", 403)

    const job = await enqueueReinstallJob({
      orderId: vps.orderId,
      vpsInstanceId: vps.id,
      customerId,
      osTemplateId: template.id,
      hostname,
      username: finalAdminUsername,
      password: needsPassword ? password : undefined,
      sshPublicKey: isWindows ? undefined : finalSshKey,
      preserveIp,
      actor: `customer:${customerId}`,
      loginMethod,
      sshKeyId: finalSshKeyId,
    })

    await prisma.vpsInstance.update({ where: { id: vps.id }, data: { status: "REINSTALLING", name: hostname, instanceName: hostname, adminUsername: finalAdminUsername, operatingSystemId: template.id } })
    await persistVpsConsoleMetadata({ vpsId: vps.id, template })
    await prisma.order.update({ where: { id: vps.orderId }, data: { provisioningStatus: "REINSTALLING", provisioningError: null, osName: template.name, operatingSystemId: template.id } })
    await createPanelLog({
      category: "Provisioning",
      message: "reinstall_requested",
      customerId,
      orderId: vps.orderId,
      vpsInstanceId: vps.id,
      vmid: vps.vmid,
      metadata: { templateId: template.id, templateName: template.name, hostname, preserveIp, operationId, reinstallConsumed: !decision.duplicate, reinstallDuplicate: decision.duplicate },
    }).catch(() => null)
    return NextResponse.json({ success: true, step: "queued", jobId: job.id, reinstall: { consumed: !decision.duplicate, duplicate: decision.duplicate, remaining: decision.allowance.remaining, monthlyLimit: decision.allowance.granted, nextResetAt: decision.allowance.nextResetAt } })
  } catch (error: any) {
    const step = String(error?.step || "validation_failed") as ReinstallStep
    const safeStep = ["stop_failed", "destroy_failed", "clone_failed", "resize_failed", "config_failed", "start_failed", "verify_failed"].includes(step) ? step : "validation_failed"
    return fail(safeStep as ReinstallStep, error?.message || "Unable to queue reinstall", 500)
  }
}
