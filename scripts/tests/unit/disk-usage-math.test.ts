import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { parseWindowsLogicalDiskJson, parseLinuxDf } from "@/lib/guest-automation/parsers"

const WINDOWS_JSON = JSON.stringify([
  {
    DeviceID: "C:",
    DriveType: 3,
    Size: 107267223552,
    FreeSpace: 83735191552,
    FileSystem: "NTFS",
    VolumeName: "",
  },
  {
    DeviceID: "D:",
    DriveType: 2,
    Size: 953869721600,
    FreeSpace: 953000000000,
    FileSystem: "NTFS",
    VolumeName: "",
  },
])

const LINUX_DF = [
  "Filesystem         1-blocks       Used    Available Capacity Mounted on",
  "/dev/sda1      104075075584 1630625792 102427672576       2% /",
  "tmpfs            411012608         0  411012608       0% /dev/shm",
].join("\n")

function assertConsistent(usage: { totalBytes: number; usedBytes: number; freeBytes: number; usedPercent: number }) {
  assert.ok(usage.totalBytes > 0, "totalBytes must be positive")
  assert.ok(usage.usedBytes + usage.freeBytes <= usage.totalBytes, "used + free must never exceed total")
  const expected = (usage.usedBytes / usage.totalBytes) * 100
  assert.ok(Math.abs(usage.usedPercent - expected) < 0.01, `usedPercent ${usage.usedPercent} must equal usedBytes / totalBytes * 100 (${expected})`)
}

describe("windows disk usage normalization (DriveType 3, exact bytes)", () => {
  it("selects the fixed system drive and reports exact bytes", () => {
    const usage = parseWindowsLogicalDiskJson(WINDOWS_JSON)
    assert.equal(usage.ok, true)
    if (!usage.ok || !usage.selected) return
    assert.equal(usage.selected.name, "C:")
    assert.equal(usage.selected.filesystem, "NTFS")
    assert.equal(usage.selected.totalBytes, 107267223552)
    assert.equal(usage.selected.freeBytes, 83735191552)
    assert.equal(usage.selected.usedBytes, 107267223552 - 83735191552)
    assert.equal(usage.collector, "windows_cim")
    assertConsistent(usage.selected)
  })

  it("ignores removable drives (DriveType 2)", () => {
    const usage = parseWindowsLogicalDiskJson(WINDOWS_JSON)
    assert.equal(usage.ok && usage.volumes.some((volume) => volume.device === "D:"), false, "DriveType 2 must be skipped")
  })

  it("refuses a df payload instead of guessing (cross-OS guard)", () => {
    const usage = parseWindowsLogicalDiskJson(LINUX_DF)
    assert.equal(usage.ok, false)
    assert.equal(usage.errorCode, "PARSE_FAILED")
  })
})

describe("linux disk usage normalization (df -B1 -P)", () => {
  it("prefers the root filesystem and reports exact bytes", () => {
    const usage = parseLinuxDf(LINUX_DF)
    assert.equal(usage.ok, true)
    if (!usage.ok || !usage.selected) return
    assert.equal(usage.selected.name, "/")
    assert.equal(usage.selected.system, true)
    assert.equal(usage.selected.device, "/dev/sda1")
    assert.equal(usage.selected.totalBytes, 104075075584)
    assert.equal(usage.selected.usedBytes, 1630625792)
    assert.equal(usage.selected.freeBytes, 102427672576)
    assertConsistent(usage.selected)
  })

  it("refuses a Windows payload instead of guessing (cross-OS guard)", () => {
    const usage = parseLinuxDf(WINDOWS_JSON)
    assert.equal(usage.ok, false)
    assert.equal(usage.errorCode, "PARSE_FAILED")
  })
})
