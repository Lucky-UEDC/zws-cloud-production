import { describe, it } from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import assert from "node:assert/strict"

import {
  GUEST_OPERATIONS,
  assertShellMatchesEngine,
  crossOsCommandViolations,
  engineForShell,
  isGuestOperation,
  isGuestShell,
  isGuestNativeVerb,
} from "@/lib/guest-automation/constants"
import { buildGuestCommand, shellArgv, guestNative, execGuestCommand } from "@/lib/guest-automation/proxmox-guest"
import { classifyGuestOsInfo, deriveOsId } from "@/lib/guest-automation/os-detection"
import { crossOsCommandViolations } from "@/lib/guest-automation/constants"
import { scoreTemplate } from "@/lib/guest-automation/template-resolver"
import { guestAgentChannelOpen, readAgentFlag } from "@/lib/proxmox-agent-flag"
import { validateTemplateDraft } from "@/lib/guest-automation/validation"
import { DEFAULT_GUEST_TEMPLATES } from "@/lib/guest-automation/default-templates"
import {
  parseLinuxDf,
  parseWindowsLogicalDiskJson,
  parseWindowsWmicList,
  parseWindowsFsutil,
  hypervisorMacsFromConfig,
  parseNativeInterfaces,
  parseNativeOsInfo,
  parseHostname,
  parseTimezone,
  parseNativeUsers,
  parseNativeFsInfo,
} from "@/lib/guest-automation/parsers"
import { buildPlan, deriveRunStatus, EMPTY_SNAPSHOT, type GuestStateSnapshot } from "@/lib/guest-automation/plan"
import { assertExpectation, observeFromOutput } from "@/lib/guest-automation/verification"
import { renderTemplate, maskCommandSecrets, SECRET_MASK, extractPlaceholders } from "@/lib/guest-automation/placeholders"
import type { GuestEngine } from "@/lib/guest-automation/constants"
import type { ResolvedTemplate } from "@/lib/guest-automation/template-resolver"

const LINUX_DETECTED = { kind: "linux" as const, engine: "linux" as const, osId: "ubuntu", name: "Ubuntu", version: "24.04", kernelVersion: null, source: "guest-agent" as const }
const WINDOWS_DETECTED = { kind: "windows" as const, engine: "windows" as const, osId: "windows", name: "Windows Server 2022", version: "10.0.20348", kernelVersion: null, source: "guest-agent" as const }

function makeClient(overrides: Record<string, any> = {}) {
  const calls: Array<{ method: string; args: any[] }> = []
  const record = (method: string) => (...args: any[]) => {
    calls.push({ method, args })
    return overrides[method]
  }
  return {
    calls,
    client: {
      guestCmd: async (node: string, vmid: number, verb: string, body?: any) => {
        calls.push({ method: "guestCmd", args: [node, vmid, verb, body] })
        return { data: overrides[verb] }
      },
      pingVMGuestAgent: record("pingVMGuestAgent"),
      execVMGuestCommandWithInput: record("execVMGuestCommandWithInput"),
      getVMGuestExecStatus: record("getVMGuestExecStatus"),
    },
  }
}

describe("cross-OS safety: shell and engine must never be mixed", () => {
  it("refuses a Linux shell on a Windows guest", () => {
    const result = assertShellMatchesEngine("linux-sh", "windows")
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, "CROSS_OS_VIOLATION")
      assert.match(result.reason, /Windows guest/)
    }
  })

  it("refuses a PowerShell shell on a Linux guest", () => {
    const result = assertShellMatchesEngine("windows-powershell", "linux")
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, "CROSS_OS_VIOLATION")
      assert.match(result.reason, /Linux guest/)
    }
  })

  it("refuses netsh on a Linux guest", () => {
    assert.equal(assertShellMatchesEngine("windows-netsh", "linux").ok, false)
  })

  it("refuses cmd.exe on a Linux guest", () => {
    assert.equal(assertShellMatchesEngine("windows-cmd", "linux").ok, false)
  })

  it("refuses systemctl/netplan/ifupdown commands on a Windows guest", () => {
    for (const token of ["systemctl restart NetworkManager", "nmcli con up eth0", "netplan apply", "ifup eth0", "useradd bob", "chpasswd < pw"]) {
      const hits = crossOsCommandViolations(token, "windows")
      assert.ok(hits.length > 0, `expected "${token}" to be flagged for windows`)
    }
  })

  it("refuses netsh / PowerShell / wmic / diskpart on a Linux guest", () => {
    for (const token of [
      "fsutil volume diskfree C:",
      "Get-CimInstance Win32_LogicalDisk",
      "wmic logicaldisk get Size",
      "diskpart",
      "netsh interface ip set address",
      "powershell -Command Get-Volume",
    ]) {
      const hits = crossOsCommandViolations(token, "linux")
      assert.ok(hits.length > 0, `expected "${token}" to be flagged for linux`)
    }
  })

  it("allows the canonical collector for its own engine", () => {
    // `df -B1 -P` is THE Linux collector; it must never be flagged for linux.
    assert.deepEqual(crossOsCommandViolations("df -B1 -P", "linux"), [])
    assert.deepEqual(crossOsCommandViolations("systemctl restart networking", "linux"), [])
    assert.deepEqual(crossOsCommandViolations('Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"', "windows"), [])
    assert.deepEqual(crossOsCommandViolations("Set-DnsClientServerAddress -InterfaceAlias Ethernet", "windows"), [])
  })

  it("runs no command at all when the engine is unknown", () => {
    const result = assertShellMatchesEngine("linux-sh", "unknown")
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /detection/i)
  })

  it("maps shells to their engine", () => {
    assert.equal(engineForShell("linux-sh"), "linux")
    assert.equal(engineForShell("linux-bash"), "linux")
    assert.equal(engineForShell("windows-powershell"), "windows")
    assert.equal(engineForShell("windows-cmd"), "windows")
    assert.equal(engineForShell("windows-netsh"), "windows")
    assert.equal(engineForShell("fish"), null)
  })

  it("never builds argv for a mismatched engine", () => {
    const linux = buildGuestCommand({ engine: "linux", shell: "linux-sh", command: "df -B1 -P" })
    assert.equal(linux.ok, true)
    if (linux.ok) assert.deepEqual(linux.argv, ["sh", "-c", "df -B1 -P"])

    const refused = buildGuestCommand({ engine: "windows", shell: "linux-sh", command: "df -B1 -P" })
    assert.equal(refused.ok, false)
  })

  it("produces engine-correct argv prefixes", () => {
    assert.deepEqual(shellArgv("linux-bash", "x"), ["bash", "-lc", "x"])
    assert.deepEqual(shellArgv("windows-powershell", "x"), ["powershell", "-NoProfile", "-NonInteractive", "-Command", "x"])
    assert.deepEqual(shellArgv("windows-cmd", "x"), ["cmd", "/c", "x"])
    assert.deepEqual(shellArgv("windows-netsh", "x"), ["netsh", "-c", "x"])
  })
})

describe("OS detection from the guest agent", () => {
  it("classifies a Linux get-osinfo payload", () => {
    const result = classifyGuestOsInfo({ id: "ubuntu", name: "Ubuntu", "version-id": "24.04", "kernel-release": "6.8.0-45" })
    assert.equal(result.kind, "linux")
    assert.equal(result.engine, "linux")
    assert.equal(result.osId, "ubuntu")
    assert.equal(result.version, "24.04")
  })

  it("classifies a Windows get-osinfo payload", () => {
    const result = classifyGuestOsInfo({ id: "windows", name: "Microsoft Windows Server 2022", "version-id": "10.0.20348" })
    assert.equal(result.kind, "windows")
    assert.equal(result.engine, "windows")
  })

  it("returns unknown rather than guessing for an unrecognised payload", () => {
    assert.equal(classifyGuestOsInfo({ id: "plan9", name: "Plan 9" }).kind, "unknown")
    assert.equal(classifyGuestOsInfo({}).kind, "unknown")
    assert.equal(classifyGuestOsInfo(null).kind, "unknown")
    assert.equal(classifyGuestOsInfo("windows").kind, "unknown")
  })

  it("refuses a non-native guest verb", async () => {
    const { client, calls } = makeClient()
    const result = await guestNative({ client, node: "n1", vmid: 100, engine: "linux" }, "not-a-verb")
    assert.equal(result.ok, false)
    assert.equal(calls.length, 0, "no Proxmox call may be made for an invalid verb")
  })

  it("runs no guest command when the engine is unknown for a non-neutral verb", async () => {
    const { client, calls } = makeClient()
    const result = await guestNative({ client, node: "n1", vmid: 100, engine: "unknown" }, "set-user-password")
    assert.equal(result.ok, false)
    assert.equal(calls.length, 0)
  })
})

