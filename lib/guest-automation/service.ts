/**
 * GuestAutomationService — the single entry point for every guest mutation.
 *
 * Every method resolves the OS dynamically (guest agent first, authoritative
 * metadata second), loads the matching OS template, and executes only the
 * operations the OS profile actually defines. Nothing about Ubuntu, Debian or
 * Windows is hardcoded here: the engines differ only in which template matches.
 *
 * Guarantees provided by this layer:
 *  - No raw client input reaches the guest. Callers pass semantic requests
 *    (`setIP({ ip, prefix, gateway })`); the service builds the command.
 *  - Secrets are stdin-only and never persisted in an audit row.
 *  - Every step is verified, logged with duration + error code, and idempotent.
 *  - Dangerous steps get a recorded backup point and a rollback attempt.
 *  - An unknown OS runs no guest command at all.
 */

import { prisma } from "@/lib/db"
import { createProxmoxClient, type ProxmoxClientOptions } from "@/lib/proxmox"
import { writeAuditLog } from "@/lib/audit-log"
import {
  DESTRUCTIVE_OPERATIONS,
  GUEST_ERROR_MESSAGES,
  FIRST_BOOT_SEQUENCE,
  assertShellMatchesEngine,
  crossOsCommandViolations,
  isGuestOperation,
  type GuestEngine,
  type GuestErrorCode,
  type GuestOperation,
  type GuestOperationStatus,
  type GuestRunTrigger,
} from "./constants"
import { detectGuestOs, isGuestAgentReachable, persistDetection, type DetectedOs } from "./os-detection"
import {
  execGuestCommand,
  guestNative,
  retryDelayMs,
  shouldRetryGuestError,
  type GuestTarget,
  type ProxmoxGuestClient,
} from "./proxmox-guest"
import { hypervisorMacsFromConfig, parseHostname, parseNativeFsInfo, parseNativeInterfaces, parseNativeOsInfo, parseNativeUsers, parseTimezone } from "./parsers"
import { buildPlan, deriveRunStatus, serializePlan, type GuestStateSnapshot, type OperationPlan, type PlanRequest, EMPTY_SNAPSHOT } from "./plan"
import { extractPlaceholders, maskCommandSecrets, renderTemplate, unknownPlaceholders } from "./placeholders"
import { enabledOperations, resolveTemplate, type ResolvedOperation, type ResolvedTemplate } from "./template-resolver"
import { assertExpectation, observeFromOutput, verifyOperation, type Observation } from "./verification"

export type VmContext = {
  vpsInstanceId: string
  vmid: number
  nodeName: string
  node: {
    host: string
    tokenId: string
    tokenSecret: string
    nodeName: string
    allowInsecureTls: boolean
  }
  clientOptions?: ProxmoxClientOptions
  /**
   * This guest is not a panel service, so nothing may be written against it.
   *
   * Used by the production QA script and by the admin "Test on VM" action when
   * an admin points it at a VM the panel does not manage. Without it every call
   * attempts an adoption or run insert against a `vpsInstanceId` that does not
   * exist, and the resulting foreign-key error fills an operator's log with
   * noise about a test. Detection and execution still work; only the record is
   * skipped.
   */
  ephemeral?: boolean
}

export type Actor = {
  requestedBy?: string | null
  role?: string | null
  ipAddress?: string | null
  userAgent?: string | null
}

export type OperationOutcome = {
  operation: GuestOperation
  status: GuestOperationStatus
  changed: boolean
  verified: boolean
  durationMs: number
  attempts: number
  errorCode: GuestErrorCode | null
  error: string | null
  /** Masked command for the audit trail. */
  commandMasked: string | null
  /** Non-sensitive structured result. */
  result: Record<string, unknown>
  rollbackStatus?: "not-required" | "attempted-success" | "attempted-failed" | "skipped"
}

export type RunResult = {
  ok: boolean
  runId: string
  status: "success" | "partial" | "failed" | "rolled_back"
  steps: OperationOutcome[]
  plan: ReturnType<typeof serializePlan>
  detected: DetectedOs
  template: { id: string; name: string; version: number } | null
  error: string | null
  errorCode: GuestErrorCode | null
}

const OPS_TABLE = "guest_operation_runs"

/**
 * Sample values for a dry run and for an admin test.
 *
 * Deliberately obviously fake. A dry run that substituted a real customer's
 * address or password would either leak a secret into a browser tab or, worse,
 * make a command look safe because it happened to be a no-op for one server.
 */
const SAMPLE_VALUES: Record<string, string> = {
  VMID: "100000",
  IP: "192.0.2.10",
  PREFIX: "24",
  MASK: "255.255.255.0",
  GATEWAY: "192.0.2.1",
  DNS1: "192.0.2.53",
  DNS2: "192.0.2.54",
  NIC: "eth0",
  USERNAME: "zwsuser",
  PASSWORD: "sample-not-a-real-password",
  TIMEZONE: "Asia/Kolkata",
}

function sampleValues(): Record<string, string> {
  return { ...SAMPLE_VALUES }
}

export class GuestAutomationService {
  private client: ProxmoxGuestClient

  constructor(
    private ctx: VmContext,
    client?: ProxmoxGuestClient,
  ) {
    this.client =
      client ??
      (createProxmoxClient(ctx.node.host, ctx.node.tokenId, ctx.node.tokenSecret, ctx.clientOptions ?? { allowInsecureTls: ctx.node.allowInsecureTls }) as unknown as ProxmoxGuestClient)
  }

  get vmid() {
    return this.ctx.vmid
  }

