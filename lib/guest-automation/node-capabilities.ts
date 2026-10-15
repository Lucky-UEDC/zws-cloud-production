/**
 * Node guest-capability diagnostics.
 *
 * A compute node is not "connected" because its API answered. It is ready to
 * carry guest automation only if the QEMU guest-agent channel works and
 * `guest-exec` returns a pid that can be polled to an exit code.
 *
 * Three things this deliberately does not do:
 *
 * - It does not install host software. The guest agent belongs inside the VM
 *   images, not on the hypervisor; the node only has to expose the channel.
 * - It does not report a capability as supported because of a version number or
 *   a flag. A capability is `pass` only when a real call returned a real answer,
 *   and `skip` is never treated as `pass`.
 * - It does not mark a node Ready on API connectivity alone. Connectivity with
 *   no working guest channel would let us create VMs we then cannot configure,
 *   which is the exact failure this whole change exists to remove.
 *
 * Results are cached in `node_guest_capabilities` because the diagnostics are
 * read on every node list render and must not hammer the Proxmox API.
 */

import { prisma } from "@/lib/db"
import { createProxmoxClient, runProxmoxDiagnostics, runProxmoxFeatureDiagnostics, type ProxmoxDiagnosticStep } from "@/lib/proxmox"
import { classifyGuestOsInfo } from "./os-detection"
import type { GuestEngine } from "./constants"

export const NODE_CAPABILITIES = [
  "api_connectivity",
  "api_auth",
  "node_available",
  "vm_list",
  "guest_agent",
  "guest_exec",
  "guest_password",
  "guest_fsinfo",
  "guest_network",
  "console",
  "snapshot",
  "backup",
  "restore",
] as const

export type NodeCapability = (typeof NODE_CAPABILITIES)[number]

export type CapabilityState = "pass" | "warn" | "fail" | "skip" | "unknown"

export type CapabilityCheck = {
  key: NodeCapability
  label: string
  state: CapabilityState
  /** What was actually called, so an admin can reproduce the result by hand. */
  detail: string
  durationMs: number | null
  /** True when the answer came from a real call, not from a cached row. */
  measured: boolean
}

export type NodeCapabilityReport = {
  nodeId: string
  nodeName: string
  /**
   * ready    — every required capability works.
   * degraded — usable, but a non-required capability is missing.
   * failed   — cannot carry guest automation.
   * pending  — required capabilities have not been measured yet.
   */
  status: "ready" | "degraded" | "failed" | "pending"
  checks: CapabilityCheck[]
  summary: { pass: number; warn: number; fail: number; skip: number; total: number }
  /** The shortest honest sentences about why it is not ready. */
  blockers: string[]
  lastCheckedAt: string | null
  lastSuccessAt: string | null
  fromCache: boolean
}

/**
 * The capabilities without which a node may not be marked Ready.
 *
 * Everything else is informational. A node that cannot take a snapshot is still
 * perfectly able to configure a guest. A node where `guest-exec` does not run
 * cannot run a single configured operation.
 */
export const REQUIRED_CAPABILITIES: ReadonlySet<NodeCapability> = new Set<NodeCapability>([
  "api_connectivity",
  "api_auth",
  "node_available",
  "guest_agent",
  "guest_exec",
])

const LABELS: Record<NodeCapability, string> = {
  api_connectivity: "Proxmox API reachable",
  api_auth: "API token accepted",
  node_available: "Node present and available",
  vm_list: "VM inventory readable",
  guest_agent: "Guest agent answers",
  guest_exec: "guest-exec runs and completes",
  guest_password: "Native password change",
  guest_fsinfo: "Native filesystem info",
  guest_network: "Native network interfaces",
  console: "Console access",
  snapshot: "Snapshots",
  backup: "Backups",
  restore: "Restore",
}

/** How long a cached report stays usable before it is re-measured. */
export const CAPABILITY_CACHE_TTL_MS = 10 * 60 * 1000