describe("guest agent channel flag", () => {
  /**
   * Proxmox does not store the agent flag as `1`.
   *
   * It stores the whole QGA option string, so a template with fstrim-on-clone
   * enabled reads `agent=1,fstrim_cloned_disks=1`. A check written as
   * `Number(value) === 1` gets `NaN` and reports the channel closed — for every
   * VM that has any other agent option set, which is most of them. Since this
   * flag gates whether provisioning treats a template as configurable, the bug
   * decided that working, agent-enabled images were unusable.
   *
   * Found by the production QA script, whose catalogue listing contradicted what
   * the hypervisor said about the same VM.
   */
  it("reads the agent flag out of a full Proxmox option string", () => {
    assert.equal(guestAgentChannelOpen({ agent: "1,fstrim_cloned_disks=1" }), true)
    assert.equal(guestAgentChannelOpen({ agent: "1" }), true)
    assert.equal(guestAgentChannelOpen({ agent: "1,freeze-fs-on-backup=1,fsfreeze-style=quiesce" }), true)
    assert.equal(guestAgentChannelOpen({ agent: 1 }), true)
    assert.equal(guestAgentChannelOpen({ agent: "1" }), true)
  })

  it("reads a per-NIC agent flag too", () => {
    assert.equal(guestAgentChannelOpen({ agent1: "1", net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0" }), true)
    assert.equal(guestAgentChannelOpen({ agent2: "1" }), true)
  })

  it("reports the channel closed when it is closed, absent or nonsense", () => {
    assert.equal(guestAgentChannelOpen({ agent: "0,fstrim_cloned_disks=1" }), false)
    assert.equal(guestAgentChannelOpen({ agent: "0" }), false)
    assert.equal(guestAgentChannelOpen({}), false)
    assert.equal(guestAgentChannelOpen(null), false)
    assert.equal(guestAgentChannelOpen(undefined), false)
    assert.equal(guestAgentChannelOpen({ agent: "yes" }), false)
    // Not the same key: `agents` is a different setting entirely.
    assert.equal(guestAgentChannelOpen({ agents: "1" }), false)
  })

  it("hands back the flag verbatim so other options are not lost when writing", () => {
    assert.equal(readAgentFlag({ agent: "1,fstrim_cloned_disks=1" }), "1,fstrim_cloned_disks=1")
    assert.equal(readAgentFlag({ net0: "virtio=AA" }), null)
  })
})

describe("template matching", () => {
  it("prefers a version-specific template over a family-wide one", () => {
    const versioned = { engine: "linux", osIds: ["ubuntu"], versionPattern: "^24(\\D|$)", priority: 340 }
    const family = { engine: "linux", osIds: ["ubuntu"], versionPattern: null, priority: 100 }
    const specific = scoreTemplate(versioned, LINUX_DETECTED)
    const generic = scoreTemplate(family, LINUX_DETECTED)
    assert.ok(specific && generic)
    assert.ok(specific!.score > generic!.score)
  })

  /**
   * A version pattern is the row's own statement of which versions it handles, so
   * a guest outside that scope is not a candidate — not a weaker one.
   *
   * Found against a real guest: a CentOS 7 clone resolved to the *RHEL 9*
   * profile and would have been configured with RHEL 9 commands. Scoring instead
   * of rejecting let `rhel-9` (declared `^9`, priority 310 → 200+310 = 510)
   * outvote `centos-7` (declared `^7`, exactly right → 300+200 = 500).
   */
  it("rejects a version outside a profile's declared scope rather than scoring it low", () => {
    const row = { engine: "linux", osIds: ["debian"], versionPattern: "^11(\\D|$)", priority: 300 }
    assert.ok(scoreTemplate(row, { ...LINUX_DETECTED, osId: "debian", version: "11.9" }))
    assert.equal(scoreTemplate(row, { ...LINUX_DETECTED, osId: "debian", version: "12.4" }), null)
  })

  it("never lets a high-priority profile claim a version outside its own scope", () => {
    // The exact shape of the shipped defaults, and the exact failure.
    const rhel9 = { engine: "linux", osIds: ["rhel", "almalinux", "centos"], versionPattern: "^9(\\D|$)", priority: 310 }
    const rhel8 = { engine: "linux", osIds: ["rhel", "almalinux", "centos"], versionPattern: "^8(\\D|$)", priority: 300 }
    const centos7 = { engine: "linux", osIds: ["centos"], versionPattern: "^7(\\D|$)", priority: 200, family: "centos" }
    const guest = { ...LINUX_DETECTED, osId: "centos", version: "7", name: "CentOS Linux" }

    const scored = [rhel9, rhel8, centos7]
      .map((row) => ({ row, scored: scoreTemplate(row, guest) }))
      .filter((entry) => entry.scored)
    assert.equal(scored.length, 1, "only the profile whose declared scope contains the guest may be a candidate")
    assert.equal(scored[0].row, centos7)
  })

  it("still picks the right RHEL profile for an AlmaLinux guest", () => {
    const rhel8 = { engine: "linux", osIds: ["rhel", "almalinux", "centos"], versionPattern: "^8(\\D|$)", priority: 300 }
    const rhel9 = { engine: "linux", osIds: ["rhel", "almalinux", "centos"], versionPattern: "^9(\\D|$)", priority: 310 }
    const rhel10 = { engine: "linux", osIds: ["rhel", "almalinux"], versionPattern: "^10(\\D|$)", priority: 320 }
    const guest = { ...LINUX_DETECTED, osId: "almalinux", version: "8.10 (Cerulean Leopard)" }
    const scored = [rhel8, rhel9, rhel10]
      .map((row) => ({ row, scored: scoreTemplate(row, guest) }))
      .filter((entry) => entry.scored)
      .sort((a, b) => b.scored!.score - a.scored!.score)
    assert.equal(scored[0].row, rhel8)
  })

  it("breaks a versionless guest's tie on family, not on priority alone", () => {
    // A guest that reports no usable version must not land on whichever
    // profile happens to carry the highest priority when several claim its os
    // id as an alias.
    const centos7 = { engine: "linux", osIds: ["centos"], versionPattern: null, priority: 200, family: "centos" }
    const rhel10 = { engine: "linux", osIds: ["rhel", "centos"], versionPattern: null, priority: 900, family: "rhel" }
    const guest = { ...LINUX_DETECTED, osId: "centos", version: null, name: "CentOS Linux" }
    const scored = [centos7, rhel10]
      .map((row) => ({ row, scored: scoreTemplate(row, guest) }))
      .filter((entry) => entry.scored)
      .sort((a, b) => b.scored!.score - a.scored!.score)
    assert.equal(scored[0].row, centos7)
  })

  it("keeps matching a profile whose declared version cannot be checked", () => {
    // An unreadable version must not disqualify the one profile that obviously
    // applies, or an unreadable version would read as "unsupported OS".
    const row = { engine: "linux", osIds: ["debian"], versionPattern: "^11(\\D|$)", priority: 300, family: "debian" }
    const scored = scoreTemplate(row, { ...LINUX_DETECTED, osId: "debian", version: "" })
    assert.ok(scored, "a missing version must not make a profile vanish")
    assert.ok((scored!.score as number) > 0)
  })

  it("never matches a Linux template to a Windows guest", () => {
    const row = { engine: "linux", osIds: ["windows"], priority: 999 }
    assert.equal(scoreTemplate(row, WINDOWS_DETECTED), null)
  })

  it("returns no match for an unknown os id", () => {
    const row = { engine: "linux", osIds: ["ubuntu"], priority: 100 }
    assert.equal(scoreTemplate(row, { ...LINUX_DETECTED, osId: "plan9" }), null)
  })
})

describe("template validation", () => {
  const base = {
    name: "Test Linux",
    slug: "test-linux",
    family: "test",
    engine: "linux" as GuestEngine,
    osIds: ["testlinux"],
    operations: [
      {
        operation: "disk_usage",
        shell: "linux-sh",
        command: "df -B1 -P",
        timeoutSeconds: 30,
        verificationCommand: "df -B1 -P",
        verificationParser: "df-posix",
      },
    ],
  }

  it("accepts a well-formed template", () => {
    const result = validateTemplateDraft(base)
    assert.equal(result.ok, true, JSON.stringify(result.errors))
  })

  it("rejects a Windows shell in a Linux template", () => {
    const result = validateTemplateDraft({
      ...base,
      operations: [{ operation: "disk_usage", shell: "windows-powershell", command: "Get-Volume", timeoutSeconds: 30 }],
    })
    assert.equal(result.ok, false)
    assert.match(JSON.stringify(result.errors), /windows-powershell/)
  })

  it("does not judge a guest-native operation by its (unused) shell field", () => {
    // `get-osinfo` is a verb handed straight to the agent: no shell runs, so a
    // native operation shared by both engines must stay valid in either one.
    const native = { operation: "detect_os", commandType: "guest-native", command: "get-osinfo", timeoutSeconds: 15 }
    for (const engine of ["linux", "windows"] as const) {
      const result = validateTemplateDraft({ ...base, engine, operations: [native] })
      assert.equal(result.ok, true, `${engine}: ${JSON.stringify(result.errors)}`)
    }
  })

  it("still judges a guest-exec operation by its shell", () => {
    const result = validateTemplateDraft({
      ...base,
      engine: "windows",
      operations: [{ operation: "disk_usage", shell: "linux-sh", command: "Get-Volume", timeoutSeconds: 30 }],
    })
    assert.equal(result.ok, false)
    assert.match(JSON.stringify(result.errors), /linux shell/)
  })

  it("rejects a Linux command pasted into a Windows template", () => {
    const result = validateTemplateDraft({
      ...base,
      engine: "windows",
      operations: [{ operation: "disk_usage", shell: "windows-powershell", command: "systemctl restart networking", timeoutSeconds: 30 }],
    })
    assert.equal(result.ok, false)
    assert.match(JSON.stringify(result.errors), /Linux/)
  })

  it("rejects a Windows command pasted into a Linux template", () => {
    const result = validateTemplateDraft({
      ...base,
      operations: [{ operation: "disk_usage", shell: "linux-sh", command: "fsutil volume diskfree C:", timeoutSeconds: 30 }],
    })
    assert.equal(result.ok, false)
    assert.match(JSON.stringify(result.errors), /Windows/)
  })

  it("rejects an unknown operation name", () => {
    const result = validateTemplateDraft({
      ...base,
      operations: [{ operation: "rm_rf", shell: "linux-sh", command: "rm -rf /", timeoutSeconds: 5 }],
    })
    assert.equal(result.ok, false)
    assert.match(JSON.stringify(result.errors), /not a supported operation/)
  })

  it("rejects an unknown placeholder", () => {
    const result = validateTemplateDraft({
      ...base,
      operations: [{ operation: "set_ip", shell: "linux-sh", command: "ip addr add {{EVIL}}/24", timeoutSeconds: 30 }],
    })
    assert.equal(result.ok, false)
    assert.match(JSON.stringify(result.errors), /Unknown placeholder/)
  })

  it("rejects a dangerous operation without confirmation", () => {
    const result = validateTemplateDraft({
      ...base,
      operations: [
        { operation: "delete_user", shell: "linux-sh", command: "userdel {{USERNAME}}", timeoutSeconds: 30, dangerLevel: "dangerous", supportsRollback: false },
      ],
    })
    assert.equal(result.ok, false)
    assert.match(JSON.stringify(result.errors), /confirmation/i)
  })

  it("rejects a dangerous operation that claims rollback without a rollback command", () => {
    const result = validateTemplateDraft({
      ...base,
      operations: [
        {
          operation: "delete_user",
          shell: "linux-sh",
          command: "userdel {{USERNAME}}",
          timeoutSeconds: 30,
          dangerLevel: "dangerous",
          requiresConfirmation: true,
          supportsRollback: true,
        },
      ],
    })
    assert.equal(result.ok, false)
    assert.match(JSON.stringify(result.errors), /rollback/i)
  })

  it("rejects an out-of-range timeout", () => {
    const result = validateTemplateDraft({
      ...base,
      operations: [{ operation: "disk_usage", shell: "linux-sh", command: "df -B1 -P", timeoutSeconds: 99_999 }],
    })
    assert.equal(result.ok, false)
    assert.match(JSON.stringify(result.errors), /Timeout/)
  })

  it("rejects an invalid version pattern", () => {
    const result = validateTemplateDraft({ ...base, versionPattern: "([unclosed" })
    assert.equal(result.ok, false)
    assert.match(JSON.stringify(result.errors), /regular expression/)
  })

  it("rejects a duplicate operation", () => {
    const result = validateTemplateDraft({
      ...base,
      operations: [
        { operation: "disk_usage", shell: "linux-sh", command: "df -B1 -P", timeoutSeconds: 30 },
        { operation: "disk_usage", shell: "linux-sh", command: "df -h", timeoutSeconds: 30 },
      ],
    })
    assert.equal(result.ok, false)
    assert.match(JSON.stringify(result.errors), /defined twice/)
  })
})

describe("built-in templates are internally consistent", () => {
  it("validates every seeded template", () => {
    for (const template of DEFAULT_GUEST_TEMPLATES) {
      const result = validateTemplateDraft({
        name: template.name,
        slug: template.slug,
        family: template.family,
        engine: template.engine,
        osIds: template.osIds,
        versionPattern: template.versionPattern,
        enabled: template.enabled,
        operations: template.operations as any,
      })
      assert.equal(result.ok, true, `${template.slug}: ${JSON.stringify(result.errors)}`)
    }
  })

  it("never mixes engines inside a template", () => {
    for (const template of DEFAULT_GUEST_TEMPLATES) {
      for (const operation of template.operations) {
        if (operation.commandType === "guest-native") continue
        const shellEngine = engineForShell(operation.shell)
        assert.equal(shellEngine, template.engine, `${template.slug}/${operation.operation} shell ${operation.shell}`)
        const violations = crossOsCommandViolations(operation.command, template.engine)
        assert.deepEqual(violations, [], `${template.slug}/${operation.operation} contains ${violations.join(", ")}`)
      }
    }
  })

  it("gives every template a disk collector", () => {
    for (const template of DEFAULT_GUEST_TEMPLATES) {
      const disk = template.operations.find((operation) => operation.operation === "disk_usage")
      assert.ok(disk, `${template.slug} has no disk_usage operation`)
      if (template.engine === "linux") assert.match(String(disk!.command), /df -B1 -P/)
      if (template.engine === "windows") assert.match(String(disk!.command), /Win32_LogicalDisk/)
    }
  })

  it("never inlines a literal password value into a command template", () => {
    for (const template of DEFAULT_GUEST_TEMPLATES) {
      for (const operation of template.operations) {
        const command = String(operation.command || "")
        // Password operations must not inline literal password values.
        // Windows uses {{PASSWORD}} placeholder or $env:ZWS_SECRET env var; Linux reads from stdin via `read -r SECRET`.
        // Both approaches keep the literal password out of argv and Proxmox task logs.
        if (operation.operation === "set_password" || operation.operation === "create_user") {
          const hasPasswordPlaceholder = command.includes("{{PASSWORD}}")
          const readsFromStdin = command.includes("read -r SECRET") || command.includes("read -r PASSWORD")
          const usesEnvVar = command.includes("$env:ZWS_SECRET")
          assert.ok(
            hasPasswordPlaceholder || readsFromStdin || usesEnvVar,
            `${template.slug}/${operation.operation} must use {{PASSWORD}} placeholder, read password from stdin, or use $env:ZWS_SECRET`
          )
        } else {
          // Non-password operations must not contain the PASSWORD placeholder
          const used = extractPlaceholders(command)
          assert.ok(!used.includes("PASSWORD"), `${template.slug}/${operation.operation} must not use {{PASSWORD}} placeholder`)
        }
      }
    }
  })
})

describe("Linux disk parsing (df -B1 -P)", () => {
  it("selects the root filesystem and reports bytes", () => {
    const output = [
      "Filesystem     1B-blocks       Used  Available Use% Mounted on",
      "/dev/sda1      85899345920 14336000000 71563345920  17% /",
      "tmpfs           1073741824         0 1073741824   0% /dev/shm",
      "/dev/sdb1     214748364800 1073741824 213674622976   1% /data",
    ].join("\n")
    const result = parseLinuxDf(output)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.selected!.name, "/")
    assert.equal(result.selected!.totalBytes, 85899345920)
    assert.equal(result.selected!.usedBytes, 14336000000)
    assert.equal(result.selected!.freeBytes, 71563345920)
    // Derived from the bytes, not from df's rounded Use% column ("17%").
    assert.ok(Math.abs(result.selected!.usedPercent - (14336000000 / 85899345920) * 100) < 0.01)
    assert.equal(result.collector, "linux_df")
  })

  it("ignores pseudo filesystems", () => {
    const output = [
      "Filesystem     1B-blocks       Used  Available Use% Mounted on",
      "proc                 0           0          0   0% /proc",
      "sysfs                0           0          0   0% /sys",
      "devtmpfs       1073741824         0 1073741824   0% /dev",
      "tmpfs         21474836480 1048576 21473787904   1% /run",
      "overlay       107374182400 5368709120 102005473280   5% /var/lib/docker",
      "/dev/sda1      85899345920 14336000000 71563345920  17% /",
    ].join("\n")
    const result = parseLinuxDf(output)
    assert.equal(result.ok, true)
    if (!result.ok) return
    const mounts = result.volumes.map((volume) => volume.name)
    assert.deepEqual(mounts, ["/"])
    // `df -B1 -P` has no filesystem-type column, so none is invented.
    assert.equal(result.selected!.filesystem, null)
    assert.equal(result.selected!.device, "/dev/sda1")
  })

  it("falls back to the largest real filesystem when / is not listed", () => {
    const output = [
      "Filesystem     1B-blocks       Used  Available Use% Mounted on",
      "tmpfs          1073741824         0 1073741824   0% /run",
      "/dev/sdb1    214748364800 1073741824 213674622976   1% /data",
    ].join("\n")
    const result = parseLinuxDf(output)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.selected!.name, "/data")
  })

  it("rejects a Windows payload", () => {
    const result = parseLinuxDf('DeviceID=C: DriveType=3 Size=100 FreeSpace=40')
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.errorCode, "PARSE_FAILED")
  })

  it("rejects output with no recognizable header", () => {
    const result = parseLinuxDf("some random text\nmore text")
    assert.equal(result.ok, false)
  })

  it("rejects empty output", () => {
    const result = parseLinuxDf("")
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.errorCode, "PARSE_FAILED")
  })

  it("rejects rows that do not reconcile", () => {
    const output = [
      "Filesystem     1B-blocks       Used  Available Use% Mounted on",
      "/dev/sda1      85899345920 99999999999 71563345920  17% /",
    ].join("\n")
    const result = parseLinuxDf(output)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.errorCode, "PARSE_FAILED")
  })

  it("rejects a filesystem that is entirely pseudo", () => {
    const output = [
      "Filesystem     1B-blocks       Used  Available Use% Mounted on",
      "tmpfs          1073741824         0 1073741824   0% /run",
    ].join("\n")
    const result = parseLinuxDf(output)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.errorCode, "DISK_DATA_INVALID")
  })

  it("handles a mount point containing a space", () => {
    const output = [
      "Filesystem     1B-blocks       Used  Available Use% Mounted on",
      "/dev/sdb1      85899345920 14336000000 71563345920  17% /mnt/my disk",
    ].join("\n")
    const result = parseLinuxDf(output)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.selected!.name, "/mnt/my disk")
  })
})

