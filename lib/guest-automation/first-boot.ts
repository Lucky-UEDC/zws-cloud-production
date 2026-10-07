/**
 * Provisioning bridge: the guest-automation replacement for Cloud-Init.
 *
 * Cloud-Init configured a guest before it booted by writing `ciuser`,
 * `cipassword`, `ipconfig0` and friends into the Proxmox VM config, then
 * running `qm cloudinit update`. That path is removed from guest management. The
 * new flow splits cleanly along the only line that actually matters — what the
 * host owns versus what the guest owns:
 *
 *   Before start (host side, `qm set` only)
 *     name, description, net0/MAC. Nothing the guest is supposed to apply.
 *
 *   After start (guest side, `qm guest`)
 *     hostname, network, DNS, password, user, SSH, timezone — each executed
 *     through the OS template for the guest that actually answered, then
 *     verified by reading the state back.
 *
 * The consequence is that a template no longer has to be a cloud-init template
 * and the guest is configured by its own tooling (ifupdown, netplan,
 * NetworkManager, PowerShell) rather than by a disk injected at boot.
 */

import { GuestAutomationService, osMetadataForVps, type VmContext } from "./service"

export type { VmContext }
import { GUEST_ERROR_MESSAGES, type GuestErrorCode } from "./constants"
import { isGuestAgentReachable } from "./os-detection"
import type { DetectedOs } from "./os-detection"
import type { ResolvedTemplate } from "./template-resolver"
import { guestNative } from "./proxmox-guest"

export type FirstBootRequest = {
  vms: {
    vpsInstanceId: string
    vmid: number
    nodeName: string
    node: VmContext["node"]
  }
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
    createUser?: { username: string; password: string }
  }
  metadata?: Record<string, unknown> | null
  clientOptions?: VmContext["clientOptions"]
}

export type FirstBootResult =
  | {
      ok: true
      runId: string
      status: "success" | "partial"
      detected: DetectedOs
      template: { id: string; name: string; version: number }
      steps: Array<{ operation: string; status: string; errorCode?: GuestErrorCode | null }>
      noChange: boolean
    }
  | {
      ok: false
      runId: string | null
      errorCode: GuestErrorCode
      message: string
      detected: DetectedOs | null
      template: ResolvedTemplate | null
    }

/**
 * Build a guest context from a ProxmoxNode row, so callers that already hold a
 * node do not have to re-resolve credentials.
 */
export function guestContextFor(input: {
  vpsInstanceId: string
  vmid: number
  node: { nodeName: string; host: string; tokenId: string; tokenSecret: string; allowInsecureTls?: boolean | null }
  clientOptions?: VmContext["clientOptions"]
  /** The guest is not a panel service; see `VmContext.ephemeral`. */
  ephemeral?: boolean
}): VmContext {
  // A missing node is a caller mistake, and a `TypeError` about `nodeName` sends
  // whoever hit it looking for a VM problem instead. Say what is actually wrong.
  if (!input.node || !input.node.nodeName) {
    throw new Error("guest_automation_no_node: this server is not assigned to a compute node, so it cannot be configured")
  }
  if (!input.node.host || !input.node.tokenId || !input.node.tokenSecret) {
    throw new Error("guest_automation_no_credentials: the assigned compute node has no usable API credentials")
  }
  if (!Number.isInteger(Number(input.vmid)) || Number(input.vmid) <= 0) {
    throw new Error(`guest_automation_no_vmid: this server has no valid VMID (got ${JSON.stringify(input.vmid)})`)
  }
  return {
    vpsInstanceId: input.vpsInstanceId,
    vmid: Number(input.vmid),
    nodeName: input.node.nodeName,
    node: {
      host: input.node.host,
      tokenId: input.node.tokenId,
      tokenSecret: input.node.tokenSecret,
      nodeName: input.node.nodeName,
      allowInsecureTls: Boolean(input.node.allowInsecureTls),
    },
    clientOptions: input.clientOptions,
    ephemeral: input.ephemeral === true,
  }
}

/**
 * Proxmox VM config that is safe to write before the guest boots.
 *
 * This is deliberately a short list. Anything here becomes guest configuration
 * that the guest itself should own, which is exactly what the guest automation
 * templates take over.
 */
export function buildPreBootVmConfig(input: {
  vmid: number
  hostname: string
  description?: string | null
  macAddress?: string | null
  netBridge?: string | null
}): Record<string, string> {
  const config: Record<string, string> = {
    // `name` is a Proxmox-side label, not the guest hostname. The guest hostname
    // is set inside the guest by the set_hostname operation.
    name: `zws-${input.vmid}`,
  }
  if (input.description) config.description = input.description
  // net0 is intentionally NOT set here. `<bridge>,bridge=<bridge>,macaddr=...`
  // is not a valid Proxmox net0 value (the primary device model must be a
  // NIC model like virtio), and callers own net0 via net0Value().
  return config
}