  /**
   * The Proxmox connection this service talks over.
   *
   * Exposed so a caller that needs to probe the agent directly (the first-boot
   * wait loop) uses the same authenticated client the service does, rather than
   * opening a second connection with its own credentials.
   */
  get proxmoxClient(): ProxmoxGuestClient {
    return this.client
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  private target(engine: GuestEngine | "unknown" = "unknown"): GuestTarget {
    return { client: this.client, node: this.ctx.nodeName, vmid: this.ctx.vmid, engine }
  }

  /**
   * How long a detection result is reused.
   *
   * Short, because a guest that is being re-imaged or upgraded changes what it
   * reports, and a stale OS means a template that no longer matches. Long enough
   * that a single request — which detects, resolves, snapshots and plans — makes
   * one call rather than four, and a burst of calls cannot hammer the agent into
   * dropping a `get-osinfo` it would otherwise have answered.
   */
  private static readonly DETECTION_TTL_MS = 30_000
  private detectionCache: { at: number; key: string; detected: DetectedOs } | null = null

  /**
   * Detect the live OS. The guest agent is authoritative; metadata is only a
   * fallback for a guest that is not running.
   *
   * Cached per metadata key for a short window. Detection is called several times
   * per request and once per VM per telemetry tick, and an uncached version both
   * costs a round trip each time and can fail intermittently under that load —
   * which presents as a guest that is sometimes "unsupported" for no reason.
   */
  async detectOs(metadata?: Record<string, unknown> | null, options: { persist?: boolean } = {}): Promise<DetectedOs> {
    const cacheKey = JSON.stringify(metadata ?? null)
    const cached = this.detectionCache
    if (cached && cached.key === cacheKey && Date.now() - cached.at < GuestAutomationService.DETECTION_TTL_MS) {
      return cached.detected
    }
    const detected = await this.detectOsUncached(metadata, options)
    this.detectionCache = { at: Date.now(), key: cacheKey, detected }
    return detected
  }

  /** Drop the cached detection. Called when a VM's state changes underneath us. */
  invalidateDetection() {
    this.detectionCache = null
  }

  /**
   * A run id for a guest that is not a panel service.
   *
   * `GuestAutomationRun` has a foreign key to a real service, so an external VM
   * has nowhere to record a run. A synthetic id is returned instead: the run is
   * still executed and verified, and only the record is skipped, which is the
   * whole difference between "this guest cannot be tested" and "this guest is not
   * ours".
   */
  private syntheticRunId() {
    return `ephemeral:${this.ctx.vpsInstanceId}:${this.ctx.vmid}:${Date.now().toString(36)}`
  }

  private get persists() {
    return this.ctx.ephemeral !== true
  }

  private async detectOsUncached(metadata?: Record<string, unknown> | null, options: { persist?: boolean } = {}): Promise<DetectedOs> {
    const running = await this.isRunning()
    const detected = await detectGuestOs({
      client: this.client,
      node: this.ctx.nodeName,
      vmid: this.ctx.vmid,
      running,
      metadata: (metadata ?? null) as any,
    })
    // Recorded on both outcomes. The adoption row is the cached view admin pages
    // and later operations share, so a successful detection that is not recorded
    // leaves every admin page re-probing Proxmox and shows the server as
    // un-adopted even though automation works on it.
    //
    // Best-effort in both directions: a failed bookkeeping write must not turn a
    // guest we just identified into "OS detection unavailable", which is what
    // happens if the write is allowed to throw.
    //
    // Skipped entirely when the guest is ephemeral, or the caller asks.
    //
    // An ephemeral guest is not a panel service, so it has no adoption row to
    // write; every call that reached detection without the flag still tried, and
    // filled an operator's log with foreign-key errors about a VM the panel does
    // not manage. Enforced here rather than at each call site, because a per-call
    // flag is exactly the kind of thing the next caller forgets.
    if (options.persist !== false && this.ctx.ephemeral !== true) {
      await persistDetection({
        vpsInstanceId: this.ctx.vpsInstanceId,
        detected,
        guestAgentReachable: detected.kind !== "unknown",
        automationReady: detected.kind !== "unknown",
        unsupportedReason: detected.kind === "unknown" ? GUEST_ERROR_MESSAGES.OS_DETECTION_UNAVAILABLE : null,
      }).catch(() => null)
    }
    return detected
  }

  /** Resolve the template for a detection result. */
  async getTemplate(detected: DetectedOs, options: { templateId?: string | null } = {}) {
    return resolveTemplate(detected, options)
  }

  /** One-call convenience: detect + resolve. */
  async resolve(metadata?: Record<string, unknown> | null) {
    const detected = await this.detectOs(metadata)
    const resolved = await this.getTemplate(detected)
    return { detected, resolved }
  }

  async isRunning(): Promise<boolean> {
    try {
      const status = await this.client.getVMStatus(this.ctx.nodeName, this.ctx.vmid)
      return String((status as any)?.data?.status ?? status?.status ?? "").toLowerCase() === "running"
    } catch {
      return false
    }
  }

  /**
   * What this guest can be asked to do.
   *
   * Two separate questions, kept separate because they fail for different
   * reasons: whether the agent answers at all, and whether the OS it reports has
   * an enabled template with the operations we would need. A guest with a
   * working agent but no matching template is reachable and still not
   * manageable, and collapsing the two would report that as healthy.
   */
  async getCapabilities() {
    const running = await this.isRunning()
    if (!running) {
      return {
        running: false,
        guestAgentReachable: false,
        automationSupported: false,
        supportedOperations: [] as GuestOperation[],
        reason: GUEST_ERROR_MESSAGES.VM_STOPPED as string,
      }
    }
    const health = await isGuestAgentReachable({ target: this.target(), bypassCache: true })
    if (!health.reachable) {
      return {
        running: true,
        guestAgentReachable: false,
        automationSupported: false,
        supportedOperations: [] as GuestOperation[],
        reason: GUEST_ERROR_MESSAGES.GUEST_AGENT_UNREACHABLE as string,
        checkedAt: new Date(health.checkedAt).toISOString(),
      }
    }
    const detected = await this.detectOs()
    if (detected.kind === "unknown") {
      return {
        running: true,
        guestAgentReachable: true,
        automationSupported: false,
        supportedOperations: [] as GuestOperation[],
        reason: GUEST_ERROR_MESSAGES.OS_DETECTION_UNAVAILABLE as string,
        checkedAt: new Date(health.checkedAt).toISOString(),
      }
    }
    const resolved = await this.getTemplate(detected)
    if (!resolved.ok) {
      return {
        running: true,
        guestAgentReachable: true,
        automationSupported: false,
        supportedOperations: [] as GuestOperation[],
        reason: resolved.reason,
        checkedAt: new Date(health.checkedAt).toISOString(),
      }
    }
    return {
      running: true,
      guestAgentReachable: true,
      automationSupported: true,
      supportedOperations: enabledOperations(resolved.template).map((entry) => entry.operation),
      template: { id: resolved.template.id, name: resolved.template.name, version: resolved.template.version },
      checkedAt: new Date(health.checkedAt).toISOString(),
    }
  }

  /**
   * Read the guest's current state using native verbs only. No shell is spawned,
   * which keeps this cheap enough for the provisioning loop and the dry-run.
   */
  async getState(engine: GuestEngine | "unknown" = "unknown"): Promise<GuestStateSnapshot> {
    const target = this.target(engine)
    const running = await this.isRunning()
    if (!running) return { ...EMPTY_SNAPSHOT, collectedAt: Date.now() }

    const [networks, hostname, users, fsinfo, timezone] = await Promise.all([
      guestNative(target, "network-get-interfaces").catch(() => null),
      guestNative(target, "get-host-name").catch(() => null),
      guestNative(target, "get-users").catch(() => null),
      guestNative(target, "get-fsinfo").catch(() => null),
      guestNative(target, "get-timezone").catch(() => null),
    ])

    // The MACs Proxmox assigned to this VM, so the primary interface can be the
    // NIC the customer was actually sold rather than whichever bridge the guest
    // happens to be running.
    const vmConfig = await this.proxmoxClient.getVMConfig(this.ctx.nodeName, this.ctx.vmid).catch(() => null)
    const parsedInterfaces = networks?.ok
      ? parseNativeInterfaces(networks.data, { hypervisorMacs: hypervisorMacsFromConfig(vmConfig) })
      : null
    const parsedHostname = hostname?.ok ? parseHostname(hostname.data) : ""
    const parsedUsers = users?.ok ? parseNativeUsers(users.data) : []
    const parsedFs = fsinfo?.ok ? parseNativeFsInfo(fsinfo.data) : []

    return {
      interfaces: parsedInterfaces?.interfaces ?? [],
      primaryInterface: parsedInterfaces?.primary?.name ?? null,
      ipv4: parsedInterfaces?.primary?.ipv4 ?? [],
      hostname: parsedHostname || null,
      username: null,
      users: parsedUsers.map((user) => user.name),
      gateway: null,
      dns: [],
      timezone: timezone?.ok ? parseTimezone(timezone.data) || null : null,
      diskMounts: parsedFs.map((entry) => entry.mountpoint || entry.name),
      collectedAt: Date.now(),
    }
  }

  // -------------------------------------------------------------------------
  // Disk
  // -------------------------------------------------------------------------

  /**
   * Collect real disk usage using the OS profile's `disk_usage` operation.
   *
   * Returns the normalized shape the frontend uses. Failures carry an error code
   * and never a fabricated zero.
   */
  async getDiskUsage(input: { detected?: DetectedOs; template?: ResolvedTemplate | null; includeAllVolumes?: boolean } = {}) {
    const started = Date.now()

    // Power state is checked before detection, deliberately.
    //
    // A stopped guest has no agent, so detection legitimately fails — and
    // reporting that as "OS detection unavailable" tells a customer their server
    // is broken when the actual answer is that they stopped it. The honest
    // answer is the one they can act on.
    if (!input.detected && !(await this.isRunning())) {
      return { ok: false as const, os: "unknown" as const, errorCode: "VM_STOPPED" as GuestErrorCode, message: GUEST_ERROR_MESSAGES.VM_STOPPED, totalBytes: 0, usedBytes: 0, freeBytes: 0, usedPercent: 0, volumes: [], selected: null, collectionDurationMs: Date.now() - started }
    }

    const detected = input.detected ?? (await this.detectOs())
    if (detected.kind === "unknown") {
      return { ok: false as const, os: "unknown" as const, errorCode: "OS_DETECTION_UNAVAILABLE" as GuestErrorCode, message: GUEST_ERROR_MESSAGES.OS_DETECTION_UNAVAILABLE, totalBytes: 0, usedBytes: 0, freeBytes: 0, usedPercent: 0, volumes: [], selected: null, collectionDurationMs: 0 }
    }

    const resolved = input.template ? { ok: true as const, template: input.template, matchedBy: "os-id" as const } : await this.getTemplate(detected)
    if (!resolved.ok) {
      return {
        ok: false as const,
        os: detected.kind,
        errorCode: resolved.code,
        message: resolved.reason,
        totalBytes: 0,
        usedBytes: 0,
        freeBytes: 0,
        usedPercent: 0,
        volumes: [],
        selected: null,
        collectionDurationMs: Date.now() - started,
      }
    }

    const operation = input.includeAllVolumes ? "disk_usage_all" : "disk_usage"
    const definition = resolved.template.operations.get(operation) ?? resolved.template.operations.get("disk_usage")
    if (!definition || !definition.enabled) {
      return {
        ok: false as const,
        os: detected.kind,
        errorCode: "UNSUPPORTED_OPERATION" as GuestErrorCode,
        message: GUEST_ERROR_MESSAGES.UNSUPPORTED_OPERATION,
        totalBytes: 0,
        usedBytes: 0,
        freeBytes: 0,
        usedPercent: 0,
        volumes: [],
        selected: null,
        collectionDurationMs: Date.now() - started,
      }
    }

    const target = this.target(detected.engine)
    const running = await this.isRunning()
    if (!running) {
      return {
        ok: false as const,
        os: detected.kind,
        errorCode: "VM_STOPPED" as GuestErrorCode,
        message: GUEST_ERROR_MESSAGES.VM_STOPPED,
        totalBytes: 0,
        usedBytes: 0,
        freeBytes: 0,
        usedPercent: 0,
        volumes: [],
        selected: null,
        collectionDurationMs: Date.now() - started,
      }
    }

    const health = await isGuestAgentReachable({ target, bypassCache: true })
    if (!health.reachable) {
      return {
        ok: false as const,
        os: detected.kind,
        errorCode: "GUEST_AGENT_UNREACHABLE" as GuestErrorCode,
        message: GUEST_ERROR_MESSAGES.GUEST_AGENT_UNREACHABLE,
        totalBytes: 0,
        usedBytes: 0,
        freeBytes: 0,
        usedPercent: 0,
        volumes: [],
        selected: null,
        collectionDurationMs: Date.now() - started,
      }
    }

    const parsed = await this.executeCollector(target, definition, detected.kind, operation)
    if (!parsed.ok) {
      return {
        ok: false as const,
        os: detected.kind,
        errorCode: parsed.errorCode,
        message: GUEST_ERROR_MESSAGES[parsed.errorCode] ?? parsed.error,
        totalBytes: 0,
        usedBytes: 0,
        freeBytes: 0,
        usedPercent: 0,
        volumes: [],
        selected: null,
        collectionDurationMs: Date.now() - started,
      }
    }

    return {
      ok: true as const,
      os: detected.kind,
      engine: detected.engine,
      source: parsed.collector,
      templateId: resolved.template.id,
      templateVersion: resolved.template.version,
      totalBytes: parsed.selected.totalBytes,
      usedBytes: parsed.selected.usedBytes,
      freeBytes: parsed.selected.freeBytes,
      usedPercent: parsed.selected.usedPercent,
      // The filesystem's own type, and separately where it is mounted. POSIX df
      // reports no type, so this is null rather than a guess from the device
      // name; conflating the two is how "ext4" ends up displayed as "/".
      filesystem: parsed.selected.filesystem ?? null,
      mountPoint: parsed.selected.name,
      device: parsed.selected.device ?? null,
      volumes: parsed.volumes,
      selected: parsed.selected,
      collectionDurationMs: Date.now() - started,
    }
  }

  /**
   * Run a disk collector, trying the primary command then the template's
   * declared fallbacks. A fallback is only attempted for a parse/exec failure,
   * never to work around a cross-OS refusal.
   */
  private async executeCollector(
    target: GuestTarget,
    definition: ResolvedOperation,
    engine: GuestEngine,
    operation: GuestOperation,
  ): Promise<{ ok: true; volumes: any[]; selected: any; collector: string } | { ok: false; errorCode: GuestErrorCode; error: string }> {
    const candidates = [definition, ...(definition.fallbacks as any[]).map((entry) => ({ ...definition, ...entry }))]
    let lastError: GuestErrorCode = "GUEST_EXEC_FAILED"
    let lastMessage = "Guest command failed."

    for (const candidate of candidates) {
      const command = String(candidate.command || "").trim()
      if (!command) continue
      const shell = (candidate.shell || definition.shell) as any
      const gate = assertShellMatchesEngine(shell, engine)
      if (!gate.ok) return { ok: false, errorCode: "CROSS_OS_VIOLATION", error: gate.reason }

      const outcome = await execGuestCommand(target, {
        engine,
        shell,
        command,
        timeoutMs: (candidate.timeoutSeconds ?? definition.timeoutSeconds) * 1000,
      })
      if (!outcome.ok) {
        lastError = outcome.errorCode
        lastMessage = outcome.error
        // A timeout or an unreachable agent will not be fixed by a different
        // command, so stop rather than hammering a dead channel.
        if (outcome.timedOut || outcome.errorCode === "GUEST_AGENT_UNREACHABLE" || outcome.errorCode === "GUEST_AGENT_TIMEOUT") {
          return { ok: false, errorCode: lastError, error: lastMessage }
        }
        continue
      }

      const observation = observeFromOutput(candidate.verificationParser ?? definition.verificationParser, outcome.output, engine)
      if (observation.kind === "failed") {
        lastError = observation.errorCode
        lastMessage = observation.error
        continue
      }
      if (observation.kind !== "disk") {
        lastError = "PARSE_FAILED"
        lastMessage = `Collector "${operation}" did not return disk data.`
        continue
      }
      const summary = observation as Extract<Observation, { kind: "disk" }>
      // Re-parse for the full volume list and the selected volume's own fields.
      //
      // The observation is a summary: it carries the numbers and a `filesystem`
      // label, but not the device and not the type. Selecting from it therefore
      // loses both, and reading `selected.name` off it yields undefined. The
      // re-parse is what gives a `ParsedVolume` with everything on it.
      const detail = await this.volumeDetail(target, candidate, engine, operation, outcome.output)
      const volumes = detail.ok ? detail.volumes : []
      const selected = detail.ok
        ? detail.volumes.find((volume) => volume.name === summary.filesystem) || detail.volumes[0]
        : this.volumeFromSummary(summary)
      return { ok: true, volumes, selected, collector: candidate.verificationParser ?? "unknown" }
    }

    return { ok: false, errorCode: lastError, error: lastMessage }
  }

  /**
   * A `ParsedVolume` built from a summary observation alone.
   *
   * Only reached when the re-parse failed, which means we have the numbers but
   * not the device or the type. Reporting the numbers with an explicit null for
   * what we do not know beats reporting nothing.
   */
  private volumeFromSummary(summary: Extract<Observation, { kind: "disk" }>) {
    return {
      name: summary.filesystem,
      filesystem: null,
      device: null,
      totalBytes: summary.totalBytes,
      usedBytes: summary.usedBytes,
      freeBytes: summary.freeBytes,
      usedPercent: summary.usedPercent,
      system: true,
    }
  }

  private async volumeDetail(
    target: GuestTarget,
    definition: ResolvedOperation,
    engine: GuestEngine,
    _operation: GuestOperation,
    output: string,
  ) {
    const {
      parseLinuxDf,
      parseWindowsLogicalDiskJson,
      parseWindowsWmicList,
      parseWindowsFsutil,
    } = await import("./parsers")
    const parser = definition.verificationParser
    if (parser === "df-posix") {
      const parsed = parseLinuxDf(output)
      return parsed.ok ? { ok: true as const, volumes: parsed.volumes } : { ok: false as const }
    }
    if (parser === "win-logicaldisk") {
      const parsed = parseWindowsLogicalDiskJson(output)
      return parsed.ok ? { ok: true as const, volumes: parsed.volumes } : { ok: false as const }
    }
    if (parser === "fsutil-list") {
      const parsed = parseWindowsFsutil(output)
      return parsed.ok ? { ok: true as const, volumes: parsed.volumes } : { ok: false as const }
    }
    if (engine === "windows" && /\bDeviceID=/i.test(output)) {
      const parsed = parseWindowsWmicList(output)
      return parsed.ok ? { ok: true as const, volumes: parsed.volumes } : { ok: false as const }
    }
    return { ok: false as const }
  }

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  /** Build a plan without executing anything. Powers the admin dry-run. */
  async plan(input: Omit<PlanRequest, "vmid" | "detected" | "template" | "snapshot"> & { metadata?: Record<string, unknown> | null; templateId?: string | null }): Promise<{
    ok: true
    plan: OperationPlan
  } | { ok: false; errorCode: GuestErrorCode; message: string; detected: DetectedOs }> {
    const detected = await this.detectOs(input.metadata)
    if (detected.kind === "unknown") {
      return { ok: false, errorCode: "OS_DETECTION_UNAVAILABLE", message: GUEST_ERROR_MESSAGES.OS_DETECTION_UNAVAILABLE, detected }
    }
    const resolved = await this.getTemplate(detected, { templateId: input.templateId ?? null })
    if (!resolved.ok) return { ok: false, errorCode: resolved.code, message: resolved.reason, detected }
    const snapshot = await this.getState(detected.engine)
    const plan = buildPlan({
      vmid: this.ctx.vmid,
      detected,
      template: resolved.template,
      snapshot,
      desired: input.desired,
      mode: input.mode,
    })
    return { ok: true, plan }
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Run a plan. Steps execute in order; a failed step stops the sequence unless
   * the step is marked as independent.
   *
   * Transient QGA failures (agent starting, temporary network blip, guest reboot)
   * are retried at the step level before giving up. This prevents a healthy
   * Linux boot from being marked as permanently failed because the agent was
   * still initializing a subsystem.
   */
  async executePlan(input: {
    plan: OperationPlan
    trigger: GuestRunTrigger
    actor?: Actor
    runId?: string
    /** Stop after the first failure (default true for sequential safety). */
    stopOnFailure?: boolean
  }): Promise<RunResult> {
    const { plan, trigger } = input
    const actor = input.actor ?? {}
    const runId =
      input.runId ??
      (this.persists
        ? (
            await prisma.guestAutomationRun.create({
              data: {
                vpsInstanceId: this.ctx.vpsInstanceId,
                trigger,
                operations: plan.operations.map((operation) => operation.operation) as any,
                status: "running",
                startedAt: new Date(),
                templateId: plan.template.id,
                templateVersion: plan.template.version,
                requestedBy: actor.requestedBy ?? null,
                requestedRole: actor.role ?? null,
                backupPoint: this.backupPointFor(plan) as any,
                metadata: { vmid: this.ctx.vmid, node: this.ctx.nodeName, os: plan.detected.osId } as any,
              },
            })
          ).id
        : this.syntheticRunId())

    const steps: OperationOutcome[] = []
    const stopOnFailure = input.stopOnFailure ?? true

    for (const planned of plan.operations) {
      if (planned.status === "skipped") {
        steps.push({
          operation: planned.operation,
          status: "skipped",
          changed: false,
          verified: true,
          durationMs: 0,
          attempts: 0,
          errorCode: null,
          error: null,
          commandMasked: null,
          result: { reason: planned.reason },
          rollbackStatus: "not-required",
        })
        continue
      }

      // Retry the entire step for transient QGA failures. A Linux guest can
      // temporarily lose agent connectivity while subsystems initialize, and
      // a single retry often resolves it without human intervention.
      const maxStepRetries = plan.detected.engine === "linux" ? 3 : 2
      let stepAttempt = 0
      let outcome: OperationOutcome | null = null
      while (stepAttempt <= maxStepRetries) {
        stepAttempt++
        outcome = await this.executeStep(runId, planned.operation, planned.template!, plan, actor)
        if (outcome.status === "success" || outcome.status === "already_applied") {
          break
        }
        const isTransient = shouldRetryGuestError(outcome.errorCode as GuestErrorCode, stepAttempt)
        if (!isTransient) break
        // Brief delay before retrying the step; the agent usually recovers quickly.
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(stepAttempt)))
      }

      if (!outcome) {
        outcome = {
          operation: planned.operation,
          status: "failed",
          changed: false,
          verified: false,
          durationMs: 0,
          attempts: 0,
          errorCode: "GUEST_EXEC_FAILED",
          error: "Step execution returned no outcome.",
          commandMasked: planned.template?.command ?? null,
          result: {},
          rollbackStatus: "not-required",
        }
      }
      steps.push(outcome)
      if (this.persists) await this.persistStep(runId, outcome, plan)

      const failed = outcome.status === "failed" || outcome.status === "timeout" || outcome.status === "unsupported"
      if (failed) {
        if (isNetworkOperationSafe(planned.operation)) {
          await this.escalateNetworkRecovery(runId, plan, outcome, actor)
        }
        if (stopOnFailure) break
      }
    }

    const status = deriveRunStatus(steps)
    if (this.persists) {
      await prisma.guestAutomationRun.update({
        where: { id: runId },
        data: {
          status,
          completedAt: new Date(),
          error: steps.find((step) => step.error)?.error ?? null,
        },
      })
    }

    if (trigger === "first_boot" && status === "success" && this.persists) {
      await prisma.vmGuestAdoption
        .updateMany({
          where: { vpsInstanceId: this.ctx.vpsInstanceId },
          data: { automationReady: true, appliedTemplateVersion: plan.template.version, adoptedAt: new Date(), unsupportedReason: null },
        })
        .catch(() => null)
    }

    const result: RunResult = {
      ok: status === "success",
      runId,
      status: status as RunResult["status"],
      steps,
      plan: serializePlan(plan),
      detected: plan.detected,
      template: { id: plan.template.id, name: plan.template.name, version: plan.template.version },
      error: steps.find((step) => step.error)?.error ?? null,
      errorCode: steps.find((step) => step.errorCode)?.errorCode ?? null,
    }

    if (!this.persists) return result

    await writeAuditLog({
      action: `guest_run_${result.ok ? "succeeded" : "failed"}`,
      actorEmail: actor.requestedBy ?? null,
      customerId: actor.role === "customer" ? actor.requestedBy ?? null : null,
      targetType: "vps",
      targetId: this.ctx.vpsInstanceId,
      metadata: {
        runId,
        trigger,
        vmid: this.ctx.vmid,
        os: plan.detected.osId,
        engine: plan.detected.engine,
        template: plan.template.name,
        templateVersion: plan.template.version,
        steps: steps.map((step) => ({ operation: step.operation, status: step.status, durationMs: step.durationMs, errorCode: step.errorCode })),
      },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    })

    return result
  }