describe("Windows disk parsing (PowerShell / CIM)", () => {
  it("parses a single-object JSON payload and selects C:", () => {
    const output = JSON.stringify({ DeviceID: "C:", DriveType: 3, Size: 107374182400, FreeSpace: 53687091200, FileSystem: "NTFS" })
    const result = parseWindowsLogicalDiskJson(output)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.selected!.name, "C:")
    assert.equal(result.selected!.totalBytes, 107374182400)
    assert.equal(result.selected!.usedBytes, 53687091200)
    assert.equal(result.selected!.usedPercent, 50)
    assert.equal(result.collector, "windows_cim")
  })

  it("parses an array payload and prefers C: over a larger data drive", () => {
    const output = JSON.stringify([
      { DeviceID: "D:", DriveType: 3, Size: 214748364800, FreeSpace: 107374182400 },
      { DeviceID: "C:", DriveType: 3, Size: 107374182400, FreeSpace: 107374182400 },
    ])
    const result = parseWindowsLogicalDiskJson(output)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.selected!.name, "C:")
    assert.equal(result.volumes.length, 2)
  })

  it("ignores CD, removable and network drives", () => {
    const output = JSON.stringify([
      { DeviceID: "E:", DriveType: 5, Size: 0, FreeSpace: 0 },
      { DeviceID: "F:", DriveType: 2, Size: 4294967296, FreeSpace: 4294967296 },
      { DeviceID: "C:", DriveType: 3, Size: 107374182400, FreeSpace: 53687091200 },
    ])
    const result = parseWindowsLogicalDiskJson(output)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.volumes.map((volume) => volume.name), ["C:"])
  })

  it("fails when only removable media is reported", () => {
    const output = JSON.stringify([{ DeviceID: "E:", DriveType: 5, Size: 0, FreeSpace: 0 }])
    const result = parseWindowsLogicalDiskJson(output)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.errorCode, "DISK_DATA_INVALID")
  })

  it("rejects a df payload", () => {
    const result = parseWindowsLogicalDiskJson("Filesystem 1B-blocks Used Available Use% Mounted on\n/dev/sda1 100 50 50 50% /")
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.errorCode, "PARSE_FAILED")
  })

  it("rejects invalid JSON", () => {
    const result = parseWindowsLogicalDiskJson("{not json")
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.errorCode, "PARSE_FAILED")
  })

  it("rejects negative or inconsistent sizes", () => {
    const output = JSON.stringify({ DeviceID: "C:", DriveType: 3, Size: 100, FreeSpace: 500 })
    const result = parseWindowsLogicalDiskJson(output)
    assert.equal(result.ok, false)
  })

  it("parses the legacy wmic list fallback", () => {
    const output = ["DeviceID=C:", "FreeSpace=53687091200", "Size=107374182400", "", "DeviceID=D:", "FreeSpace=107374182400", "Size=214748364800", ""].join("\n")
    const result = parseWindowsWmicList(output)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.selected!.name, "C:")
    assert.equal(result.collector, "windows_wmic")
  })

  it("rejects the human-unit fsutil payload rather than guessing a factor", () => {
    const output = "Volume C: (C:)\n  Free Space: 50 GB\n  Total Space:  100 GB\n"
    // fsutil reports human units; converting them would silently misreport a
    // customer's disk, so the payload is refused.
    const result = parseWindowsFsutil(output, "C:")
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.errorCode, "PARSE_FAILED")
  })

  it("parses an fsutil payload that reports raw bytes", () => {
    const output = "Volume C: (C:)\n  Free Space: 53687091200 bytes\n  Total Space:  107374182400 bytes\n"
    const result = parseWindowsFsutil(output, "C:")
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.selected!.totalBytes, 107374182400)
      assert.equal(result.selected!.freeBytes, 53687091200)
      assert.equal(result.selected!.usedPercent, 50)
    }
  })
})

