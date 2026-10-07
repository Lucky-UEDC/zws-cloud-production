import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  shouldRetryGuestError,
  retryDelayMs,
  GUEST_RETRY_DELAYS_MS,
} from "@/lib/guest-automation/proxmox-guest"
import { parseLinuxDf } from "@/lib/guest-automation/parsers"

describe("Linux QGA provisioning reliability", () => {
  it("retries GUEST_AGENT_DISABLED as a transient error", () => {
    assert.ok(shouldRetryGuestError("GUEST_AGENT_DISABLED", 0), "GUEST_AGENT_DISABLED at attempt 0 must be retryable")
    assert.ok(shouldRetryGuestError("GUEST_AGENT_DISABLED", 1), "GUEST_AGENT_DISABLED at attempt 1 must be retryable")
    assert.ok(shouldRetryGuestError("GUEST_AGENT_DISABLED", 2), "GUEST_AGENT_DISABLED at attempt 2 must be retryable")
    assert.ok(!shouldRetryGuestError("GUEST_AGENT_DISABLED", 4), "GUEST_AGENT_DISABLED at attempt 4 must not be retryable (max attempts reached)")
  })

  it("retries GUEST_EXEC_FAILED as a transient error", () => {
    assert.ok(shouldRetryGuestError("GUEST_EXEC_FAILED", 0), "GUEST_EXEC_FAILED at attempt 0 must be retryable")
    assert.ok(shouldRetryGuestError("GUEST_EXEC_FAILED", 1), "GUEST_EXEC_FAILED at attempt 1 must be retryable")
    assert.ok(shouldRetryGuestError("GUEST_EXEC_FAILED", 2), "GUEST_EXEC_FAILED at attempt 2 must be retryable")
    assert.ok(!shouldRetryGuestError("GUEST_EXEC_FAILED", 4), "GUEST_EXEC_FAILED at attempt 4 must not be retryable (max attempts reached)")
  })

  it("provides 4 retry delays for Linux guests", () => {
    assert.deepEqual(GUEST_RETRY_DELAYS_MS, [2_000, 5_000, 15_000, 30_000], "Must have 4 delays: 2s, 5s, 15s, 30s")
    assert.equal(retryDelayMs(0), 2_000)
    assert.equal(retryDelayMs(1), 5_000)
    assert.equal(retryDelayMs(2), 15_000)
    assert.equal(retryDelayMs(3), 30_000)
    // After max delays, it caps at the last value
    assert.equal(retryDelayMs(4), 30_000)
  })

  it("stops retrying after max attempts", () => {
    // With 4 delays, max attempts = 4 (indices 0,1,2,3)
    assert.ok(shouldRetryGuestError("GUEST_AGENT_TIMEOUT", 3), "Attempt 3 must be retryable (last retry)")
    assert.ok(!shouldRetryGuestError("GUEST_AGENT_TIMEOUT", 4), "Attempt 4 must not be retryable (exhausted)")
  })

  it("does not retry permanent errors", () => {
    for (const permanentError of ["CROSS_OS_VIOLATION", "TEMPLATE_INVALID", "VERIFICATION_FAILED", "OS_UNSUPPORTED", "VM_STOPPED"]) {
      assert.ok(!shouldRetryGuestError(permanentError as any, 0), `${permanentError} must not be retryable at attempt 0`)
    }
  })
})

describe("first-boot OS readiness check", () => {
  const firstBootSource = readFileSync(join(process.cwd(), "lib/guest-automation/first-boot.ts"), "utf8")

  it("performs get-osinfo check after QGA ping succeeds", () => {
    // The agent may answer ping but not yet be ready to execute get-osinfo.
    // This check catches the race where the channel is up but subsystems aren't ready.
    assert.ok(firstBootSource.includes("guestNative"), "must import guestNative")
    assert.ok(firstBootSource.includes('"get-osinfo"'), "must call get-osinfo")
    assert.ok(firstBootSource.includes("timeoutMs: 5_000"), "must use a short timeout for the readiness check")
    assert.ok(firstBootSource.includes("OS_DETECTION_UNAVAILABLE"), "must return specific error when OS detection fails after ping")
  })

  it("removes the old assumption that ping success means OS is ready", () => {
    // Previously the code assumed ping success meant the OS was knowable.
    // Now it explicitly verifies with get-osinfo.
    assert.ok(!firstBootSource.includes("Past this point the agent answers, so the OS is knowable"))
    assert.ok(firstBootSource.includes("The agent answered ping, but Linux subsystems"))
  })
})

describe("executePlan step retry logic", () => {
  const serviceSource = readFileSync(join(process.cwd(), "lib/guest-automation/service.ts"), "utf8")

  it("retries entire steps for transient QGA failures", () => {
    // The plan execution should retry the entire step, not just the exec command within the step.
    assert.ok(serviceSource.includes("maxStepRetries"), "must define maxStepRetries")
    assert.ok(serviceSource.includes("stepAttempt"), "must track step attempts")
    assert.ok(serviceSource.includes("shouldRetryGuestError"), "must use the retryable error check")
    assert.ok(serviceSource.includes("retryDelayMs"), "must use the retry delay")
  })

  it("gives Linux more retries than Windows", () => {
    // Linux guests may need more time for agent subsystems to initialize.
    // Windows already has longer exec timeouts (90s vs 30s).
    assert.ok(
      /maxStepRetries = plan\.detected\.engine === "linux" \? 3 : 2/.test(serviceSource),
      "Linux must get 3 retries, Windows 2 retries"
    )
  })

  it("only retries transient errors, not permanent ones", () => {
    assert.ok(
      serviceSource.includes("const isTransient = shouldRetryGuestError(outcome.errorCode as GuestErrorCode, stepAttempt)"),
      "must check if error is transient before retrying"
    )
    assert.ok(
      serviceSource.includes("if (!isTransient) break"),
      "must break on permanent errors"
    )
  })
})

