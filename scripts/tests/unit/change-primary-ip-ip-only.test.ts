import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const orchestrator = readFileSync(join(process.cwd(), "lib/vm-network-orchestrator.ts"), "utf8")

describe("change primary IP is IP-only", () => {
  it("keeps the VM's current bridge unless a bridge is explicitly requested", () => {
    assert.ok(
      orchestrator.includes('cleanText(input.manualBridge) || cleanText(snapshot.net0.bridge)'),
      "desiredBridge must prefer the VM's existing net0 bridge over the pool bridge",
    )
  })

  it("does not send DNS to the guest unless the caller asked for it", () => {
    assert.ok(orchestrator.includes('applyDns: input.applyDns === true'), "guest desired DNS must be gated on an explicit request")
    assert.ok(
      orchestrator.includes('dns: input.applyDns === true ? dns.split'),
      "an IP-only change must pass an empty DNS list so the guest resolver is untouched",
    )
  })

  it("the admin routes expose the explicit DNS opt-in", () => {
    for (const route of [
      "app/api/admin/vms/[id]/network/change-primary-ip/route.ts",
      "app/api/admin/vps/[id]/change-ip/route.ts",
    ]) {
      const source = readFileSync(join(process.cwd(), route), "utf8")
      assert.ok(source.includes("applyDns: body"), `${route} must forward applyDns`)
    }
  })
})