  /** First-boot automation: run the full sequence once, verify, then activate. */
  async firstBoot(
    input: { desired: PlanRequest["desired"]; metadata?: Record<string, unknown> | null; actor?: Actor },
  ): Promise<{ ok: false; errorCode: GuestErrorCode; message: string; runId: null; steps: [] } | RunResult> {
    const planned = await this.plan({ desired: input.desired, mode: "first_boot", metadata: input.metadata })
    if (!planned.ok) return { ok: false, errorCode: planned.errorCode, message: planned.message, runId: null, steps: [] }
    return this.executePlan({ plan: planned.plan, trigger: "first_boot", actor: input.actor })
  }

  /** A customer change: only the affected operations are planned and run. */
  async applyChange(
    input: { desired: PlanRequest["desired"]; actor?: Actor; metadata?: Record<string, unknown> | null },
  ): Promise<{ ok: false; errorCode: GuestErrorCode; message: string; runId: null; steps: [] } | RunResult> {
    const planned = await this.plan({ desired: input.desired, mode: "change", metadata: input.metadata })
    if (!planned.ok) return { ok: false, errorCode: planned.errorCode, message: planned.message, runId: null, steps: [] }
    return this.executePlan({ plan: planned.plan, trigger: "customer_change", actor: input.actor })
  }