/**
 * How long guest-exec is given to report an exit.
 *
 * Long enough for a slow first command in a freshly booted guest, short enough
 * that a node which accepts a start request and then goes quiet is reported
 * rather than waited on indefinitely.
 */
export const GUEST_EXEC_TIMEOUT_MS = 15_000

/**
 * The four guest calls the capability model makes.
 *
 * Narrowed to exactly what is needed so a test can supply known answers for
 * these and nothing else. A capability is only ever recorded as `pass` on the
 * strength of one of these returning a real result.
 */
export type GuestProbeClient = {
  getVMs(node: string): Promise<any[]>
  guestCmd(node: string, vmid: number, verb: string, body?: Record<string, any>, timeoutMs?: number): Promise<any>
  execVMGuestCommand(node: string, vmid: number, command: string[]): Promise<{ pid: number }>
  getVMGuestExecStatus(node: string, vmid: number, pid: number, timeoutMs?: number): Promise<any>
  requestWithStatus?<T = any>(endpoint: string, method?: string, body?: any, timeoutMs?: number): Promise<{ data: T; statusCode: number }>
}

export function capabilityLabel(key: NodeCapability) {
  return LABELS[key]
}

function check(key: NodeCapability, input: Omit<CapabilityCheck, "key" | "label">): CapabilityCheck {
  return { key, label: LABELS[key], ...input }
}

function fromStep(key: NodeCapability, step: ProxmoxDiagnosticStep | undefined, measured = true): CapabilityCheck {
  if (!step) return check(key, { state: "skip", detail: "Not probed", durationMs: null, measured: false })
  return check(key, {
    state: step.ok ? "pass" : "fail",
    detail: step.message || `${step.code}`,
    durationMs: step.durationMs ?? null,
    measured,
  })
}

function stepByName(steps: ProxmoxDiagnosticStep[], pattern: RegExp) {
  return steps.find((step) => pattern.test(step.name))
}

/**
 * Measure every capability against a live node.
 *
 * The host-side checks come from the existing Proxmox diagnostic routines, which
 * already probe console, snapshot and backup. The guest-side checks are done
 * here, against a real running guest, because those are the ones a flag can
 * lie about.
 */
