import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("windows guest exec timeouts", () => {
  const guestWrapper = readFileSync(join(process.cwd(), "lib/guest-automation/proxmox-guest.ts"), "utf8")
  const provision = readFileSync(join(process.cwd(), "lib/provision.ts"), "utf8")

  it("gives a Windows guest exec a realistic budget", () => {
    assert.ok(
      guestWrapper.includes('target.engine === "windows" ? 90_000 : 30_000'),
      "Windows guest exec must not share the short Linux budget",
    )
  })

  it("reads Windows guest network evidence with the longer budget", () => {
    assert.ok(provision.includes("isWindows ? 90_000 : 30_000"), "guest evidence read must allow slow Windows exec")
    assert.equal(provision.includes("vmid, Number(started.pid), 20_000)"), false, "the old 20s window times out healthy Windows guests")
  })
})