describe("native guest payload parsing", () => {
  it("picks a real interface and never assumes eth0", () => {
    const payload = [
      { name: "lo", "hardware-address": "00:00:00:00:00:00", "ip-addresses": [{ "ip-address-type": 4, "ip-address": "127.0.0.1" }] },
      { name: "ens18", "hardware-address": "52:54:00:ab:cd:ef", "ip-addresses": [{ "ip-address-type": 4, "ip-address": "10.0.0.20" }] },
    ]
    const result = parseNativeInterfaces(payload)
    assert.equal(result.primary!.name, "ens18")
    assert.deepEqual(result.primary!.ipv4, ["10.0.0.20"])
  })

  /**
   * Found by the production QA script against real guests.
   *
   * Both running Linux guests turned out to be running containers, so the guest
   * agent reported `br-ae8945c50794` and `docker0` alongside the real NIC — and
   * both were selected as primary, because a bridge's address is tidier than a
   * NAT'd address. A customer IP configured onto `docker0` takes the container
   * network down with it.
   */
  it("never picks a container bridge as the primary interface", () => {
    const payload = [
      { name: "docker0", "hardware-address": "02:42:aa:bb:cc:dd", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "172.17.0.1" }] },
      { name: "br-ae8945c50794", "hardware-address": "02:42:11:22:33:44", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "172.18.0.1" }] },
      { name: "veth9f2a1c", "hardware-address": "02:42:55:66:77:88", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "172.18.0.2" }] },
      { name: "ens18", "hardware-address": "52:54:00:ab:cd:ef", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "10.0.0.20" }] },
    ]
    assert.equal(parseNativeInterfaces(payload).primary!.name, "ens18")
  })

  it("prefers the MAC the hypervisor assigned, even with no address yet", () => {
    // A guest that has not brought its NIC up still has a NIC, and the address
    // belongs on it. The MAC is the one fact the hypervisor and the guest agree
    // on, so it outranks a name-based guess.
    const payload = [
      { name: "ens18", "hardware-address": "52:54:00:ab:cd:ef", "ip-addresses": [] },
      { name: "docker0", "hardware-address": "02:42:aa:bb:cc:dd", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "172.17.0.1" }] },
    ]
    const result = parseNativeInterfaces(payload, { hypervisorMacs: ["52:54:00:ab:cd:ef"] })
    assert.equal(result.primary!.name, "ens18")
  })

  it("still finds the real NIC when the guest's bridge has a rounder address", () => {
    const payload = [
      { name: "virbr0", "hardware-address": "52:54:00:99:99:99", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "192.168.122.1" }] },
      { name: "ens18", "hardware-address": "52:54:00:ab:cd:ef", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "203.0.113.9" }] },
    ]
    assert.equal(parseNativeInterfaces(payload, { hypervisorMacs: ["52:54:00:ab:cd:ef"] }).primary!.name, "ens18")
    // And without the hypervisor MACs, the name filter alone still gets it right.
    assert.equal(parseNativeInterfaces(payload).primary!.name, "ens18")
  })

  it("reads the MACs Proxmox assigned out of net0..netN", () => {
    assert.deepEqual(
      hypervisorMacsFromConfig({ net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0", net1: "e1000=11:22:33:44:55:66", scsi0: "local-lvm:vm-100-disk-0" }),
      ["aa:bb:cc:dd:ee:ff", "11:22:33:44:55:66"],
    )
    assert.deepEqual(hypervisorMacsFromConfig(null), [])
  })

  it("never selects loopback as the primary interface", () => {
    const payload = [
      { name: "lo", "ip-addresses": [{ "ip-address-type": 4, "ip-address": "127.0.0.1" }] },
      { name: "enp1s0", "ip-addresses": [{ "ip-address-type": 4, "ip-address": "192.0.2.5" }] },
    ]
    assert.equal(parseNativeInterfaces(payload).primary!.name, "enp1s0")
  })

  it("returns no primary when only loopback is up", () => {
    const payload = [{ name: "lo", "ip-addresses": [{ "ip-address-type": 4, "ip-address": "127.0.0.1" }] }]
    assert.equal(parseNativeInterfaces(payload).primary, null)
  })

  it("unwraps the agent's result envelope before any parser sees it", () => {
    // Every `agent/<verb>` response is `{ data: { result: <payload> } }`.
    // Unwrapping only `data` hands every parser a `{ result: ... }` wrapper
    // instead of the payload, so `get-osinfo` reading `id` at the top level sees
    // nothing and every guest classifies as unknown.
    const payload = { "pretty-name": "Ubuntu 22.04.5 LTS", version: "22.04.5" }
    const client = {
      guestCmd: async () => ({ data: { result: payload } }),
    } as any
    return guestNative({ client, node: "n", vmid: 1, engine: "unknown" }, "get-osinfo").then((result: any) => {
      assert.equal(result.ok, true)
      assert.deepEqual(result.data, payload)
      assert.equal(classifyGuestOsInfo(result.data).osId, "ubuntu")
    })
  })

  it("classifies a guest that only reports pretty-name", () => {
    // Taken from a live guest on this fleet. Several QEMU Guest Agent builds
    // omit `id` and `name` entirely and send only `pretty-name`, `version` and
    // `kernel-version`. A parser that only reads `id` classifies every such guest
    // as unknown, which is the same as saying no guest on the fleet can be
    // configured.
    const parsed = classifyGuestOsInfo({ "pretty-name": "Ubuntu 22.04.5 LTS", version: "22.04.5 LTS (Jammy Jellyfish)", "kernel-version": "#49-Ubuntu SMP" })
    assert.equal(parsed.kind, "linux")
    assert.equal(parsed.engine, "linux")
    assert.equal(parsed.osId, "ubuntu")
  })

  it("derives the os id from the name, earliest match winning", () => {
    // Every Linux vendor puts "Linux" in the name, so matching the longest
    // candidate first resolves all of them to a generic id no template claims.
    // The distribution name comes first in the string, so position is the signal.
    assert.equal(deriveOsId("", "Arch Linux"), "arch")
    assert.equal(deriveOsId("", "Kali GNU/Linux Rolling"), "kali")
    assert.equal(deriveOsId("", "Debian GNU/Linux 12 (bookworm)"), "debian")
    assert.equal(deriveOsId("", "Rocky Linux 9.4 (Blue Onyx)"), "rocky")
    assert.equal(deriveOsId("", "AlmaLinux 8.10 (Cerulean Leopard)"), "almalinux")
    assert.equal(deriveOsId("", "CentOS Linux release 7.9.2009 (Core)"), "centos")
    assert.equal(deriveOsId("", "Oracle Linux Server 9.4"), "oracle")
    assert.equal(deriveOsId("", "Fedora Linux 40"), "fedora")
    assert.equal(deriveOsId("", "openSUSE Leap 15.6"), "opensuse")
    assert.equal(deriveOsId("", "Alpine Linux v3.20"), "alpine")
  })

  it("prefers a real id over the name, and never guesses", () => {
    assert.equal(deriveOsId("debian", "Anything At All"), "debian")
    // An unrecognised id stays unrecognised. Refusing to guess is the safe
    // direction: an unknown OS must not be configured with a guessed profile.
    assert.equal(deriveOsId("totally-unknown-id", "Whatever"), null)
    assert.equal(deriveOsId("", "SomethingWeirdOS 1.0"), null)
    assert.equal(deriveOsId("", ""), null)
  })

  it("does not match a distribution name inside a longer word", () => {
    // "search" contains "arch" and "abuse" contains "suse".
    assert.equal(deriveOsId("", "search-engine-thing"), null)
    assert.equal(deriveOsId("", "an-abuse-of-terms"), null)
  })

  it("normalises get-osinfo", () => {
    const parsed = parseNativeOsInfo({ id: "rocky", name: "Rocky Linux", "version-id": "9.4", "kernel-release": "5.14.0" })
    assert.equal(parsed.osId, "rocky")
    assert.equal(parsed.version, "9.4")
  })

  it("normalises get-users", () => {
    const parsed = parseNativeUsers([{ name: "root", uid: 0 }, { name: "zws" }])
    assert.deepEqual(parsed.map((user) => user.name), ["root", "zws"])
  })

  it("normalises get-fsinfo", () => {
    // The real shape, taken from a live guest. The sizes are on the filesystem
    // entry; `disk` carries identity only. Reading the sizes off the disk object
    // finds nothing and yields an empty list on every guest.
    const parsed = parseNativeFsInfo([
      { mountpoint: "/", type: "ext4", name: "sda1", "total-bytes": 85899345920, "used-bytes": 14336000000, disk: [{ dev: "/dev/sda1", serial: "QM00005" }] },
    ])
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].totalBytes, 85899345920)
    assert.equal(parsed[0].usedBytes, 14336000000)
    assert.equal(parsed[0].freeBytes, 85899345920 - 14336000000)
    assert.equal(parsed[0].type, "ext4")
    assert.equal(parsed[0].name, "/dev/sda1")
    assert.equal(parsed[0].mountpoint, "/")
  })

  it("ignores a filesystem with no size rather than reporting it as full or empty", () => {
    // `/snap/*` mounts report a size but a backing disk list is empty; an entry
    // with no size at all is not a measurement.
    const parsed = parseNativeFsInfo([{ mountpoint: "/run", type: "tmpfs", name: "tmpfs", "used-bytes": 123, disk: [] }])
    assert.deepEqual(parsed, [])
  })

  it("accepts either the payload or the agent's result wrapper", () => {
    // Every agent response is wrapped, but a caller reaching a parser through
    // `guestNative` holds the unwrapped payload. Both must work: a parser that
    // accepts only one fails silently on the other.
    const payload = [{ mountpoint: "/", type: "ext4", name: "sda1", "total-bytes": 1000, "used-bytes": 400, disk: [] }]
    assert.equal(parseNativeFsInfo(payload).length, 1)
    assert.equal(parseNativeFsInfo({ result: payload }).length, 1)
    assert.equal(parseNativeUsers({ result: [{ name: "root" }] })[0]?.name, "root")
    assert.equal(parseNativeInterfaces({ result: [{ name: "eth0", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "10.0.0.5" }] }] }).primary?.name, "eth0")
  })

  it("reads the address family the agent actually sends", () => {
    // `ip-address-type` arrives as the string "ipv4", not the number 4. Reading
    // it as a number collects nothing, and the result looks like a network
    // fault rather than a parsing one.
    const parsed = parseNativeInterfaces([
      { name: "eth0", "hardware-address": "aa:bb:cc:dd:ee:ff", "ip-addresses": [
        { "ip-address-type": "ipv4", "ip-address": "10.0.0.5" },
        { "ip-address-type": "ipv6", "ip-address": "fe80::1" },
      ] },
    ])
    assert.deepEqual(parsed.primary?.ipv4, ["10.0.0.5"])
    assert.deepEqual(parsed.primary?.ipv6, ["fe80::1"])
  })
})