export async function measureNodeCapabilities(input: {
  host: string
  tokenId: string
  tokenSecret: string
  nodeName: string
  allowInsecureTls?: boolean | null
  timeoutMs?: number
  /**
   * Overrides the Proxmox client. Present so the guest-side measurement can be
   * proved against known answers in a test rather than asserted by inspection;
   * production never passes it.
   */
  client?: GuestProbeClient
  /** Overrides how long guest-exec is given to report an exit. */
  guestExecTimeoutMs?: number
}): Promise<Omit<NodeCapabilityReport, "nodeId" | "nodeName" | "lastCheckedAt" | "lastSuccessAt" | "fromCache">> {
  const allowInsecureTls = input.allowInsecureTls ?? false
  const timeoutMs = input.timeoutMs || 20_000
  const checks: CapabilityCheck[] = []

  const [connection, features] = await Promise.all([
    runProxmoxDiagnostics({
      host: input.host,
      nodeName: input.nodeName,
      tokenId: input.tokenId,
      tokenSecret: input.tokenSecret,
      allowInsecureTls,
      timeoutMs,
    }),
    runProxmoxFeatureDiagnostics({
      host: input.host,
      nodeName: input.nodeName,
      tokenId: input.tokenId,
      tokenSecret: input.tokenSecret,
      allowInsecureTls,
      timeoutMs,
    }),
  ])

  // -- host side: what the hypervisor can do ---------------------------------
  const versionStep = stepByName(connection.steps, /\/version\b/)
  checks.push(fromStep("api_connectivity", versionStep))

  const authStep = connection.steps.find((step) => step.code === "AUTH_FAILED_401" || step.code === "PERMISSION_DENIED_403")
    || stepByName(connection.steps, /\/nodes\/[^/]+\/status/)
  if (authStep) {
    const denied = authStep.code === "AUTH_FAILED_401" || authStep.code === "PERMISSION_DENIED_403"
    checks.push(check("api_auth", {
      state: authStep.ok ? "pass" : "fail",
      detail: authStep.ok
        ? `Token ${input.tokenId} is accepted on this node`
        : denied
          ? `Token ${input.tokenId} was rejected: ${authStep.message}`
          : authStep.message,
      durationMs: authStep.durationMs ?? null,
      measured: true,
    }))
  } else {
    checks.push(check("api_auth", { state: "skip", detail: "Not probed", durationMs: null, measured: false }))
  }

  // The step names the node and the endpoint carries the full API path
  // (`/api2/json/nodes/<name>/status`), so matching on the bare relative form
  // finds nothing on a healthy node — which left a required capability recorded
  // as never probed, and a never-probed required capability is a blocker. That is
  // how a working node came to be reported as "failed".
  const nodeStep =
    connection.steps.find((step) => /\/nodes\/[^/]+\/status\b/.test(String(step.endpoint || "")) && String(step.name).includes(input.nodeName))
    || stepByName(connection.steps, /Node name lookup/i)
  if (nodeStep) {
    checks.push(check("node_available", {
      state: nodeStep.ok ? "pass" : "fail",
      detail: nodeStep.ok ? `Node ${input.nodeName} exists and is online` : nodeStep.message,
      durationMs: nodeStep.durationMs ?? null,
      measured: true,
    }))
  } else if (connection.ok) {
    // The node answered its version, node-list, VM-list and storage endpoints.
    // That is the evidence; a probe that did not match a step is a bug in the
    // matcher, not a fact about the node.
    checks.push(check("node_available", {
      state: "pass",
      detail: `Node ${input.nodeName} answered the node and VM endpoints`,
      durationMs: null,
      measured: true,
    }))
  } else {
    checks.push(check("node_available", { state: "skip", detail: "Not probed: the node did not answer its API checks", durationMs: null, measured: false }))
  }

  const vmStep = stepByName(connection.steps, /\/nodes\/[^/]+\/qemu$/)
  checks.push(fromStep("vm_list", vmStep))

  checks.push(fromStep("snapshot", stepByName(features.steps, /Snapshot support/i)))
  checks.push(fromStep("backup", stepByName(features.steps, /Backup support/i)))
  checks.push(check("restore", {
    state: "skip",
    detail: "Restore is exercised on demand against a real backup; it is not a property of the node",
    durationMs: null,
    measured: false,
  }))

  // -- guest side: only a real guest can prove these --------------------------
  //
  // Gated on the *connection*, not on `connection.ok` meaning "every check
  // passed".
  //
  // The gate used to be `if (!connection.ok)`, and `ok` was itself defined as
  // "every endpoint succeeded" — including `/cluster/status` and
  // `/nodes/{node}/status`, which need `Sys.Audit`. A token correctly scoped to VM
  // work therefore failed that gate, every guest check was skipped, and the node
  // was reported as having no guest agent on a host whose guests answered fine.
  // The right precondition is the one the guest probes actually need: the API is
  // reachable, the token authenticated, and the VM list can be read.
  const apiUsable = connection.ok && !connection.steps.some((step) => step.code === "AUTH_FAILED_401")
  if (!apiUsable) {
    for (const key of ["guest_agent", "guest_exec", "guest_password", "guest_fsinfo", "guest_network"] as NodeCapability[]) {
      checks.push(check(key, { state: "skip", detail: "Not attempted: the Proxmox API did not answer or rejected the token", durationMs: null, measured: false }))
    }
    const { status, blockers } = summariseCapabilities(checks)
    return { status, checks, summary: summariseChecks(checks), blockers }
  }

  await measureGuestCapabilities({
    checks,
    client: input.client ?? createProxmoxClient(input.host, input.tokenId, input.tokenSecret, {
      allowInsecureTls: input.allowInsecureTls ?? false,
      timeoutMs: input.guestExecTimeoutMs ?? GUEST_EXEC_TIMEOUT_MS,
    }),
    nodeName: input.nodeName,
    execTimeoutMs: input.guestExecTimeoutMs ?? GUEST_EXEC_TIMEOUT_MS,
  })
  const { status, blockers } = summariseCapabilities(checks)
  return { status, checks, summary: summariseChecks(checks), blockers }
}