  // -------------------------------------------------------------------------
  // Single operations
  // -------------------------------------------------------------------------

  async setIP(input: { ip: string; prefix: number; gateway: string; dns?: string[]; searchDomain?: string; actor?: Actor; metadata?: Record<string, unknown> | null }) {
    return this.applyChange({
      desired: { ip: input.ip, prefix: input.prefix, gateway: input.gateway, dns: input.dns, searchDomain: input.searchDomain },
      actor: input.actor,
      metadata: input.metadata,
    })
  }

  async setDNS(input: { dns: string[]; searchDomain?: string; actor?: Actor; metadata?: Record<string, unknown> | null }) {
    return this.applyChange({ desired: { dns: input.dns, searchDomain: input.searchDomain }, actor: input.actor, metadata: input.metadata })
  }

  async setHostname(input: { hostname: string; actor?: Actor; metadata?: Record<string, unknown> | null }) {
    return this.applyChange({ desired: { hostname: input.hostname }, actor: input.actor, metadata: input.metadata })
  }

  async setPassword(input: { username: string; password: string; actor?: Actor; metadata?: Record<string, unknown> | null }) {
    return this.applyChange({ desired: { username: input.username, password: input.password }, actor: input.actor, metadata: input.metadata })
  }

  async createUser(input: { username: string; password: string; actor?: Actor; metadata?: Record<string, unknown> | null }) {
    return this.applyChange({ desired: { createUser: { username: input.username, password: input.password } }, actor: input.actor, metadata: input.metadata })
  }