describe("a stopped guest is reported as stopped", () => {
  /**
   * Found by running the layer against VMID 465543, a real stopped server.
   *
   * A stopped guest has no agent, so OS detection legitimately fails. Reporting
   * that as "OS detection unavailable" tells a customer their server is broken
   * when the answer they can act on is that they stopped it. The metric side was
   * already right — last known value, with the freshness state carried
   * separately — and the disk side has to agree with it.
   */
  it("a stopped server reports VM_STOPPED, not OS detection unavailable", () => {
    const source = readFileSync(join(process.cwd(), "lib/guest-automation/service.ts"), "utf8")
    const getDiskUsage = source.slice(source.indexOf("async getDiskUsage("), source.indexOf("private async executeCollector("))
    // Power state is checked before detection, and names itself.
    assert.ok(
      getDiskUsage.indexOf("this.isRunning()") < getDiskUsage.indexOf("this.detectOs()"),
      "getDiskUsage must check the power state before it tries to detect the OS",
    )
    assert.match(getDiskUsage, /errorCode: "VM_STOPPED" as GuestErrorCode, message: GUEST_ERROR_MESSAGES\.VM_STOPPED/)
  })

  it("a context without a usable node fails with a sentence, not a TypeError", () => {
    const source = readFileSync(join(process.cwd(), "lib/guest-automation/first-boot.ts"), "utf8")
    // A TypeError about `nodeName` sends whoever hit it looking for a VM problem
    // instead of the caller mistake it is.
    assert.match(source, /guest_automation_no_node/)
    assert.match(source, /guest_automation_no_credentials/)
    assert.match(source, /guest_automation_no_vmid/)
  })
})