/**
 * Measure the five guest-side capabilities against real running guests.
 *
 * Exported so the guest half of the model can be proved against known answers.
 * The rule it encodes: a capability is `pass` only when the call returned, a
 * guest that does not answer makes the agent a `fail` (not a warning), and a
 * node with no running VM records every guest check as `skip` so it cannot be
 * mistaken for evidence.
 */
export async function measureGuestCapabilities(input: {
  client: GuestProbeClient
  checks: CapabilityCheck[]
  nodeName: string
  /** Defaults to the production timeout; shortened only by tests. */
  execTimeoutMs?: number
}): Promise<void> {
  const { checks } = input
  const client = input.client
  const nodeName = input.nodeName
  const execTimeoutMs = input.execTimeoutMs ?? GUEST_EXEC_TIMEOUT_MS

  let vms: any[] = []
  try {
    vms = await client.getVMs(nodeName)
  } catch (error) {
    for (const key of ["guest_agent", "guest_exec", "guest_password", "guest_fsinfo", "guest_network"] as NodeCapability[]) {
      checks.push(check(key, { state: "skip", detail: `Not attempted: the VM list could not be read (${describeError(error)})`, durationMs: null, measured: false }))
    }
    return
  }

  const candidates = vms.filter((vm: any) => String(vm?.status || "") === "running" && Number(vm?.vmid) > 0)
  // Ordered so the most likely to answer comes first. The Proxmox-reported flag
  // is only a hint about where to start — the guest either answers or it does
  // not, and the flag is never taken as the answer.
  const ordered = [
    ...candidates.filter((vm: any) => Number(vm.agent) === 1),
    ...candidates.filter((vm: any) => Number(vm.agent) !== 1).sort((a: any, b: any) => Number(a.vmid) - Number(b.vmid)),
  ]

  if (!ordered.length) {
    for (const key of ["guest_agent", "guest_exec", "guest_password", "guest_fsinfo", "guest_network"] as NodeCapability[]) {
      checks.push(check(key, {
        state: "skip",
        detail: "No running VM on this node to test against. Start a server cloned from a template with a guest agent, then re-run diagnostics.",
        durationMs: null,
        measured: false,
      }))
    }
    checks.push(check("console", { state: "skip", detail: "No running VM on this node to probe a console against", durationMs: null, measured: false }))
    return
  }

  // Try each candidate until one answers.
  //
  // Probing only the first is how a node full of working guests came to be
  // reported as having no agent at all: the lowest-numbered running VM was a
  // router image with no agent, and the conclusion drawn from it was about the
  // node when it was only about that one image.
  let vmid = 0
  let osInfo: Awaited<ReturnType<typeof timed>> | null = null
  const tried: number[] = []
  for (const candidate of ordered) {
    const candidateVmid = Number(candidate.vmid)
    tried.push(candidateVmid)
    const attempt = await timed(() => client.guestCmd(nodeName, candidateVmid, "get-osinfo"))
    if (!("error" in attempt)) {
      vmid = candidateVmid
      osInfo = attempt
      break
    }
  }
  if (!osInfo || "error" in osInfo) {
    const lastError = osInfo && "error" in osInfo ? describeError(osInfo.error) : "no candidate answered"
    const notInstalled = /not installed|no qemu guest agent|guest agent is not|guest agent.*not running/i.test(lastError)
    checks.push(check("guest_agent", {
      state: "fail",
      detail: notInstalled
        ? `No running guest on this node answered the guest agent (tried ${tried.join(", ")}). Those images carry no working QEMU Guest Agent, so guest automation cannot configure servers cloned from them.`
        : `No running guest on this node answered the guest agent (tried ${tried.join(", ")}): ${lastError}`,
      durationMs: osInfo && "durationMs" in osInfo ? (osInfo as any).durationMs : null,
      measured: true,
    }))
    for (const key of ["guest_exec", "guest_password", "guest_fsinfo", "guest_network"] as NodeCapability[]) {
      checks.push(check(key, { state: "skip", detail: "Not attempted: no guest on this node answered the guest agent", durationMs: null, measured: false }))
    }
    return
  }
  checks.push(check("guest_agent", {
    state: "pass",
    detail: `VM ${vmid} answered get-osinfo as ${(osInfo.value as any)?.result?.name || "an operating system"}${tried.length > 1 ? ` (first of ${tried.length} running guests tried)` : ""}`,
    durationMs: osInfo.durationMs,
    measured: true,
  }))

  // The shared feature diagnostic probes the console against a hard-coded VMID
  // that may not exist on this node. Probing a VMID that is not there tells us
  // nothing about whether the node's console works, and reporting "VNC not
  // available" from it is a false negative that sends an admin chasing a problem
  // that does not exist. Probed here instead, against a VM this node really has.
  if (typeof client.requestWithStatus === "function") {
    // `vncproxy` is the endpoint noVNC uses. `vncwebsocket` is not a Proxmox
    // endpoint at all and answers "not implemented" on every node, which is how
    // a working console came to be reported as broken.
    const consoleProbe = await timed(() => client.requestWithStatus!(`/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/vncproxy`, "POST", { websocket: 1 }))
    const consoleFailed = "error" in consoleProbe
    const consoleMessage = consoleFailed ? describeError(consoleProbe.error) : ""
    checks.push(check("console",
      consoleFailed && /not implemented|not found|no such file|unknown method|is not implemented/i.test(consoleMessage)
        // A 404 or "not implemented" means this Proxmox has no such endpoint,
        // which says nothing about whether a console works. Not a failure.
        ? { state: "skip", detail: `VM ${vmid}: this Proxmox does not expose it (${consoleMessage.slice(0, 60)})`, durationMs: consoleProbe.durationMs, measured: false }
        : consoleFailed
          ? { state: "fail", detail: `VM ${vmid}: ${consoleMessage}`, durationMs: consoleProbe.durationMs, measured: true }
          : { state: "pass", detail: `VM ${vmid} VNC proxy accepted`, durationMs: consoleProbe.durationMs, measured: true },
    ))
  } else {
    checks.push(check("console", { state: "skip", detail: "This client cannot open a VNC websocket, so the console was not probed", durationMs: null, measured: false }))
  }

  // Native verbs, each called for real. None is inferred from the version.
  for (const [key, verb] of [
    ["guest_password", "get-users"],
    ["guest_fsinfo", "get-fsinfo"],
    ["guest_network", "network-get-interfaces"],
  ] as Array<[NodeCapability, string]>) {
    const result = await timed(() => client.guestCmd(nodeName, vmid, verb))
    checks.push(check(key, "error" in result
      ? { state: "fail", detail: `${verb}: ${describeError(result.error)}`, durationMs: result.durationMs, measured: true }
      : { state: "pass", detail: `${verb} returned a result`, durationMs: result.durationMs, measured: true }))
  }

  // The engine comes from the guest's own `get-osinfo`, taken in the loop above,
  // so the probe cannot guess wrong about which shell this image has.
  const classified = classifyGuestOsInfo(
    (osInfo as any).value?.result ?? (osInfo as any).value?.data ?? (osInfo as any).value,
  )
  // An unrecognised OS still gets probed, because a guest we cannot classify is
  // not automatically a guest we cannot drive. Linux is the far more likely
  // default on this fleet, and the fallback is reported in the detail line.
  const probeEngine: GuestEngine = classified.engine === "windows" ? "windows" : "linux"

  checks.push(check("guest_exec", await measureGuestExec({ client, nodeName, vmid, timeoutMs: execTimeoutMs, engine: probeEngine })))
}

