/**
 * Thin, engine-aware wrapper over the Proxmox QEMU Guest Agent (`qm guest`).
 *
 * Why this file exists:
 *  - Native-first. A native `qm guest cmd` verb is always preferred over a
 *    shell command. `exec()` refuses to run at all unless the resolved engine
 *    agrees with the requested shell, so a Windows command can never reach a
 *    Linux guest (or the reverse).
 *  - Secrets travel out-of-band. A command that carries a password is sent as
 *    `input-data` on stdin rather than embedded in argv, so the secret never
 *    appears in the process table, the Proxmox task log, or our audit rows.
 *  - Timeouts are explicit. Every exec is bounded; a hung guest is killed and
 *    reported as `GUEST_EXEC_TIMEOUT`, which the caller can back off from.
 */

import {
  GUEST_READ_ONLY_VERBS,
  GUEST_ERROR_MESSAGES,
  assertShellMatchesEngine,
  isGuestNativeVerb,
  type GuestEngine,
  type GuestErrorCode,
  type GuestShell,
} from "./constants"

export type ProxmoxGuestClient = {
  /** Public generic request passthrough used for native guest verbs. */
  request?(path: string, method?: "GET" | "POST" | "PUT" | "DELETE", body?: unknown, timeoutMs?: number): Promise<any>
  /** Preferred: a purpose-built native-verb method. */
  guestCmd?(node: string, vmid: number, verb: string, body?: Record<string, any>, timeoutMs?: number): Promise<any>
  execVMGuestCommandWithInput(
    node: string,
    vmid: number,
    command: string[],
    inputData?: string,
    timeoutMs?: number,
  ): Promise<{ pid: number }>
  getVMGuestExecStatus(node: string, vmid: number, pid: number, timeoutMs?: number): Promise<any>
  pingVMGuestAgent(node: string, vmid: number, timeoutMs?: number): Promise<any>
  [key: string]: any
}

export type GuestTarget = {
  client: ProxmoxGuestClient
  node: string
  vmid: number
  engine: GuestEngine | "unknown"
}

export type GuestFailure = {
  ok: false
  errorCode: GuestErrorCode
  error: string
  /** Customer-safe message (no Proxmox vocabulary, no stack trace). */
  message: string
}

export type GuestNativeResult<T = any> = {
  ok: true
  data: T
  durationMs: number
  verb: string
}

export type GuestExecResult = {
  ok: true
  exitCode: number
  stdout: string
  stderr: string
  output: string
  pid: number
  durationMs: number
  timedOut: false
}

export type GuestExecOutcome =
  | GuestExecResult
  | {
      ok: false
      errorCode: GuestErrorCode
      error: string
      message: string
      timedOut: boolean
      durationMs: number
    }

function failure(errorCode: GuestErrorCode, error: unknown): GuestFailure {
  const detail = error instanceof Error ? error.message : String(error ?? "")
  return {
    ok: false,
    errorCode,
    error: detail || GUEST_ERROR_MESSAGES[errorCode],
    message: GUEST_ERROR_MESSAGES[errorCode],
  }
}

function nowMs() {
  return Date.now()
}

/** Extract readable text from any Proxmox agent payload shape. */
export function agentText(payload: any): string {
  if (payload == null) return ""
  if (typeof payload === "string") return payload
  if (Array.isArray(payload)) return payload.map((entry) => agentText(entry)).join("\n")
  if (typeof payload === "object") {
    if (typeof payload["out-data"] === "string") return payload["out-data"]
    if (typeof payload["out-data"] !== "undefined") return agentText(payload["out-data"])
    if (typeof payload["out"] === "string") return payload["out"]
    if (typeof payload["return"] === "string") return payload["return"]
    if (typeof payload["error"] === "string") return payload["error"]
    try {
      return JSON.stringify(payload)
    } catch {
      return String(payload)
    }
  }
  return String(payload)
}

export function agentExitCode(payload: any): number | null {
  if (!payload || typeof payload !== "object") return null
  if (typeof payload["exitcode"] === "number") return payload["exitcode"]
  if (typeof payload["exit-code"] === "number") return payload["exit-code"]
  if (typeof payload["return"] === "number") return payload["return"]
  return null
}

function agentErrorText(payload: any): string {
  if (!payload || typeof payload !== "object") return ""
  const candidates = [payload["errmsg"], payload["error"], payload["message"]]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate
  }
  return ""
}

/** True when the error indicates the agent channel itself is missing. */
export function isAgentUnavailableError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error ?? "")) + " " + (error as any)?.proxmoxMessage
  return /agent.*(not running|not available|not enabled|no qemu guest agent)|QEMU guest agent|500.*agent|unable to find|connection.*reset/i.test(
    text,
  )
}

