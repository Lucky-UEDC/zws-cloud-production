import { describe, it } from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import assert from "node:assert/strict"

import { buildPreBootVmConfig } from "@/lib/guest-automation/first-boot"

describe("preboot VM network config regression", () => {
  it("buildPreBootVmConfig never emits a malformed net0 value", () => {
    const config = buildPreBootVmConfig({
      vmid: 465544,
      hostname: "unit-test",
      description: null,
      macAddress: "02:10:11:65:07:dd",
      netBridge: "vmbr0",
    })
    assert.equal(config.net0, undefined, "net0 must be owned by callers (net0Value)")
    assert.equal(JSON.stringify(config).includes("macaddr="), false, "macaddr assignment is not a valid net0 value")
  })

  it("provision.ts applies net0Value after the preboot helper so it cannot be overwritten", () => {
    const source = readFileSync(join(process.cwd(), "lib/provision.ts"), "utf8")
    const helperIdx = source.indexOf("...buildPreBootVmConfig(")
    const net0Idx = source.indexOf("net0: net0Value(input.macAddress")
    assert.ok(helperIdx > 0, "buildPreBootVmConfig spread must exist")
    assert.ok(net0Idx > helperIdx, "net0Value must be assigned after the helper spread")
  })

  it("proxmox error classification does not misclassify vmbr configs as bridge-missing", () => {
    const source = readFileSync(join(process.cwd(), "lib/proxmox.ts"), "utf8")
    assert.equal(source.includes("|vmbr\\d+/.test"), false, "bare vmbr matcher misclassifies network config errors")
    const status = readFileSync(join(process.cwd(), "lib/provisioning-status.ts"), "utf8")
    assert.ok(status.includes("NETWORK_CONFIG_INVALID"), "config validation errors have their own label")
  })
})
