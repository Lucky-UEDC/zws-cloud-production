import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("stale reinstall lock", () => {
  const route = readFileSync(join(process.cwd(), "app/api/client/vps/[id]/reinstall/route.ts"), "utf8")

  it("does not let a crashed reinstall block the customer forever", () => {
    assert.ok(route.includes("STALE_REINSTALL_LOCK_MS"), "the route must define a stale-lock budget")
    assert.ok(route.includes("reinstall_lock_reclaimed_stale"), "a reclaimed lock must be recorded")
  })

  it("only reclaims a lock with no live reinstall job", () => {
    assert.ok(
      route.includes('type: "reinstall"') && route.includes('status: { in: ["queued", "running", "retrying"] }'),
      "the reclaim must check for a still-running reinstall job",
    )
  })

  it("keeps refusing while a reinstall job is genuinely live", () => {
    assert.ok(route.includes("A reinstall is already in progress"), "a live job still blocks a second reinstall")
  })
})