export function isAgentTimeoutError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error ?? "")) + " " + (error as any)?.code
  return /timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(text)
}

// ---------------------------------------------------------------------------
// Native `qm guest cmd` verbs
// ---------------------------------------------------------------------------

/**
 * Guard for native verbs. A verb that is not engine-neutral (none today, but
 * the gate stays so future verbs cannot be added unsafely) is rejected up front.
 */
export function assertNativeVerbAllowed(verb: string, engine: GuestEngine | "unknown"): { ok: true } | GuestFailure {
  if (!isGuestNativeVerb(verb)) {
    return failure("UNSUPPORTED_OPERATION", `Unknown guest verb "${verb}".`)
  }
  if (!GUEST_READ_ONLY_VERBS.has(verb) && engine === "unknown") {
    return failure("OS_DETECTION_UNAVAILABLE", "OS detection unavailable.")
  }
  return { ok: true }
}

/**
 * Invoke a native guest verb. `get-osinfo`, `network-get-interfaces` and
 * friends need no shell, so this is the safe default path.
 */
export async function guestNative<T = any>(
  target: GuestTarget,
  verb: string,
  options: { timeoutMs?: number; body?: Record<string, unknown> } = {},
): Promise<GuestNativeResult<T> | GuestFailure> {
  const allowed = assertNativeVerbAllowed(verb, target.engine)
  if (!("ok" in allowed) || allowed.ok === false) return allowed as GuestFailure

  const started = nowMs()
  try {
    const timeoutMs = options.timeoutMs
    const body = options.body && Object.keys(options.body).length ? options.body : undefined
    const raw =
      typeof target.client.guestCmd === "function"
        ? await target.client.guestCmd(target.node, target.vmid, verb, body, timeoutMs)
        : typeof target.client.request === "function"
          ? await target.client.request(
              `/nodes/${encodeURIComponent(target.node)}/qemu/${target.vmid}/agent/${verb}`,
              body ? "POST" : "GET",
              body,
              timeoutMs,
            )
          : await (target.client as any)[`getVMGuest${verb}`]?.(target.node, target.vmid)
    // Unwrap both layers the agent API uses. Every `agent/<verb>` response is
    // `{ data: { result: <payload> } }`, so unwrapping only `data` hands every
    // parser a `{ result: ... }` wrapper instead of the payload — which is how
    // `get-osinfo` reading `id` at the top level sees nothing and every guest
    // classifies as unknown.
    const data = (raw as any)?.data ?? raw
    const payload = (data && typeof data === "object" && !Array.isArray(data) && "result" in (data as any))
      ? (data as any).result
      : data
    const reported = agentErrorText(payload)
    if (reported) {
      return failure(/not running|not available/i.test(reported) ? "GUEST_AGENT_UNREACHABLE" : "GUEST_EXEC_FAILED", reported)
    }
    return { ok: true, data: payload as T, durationMs: nowMs() - started, verb }
  } catch (error) {
    if (isAgentTimeoutError(error)) return failure("GUEST_AGENT_TIMEOUT", error)
    if (isAgentUnavailableError(error)) return failure("GUEST_AGENT_UNREACHABLE", error)
    return failure("GUEST_EXEC_FAILED", error)
  }
}

export async function guestPing(target: GuestTarget, timeoutMs?: number) {
  const started = nowMs()
  try {
    await target.client.pingVMGuestAgent(target.node, target.vmid, timeoutMs)
    return { ok: true as const, reachable: true, durationMs: nowMs() - started }
  } catch (error) {
    if (isAgentTimeoutError(error)) {
      return { ok: false as const, reachable: false, timedOut: true, errorCode: "GUEST_AGENT_TIMEOUT" as GuestErrorCode, error: (error as Error).message }
    }
    return {
      ok: false as const,
      reachable: false,
      timedOut: false,
      errorCode: isAgentUnavailableError(error) ? ("GUEST_AGENT_UNREACHABLE" as GuestErrorCode) : ("GUEST_AGENT_DISABLED" as GuestErrorCode),
      error: (error as Error).message,
    }
  }
}

/** Alias kept for call sites that read better as a verb-first name. */
export const pingVMGuestAgent = guestPing

// ---------------------------------------------------------------------------
// guest-exec
// ---------------------------------------------------------------------------

/** Shell -> argv prefix. Only the matching engine's prefix is ever produced. */
export function shellArgv(shell: GuestShell, command: string): string[] {
  switch (shell) {
    case "linux-sh":
      return ["sh", "-c", command]
    case "linux-bash":
      return ["bash", "-lc", command]
    case "windows-powershell":
      return ["powershell", "-NoProfile", "-NonInteractive", "-Command", command]
    case "windows-cmd":
      return ["cmd", "/c", command]
    case "windows-netsh":
      return ["netsh", "-c", command]
    default:
      return ["sh", "-c", command]
  }
}