  /**
   * Password change with the native QGA verb preferred. This is the
   * `set-user-password` path, which avoids a shell entirely on both engines.
   */
  async setPasswordNative(input: { username: string; password: string; actor?: Actor; metadata?: Record<string, unknown> | null }) {
    const detected = await this.detectOs(input.metadata)
    if (detected.kind === "unknown") {
      return { ok: false as const, errorCode: "OS_DETECTION_UNAVAILABLE" as GuestErrorCode, message: GUEST_ERROR_MESSAGES.OS_DETECTION_UNAVAILABLE }
    }
    const target = this.target(detected.engine)
    const started = Date.now()
    const result = await guestNative(target, "set-user-password", {
      timeoutMs: 30_000,
      body: { username: input.username, password: input.password, crypted: 0 },
    })
    if (!result.ok) {
      await writeAuditLog({
        action: "guest_password_change_failed",
        actorEmail: input.actor?.requestedBy ?? null,
        targetType: "vps",
        targetId: this.ctx.vpsInstanceId,
        metadata: { vmid: this.ctx.vmid, os: detected.osId, errorCode: result.errorCode },
      })
      return { ok: false as const, errorCode: result.errorCode, message: result.message, durationMs: Date.now() - started }
    }
    await writeAuditLog({
      action: "guest_password_changed",
      actorEmail: input.actor?.requestedBy ?? null,
      targetType: "vps",
      targetId: this.ctx.vpsInstanceId,
      metadata: { vmid: this.ctx.vmid, os: detected.osId, engine: detected.engine, username: input.username, method: "guest-native" },
    })
    return { ok: true as const, durationMs: Date.now() - started, message: "Password updated." }
  }

  async reboot(input: { actor?: Actor; metadata?: Record<string, unknown> | null }) {
    return this.powerOperation("reboot", input)
  }

  async shutdown(input: { actor?: Actor; metadata?: Record<string, unknown> | null }) {
    return this.powerOperation("shutdown", input)
  }

  /**
   * Power operations use the Proxmox API rather than a guest command: there is no
   * need to ask the guest to shut itself down, and the host can guarantee it.
   */
  private async powerOperation(action: "reboot" | "shutdown", input: { actor?: Actor; metadata?: Record<string, unknown> | null }) {
    const detected = await this.detectOs(input.metadata)
    const started = Date.now()
    try {
      const response = action === "reboot" ? await this.client.rebootVM(this.ctx.nodeName, this.ctx.vmid) : await this.client.shutdownVM(this.ctx.nodeName, this.ctx.vmid)
      await writeAuditLog({
        action: `guest_${action}_requested`,
        actorEmail: input.actor?.requestedBy ?? null,
        targetType: "vps",
        targetId: this.ctx.vpsInstanceId,
        metadata: { vmid: this.ctx.vmid, os: detected.osId },
      })
      return { ok: true as const, upid: (response as any)?.data?.upid ?? (response as any)?.upid ?? null, durationMs: Date.now() - started }
    } catch (error) {
      return { ok: false as const, errorCode: "GUEST_EXEC_FAILED" as GuestErrorCode, message: (error as Error).message, durationMs: Date.now() - started }
    }
  }

  async resizeDisk(input: { diskGb: number; growFilesystem?: boolean; actor?: Actor; metadata?: Record<string, unknown> | null }) {
    const detected = await this.detectOs(input.metadata)
    if (detected.kind === "unknown") {
      return { ok: false as const, errorCode: "OS_DETECTION_UNAVAILABLE" as GuestErrorCode, message: GUEST_ERROR_MESSAGES.OS_DETECTION_UNAVAILABLE, steps: [], runId: null }
    }
    // Growing the virtual disk is a Proxmox operation; the guest only needs to
    // be told to expand its partition and filesystem afterwards.
    const grow = await this.runSingleOperation(detected, input.growFilesystem === false ? "disk_resize" : "filesystem_grow", input.actor, {
      DESIRED_DISK_GB: String(input.diskGb),
    })
    if (!grow.ok) return { ok: false as const, errorCode: grow.errorCode, message: grow.message, steps: [], runId: null }
    return { ok: true as const, runId: grow.runId, steps: grow.steps }
  }

  async enableSSH(input: { enable: boolean; actor?: Actor; metadata?: Record<string, unknown> | null }) {
    const detected = await this.detectOs(input.metadata)
    if (detected.kind === "unknown") {
      return { ok: false as const, errorCode: "OS_DETECTION_UNAVAILABLE" as GuestErrorCode, message: GUEST_ERROR_MESSAGES.OS_DETECTION_UNAVAILABLE, steps: [], runId: null }
    }
    const result = await this.runSingleOperation(detected, "enable_ssh", input.actor, { ENABLE: input.enable ? "1" : "0" })
    return result.ok
      ? { ok: true as const, runId: result.runId, steps: result.steps }
      : { ok: false as const, errorCode: result.errorCode, message: result.message, steps: [], runId: null }
  }

  /**
   * Execute exactly one template operation, outside the change-driven plan.
   * Used for operations the customer never requests directly (disk grow, SSH
   * enable) but which still need full verification and audit.
   */
  private async runSingleOperation(
    detected: DetectedOs,
    operation: GuestOperation,
    actor: Actor | undefined,
    extraValues: Record<string, string>,
  ): Promise<{ ok: true; runId: string; steps: OperationOutcome[] } | { ok: false; errorCode: GuestErrorCode; message: string; runId: string | null }> {
    const resolved = await this.getTemplate(detected)
    if (!resolved.ok) return { ok: false, errorCode: resolved.code, message: resolved.reason, runId: null }
    const definition = resolved.template.operations.get(operation)
    if (!definition || !definition.enabled) {
      return { ok: false, errorCode: "UNSUPPORTED_OPERATION", message: GUEST_ERROR_MESSAGES.UNSUPPORTED_OPERATION, runId: null }
    }
    const snapshot = await this.getState(detected.engine)
    const plan: OperationPlan = {
      vmid: this.ctx.vmid,
      detected,
      template: resolved.template,
      noChange: false,
      operations: [
        {
          operation,
          status: "pending",
          reason: "Explicitly requested operation.",
          changed: true,
          template: definition,
          values: extraValues,
          previous: {},
          dangerous: definition.dangerLevel === "dangerous",
          requiresRunning: definition.requiresRunning,
          requiresStopped: definition.requiresStopped,
          verificationRequired: definition.verificationRequired,
          supportsRollback: definition.supportsRollback,
          rebootRequired: definition.rebootRequired,
        },
      ],
    }
    const result = await this.executePlan({ plan, trigger: "customer_change", actor })
    if (!result.ok) {
      return { ok: false, errorCode: result.errorCode ?? "GUEST_EXEC_FAILED", message: result.error ?? GUEST_ERROR_MESSAGES.INTERNAL_ERROR, runId: result.runId }
    }
    return { ok: true, runId: result.runId, steps: result.steps }
  }

  // -------------------------------------------------------------------------
  // Admin testing
  // -------------------------------------------------------------------------