describe("payload shapes taken from real guests", () => {
  /**
   * Every assertion in this block is a shape copied from a live guest on this
   * fleet, not from the specification. Each one was wrong in the code before it
   * was read off a real `get-*` response, and each wrong one failed silently —
   * an empty list, an `undefined`, or a guest that could not be identified.
   */

  it("a Windows template claims the id a Windows guest actually reports", () => {
    // `get-osinfo` returns `mswindows`. A template claiming only "windows"
    // matches no real guest, so every Windows server reported "this operating
    // system is not yet supported" while the platform looked correctly
    // configured. Verified against VMID 102, which reports `mswindows`.
    const windows = DEFAULT_GUEST_TEMPLATES.filter((template) => template.engine === "windows")
    assert.ok(windows.length >= 1)
    for (const template of windows) {
      assert.ok(template.osIds.includes("mswindows"), `${template.slug} does not claim mswindows`)
    }
  })

  it("no seeded template has a duplicated os id", () => {
    for (const template of DEFAULT_GUEST_TEMPLATES) {
      const unique = new Set(template.osIds)
      assert.equal(unique.size, template.osIds.length, `${template.slug} has a duplicated os id: ${template.osIds.join(",")}`)
    }
  })

  it("every seeded template claims at least one os id", () => {
    for (const template of DEFAULT_GUEST_TEMPLATES) {
      assert.ok(template.osIds.length > 0, `${template.slug} claims no os id and can never be selected`)
    }
  })

  it("get-fsinfo puts the sizes on the filesystem, not on the backing disk", () => {
    // Real payload:
    //   { mountpoint: "/", type: "ext4", name: "sda1",
    //     "total-bytes": 83263205376, "used-bytes": 2610900992,
    //     disk: [ { dev: "/dev/sda1", serial: "QM00005" } ] }
    // The disk array carries identity only. Reading sizes off it yields nothing
    // and presents as "this server reports no disks".
    const parsed = parseNativeFsInfo([
      { mountpoint: "/", type: "ext4", name: "sda1", "total-bytes": 83263205376, "used-bytes": 2610900992, disk: [{ dev: "/dev/sda1", serial: "QM00005" }] },
    ])
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].name, "/dev/sda1")
    assert.equal(parsed[0].mountpoint, "/")
    assert.equal(parsed[0].type, "ext4")
    assert.equal(parsed[0].freeBytes, 83263205376 - 2610900992)
  })

  it("get-timezone reports zone, and the hostname verb reports host-name", () => {
    // Both were read under the wrong key, so every server reported no timezone
    // and no hostname — which for the hostname also means every change-driven
    // plan believed a rename was needed.
    assert.equal((parseTimezone({ zone: "India Standard Time", offset: 19800 }) as string).includes("India"), true)
    assert.equal(parseHostname({ "host-name": "ip-103-216-170-233" }), "ip-103-216-170-233")
    assert.equal(parseHostname({ name: "LUCKY" }), "LUCKY")
  })

  it("get-users on Windows reports user, and Linux reports name", () => {
    // Real Windows payload: { "login-time": ..., "user": "Administrator", "domain": "LUCKY" }
    assert.deepEqual(parseNativeUsers([{ "user": "Administrator", domain: "LUCKY" }]).map((user) => user.name), ["Administrator"])
    assert.deepEqual(parseNativeUsers([{ name: "root" }]).map((user) => user.name), ["root"])
  })
})