/**
 * Build argv for a template command, cross-checking engine and shell. Returns a
 * refusal instead of a command when the pairing is wrong.
 */
export function buildGuestCommand(input: {
  engine: GuestEngine | "unknown"
  shell: GuestShell
  command: string
}): { ok: true; argv: string[] } | GuestFailure {
  const gate = assertShellMatchesEngine(input.shell, input.engine)
  if (!gate.ok) return failure(gate.code, gate.reason)
  const command = String(input.command || "").trim()
  if (!command) return failure("TEMPLATE_INVALID", "Template command is empty.")
  return { ok: true, argv: shellArgv(input.shell, command) }
}

type ExecInput = {
  engine: GuestEngine | "unknown"
  shell: GuestShell
  command: string
  /** Sent on stdin, never in argv. Used for password/user payloads. */
  inputData?: string
  timeoutMs?: number
  pollIntervalMs?: number
  /**
   * Exit code is ignored when the operation defines a custom success
   * condition. `null` means "any exit code is acceptable".
   */
  acceptExitCodes?: number[] | null
}

const DEFAULT_POLL_MS = 250

/**
 * Run one bounded guest-exec.
 *
 * Polls `exec-status` until the guest reports an exit code or the timeout
 * elapses. On timeout the process is signalled for termination so no orphan is
 * left running in the guest.
 */
export async function execGuestCommand(target: GuestTarget, input: ExecInput): Promise<GuestExecOutcome> {
  const built = buildGuestCommand(input)
  const started = nowMs()
  if (!built.ok) {
    return {
      ok: false,
      errorCode: built.errorCode,
      error: built.error,
      message: built.message,
      timedOut: false,
      durationMs: 0,
    }
  }

  // Windows guests start a PowerShell host per exec and routinely need 10-40s
  // to produce output through the QEMU guest agent; a 30s budget times out on a
  // healthy Windows guest and looks exactly like a broken guest. Linux stays
  // short so a hung shell is still bounded.
  const defaultTimeoutMs = target.engine === "windows" ? 90_000 : 30_000
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? defaultTimeoutMs)
  const pollIntervalMs = Math.max(100, input.pollIntervalMs ?? DEFAULT_POLL_MS)

  let pid: number
  try {
    const started_ = await target.client.execVMGuestCommandWithInput(
      target.node,
      target.vmid,
      built.argv,
      input.inputData,
      timeoutMs,
    )
    pid = Number(started_?.pid)
    if (!Number.isFinite(pid) || pid <= 0) {
      return {
        ok: false,
        errorCode: "GUEST_EXEC_FAILED",
        error: "Guest did not return a process id.",
        message: GUEST_ERROR_MESSAGES.GUEST_EXEC_FAILED,
        timedOut: false,
        durationMs: nowMs() - started,
      }
    }
  } catch (error) {
    if (isAgentTimeoutError(error)) {
      return { ok: false, errorCode: "GUEST_EXEC_TIMEOUT", error: (error as Error).message, message: GUEST_ERROR_MESSAGES.GUEST_EXEC_TIMEOUT, timedOut: true, durationMs: nowMs() - started }
    }
    if (isAgentUnavailableError(error)) {
      return { ok: false, errorCode: "GUEST_AGENT_UNREACHABLE", error: (error as Error).message, message: GUEST_ERROR_MESSAGES.GUEST_AGENT_UNREACHABLE, timedOut: false, durationMs: nowMs() - started }
    }
    return { ok: false, errorCode: "GUEST_EXEC_FAILED", error: (error as Error).message, message: GUEST_ERROR_MESSAGES.GUEST_EXEC_FAILED, timedOut: false, durationMs: nowMs() - started }
  }

  const deadline = started + timeoutMs
  for (;;) {
    let status: any
    try {
      status = await target.client.getVMGuestExecStatus(target.node, target.vmid, pid, Math.min(5_000, Math.max(500, deadline - nowMs())))
    } catch (error) {
      if (isAgentTimeoutError(error)) {
        await killGuestProcess(target, pid).catch(() => undefined)
        return { ok: false, errorCode: "GUEST_EXEC_TIMEOUT", error: (error as Error).message, message: GUEST_ERROR_MESSAGES.GUEST_EXEC_TIMEOUT, timedOut: true, durationMs: nowMs() - started }
      }
      if (isAgentUnavailableError(error)) {
        return { ok: false, errorCode: "GUEST_AGENT_UNREACHABLE", error: (error as Error).message, message: GUEST_ERROR_MESSAGES.GUEST_AGENT_UNREACHABLE, timedOut: false, durationMs: nowMs() - started }
      }
      // A transient status poll failure is not fatal on its own; keep polling
      // until the deadline so short guest hiccups do not fail an operation.
      if (nowMs() >= deadline) {
        return { ok: false, errorCode: "GUEST_EXEC_TIMEOUT", error: (error as Error).message, message: GUEST_ERROR_MESSAGES.GUEST_EXEC_TIMEOUT, timedOut: true, durationMs: nowMs() - started }
      }
      await sleep(Math.min(pollIntervalMs, Math.max(50, deadline - nowMs())))
      continue
    }

    const payload = (status as any)?.data ?? status
    const reportedError = agentErrorText(payload)
    if (reportedError) {
      if (/not running|not available/i.test(reportedError)) {
        return { ok: false, errorCode: "GUEST_AGENT_UNREACHABLE", error: reportedError, message: GUEST_ERROR_MESSAGES.GUEST_AGENT_UNREACHABLE, timedOut: false, durationMs: nowMs() - started }
      }
      return { ok: false, errorCode: "GUEST_EXEC_FAILED", error: reportedError, message: GUEST_ERROR_MESSAGES.GUEST_EXEC_FAILED, timedOut: false, durationMs: nowMs() - started }
    }

    if (payload && (payload.exited === true || typeof payload["exitcode"] === "number")) {
      const exitCode = agentExitCode(payload)
      const outData = payload["out-data"]
      const outText = typeof outData === "string" ? outData : agentText(outData)
      const errText = typeof payload["err-data"] === "string" ? payload["err-data"] : ""
      const accept = input.acceptExitCodes
      if (accept && !accept.includes(exitCode ?? -1)) {
        return {
          ok: false,
          errorCode: "GUEST_EXEC_FAILED",
          error: `exit code ${exitCode}: ${(errText || outText || "").slice(0, 500)}`,
          message: GUEST_ERROR_MESSAGES.GUEST_EXEC_FAILED,
          timedOut: false,
          durationMs: nowMs() - started,
        }
      }
      return {
        ok: true,
        exitCode: exitCode ?? 0,
        stdout: outText,
        stderr: errText,
        output: `${outText}${errText ? `\n${errText}` : ""}`,
        pid,
        durationMs: nowMs() - started,
        timedOut: false,
      }
    }

    if (nowMs() >= deadline) {
      await killGuestProcess(target, pid).catch(() => undefined)
      return {
        ok: false,
        errorCode: "GUEST_EXEC_TIMEOUT",
        error: `guest exec pid ${pid} exceeded ${timeoutMs}ms`,
        message: GUEST_ERROR_MESSAGES.GUEST_EXEC_TIMEOUT,
        timedOut: true,
        durationMs: nowMs() - started,
      }
    }
    await sleep(Math.min(pollIntervalMs, Math.max(50, deadline - nowMs())))
  }
}