/**
 * The operations a first boot must NOT block on.
 *
 * `set_password` re-applying is harmless but a failure there is usually an
 * account-lockout condition the admin must see, so it is a hard failure. The
 * reverse holds for DNS search domains and timezone: a guest that ignores the
 * request still works.
 */
const FIRST_BOOT_FATAL: ReadonlySet<string> = new Set(["set_ip", "set_gateway", "set_password", "create_user", "guest_health"])

export function summariseFirstBoot(
  steps: Array<{ operation: string; status: string; errorCode?: GuestErrorCode | null }>,
): { fatal: string[]; tolerated: string[] } {
  const fatal: string[] = []
  const tolerated: string[] = []
  for (const step of steps) {
    if (step.status === "success" || step.status === "skipped" || step.status === "already_applied") continue
    if (FIRST_BOOT_FATAL.has(step.operation)) fatal.push(step.operation)
    else tolerated.push(step.operation)
  }
  return { fatal, tolerated }
}

/**
 * Wait until the guest agent answers, then run the first-boot pipeline.
 *
 * The wait is bounded and reported: a guest that never answers fails with
 * `GUEST_AGENT_UNREACHABLE`, which is an actionable message, rather than
 * hanging a provisioning job.
 *
 * Windows boots normally in 1-3 minutes, but can take up to 10 minutes.
 * Linux boots normally in 1-1.5 minutes. The default wait is 10 minutes to
 * accommodate slow Windows boots.
 */
/**
 * The first-boot stages, in the order they happen.
 *
 * Reported rather than inferred, so a customer watching a deployment can see
 * that the wait is their operating system booting instead of watching one
 * spinner for the whole time.
 *
 * Windows boots in ~1-3 minutes normally; some images take 5-10 minutes.
 * Linux boots in ~1-1.5 minutes. The wait is 10 minutes max.
 */
export const FIRST_BOOT_STAGES = [
  "WAITING_GUEST_AGENT",
  "DETECTING_OS",
  "LOADING_OS_TEMPLATE",
  "CONFIGURING_NETWORK",
  "CONFIGURING_ACCESS",
  "CONFIGURING_GUEST",
  "VERIFYING_NETWORK",
  "COLLECTING_METRICS",
  "VERIFYING_GUEST",
] as const

export type FirstBootStage = (typeof FIRST_BOOT_STAGES)[number]