describe("cross-OS token coverage", () => {
  /**
   * Found by the production QA script, not by a unit test: `ip` (iproute2) was
   * absent from the Linux token list, so a Windows template carrying
   * `ip route show` was accepted. It would then fail silently in PowerShell — a
   * template that looks configured and is not.
   */
  it("refuses iproute2 on a Windows guest", () => {
    for (const command of ["ip route show", "ip addr show eth0", "ip link set eth0 up", "ip -4 a", "/sbin/ip addr"]) {
      assert.ok(crossOsCommandViolations(command, "windows").length > 0, `Windows accepted: ${command}`)
    }
  })

  it("refuses the rest of the Linux-only configuration surface on Windows", () => {
    for (const command of [
      "resolvectl dns eth0 1.1.1.1",
      "hostnamectl set-hostname web1",
      "findmnt /",
      "blkid /dev/sda1",
      "resize2fs /dev/sda1",
      "xfs_growfs /",
      "mount /dev/sda1 /mnt",
      "swapon -a",
      "dpkg -l qemu-guest-agent",
      "chkconfig --list",
      "cloud-init status --wait",
      "ifconfig eth0 up",
      "journalctl -u systemd-networkd",
    ]) {
      assert.ok(crossOsCommandViolations(command, "windows").length > 0, `Windows accepted: ${command}`)
    }
  })

  it("does not mistake a Windows command for a Linux one", () => {
    for (const command of [
      "New-NetIPAddress -InterfaceAlias 'Ethernet' -IPAddress '10.0.0.5' -PrefixLength 24",
      "ipconfig /renew",
      "Get-NetIPAddress -AddressFamily IPv4",
      "Get-Volume -DriveLetter C",
      "Set-DnsClientServerAddress -InterfaceAlias 'Ethernet' -ServerAddresses ('1.1.1.1')",
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'",
    ]) {
      assert.equal(crossOsCommandViolations(command, "windows").length, 0, `Windows command wrongly refused: ${command}`)
    }
  })

  it("a placeholder is not a command", () => {
    // `{{IP}}` in a Windows command is the address the platform substitutes, not
    // iproute2's `ip`. Without masking, a correct `-IPAddress '{{IP}}'` matches
    // the `ip` token and the template is refused for containing a command it does
    // not contain.
    assert.equal(crossOsCommandViolations("New-NetIPAddress -IPAddress '{{IP}}' -PrefixLength {{PREFIX}}", "windows").length, 0)
    assert.equal(crossOsCommandViolations("New-NetIPAddress -IPAddress '{{IP}}' -PrefixLength {{PREFIX}}", "windows").length, 0)
    // And masking cannot smuggle a command through a placeholder: a username
    // cannot contain a space or a shell metacharacter.
    assert.equal(crossOsCommandViolations("ip route show {{IP}}", "windows").length > 0, true)
  })
})

describe("placeholder safety", () => {
  it("substitutes known placeholders", () => {
    const result = renderTemplate({ template: "ip addr add {{IP}}/{{PREFIX}} dev {{NIC}}", values: { IP: "10.0.0.30", PREFIX: "24", NIC: "ens18" }, engine: "linux" })
    assert.equal(result.ok, true)
    assert.equal(result.resolved, "ip addr add 10.0.0.30/24 dev ens18")
  })

  it("refuses an unknown placeholder", () => {
    const result = renderTemplate({ template: "run {{EVIL}}", values: {}, engine: "linux" })
    assert.equal(result.ok, false)
    assert.match(result.errors.join(" "), /Unknown placeholder/)
  })

  it("rejects a malformed IP", () => {
    const result = renderTemplate({ template: "ip addr add {{IP}}", values: { IP: "999.1.1.1" }, engine: "linux" })
    assert.equal(result.ok, false)
    assert.match(result.errors.join(" "), /IPv4/)
  })

  it("rejects a shell metacharacter in a value", () => {
    const result = renderTemplate({ template: "ip link set {{NIC}} up", values: { NIC: "ens18; rm -rf /" }, engine: "linux" })
    assert.equal(result.ok, false)
    assert.match(result.errors.join(" "), /unsafe/)
  })

  it("masks a password placeholder and refuses to inline it", () => {
    const result = renderTemplate({ template: "echo {{PASSWORD}}", values: { PASSWORD: "sup3rsecretvalue" }, engine: "linux" })
    assert.equal(result.ok, false)
    assert.equal(result.resolved, null)
    assert.match(result.masked, new RegExp(SECRET_MASK))
    assert.ok(!result.masked.includes("sup3rsecretvalue"))
  })

  it("flags a cross-OS token after substitution", () => {
    const result = renderTemplate({ template: "{{CMD}}", values: { CMD: "df -B1 -P" } as any, engine: "windows" })
    // CMD is not a known placeholder, so the refusal is on the placeholder.
    assert.equal(result.ok, false)
  })

  it("masks secrets in free-form text", () => {
    const masked = maskCommandSecrets("chpasswd hunter2hunter2", ["hunter2hunter2"])
    assert.ok(!masked.includes("hunter2hunter2"))
  })
})

describe("operation plans are change-driven and idempotent", () => {
  const template = {
    id: "tpl-1",
    name: "Test",
    slug: "test",
    family: "test",
    engine: "linux" as GuestEngine,
    version: 1,
    priority: 100,
    guestAgentRequired: true,
    osIds: ["testlinux"],
    versionPattern: null,
    operations: new Map(
      ["set_ip", "set_gateway", "set_dns", "set_hostname", "set_password", "create_user", "timezone", "guest_health", "enable_ssh"].map((operation) => [
        operation,
        {
          id: `op-${operation}`,
          operation,
          enabled: true,
          commandType: "guest-exec",
          shell: "linux-sh",
          command: "true",
          arguments: [],
          timeoutSeconds: 30,
          requiresRunning: true,
          requiresStopped: false,
          requiresGuestAgent: true,
          rebootRequired: false,
          dangerLevel: "safe",
          requiresConfirmation: false,
          supportsRollback: false,
          verificationRequired: true,
          verificationCommand: null,
          verificationParser: "exit-code",
          successCondition: "exit-code-0",
          rollbackCommand: null,
          rollbackArguments: null,
          fallbacks: [],
          stateKey: null,
          notes: null,
        },
      ]),
    ),
  } as unknown as ResolvedTemplate

  const snapshot = (overrides: Partial<GuestStateSnapshot> = {}): GuestStateSnapshot => ({
    ...EMPTY_SNAPSHOT,
    primaryInterface: "ens18",
    ipv4: ["10.0.0.20"],
    gateway: "10.0.0.1",
    dns: ["1.1.1.1"],
    hostname: "ip-10-0-0-20",
    users: ["root"],
    collectedAt: Date.now(),
    ...overrides,
  })

  it("plans only the DNS operation when only DNS is requested", () => {
    const plan = buildPlan({
      vmid: 114,
      detected: LINUX_DETECTED,
      template,
      snapshot: snapshot(),
      desired: { dns: ["8.8.8.8"] },
      mode: "change",
    })
    assert.deepEqual(plan.operations.map((operation) => operation.operation), ["set_dns"])
    assert.equal(plan.noChange, false)
  })

  it("does not plan set_ip for a DNS change", () => {
    const plan = buildPlan({
      vmid: 114,
      detected: LINUX_DETECTED,
      template,
      snapshot: snapshot(),
      desired: { dns: ["8.8.8.8"] },
      mode: "change",
    })
    assert.ok(!plan.operations.some((operation) => operation.operation === "set_ip"))
    assert.ok(!plan.operations.some((operation) => operation.operation === "set_password"))
  })

  it("marks an already-correct IP as already applied and skips it", () => {
    const plan = buildPlan({
      vmid: 114,
      detected: LINUX_DETECTED,
      template,
      snapshot: snapshot(),
      desired: { ip: "10.0.0.20", prefix: 24, gateway: "10.0.0.1" },
      mode: "change",
    })
    const ip = plan.operations.find((operation) => operation.operation === "set_ip")!
    assert.equal(ip.status, "skipped")
    assert.match(ip.reason, /Already applied/)
  })

  it("plans set_ip when the address differs", () => {
    const plan = buildPlan({
      vmid: 114,
      detected: LINUX_DETECTED,
      template,
      snapshot: snapshot(),
      desired: { ip: "10.0.0.30", prefix: 24, gateway: "10.0.0.1" },
      mode: "change",
    })
    const ip = plan.operations.find((operation) => operation.operation === "set_ip")!
    assert.equal(ip.status, "pending")
    assert.equal(ip.changed, true)
    assert.deepEqual(ip.previous.ipv4, ["10.0.0.20"])
  })

  it("reports no change when everything already matches", () => {
    const plan = buildPlan({
      vmid: 114,
      detected: LINUX_DETECTED,
      template,
      snapshot: snapshot(),
      desired: { ip: "10.0.0.20", prefix: 24, gateway: "10.0.0.1", dns: ["1.1.1.1"], hostname: "ip-10-0-0-20" },
      mode: "change",
    })
    assert.equal(plan.noChange, true)
  })

  it("walks the full sequence on first boot", () => {
    const plan = buildPlan({
      vmid: 114,
      detected: LINUX_DETECTED,
      template,
      snapshot: snapshot(),
      desired: { ip: "10.0.0.30", prefix: 24, gateway: "10.0.0.1", dns: ["1.1.1.1"], username: "root", password: "supersecretvalue" },
      mode: "first_boot",
    })
    const order = plan.operations.map((operation) => operation.operation)
    assert.ok(order.indexOf("set_ip") < order.indexOf("set_gateway"))
    assert.ok(order.indexOf("set_gateway") < order.indexOf("set_dns"))
    assert.ok(order.includes("set_password"))
  })

  it("marks a password step as unplanned when no password is supplied", () => {
    const plan = buildPlan({
      vmid: 114,
      detected: LINUX_DETECTED,
      template,
      snapshot: snapshot(),
      desired: { username: "root" },
      mode: "change",
    })
    // A change request without a password must not queue a credential rewrite.
    assert.ok(!plan.operations.some((operation) => operation.operation === "set_password"))
  })

  it("keeps a password out of the placeholder values", () => {
    const plan = buildPlan({
      vmid: 114,
      detected: LINUX_DETECTED,
      template,
      snapshot: snapshot(),
      desired: { username: "root", password: "supersecretvalue" },
      mode: "change",
    })
    const step = plan.operations.find((operation) => operation.operation === "set_password")!
    assert.equal(JSON.stringify(step.values).includes("supersecretvalue"), false)
    assert.equal(step.stdinSecret, "supersecretvalue")
  })

  it("skips an operation the OS profile does not define", () => {
    const plan = buildPlan({
      vmid: 114,
      detected: LINUX_DETECTED,
      template: { ...template, operations: new Map() } as unknown as ResolvedTemplate,
      snapshot: snapshot(),
      desired: { dns: ["8.8.8.8"] },
      mode: "change",
    })
    assert.equal(plan.operations[0].status, "skipped")
    assert.match(plan.operations[0].reason, /does not define/)
  })

  it("records the previous network state for rollback", () => {
    const plan = buildPlan({
      vmid: 114,
      detected: LINUX_DETECTED,
      template,
      snapshot: snapshot(),
      desired: { ip: "10.0.0.30", prefix: 24, gateway: "10.0.0.1" },
      mode: "change",
    })
    const ip = plan.operations.find((operation) => operation.operation === "set_ip")!
    assert.equal(ip.previous.interface, "ens18")
    assert.ok(ip.previous.capturedAt)
  })
})