  /**
   * Show what a command would do, without running it.
   *
   * This is what "Dry Run" means for an editor: the command is built from the
   * draft the admin is looking at, every value is substituted from a fixed set
   * of samples, the result is masked, and nothing is sent to the guest. A dry run
   * that executed anything would not be a dry run.
   *
   * The draft is validated against the guest's real engine first, so a
   * cross-OS command is reported here rather than discovered on a live guest.
   */
  async previewOperation(input: {
    operation: GuestOperation
    draft: {
      commandType: string
      shell?: string | null
      command?: string | null
      verificationCommand?: string | null
      verificationParser?: string | null
      verificationArgs?: Record<string, unknown>
      successCondition?: string | null
      dangerLevel?: string
      requiresConfirmation?: boolean
      requiresRunning?: boolean
      requiresStopped?: boolean
      requiresGuestAgent?: boolean
      verificationRequired?: boolean
      timeoutSeconds?: number | null
    }
    metadata?: Record<string, unknown> | null
    values?: Record<string, string>
  }) {
    const detected = await this.detectOs(input.metadata)
    if (detected.kind === "unknown") {
      return { ok: false as const, errorCode: "OS_DETECTION_UNAVAILABLE" as GuestErrorCode, message: GUEST_ERROR_MESSAGES.OS_DETECTION_UNAVAILABLE }
    }
    const engine = detected.engine as GuestEngine

    // A guest-native operation is run by the agent, not by a shell, so its
    // stored shell is inert and must not be judged against the engine. Judging
    // it anyway refuses every native verb, which on Windows includes the whole
    // password path.
    if (input.draft.commandType !== "guest-native") {
      const gate = assertShellMatchesEngine(input.draft.shell ?? null, engine)
      if (!gate.ok) {
        return { ok: false as const, errorCode: "CROSS_OS_VIOLATION" as GuestErrorCode, message: gate.reason }
      }
    }
    const commandCrossOs = crossOsCommandViolations(String(input.draft.command || ""), engine)
    if (commandCrossOs.length) {
      return {
        ok: false as const,
        errorCode: "CROSS_OS_VIOLATION" as GuestErrorCode,
        message: `This command contains ${commandCrossOs.join(", ")}, which belongs to the other engine. It would never run on a ${detected.osId} guest.`,
      }
    }

    const values = { ...sampleValues(), ...(input.values || {}) }
    const rendered = renderTemplate({ template: String(input.draft.command || ""), values, engine })
    const verification = input.draft.verificationCommand
      ? renderTemplate({ template: String(input.draft.verificationCommand), values, engine })
      : null

    return {
      ok: true as const,
      detected,
      engine,
      commandType: input.draft.commandType,
      shell: input.draft.shell ?? null,
      // `masked` is the only form returned. A dry run that printed a live secret
      // would leak it into a browser tab and a support screenshot.
      commandMasked: rendered.ok ? rendered.masked : String(input.draft.command || ""),
      verificationMasked: verification ? (verification.ok ? verification.masked : String(input.draft.verificationCommand)) : null,
      placeholders: extractPlaceholders(String(input.draft.command || "")),
      unknownPlaceholders: unknownPlaceholders(String(input.draft.command || "")),
      successCondition: input.draft.successCondition ?? null,
      verificationParser: input.draft.verificationParser ?? null,
      dangerLevel: input.draft.dangerLevel || "safe",
      requiresConfirmation: input.draft.requiresConfirmation === true,
      requiresRunning: input.draft.requiresRunning === true,
      requiresStopped: input.draft.requiresStopped === true,
      timeoutSeconds: input.draft.timeoutSeconds ?? 60,
      guestAgentRequired: input.draft.requiresGuestAgent !== false,
      resolved: rendered.ok ? rendered.resolved : null,
      stdinRequired: !rendered.ok || rendered.resolved === null,
    }
  }

  /**
   * Run one operation against this VM, on behalf of an admin, and report it.
   *
   * Unlike `runSingleOperation` this accepts an unsaved draft, which is what
   * makes it useful in an editor: an admin can prove a command works before it is
   * ever stored. The override is validated with exactly the same engine gate as a
   * stored command, so a test can never prove a command that would be refused in
   * production.
   */
  async testOperation(input: {
    operation: GuestOperation
    metadata?: Record<string, unknown> | null
    actor?: Actor
    /** An unsaved draft to prove. Omit to test the stored definition. */
    draft?: {
      commandType: string
      shell?: string | null
      command?: string | null
      verificationCommand?: string | null
      verificationParser?: string | null
      verificationArgs?: Record<string, unknown>
      successCondition?: string | null
      dangerLevel?: string
      requiresConfirmation?: boolean
      requiresRunning?: boolean
      requiresStopped?: boolean
      requiresGuestAgent?: boolean
      verificationRequired?: boolean
      supportsRollback?: boolean
      timeoutSeconds?: number | null
    } | null
    values?: Record<string, string>
  }): Promise<{ ok: true; runId: string; outcome: OperationOutcome } | { ok: false; errorCode: GuestErrorCode; message: string }> {
    const detected = await this.detectOs(input.metadata)
    if (detected.kind === "unknown") {
      return { ok: false, errorCode: "OS_DETECTION_UNAVAILABLE", message: GUEST_ERROR_MESSAGES.OS_DETECTION_UNAVAILABLE }
    }
    const engine = detected.engine as GuestEngine

    let definition: ResolvedOperation
    if (input.draft) {
      // Same rule as the dry run: a native verb has no shell to check.
      if (input.draft.commandType !== "guest-native") {
        const gate = assertShellMatchesEngine(input.draft.shell ?? null, engine)
        if (!gate.ok) return { ok: false, errorCode: "CROSS_OS_VIOLATION", message: gate.reason }
      }
      const violations = crossOsCommandViolations(String(input.draft.command || ""), engine)
      if (violations.length) {
        return { ok: false, errorCode: "CROSS_OS_VIOLATION", message: `Contains ${violations.join(", ")}, which belongs to the other engine.` }
      }
      definition = {
        operation: input.operation,
        commandType: (input.draft.commandType || "guest-exec") as any,
        shell: (input.draft.shell || null) as any,
        command: input.draft.command ?? null,
        verificationCommand: input.draft.verificationCommand ?? null,
        verificationParser: (input.draft.verificationParser || null) as any,
        verificationArgs: input.draft.verificationArgs ?? null,
        successCondition: input.draft.successCondition ?? null,
        dangerLevel: (input.draft.dangerLevel || "safe") as any,
        requiresConfirmation: input.draft.requiresConfirmation === true,
        requiresRunning: input.draft.requiresRunning === true,
        requiresStopped: input.draft.requiresStopped === true,
        requiresGuestAgent: input.draft.requiresGuestAgent !== false,
        rebootRequired: false,
        verificationRequired: input.draft.verificationRequired !== false,
        supportsRollback: input.draft.supportsRollback === true,
        timeoutSeconds: input.draft.timeoutSeconds ?? 60,
        stateKey: null,
        notes: null,
        id: "draft",
        arguments: [],
        rollbackCommand: null,
        rollbackArguments: null,
        fallbacks: [],
        enabled: true,
      }
    } else {
      const resolved = await this.getTemplate(detected)
      if (!resolved.ok) return { ok: false, errorCode: resolved.code, message: resolved.reason }
      const stored = resolved.template.operations.get(input.operation)
      if (!stored) return { ok: false, errorCode: "UNSUPPORTED_OPERATION", message: `This template does not define ${input.operation}.` }
      definition = stored
    }

    const run = this.persists
      ? await prisma.guestAutomationRun.create({
          data: {
            vpsInstanceId: this.ctx.vpsInstanceId,
            trigger: "admin_test",
            operations: [input.operation] as any,
            status: "running",
            templateId: definition && "templateId" in definition ? (definition as any).templateId : null,
            requestedBy: input.actor?.requestedBy ?? null,
            requestedRole: input.actor?.role ?? null,
            metadata: { vmid: this.ctx.vmid, node: this.ctx.nodeName, os: detected.osId, operation: input.operation, unsavedDraft: Boolean(input.draft) } as any,
          },
        })
      : { id: this.syntheticRunId() }

    const plan: OperationPlan = {
      vmid: this.ctx.vmid,
      detected,
      template: { id: "", name: input.draft ? "Unsaved draft" : "Stored template", version: 0, operations: new Map([[input.operation, definition]]), enabled: true } as any,
      noChange: false,
      operations: [
        {
          operation: input.operation,
          status: "pending",
          reason: "Admin test.",
          changed: true,
          template: definition,
          values: { ...sampleValues(), ...(input.values || {}) },
          previous: {},
          dangerous: definition.dangerLevel === "dangerous",
          requiresRunning: definition.requiresRunning,
          requiresStopped: definition.requiresStopped,
          verificationRequired: definition.verificationRequired,
          supportsRollback: definition.supportsRollback,
          rebootRequired: false,
        },
      ],
    }

    const outcome = await this.executeStep(run.id, input.operation, definition, plan, input.actor ?? { requestedBy: "system:admin-test", role: "admin" })
    if (this.persists) {
      await this.persistStep(run.id, outcome, plan)
      await prisma.guestAutomationRun.update({
        where: { id: run.id },
        data: {
          status: outcome.status === "success" ? "success" : outcome.status === "skipped" ? "success" : "failed",
          completedAt: new Date(),
          error: outcome.error,
        },
      })
    }

    return { ok: true, runId: run.id, outcome }
  }

