import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("vm runtime snapshot must not fabricate disk metrics", () => {
  const source = readFileSync(join(process.cwd(), "lib/vm-runtime-status.ts"), "utf8")

  it("keeps guest disk samples instead of writing runtime zeros", () => {
    assert.ok(source.includes("lastDiskBytes"), "runtime refresh must carry the last real guest disk sample forward")
    assert.equal(source.includes("diskUsedBytes: BigInt(Math.max(0, Math.floor(Number(runtime?.disk || 0))))"), false, "raw runtime disk must not be written unconditionally")
  })

  it("writes the carried-forward values", () => {
    assert.ok(source.includes("diskUsedBytes: BigInt(diskUsedBytes)"))
    assert.ok(source.includes("diskTotalBytes: BigInt(diskTotalBytes)"))
  })

  it("never lets a zero runtime 'used' overwrite a real sample", () => {
    // Regression: qemu reports a real block capacity but no guest usage, so
    // `runtime.disk === 0` while `runtime.maxdisk` looks perfectly real. An
    // earlier version treated "the total looks real" as permission to write the
    // zero, which put 0% disk usage back into the customer UI.
    assert.ok(source.includes("runtimeDiskIsReal"), "runtime disk values must be gated on a positive used value")
    assert.ok(
      source.includes("const runtimeDiskIsReal = runtimeDiskUsed > 0 && diskTotalLooksReal"),
      "a real-looking capacity alone must not license a zero used value",
    )
    assert.equal(
      source.includes("runtimeDiskUsed > 0 || diskTotalLooksReal ? runtimeDiskUsed"),
      false,
      "the OR condition that admitted zero must be gone",
    )
  })
})

describe("customer VM state mapping", () => {
  const source = readFileSync(join(process.cwd(), "app/client-area/vps/[id]/page.tsx"), "utf8")

  it("an active VM is not shown as provisioning because of a stale order row", () => {
    const activeIndex = source.indexOf('if (raw === "ACTIVE" || raw === "RUNNING" || raw === "OVERLOADED" || runtime === "running") return "running"')
    const provisioningIndex = source.indexOf('if (provisioningStates.has(raw) || provisioningStates.has(prov)) return "provisioning"', activeIndex)
    assert.ok(activeIndex > 0, "active mapping must exist")
    assert.ok(provisioningIndex > activeIndex, "provisioning must be evaluated after the active/power-state mapping")
  })
})