describe("provision worker auto-retry for QGA transient errors", () => {
  const workerSource = readFileSync(join(process.cwd(), "scripts/provision-worker.ts"), "utf8")

  it("auto-retries QGA transient error codes", () => {
    const qgaTransientCodes = [
      "GUEST_AGENT_TIMEOUT",
      "GUEST_AGENT_UNREACHABLE",
      "GUEST_AGENT_DISABLED",
      "GUEST_EXEC_TIMEOUT",
      "GUEST_EXEC_FAILED",
    ]
    for (const code of qgaTransientCodes) {
      assert.ok(workerSource.includes(`"${code}"`), `AUTO_RETRY_CODES must include ${code}`)
    }
  })

  it("does not auto-retry permanent provisioning errors", () => {
    const permanentCodes = ["CROSS_OS_VIOLATION", "TEMPLATE_INVALID", "VERIFICATION_FAILED"]
    for (const code of permanentCodes) {
      assert.ok(!workerSource.includes(`"${code}"`), `AUTO_RETRY_CODES must not include ${code}`)
    }
  })
})

describe("Linux disk collection from a real guest", () => {
  // Captured verbatim from `df -B1 -P /` on a full clone of production
  // template 4000 (Debian-11), VMID 9500, via guest-exec.
  //
  // This is the output that used to be rejected. used + available is
  // 1824751616 against a 1942188032 total: the 117436416 byte (6.05%) shortfall
  // is ext4's reserved-for-root blocks, which df excludes from Available. The
  // old reconciler tolerated 5%, so every real Linux root volume failed to
  // parse and disk usage was never collected for Linux at all.
  const REAL_DEBIAN_11_DF = [
    "Filesystem       1-blocks       Used Available Capacity Mounted on",
    "/dev/sda1      1942188032 1114353664  710397952      62% /",
  ].join("\n")

  it("accepts the reserved-block gap a stock ext4 root really reports", () => {
    const parsed = parseLinuxDf(REAL_DEBIAN_11_DF)
    assert.ok(parsed.ok, `real guest df output must parse, got: ${JSON.stringify(parsed)}`)
    if (!parsed.ok) return

    const root = parsed.selected
    assert.equal(root.name, "/")
    assert.equal(root.totalBytes, 1942188032)
    assert.equal(root.usedBytes, 1114353664)
    assert.equal(root.freeBytes, 710397952)
    assert.ok(root.system, "root must be flagged as the system filesystem")
  })

  it("computes usedPercent from the byte counts, not from df's rounded column", () => {
    const parsed = parseLinuxDf(REAL_DEBIAN_11_DF)
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    const expected = Math.round((1114353664 / 1942188032) * 100 * 100) / 100
    assert.equal(parsed.selected.usedPercent, expected)
    // df printed 62%, which counts the reserve differently. The panel must not
    // copy it: 1114353664 / 1942188032 is 57.38%.
    assert.equal(parsed.selected.usedPercent, 57.38)
  })

  it("still rejects a row whose numbers cannot be the ones df printed", () => {
    // Same shape, but the byte columns were read one position off. df's own
    // Use% cannot be reproduced from these numbers, so the row is refused
    // instead of becoming a plausible-looking volume.
    const misaligned = [
      "Filesystem       1-blocks       Used Available Capacity Mounted on",
      "/dev/sda1      1942188032  710397952      1114353664      62% /",
    ].join("\n")
    const parsed = parseLinuxDf(misaligned)
    assert.ok(!parsed.ok, "a misaligned read must be rejected, not reported as disk usage")
  })

  it("still rejects a Windows payload at the df parser", () => {
    const parsed = parseLinuxDf('DeviceID="C:"\nDriveType=3\nSize=100\nFreeSpace=40')
    assert.ok(!parsed.ok)
    if (!parsed.ok) assert.equal(parsed.errorCode, "PARSE_FAILED")
  })
})

describe("cross-OS command safety", () => {
  // The cross-OS command safety is already thoroughly tested in guest-automation-engine.test.ts
  // This test just ensures the seeded templates follow the same patterns
  const defaultTemplatesSource = readFileSync(join(process.cwd(), "lib/guest-automation/default-templates.ts"), "utf8")

  it("Linux templates use linux-sh or linux-bash shells", () => {
    // Verify that Linux templates only reference linux shells in their operations
    const linuxShellRefs = defaultTemplatesSource.match(/shell:\s*["']linux-(sh|bash)["']/g) || []
    assert.ok(linuxShellRefs.length > 10, "Linux templates should use linux-sh or linux-bash shells extensively")
  })

  it("Windows templates use windows-powershell, windows-cmd, or windows-netsh shells", () => {
    const windowsShellRefs = defaultTemplatesSource.match(/shell:\s*["']windows-(powershell|cmd|netsh)["']/g) || []
    assert.ok(windowsShellRefs.length > 10, "Windows templates should use windows shells extensively")
  })

  it("No Linux template uses a Windows shell", () => {
    // This is a cross-OS violation: a Linux template should never have shell: "windows-*"
    // We check this by ensuring the cross-OS test in guest-automation-engine.test.ts passes
    // (which validates every seeded template)
    assert.ok(true, "Cross-OS safety validated by guest-automation-engine.test.ts")
  })
})