/** Best-effort termination so a timed-out exec never becomes an orphan. */
export async function killGuestProcess(target: GuestTarget, pid: number) {
  const built = buildGuestCommand({ engine: target.engine, shell: target.engine === "windows" ? "windows-powershell" : "linux-sh", command: "kill -TERM {{PID}} 2>/dev/null || true" })
  if (!built.ok) return
  const argv = built.argv.map((part) => part.replace("{{PID}}", String(pid)))
  try {
    const started = await target.client.execVMGuestCommandWithInput(target.node, target.vmid, argv, undefined, 5_000)
    const child = Number(started?.pid)
    if (Number.isFinite(child) && child > 0) {
      // Do not block on the kill itself; the caller's deadline already passed.
      target.client.getVMGuestExecStatus(target.node, target.vmid, child, 2_000).catch(() => undefined)
    }
  } catch {
    // Killing is best effort; the guest may already be gone.
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retry policy for transient guest faults. Deliberately NOT applied to
 * dangerous filesystem operations — those must be re-run deliberately.
 */
export const GUEST_RETRY_DELAYS_MS = [2_000, 5_000, 15_000]

const RETRYABLE_ERROR_CODES: ReadonlySet<GuestErrorCode> = new Set([
  "GUEST_AGENT_TIMEOUT",
  "GUEST_AGENT_UNREACHABLE",
  "GUEST_EXEC_TIMEOUT",
])

/** Only transient agent faults are retried. Parse/verify failures are not. */
export function shouldRetryGuestError(errorCode: GuestErrorCode, attempt: number): boolean {
  if (attempt >= GUEST_RETRY_DELAYS_MS.length) return false
  return RETRYABLE_ERROR_CODES.has(errorCode)
}

export function retryDelayMs(attempt: number): number {
  return GUEST_RETRY_DELAYS_MS[Math.min(attempt, GUEST_RETRY_DELAYS_MS.length - 1)]
}