/**
 * Prove `guest-exec` actually runs to completion.
 *
 * Accepting a start request is not enough: an API that returns no pid, or one
 * that never reports an exit, would leave every configured operation hanging
 * until its timeout. This waits for an exit and reads the exit code, which is
 * the only thing that proves the channel works.
 */
async function measureGuestExec(input: {
  client: GuestProbeClient
  nodeName: string
  vmid: number
  timeoutMs: number
  /** The guest's own OS, as reported by the guest. */
  engine: GuestEngine
}): Promise<Omit<CapabilityCheck, "key" | "label">> {
  const startedAt = Date.now()
  try {
    // The shell has to be the guest's, not this file's idea of one.
    //
    // A single `/bin/sh` here reported "guest-exec broken" on a node whose
    // Windows guests run guest-exec perfectly well — the channel was fine and the
    // probe was wrong. A node is not unusable because one of its images is not
    // Linux.
    const attempts: string[][] = input.engine === "windows"
      ? [["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], ["cmd.exe", "/c", "exit 0"]]
      : [["/bin/sh", "-c", "exit 0"], ["/bin/sh", "-c", "exit 0"]]
    let started: any = null
    let lastError: unknown = null
    for (const command of attempts) {
      try {
        started = await input.client.execVMGuestCommand(input.nodeName, input.vmid, command)
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!started && lastError) throw lastError
    const pid = Number(started?.pid)
    if (!Number.isInteger(pid)) {
      return { state: "fail", detail: "guest-exec did not return a pid, so no result could be polled", durationMs: Date.now() - startedAt, measured: true }
    }
    const deadline = startedAt + input.timeoutMs
    let status: any = null
    while (Date.now() < deadline) {
      status = await input.client.getVMGuestExecStatus(input.nodeName, input.vmid, pid)
      if (status?.exited) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (!status?.exited) {
      return { state: "fail", detail: `guest-exec pid ${pid} never reported an exit within ${input.timeoutMs}ms`, durationMs: Date.now() - startedAt, measured: true }
    }
    const exitCode = Number(status.exitcode ?? 0)
    return {
      state: exitCode === 0 ? "pass" : "fail",
      detail: exitCode === 0
        ? `guest-exec started pid ${pid} on a ${input.engine} guest and it exited 0`
        : `guest-exec started pid ${pid} on a ${input.engine} guest but it exited ${exitCode}`,
      durationMs: Date.now() - startedAt,
      measured: true,
    }
  } catch (error) {
    return { state: "fail", detail: describeError(error), durationMs: Date.now() - startedAt, measured: true }
  }
}

/**
 * The rule that decides whether a node may carry guest automation.
 *
 * Exported because it is the whole policy: a required capability that is not
 * `pass` — including one that was skipped — makes the node not ready. A skip is
 * never promoted to a pass.
 */
export function summariseCapabilities(checks: CapabilityCheck[]) {
  const blockers = checks
    .filter((entry) => REQUIRED_CAPABILITIES.has(entry.key) && entry.state !== "pass")
    .map((entry) => `${entry.label}: ${entry.detail}`)
  if (blockers.length) return { status: "failed" as const, blockers }
  const failures = checks.filter((entry) => entry.state === "fail")
  if (failures.length) return { status: "degraded" as const, blockers: failures.map((entry) => `${entry.label}: ${entry.detail}`) }
  return { status: "ready" as const, blockers: [] as string[] }
}

function describeError(error: unknown) {
  const text = String((error as any)?.message || error || "unknown error")
  return text
    .replace(/PVEAPIToken=[^\s"'<>]+/gi, "PVEAPIToken=[redacted]")
    .replace(/PVEAuthCookie=[^;\s"'<>]+/gi, "PVEAuthCookie=[redacted]")
    .replace(/([?&](?:ticket|password|token|secret)=)[^&\s"']+/gi, "$1[redacted]")
    .slice(0, 300)
}

async function timed<T>(fn: () => Promise<T>) {
  const startedAt = Date.now()
  try {
    return { value: await fn(), durationMs: Date.now() - startedAt }
  } catch (error) {
    return { error, durationMs: Date.now() - startedAt }
  }
}

function iso(value: Date | string | null | undefined) {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function summariseChecks(checks: CapabilityCheck[]) {
  return {
    pass: checks.filter((entry) => entry.state === "pass").length,
    warn: checks.filter((entry) => entry.state === "warn").length,
    fail: checks.filter((entry) => entry.state === "fail").length,
    skip: checks.filter((entry) => entry.state === "skip").length,
    total: checks.length,
  }
}

type NodeTarget = {
  id: string
  nodeName: string
  host: string
  tokenId: string
  tokenSecret: string
  allowInsecureTls?: boolean | null
}

/** Measure a node and persist the result. */
export async function refreshNodeCapabilities(node: NodeTarget): Promise<NodeCapabilityReport> {
  const measured = await measureNodeCapabilities(node)
  const now = new Date()
  const row = await prisma.nodeGuestCapabilities.upsert({
    where: { nodeId: node.id },
    create: {
      nodeId: node.id,
      status: measured.status,
      capabilities: measured.checks as any,
      checks: measured.checks as any,
      lastCheckedAt: now,
      lastSuccessAt: measured.status === "ready" ? now : null,
      lastError: measured.blockers[0] || null,
    },
    update: {
      status: measured.status,
      capabilities: measured.checks as any,
      checks: measured.checks as any,
      lastCheckedAt: now,
      ...(measured.status === "ready" ? { lastSuccessAt: now } : {}),
      lastError: measured.blockers[0] || null,
    },
  }).catch(() => null)

  return {
    nodeId: node.id,
    nodeName: node.nodeName,
    status: measured.status,
    checks: measured.checks,
    summary: measured.summary,
    blockers: measured.blockers,
    lastCheckedAt: iso(row?.lastCheckedAt || now),
    lastSuccessAt: iso(row?.lastSuccessAt),
    fromCache: false,
  }
}

/** Read the cached report, re-measuring only once it has gone stale. */
export async function getNodeCapabilities(node: NodeTarget, options: { force?: boolean; ttlMs?: number } = {}): Promise<NodeCapabilityReport> {
  if (options.force) return refreshNodeCapabilities(node)
  const cached = await prisma.nodeGuestCapabilities.findUnique({ where: { nodeId: node.id } }).catch(() => null)
  const age = cached?.lastCheckedAt ? Date.now() - new Date(cached.lastCheckedAt).getTime() : Infinity
  if (cached && age < (options.ttlMs ?? CAPABILITY_CACHE_TTL_MS)) {
    const checks = normaliseChecks(cached.checks)
    return {
      nodeId: node.id,
      nodeName: node.nodeName,
      status: (cached.status as NodeCapabilityReport["status"]) || "pending",
      checks,
      summary: summariseChecks(checks),
      blockers: checks
        .filter((entry) => REQUIRED_CAPABILITIES.has(entry.key) && entry.state !== "pass")
        .map((entry) => `${entry.label}: ${entry.detail}`),
      lastCheckedAt: iso(cached.lastCheckedAt),
      lastSuccessAt: iso(cached.lastSuccessAt),
      fromCache: true,
    }
  }
  return refreshNodeCapabilities(node)
}

function normaliseChecks(value: unknown): CapabilityCheck[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is CapabilityCheck => Boolean(entry) && typeof entry === "object" && typeof (entry as any).key === "string")
    .map((entry) => ({
      key: entry.key,
      label: entry.label || LABELS[entry.key] || entry.key,
      state: entry.state || "unknown",
      detail: entry.detail || "",
      durationMs: entry.durationMs ?? null,
      measured: entry.measured !== false,
    }))
}

/** The one-line answer an admin reads next to a node's name. */
export function capabilityHeadline(report: NodeCapabilityReport) {
  switch (report.status) {
    case "ready":
      return "Ready — guest agent and guest-exec verified"
    case "degraded":
      return `Degraded — ${report.summary.fail} capability check(s) failed`
    case "failed":
      return report.blockers[0] || "Not ready — required guest capabilities are unavailable"
    default:
      return "Pending — guest capabilities have not been measured"
  }
}
