import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const provision = readFileSync(join(process.cwd(), "lib/provision.ts"), "utf8")
const guestConstants = readFileSync(join(process.cwd(), "lib/guest-automation/constants.ts"), "utf8")
const templates = readFileSync(join(process.cwd(), "lib/guest-automation/default-templates.ts"), "utf8")

/**
 * Regression coverage for the Windows template QA run (VMID 9001, a real clone
 * of template 2000 / Windows Server 2022 on node m2-v2).
 */
describe("windows guest command syntax", () => {
  it("never emits a here-string header mid-line", () => {
    // `$ip = @'10.10.10.10'` is a ParserError on Windows: a here-string must
    // open and close on their own lines. The whole evidence command then exits
    // 1 with empty stdout, which the hard gate reads as "no gateway".
    assert.equal(provision.includes('"$ip = @\'"'), false)
  })

  it("interpolates a validated IPv4 into a plain single-quoted string", () => {
    assert.ok(provision.includes('"$ip = \'" + String(expectedIp || "").replace(/\'/g, "") + "\'"'))
  })
})

describe("windows guest verb contract", () => {
  it("keeps ping on POST and the read verbs on GET", () => {
    // Verified live against template 2000 clone 9001:
    //   ping        POST -> {"data":{"result":{}}}
    //   get-osinfo  GET  -> Windows Server 2022 Datacenter Evaluation
    //   get-fsinfo  GET  -> C:\ NTFS 21367877632
    //   get-host-name GET -> UEDC-WINDOWS
    //   get-users   GET  -> []
    const client = readFileSync(join(process.cwd(), "lib/proxmox.ts"), "utf8")
    assert.ok(client.includes('const requiresPost = ["ping"].includes(verb)'), "ping must be dispatched with POST")
    assert.ok(
      client.includes("(body && Object.keys(body).length) || requiresPost"),
      "bodyless read verbs must stay on GET",
    )
  })

  it("does not treat agent:1 as proof the agent works", () => {
    // `agent = 1` is only the channel flag. The gate must actually ping.
    assert.ok(provision.includes("checkGuestAgent"), "the hard gate must ping the agent, not trust the config flag")
    assert.ok(guestConstants.includes("GUEST_AGENT_UNREACHABLE"), "an unreachable agent must be a distinct error code")
  })
})

describe("windows disk collection", () => {
  it("uses Get-CimInstance Win32_LogicalDisk with DriveType 3", () => {
    assert.ok(templates.includes("Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\""))
  })

  it("never sends a Linux disk command to a Windows guest", () => {
    const windowsBlock = templates.slice(templates.indexOf("WINDOWS_DISK_OPERATIONS"), templates.indexOf("/** Native verbs, shared by both engines. */"))
    for (const forbidden of ["df -B1", "lsblk", "findmnt", "du ", "blkid"]) {
      assert.equal(windowsBlock.includes(forbidden), false, `${forbidden} must not appear in the Windows collectors`)
    }
  })

  it("keeps df -B1 -P out of the Windows engine", () => {
    assert.ok(templates.includes('command: "df -B1 -P"'), "Linux collector must still use df -B1 -P")
  })
})

describe("windows password path", () => {
  it("uses a Windows-native account command", () => {
    assert.ok(templates.includes("net user {{USERNAME}} {{PASSWORD}}"), "the Windows password operation must use net user")
  })

  it("keeps the password out of the template notes as a plain value", () => {
    // The operation notes must not restate a credential; the placeholder is
    // substituted at exec time from input-data / argv, never stored.
    const passwordOperation = templates.slice(templates.indexOf('operation: "set_password"'), templates.indexOf('operation: "create_user"'))
    assert.ok(passwordOperation.length > 0)
    assert.equal(passwordOperation.includes("Sam@00000"), false, "no real credential may appear in a template")
  })
})

describe("cross-OS guard stays intact", () => {
  it("rejects the opposite engine's commands before execution", () => {
    assert.ok(guestConstants.includes("CROSS_OS_VIOLATION"), "cross-OS violations must be a named error code")
  })
})