export async function runFirstBoot(
  input: FirstBootRequest & {
    waitForAgentMs?: number
    pollIntervalMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    /** Called on entry to each stage and on every wait-loop tick. */
    onStage?: (stage: FirstBootStage, detail: { attempt: number; waitedMs: number; maxWaitMs: number }) => void | Promise<void>
  },
): Promise<FirstBootResult> {
  const onStage = input.onStage ?? (() => undefined)
  // Windows can take up to 10 minutes to boot and become guest-agent ready.
  // Default wait is 10 minutes (600 seconds) to accommodate slow Windows boots.
  const waitMs = input.waitForAgentMs ?? 600_000
  const pollMs = input.pollIntervalMs ?? 5_000
  const now = input.now ?? (() => Date.now())
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  const service = new GuestAutomationService({
    vpsInstanceId: input.vms.vpsInstanceId,
    vmid: input.vms.vmid,
    nodeName: input.vms.nodeName,
    node: input.vms.node,
    clientOptions: input.clientOptions,
  })

  const target = { client: service.proxmoxClient, node: input.vms.nodeName, vmid: input.vms.vmid, engine: "unknown" as const }
  const deadline = now() + waitMs
  const startedAt = now()
  let reachable = false
  let attempt = 0
  do {
    attempt += 1
    await onStage("WAITING_GUEST_AGENT", { attempt, waitedMs: now() - startedAt, maxWaitMs: waitMs })
    const health = await isGuestAgentReachable({ target, bypassCache: true }).catch(() => ({ reachable: false }))
    reachable = health.reachable
    if (reachable) break
    if (now() >= deadline) break
    await sleep(pollMs)
  } while (true)

  if (!reachable) {
    return {
      ok: false,
      runId: null,
      errorCode: "GUEST_AGENT_UNREACHABLE",
      message: GUEST_ERROR_MESSAGES.GUEST_AGENT_UNREACHABLE,
      detected: null,
      template: null,
    }
  }

  // The agent answered ping, but Linux subsystems (networking, filesystem,
  // user database) may still be initializing. Confirm the agent can actually
  // execute a native verb before proceeding — this catches the race where
  // the channel is up but get-osinfo still fails.
  await onStage("DETECTING_OS", { attempt, waitedMs: now() - startedAt, maxWaitMs: waitMs })
  const osInfo = await guestNative<{ id?: string; name?: string }>(
    target,
    "get-osinfo",
    { timeoutMs: 5_000 },
  ).catch(() => ({ ok: false as const }))
  if (!osInfo.ok || !osInfo.data) {
    return {
      ok: false,
      runId: null,
      errorCode: "OS_DETECTION_UNAVAILABLE",
      message: "Guest agent answered ping but OS detection failed. The guest may still be booting.",
      detected: null,
      template: null,
    }
  }
  await onStage("LOADING_OS_TEMPLATE", { attempt, waitedMs: now() - startedAt, maxWaitMs: waitMs })
  await onStage("CONFIGURING_NETWORK", { attempt, waitedMs: now() - startedAt, maxWaitMs: waitMs })
  await onStage("CONFIGURING_ACCESS", { attempt, waitedMs: now() - startedAt, maxWaitMs: waitMs })
  await onStage("CONFIGURING_GUEST", { attempt, waitedMs: now() - startedAt, maxWaitMs: waitMs })

  const result = await service.firstBoot({
    desired: {
      ip: input.desired.ip,
      prefix: input.desired.prefix,
      gateway: input.desired.gateway,
      dns: input.desired.dns,
      searchDomain: input.desired.searchDomain ?? undefined,
      hostname: input.desired.hostname,
      username: input.desired.username,
      password: input.desired.password,
      timezone: input.desired.timezone ?? undefined,
      createUser: input.desired.createUser,
    },
    metadata: input.metadata ?? null,
    actor: { requestedBy: "system:first-boot", role: "system" },
  })

  // Reading the guest back is a distinct stage: the run has executed, and now
  // every operation is being confirmed from inside the guest.
  await onStage("VERIFYING_NETWORK", { attempt, waitedMs: now() - startedAt, maxWaitMs: waitMs })
  await onStage("COLLECTING_METRICS", { attempt, waitedMs: now() - startedAt, maxWaitMs: waitMs })
  await onStage("VERIFYING_GUEST", { attempt, waitedMs: now() - startedAt, maxWaitMs: waitMs })

  // `firstBoot` returns either a plan failure (which carries `message`) or a
  // completed run. Narrowing on `message` is what distinguishes them.
  if ("message" in result) {
    return {
      ok: false,
      runId: result.runId,
      errorCode: result.errorCode,
      message: result.message,
      detected: null,
      template: null,
    }
  }
  if (!result.template) {
    return {
      ok: false,
      runId: result.runId,
      errorCode: "OS_TEMPLATE_MISSING",
      message: "Guest automation ran without a resolved OS template.",
      detected: result.detected,
      template: null,
    }
  }

  const steps = result.steps.map((step) => ({ operation: step.operation, status: step.status, errorCode: step.errorCode }))
  const { fatal } = summariseFirstBoot(steps)
  if (fatal.length) {
    const firstFatal = steps.find((step) => fatal.includes(step.operation))
    return {
      ok: false,
      runId: result.runId,
      errorCode: firstFatal?.errorCode ?? "GUEST_EXEC_FAILED",
      message: `Guest automation could not complete: ${fatal.join(", ")}.`,
      detected: result.detected,
      template: null,
    }
  }

  return {
    ok: true,
    runId: result.runId,
    status: result.status === "success" ? "success" : "partial",
    detected: result.detected,
    template: { id: result.template.id, name: result.template.name, version: result.template.version },
    steps,
    noChange: result.plan.noChange,
  }
}

/**
 * "Ensure the guest can be reached" before a power action.
 *
 * The Cloud-Init version of this re-wrote `ipconfig0`/`cipassword` on every
 * start. This one only asserts the guest side is already correct, and it is a
 * no-op for a stopped VM because there is no agent to talk to yet.
 */
export async function ensureGuestBeforeStart(input: {
  vps: any
  ctx: VmContext
  metadata?: Record<string, unknown> | null
  actor?: string | null
}): Promise<{ checked: boolean; reason: string; matched: boolean; observed: Record<string, unknown> }> {
  const service = new GuestAutomationService(input.ctx)
  const running = await service.isRunning()
  if (!running) {
    return { checked: false, reason: "VM is stopped; guest configuration is applied when it starts.", matched: true, observed: {} }
  }

  const detected = await service.detectOs(input.metadata ?? osMetadataForVps(input.vps))
  if (detected.kind === "unknown") {
    return { checked: true, reason: GUEST_ERROR_MESSAGES.OS_DETECTION_UNAVAILABLE, matched: false, observed: { os: null } }
  }

  const state = await service.getState(detected.engine)
  const assignedIp = String(input.vps?.ipAddress || input.vps?.publicIp || "")
  const observed = {
    os: detected.osId,
    engine: detected.engine,
    hostname: state.hostname,
    primaryInterface: state.primaryInterface,
    ipv4: state.ipv4,
  }
  // The IP is not re-applied here. Provisioning owns that, and doing it on every
  // start would fight a customer who has since reconfigured their own NIC.
  const matched = !assignedIp || state.ipv4.includes(assignedIp)
  return {
    checked: true,
    reason: matched ? "Guest is reachable and reports the expected address." : "Guest reports a different address than the allocation; review the network configuration.",
    matched,
    observed,
  }
}