describe("run status derivation", () => {
  it("is success when every step was skipped as already applied", () => {
    assert.equal(deriveRunStatus([{ status: "skipped" }, { status: "skipped" }]), "success")
  })

  it("is failed when nothing succeeded", () => {
    assert.equal(deriveRunStatus([{ status: "skipped" }, { status: "failed" }]), "failed")
  })

  it("is partial when some steps succeeded", () => {
    assert.equal(deriveRunStatus([{ status: "success" }, { status: "failed" }]), "partial")
  })

  it("is success when everything succeeded", () => {
    assert.equal(deriveRunStatus([{ status: "success" }, { status: "already_applied" }]), "success")
  })
})

describe("verification never trusts an exit code alone", () => {
  it("fails when the guest reports a different address", () => {
    const result = assertExpectation({ kind: "interfaces", ok: true, ipv4: ["10.0.0.20"], name: "ens18" }, { operation: "set_ip", engine: "linux", expected: { ip: "10.0.0.30" } })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.errorCode, "VERIFICATION_FAILED")
  })

  it("passes when the guest reports the requested address", () => {
    const result = assertExpectation({ kind: "interfaces", ok: true, ipv4: ["10.0.0.30"], name: "ens18" }, { operation: "set_ip", engine: "linux", expected: { ip: "10.0.0.30" } })
    assert.equal(result.ok, true)
  })

  it("fails when the account does not exist", () => {
    const result = assertExpectation({ kind: "users", ok: true, names: ["root"] }, { operation: "create_user", engine: "linux", expected: { expectedUsername: "zws" } })
    assert.equal(result.ok, false)
  })

  it("passes when the account exists", () => {
    const result = assertExpectation({ kind: "users", ok: true, names: ["root", "zws"] }, { operation: "create_user", engine: "linux", expected: { expectedUsername: "zws" } })
    assert.equal(result.ok, true)
  })

  it("compares the short hostname on Windows", () => {
    const result = assertExpectation({ kind: "hostname", ok: true, value: "srv01.corp.local" }, { operation: "set_hostname", engine: "windows", expected: { hostname: "srv01" } })
    assert.equal(result.ok, true)
  })

  it("fails on a hostname mismatch", () => {
    const result = assertExpectation({ kind: "hostname", ok: true, value: "other" }, { operation: "set_hostname", engine: "linux", expected: { hostname: "srv01" } })
    assert.equal(result.ok, false)
  })

  it("surfaces a parse failure rather than a pass", () => {
    const result = assertExpectation({ kind: "failed", ok: false, errorCode: "PARSE_FAILED", error: "bad output" }, { operation: "disk_usage", engine: "linux", expected: {} })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.errorCode, "PARSE_FAILED")
  })

  it("routes a df output through the disk observation", () => {
    const observation = observeFromOutput("df-posix", "Filesystem 1B-blocks Used Available Use% Mounted on\n/dev/sda1 85899345920 14336000000 71563345920 17% /", "linux")
    assert.equal(observation.kind, "disk")
  })

  it("rejects a Windows payload in the df observation", () => {
    const observation = observeFromOutput("df-posix", 'DeviceID=C: Size=100 FreeSpace=40', "linux")
    assert.equal(observation.kind, "failed")
  })
})

describe("guest exec timeouts and agent failures are distinguishable", () => {
  it("reports a timeout distinctly from a parse failure", async () => {
    const { client } = makeClient({
      execVMGuestCommandWithInput: { pid: 42 },
      getVMGuestExecStatus: { data: { exited: false } },
    })
    const outcome = await execGuestCommand({ client, node: "n1", vmid: 100, engine: "linux" }, { engine: "linux", shell: "linux-sh", command: "sleep 60", timeoutMs: 1_200, pollIntervalMs: 200 })
    assert.equal(outcome.ok, false)
    if (!outcome.ok) {
      assert.equal(outcome.timedOut, true)
      assert.equal(outcome.errorCode, "GUEST_EXEC_TIMEOUT")
    }
  })

  it("returns captured output on success", async () => {
    const { client } = makeClient({
      execVMGuestCommandWithInput: { pid: 7 },
      getVMGuestExecStatus: { data: { exited: true, exitcode: 0, "out-data": "hello\n" } },
    })
    const outcome = await execGuestCommand({ client, node: "n1", vmid: 100, engine: "linux" }, { engine: "linux", shell: "linux-sh", command: "echo hello", timeoutMs: 5_000 })
    assert.equal(outcome.ok, true)
    if (outcome.ok) assert.equal(outcome.stdout.trim(), "hello")
  })

  it("rejects a non-zero exit code when exit-code-0 is required", async () => {
    const { client } = makeClient({
      execVMGuestCommandWithInput: { pid: 8 },
      getVMGuestExecStatus: { data: { exited: true, exitcode: 2, "err-data": "boom" } },
    })
    const outcome = await execGuestCommand({ client, node: "n1", vmid: 100, engine: "linux" }, { engine: "linux", shell: "linux-sh", command: "false", timeoutMs: 5_000, acceptExitCodes: [0] })
    assert.equal(outcome.ok, false)
  })

  it("never spawns a guest process for a cross-OS command", async () => {
    const { client, calls } = makeClient()
    const outcome = await execGuestCommand({ client, node: "n1", vmid: 100, engine: "windows" }, { engine: "windows", shell: "linux-sh", command: "df -B1 -P", timeoutMs: 1_000 })
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.equal(outcome.errorCode, "CROSS_OS_VIOLATION")
    assert.equal(calls.length, 0)
  })
})

describe("vocabulary guards", () => {
  it("recognises exactly the supported operation names", () => {
    assert.ok(isGuestOperation("disk_usage"))
    assert.ok(isGuestOperation("set_ip"))
    assert.ok(!isGuestOperation("format_disk"))
    assert.ok(!isGuestOperation(undefined))
    assert.ok(GUEST_OPERATIONS.includes("firewall"))
  })

  it("recognises supported shells and native verbs", () => {
    assert.ok(isGuestShell("linux-sh"))
    assert.ok(!isGuestShell("fish"))
    assert.ok(isGuestNativeVerb("get-osinfo"))
    assert.ok(!isGuestNativeVerb("rm-rf"))
  })
})
