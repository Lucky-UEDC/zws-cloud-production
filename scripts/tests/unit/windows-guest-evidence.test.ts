import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const provision = readFileSync(join(process.cwd(), "lib/provision.ts"), "utf8")

describe("windows guest network evidence selects the real adapter", () => {
  it("does not rely on Get-NetIPConfiguration enumeration order", () => {
    // The failure this pins: `Get-NetIPConfiguration | Select -First 1` returns
    // whatever is enumerated first, which on the Windows template is a
    // disconnected or APIPA (169.254.x) interface. The gate then reported
    // guestGatewayApplied/guestDnsApplied = false on a healthy guest.
    assert.equal(
      provision.includes("Where-Object { $_.IPv4Address } | Select-Object -First 1"),
      false,
      "first-by-enumeration adapter selection must be gone",
    )
  })

  it("prefers the adapter that already holds the expected IP", () => {
    assert.ok(
      provision.includes("IPv4Address.IPAddress -contains $ip"),
      "the evidence read must select the adapter carrying the expected IP",
    )
    assert.ok(provision.includes("async function readGuestNetworkEvidence"), "evidence reader must exist")
  })

  it("builds a syntactically valid single-line command", () => {
    // Regression found on the real Windows clone (VMID 9001): `$ip = @'x'`
    // is a ParserError ("No characters are allowed after a here-string
    // header"), so the command exited 1 with empty stdout and the gate read it
    // as "no gateway". Verified against the guest: the here-string form exits
    // 1 with a ParserError, the plain quoted form exits 0 and returns the IP.
    assert.equal(
      provision.includes('"$ip = @\'"'),
      false,
      "a here-string header must never appear mid-line in the guest command",
    )
    assert.ok(
      provision.includes('"$ip = \'" + String(expectedIp || "").replace(/\'/g, "") + "\'"'),
      "the expected IP must be interpolated into a plain single-quoted string",
    )
  })

  it("falls back to a real hardware adapter that is Up", () => {
    assert.ok(
      provision.includes("Get-NetAdapter | Where-Object { $_.HardwareInterface -and $_.Status -eq 'Up' }"),
      "the fallback must pick a physical adapter that is Up, never a virtual/APIPA one",
    )
  })

  it("still reports gateway, DNS and search domain as before", () => {
    for (const marker of ["Write-Output ('GW='", "Write-Output ('DNS='", "Write-Output ('SEARCH='"]) {
      assert.ok(provision.includes(marker), `missing ${marker}`)
    }
  })

  it("stays Windows-only: no Linux command reaches the Windows path", () => {
    const windowsBranch = provision.slice(provision.indexOf("readGuestNetworkEvidence"), provision.indexOf("readGuestNetworkEvidence") + 2200)
    const linuxCommands = windowsBranch.match(/\b(ip route show|resolv\.conf|nmcli|systemctl)\b/g) || []
    // The Linux branch is the ternary's `false` arm and legitimately uses
    // `ip route`; nothing Linux-only may appear inside the Windows argv.
    const windowsArgv = windowsBranch.slice(0, windowsBranch.indexOf("]\n          .join") + 40)
    for (const command of linuxCommands) {
      assert.equal(windowsArgv.includes(command), false, `${command} must not be sent to a Windows guest`)
    }
  })
})