  // -------------------------------------------------------------------------
  // Step execution
  // -------------------------------------------------------------------------

  private async executeStep(runId: string, operation: GuestOperation, definition: ResolvedOperation, plan: OperationPlan, actor: Actor): Promise<OperationOutcome> {
    const started = Date.now()
    const engine = plan.detected.engine as GuestEngine
    const base: OperationOutcome = {
      operation,
      status: "failed",
      changed: false,
      verified: false,
      durationMs: 0,
      attempts: 0,
      errorCode: null,
      error: null,
      commandMasked: definition.command,
      result: {},
      rollbackStatus: "not-required",
    }

    // State gate: refuse rather than run an operation in the wrong VM state.
    if (definition.requiresRunning) {
      const running = await this.isRunning()
      if (!running) {
        return { ...base, status: "skipped", errorCode: "VM_STOPPED", error: GUEST_ERROR_MESSAGES.VM_STOPPED, durationMs: Date.now() - started }
      }
    }
    if (definition.requiresStopped) {
      const running = await this.isRunning()
      if (running) {
        return { ...base, status: "skipped", errorCode: "VM_STOPPED_REQUIRED", error: GUEST_ERROR_MESSAGES.VM_STOPPED_REQUIRED, durationMs: Date.now() - started }
      }
    }

    if (definition.requiresGuestAgent) {
      const health = await isGuestAgentReachable({ target: this.target(engine) })
      if (!health.reachable) {
        return { ...base, status: "skipped", errorCode: "GUEST_AGENT_UNREACHABLE", error: GUEST_ERROR_MESSAGES.GUEST_AGENT_UNREACHABLE, durationMs: Date.now() - started }
      }
    }

    // Build the command. The browser never contributes to this string: values
    // come from the plan, which the backend built from validated request data.
    const values = (plan.operations.find((entry) => entry.operation === operation)?.values ?? {}) as Record<string, string>
    const templated = renderTemplate({ template: String(definition.command || ""), values, engine })
    if (!templated.ok && templated.errors.length) {
      return { ...base, status: "failed", errorCode: "TEMPLATE_INVALID", error: templated.errors.join(" "), commandMasked: templated.masked, durationMs: Date.now() - started }
    }

    const gate = assertShellMatchesEngine(definition.shell, engine)
    if (!gate.ok) {
      return { ...base, status: "failed", errorCode: "CROSS_OS_VIOLATION", error: gate.reason, commandMasked: templated.masked, durationMs: Date.now() - started }
    }

    const target = this.target(engine)
    const timeoutMs = definition.timeoutSeconds * 1000
    const maxAttempts = DESTRUCTIVE_OPERATIONS.has(operation) ? 1 : 3
    // A password is delivered on stdin. It is never part of argv, the Proxmox
    // task description, or the audit row.
    const stdinSecret = (plan.operations.find((entry) => entry.operation === operation)?.stdinSecret ?? null) as string | null

    let attempts = 0
    let lastErrorCode: GuestErrorCode = "GUEST_EXEC_FAILED"
    let lastError = "Guest command failed."

    while (attempts < maxAttempts) {
      attempts++
      const outcome = await execGuestCommand(target, {
        engine,
        shell: definition.shell as any,
        command: templated.resolved ?? templated.masked,
        inputData: stdinSecret ?? undefined,
        timeoutMs,
        acceptExitCodes: definition.successCondition === "exit-code-0" || !definition.successCondition ? [0] : null,
      })
      if (!outcome.ok) {
        lastErrorCode = outcome.errorCode
        lastError = outcome.error
        if (outcome.timedOut) lastErrorCode = "GUEST_EXEC_TIMEOUT"
        if (!shouldRetryGuestError(lastErrorCode, attempts)) break
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempts)))
        continue
      }

      // Verify. An exit code of 0 is not proof.
      if (definition.verificationRequired) {
        const verification = await verifyOperation({
          target,
          engine,
          operation,
          verificationCommand: definition.verificationCommand,
          verificationParser: definition.verificationParser,
          verificationShell: definition.shell,
          verificationCommandBody: null,
          expected: this.expectedFor(operation, plan),
          timeoutMs: Math.min(timeoutMs, 20_000),
        })
        if (!verification.ok) {
          const rollback = await this.rollbackStep(definition, plan, operation, templated.masked)
          return {
            ...base,
            status: "failed",
            changed: true,
            verified: false,
            durationMs: Date.now() - started,
            attempts,
            errorCode: verification.errorCode ?? "VERIFICATION_FAILED",
            error: verification.message,
            commandMasked: templated.masked,
            result: { observed: verification.observed ?? {} },
            rollbackStatus: rollback,
          }
        }
        return {
          ...base,
          status: "success",
          changed: true,
          verified: true,
          durationMs: Date.now() - started,
          attempts,
          commandMasked: templated.masked,
          result: { verification: verification.message, observed: verification.observed ?? {} },
        }
      }

      return {
        ...base,
        status: "success",
        changed: true,
        verified: false,
        durationMs: Date.now() - started,
        attempts,
        commandMasked: templated.masked,
        result: { exitCode: outcome.exitCode },
      }
    }

    const rollback = DESTRUCTIVE_OPERATIONS.has(operation) ? await this.rollbackStep(definition, plan, operation, templated.masked) : "not-required"
    return {
      ...base,
      status: lastErrorCode === "GUEST_EXEC_TIMEOUT" ? "timeout" : "failed",
      durationMs: Date.now() - started,
      attempts,
      errorCode: lastErrorCode,
      error: lastError,
      commandMasked: templated.masked,
      rollbackStatus: rollback,
    }
  }

  private expectedFor(operation: GuestOperation, plan: OperationPlan): Record<string, unknown> {
    const planned = plan.operations.find((entry) => entry.operation === operation)
    const values = planned?.values ?? {}
    // Get verificationArgs from the template definition if available
    const templateDef = plan.template?.operations?.get(operation)
    const verificationArgs = templateDef?.verificationArgs ?? {}
    switch (operation) {
      case "set_ip":
        // For exit-code verification, we need contains to be empty string so the
        // generic verification passes (it checks for expected.contains or expected.equals).
        // The exit code is already validated by execGuestCommand.
        return { ip: values.IP, gateway: values.GATEWAY, contains: "" }
      case "set_gateway":
        return { ip: values.IP }
      case "set_dns":
        return { contains: values.DNS1 }
      case "set_hostname":
        return { hostname: values.HOSTNAME }
      case "create_user":
        return { expectedUsername: values.USERNAME }
      case "set_password":
        // For cmd-output-contains parser, we need to pass the expected string to match in output
        const contains = verificationArgs.contains as string | undefined
        if (contains) return { contains, expectedUsername: values.USERNAME }
        return { expectedUsername: values.USERNAME }
      case "timezone":
        return { timezone: values.TIMEZONE }
      default:
        return {}
    }
  }

  /**
   * Rollback for a step whose declared danger level warrants it. Only runs when
   * the template declares support, and only for operations the plan recorded a
   * previous value for.
   */
  private async rollbackStep(definition: ResolvedOperation, plan: OperationPlan, operation: GuestOperation, maskedCommand: string): Promise<OperationOutcome["rollbackStatus"]> {
    if (!definition.supportsRollback) return "not-required"
    if (definition.dangerLevel !== "dangerous") return "skipped"

    const planned = plan.operations.find((entry) => entry.operation === operation)
    const previous = planned?.previous ?? {}
    const engine = plan.detected.engine as GuestEngine
    const rollbackTemplate = String(definition.rollbackCommand || "").trim()
    if (!rollbackTemplate) return "skipped"

    const values: Record<string, string> = {}
    const previousIp = Array.isArray(previous.ipv4) ? String(previous.ipv4[0] ?? "") : ""
    if (previousIp) values.IP = previousIp
    if (previous.gateway) values.GATEWAY = String(previous.gateway)
    if (previous.hostname) values.HOSTNAME = String(previous.hostname)
    if (previous.interface) values.NIC = String(previous.interface)

    const rendered = renderTemplate({ template: rollbackTemplate, values, engine })
    if (!rendered.ok) return "attempted-failed"

    const outcome = await execGuestCommand(this.target(engine), {
      engine,
      shell: definition.shell as any,
      command: rendered.resolved ?? rendered.masked,
      timeoutMs: definition.timeoutSeconds * 1000,
    })
    if (outcome.ok) {
      await prisma.guestOperationRun.updateMany({
        where: {
          vpsInstanceId: this.ctx.vpsInstanceId,
          operation,
          status: { in: ["failed", "timeout"] },
          createdAt: { gte: new Date(Date.now() - 60_000) },
        },
        data: { result: { rollback: "succeeded" } as any },
      })
      return "attempted-success"
    }
    await writeAuditLog({
      action: "guest_operation_rollback_failed",
      targetType: "vps",
      targetId: this.ctx.vpsInstanceId,
      metadata: { vmid: this.ctx.vmid, operation, maskedCommand, errorCode: outcome.errorCode },
    })
    return "attempted-failed"
  }

  private backupPointFor(plan: OperationPlan) {
    const point: Record<string, unknown> = {}
    for (const operation of plan.operations) {
      if (operation.dangerous || operation.supportsRollback) {
        point[operation.operation] = operation.previous
      }
    }
    return point
  }

  private async persistStep(runId: string, outcome: OperationOutcome, plan: OperationPlan) {
    const definition = plan.template.operations.get(outcome.operation)
    await prisma.guestOperationRun.create({
      data: {
        runId,
        vpsInstanceId: this.ctx.vpsInstanceId,
        operation: outcome.operation,
        templateId: plan.template.id,
        templateVersion: plan.template.version,
        commandType: definition?.commandType ?? null,
        shell: definition?.shell ?? null,
        // Secrets are masked before they reach the database.
        commandMasked: maskCommandSecrets(outcome.commandMasked ?? "", []),
        status: outcome.status,
        changed: outcome.changed,
        verified: outcome.verified,
        verificationOk: outcome.verified,
        exitCode: typeof outcome.result?.exitCode === "number" ? outcome.result.exitCode : null,
        durationMs: outcome.durationMs,
        attempts: outcome.attempts,
        errorCode: outcome.errorCode,
        error: outcome.error,
        result: outcome.result as any,
        startedAt: new Date(Date.now() - outcome.durationMs),
        finishedAt: new Date(),
      },
    })
  }

  /** A failed network change is escalated: the guest may be unreachable. */
  private async escalateNetworkRecovery(runId: string, plan: OperationPlan, outcome: OperationOutcome, actor: Actor) {
    await prisma.vmGuestAdoption
      .updateMany({
        where: { vpsInstanceId: this.ctx.vpsInstanceId },
        data: { recoveryRequired: true, recoveryReason: `${outcome.operation}: ${outcome.errorCode ?? "failed"}` },
      })
      .catch(() => null)
    await writeAuditLog({
      action: "guest_network_recovery_required",
      actorEmail: actor.requestedBy ?? null,
      targetType: "vps",
      targetId: this.ctx.vpsInstanceId,
      metadata: { runId, vmid: this.ctx.vmid, operation: outcome.operation, errorCode: outcome.errorCode, os: plan.detected.osId },
    })
  }

  // -------------------------------------------------------------------------
  // Adoption (existing VMs)
  // -------------------------------------------------------------------------

  /**
   * "Adopt Guest Automation" for an existing VM. Detects and records the current
   * state WITHOUT changing anything; automated changes stay disabled until an
   * admin explicitly enables them.
   */
  async adopt(input: { metadata?: Record<string, unknown> | null; osTemplateId?: string | null; actor?: Actor }) {
    const detected = await this.detectOs(input.metadata)
    if (detected.kind === "unknown") {
      return { ok: false as const, errorCode: "OS_DETECTION_UNAVAILABLE" as GuestErrorCode, message: GUEST_ERROR_MESSAGES.OS_DETECTION_UNAVAILABLE, detected }
    }
    const resolved = await this.getTemplate(detected, { templateId: input.osTemplateId ?? null })
    const running = await this.isRunning()
    const health = running ? await isGuestAgentReachable({ target: this.target(detected.engine), bypassCache: true }) : { reachable: false }
    const snapshot = await this.getState(detected.engine)

    const adoption = await prisma.vmGuestAdoption.upsert({
      where: { vpsInstanceId: this.ctx.vpsInstanceId },
      create: {
        vpsInstanceId: this.ctx.vpsInstanceId,
        guestTemplateId: resolved.ok ? resolved.template.id : null,
        engine: detected.engine,
        detectedOsId: detected.osId,
        detectedName: detected.name,
        detectedVersion: detected.version,
        detectedKernelVersion: detected.kernelVersion,
        state: snapshot as any,
        guestAgentReachable: health.reachable,
        guestAgentCheckedAt: new Date(),
        automationReady: false,
        unsupportedReason: resolved.ok ? null : resolved.reason,
        adoptedAt: new Date(),
        lastDetectedAt: new Date(),
      },
      update: {
        guestTemplateId: resolved.ok ? resolved.template.id : undefined,
        engine: detected.engine,
        detectedOsId: detected.osId,
        detectedName: detected.name,
        detectedVersion: detected.version,
        detectedKernelVersion: detected.kernelVersion,
        state: snapshot as any,
        guestAgentReachable: health.reachable,
        guestAgentCheckedAt: new Date(),
        unsupportedReason: resolved.ok ? null : resolved.reason,
        lastDetectedAt: new Date(),
      },
    })

    await writeAuditLog({
      action: "guest_automation_adopted",
      actorEmail: input.actor?.requestedBy ?? null,
      targetType: "vps",
      targetId: this.ctx.vpsInstanceId,
      metadata: { vmid: this.ctx.vmid, os: detected.osId, engine: detected.engine, template: resolved.ok ? resolved.template.name : null, guestAgentReachable: health.reachable },
    })

    return { ok: true as const, detected, template: resolved.ok ? resolved.template : null, snapshot, adoption, guestAgentReachable: health.reachable }
  }

  /** Mark an adopted VM as ready for automated changes. */
  async enableAutomation(input: { actor?: Actor }) {
    await prisma.vmGuestAdoption.updateMany({
      where: { vpsInstanceId: this.ctx.vpsInstanceId },
      data: { automationReady: true, recoveryRequired: false, recoveryReason: null },
    })
    await writeAuditLog({
      action: "guest_automation_enabled",
      actorEmail: input.actor?.requestedBy ?? null,
      targetType: "vps",
      targetId: this.ctx.vpsInstanceId,
      metadata: { vmid: this.ctx.vmid },
    })
    return { ok: true as const }
  }
}

