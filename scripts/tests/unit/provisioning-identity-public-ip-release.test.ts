import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const source = readFileSync(join(process.cwd(), "lib/provisioning-identity.ts"), "utf8")

/**
 * `vm_provisioning_identities.public_ip` carries a unique index, so one identity
 * row owns an address for as long as the row holds it.
 *
 * Production evidence: seven addresses in the 103.216.170.0/24 pool (plus
 * 103.216.168.254) were each still held by an identity row whose
 * `vpsInstance` row was `status = 'deleted'` with a NULL `ipAddress`. Those
 * addresses could never be allocated again, yet `allocateIp` treats a dead
 * service as free and kept handing them out. Each one then failed inside
 * `ensureProvisioningIdentity` with a bare unique-constraint violation, after
 * the guest had already been cloned, resized and started.
 */
describe("provisioning identity public_ip release", () => {
  it("releases an address whose owning service is gone", () => {
    assert.ok(
      source.includes("releaseAbandonedPublicIp"),
      "a dead owner's address must be released, not left to collide",
    )
    assert.ok(
      /publicIp:\s*null/.test(source),
      "the abandoned row must clear public_ip so the unique index frees the address",
    )
  })

  it("calls the release before it can collide on the unique index", () => {
    const repairIndex = source.indexOf("async function repairProvenStalePublicIp")
    const releaseCall = source.indexOf("await releaseAbandonedPublicIp({")
    assert.ok(repairIndex > -1, "repairProvenStalePublicIp must exist")
    assert.ok(releaseCall > repairIndex, "the release must live inside the repair path")
    const existingLookup = source.indexOf("where: { orderId: input.orderId }")
    assert.ok(existingLookup > -1, "the order's own identity lookup must be findable")
    assert.ok(
      releaseCall < existingLookup,
      "the release must run before the order's own row is written, or the unique index still throws",
    )
  })

  it("only releases when the owning service is definitively gone", () => {
    assert.ok(source.includes("serviceIsGone"), "the release must be gated on the owner being gone")
    for (const status of ["DELETED", "TERMINATED", "CANCELLED", "CANCELED"]) {
      assert.ok(source.includes(`"${status}"`), `${status} must count as a gone service`)
    }
    assert.ok(
      source.includes("if (!conflict || conflict.orderId === input.orderId) return"),
      "an order must never release its own row",
    )
  })

  it("never takes an address a live service or a live allocation still holds", () => {
    assert.ok(
      /status:\s*\{\s*notIn:\s*TERMINAL_SERVICE_STATUSES\s*\}/.test(source),
      "a live service holding the address must block the release",
    )
    assert.ok(
      source.includes("ipAddress: requestedIp"),
      "the live-service check must be scoped to the contested address",
    )
    assert.ok(
      source.includes("if (liveService) return") && source.includes("if (liveAllocation) return"),
      "both live-owner checks must actually abort the release",
    )
  })

  it("excludes the current order's own allocation from the live-allocation check", () => {
    // The repair runs before markIpUsed, so at that moment the address is held
    // by this order's own `reserved` allocation. Without excluding it the repair
    // would refuse to undo the very collision it exists to undo.
    assert.ok(
      source.includes("vpsInstanceId: input.vpsInstanceId, conflict"),
      "the current order's service must be passed to the release so its own allocation is excluded",
    )
    assert.ok(
      source.includes("foreignOwner"),
      "the live-allocation query must exclude the current order's service",
    )
  })

  it("keeps the row, so the order stays locked to its VMID", () => {
    assert.ok(
      !/identityClient\(\)\.delete/.test(source),
      "the abandoned identity row must not be deleted: it is what stops a second clone",
    )
    assert.ok(
      source.includes("owning_service_deleted_and_address_unclaimed"),
      "the release must record why it happened",
    )
  })
})