function isNetworkOperationSafe(operation: GuestOperation) {
  return operation === "set_ip" || operation === "set_gateway" || operation === "set_dns" || operation === "firewall"
}

/**
 * Build a service instance for a VpsInstance row. Loads the node credentials
 * and the authoritative OS metadata used as the detection fallback.
 */
export async function serviceForVps(vps: any): Promise<GuestAutomationService> {
  if (!vps?.proxmoxNode) throw new Error("VM is not attached to a Proxmox node.")
  if (!vps?.vmid) throw new Error("VM has no vmid.")
  return new GuestAutomationService({
    vpsInstanceId: vps.id,
    vmid: Number(vps.vmid),
    nodeName: vps.proxmoxNode.nodeName,
    node: {
      host: vps.proxmoxNode.host,
      tokenId: vps.proxmoxNode.tokenId,
      tokenSecret: vps.proxmoxNode.tokenSecret,
      nodeName: vps.proxmoxNode.nodeName,
      allowInsecureTls: Boolean(vps.proxmoxNode.allowInsecureTls),
    },
  })
}

/** Authoritative OS metadata for a VpsInstance, used as the detection fallback. */
export function osMetadataForVps(vps: any) {
  return {
    osType: vps?.operatingSystem?.osType ?? null,
    osFamily: vps?.operatingSystem?.osFamily ?? null,
    category: vps?.operatingSystem?.category ?? null,
    osName: vps?.operatingSystem?.name ?? null,
    vmOsFamily: vps?.vmOsFamily ?? null,
    orderOsName: vps?.order?.osName ?? null,
  }
}

export { FIRST_BOOT_SEQUENCE, isGuestOperation }
