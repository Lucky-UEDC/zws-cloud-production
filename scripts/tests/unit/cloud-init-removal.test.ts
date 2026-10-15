/**
 * Cloud-Init removal guard.
 *
 * This suite exists to fail if anyone reintroduces a Cloud-Init dependency into
 * guest management. The checks are deliberately textual and file-scoped: the
 * requirement is about which Proxmox keys and commands the codebase may write,
 * and a behavioural test cannot observe a `qm set --ipconfig0` that never runs
 * in the test environment.
 *
 * Read-only legacy uses are listed explicitly, so removing a real write is a
 * test failure and adding a new read is a deliberate edit rather than an accident.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

// The suite runs with the repository root as cwd, matching the other unit tests.
const ROOT = process.cwd()

function read(path: string) {
  return readFileSync(join(ROOT, path), "utf8")
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue
    const full = join(dir, entry)
    if (statSync(join(ROOT, full)).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/** Files that write to a live VM. A Cloud-Init write in any of them is a defect. */
const GUEST_MANAGEMENT_FILES = [
  "lib/provision.ts",
  "lib/vps-control.ts",
  "lib/vm-network-orchestrator.ts",
  "lib/admin-vm-management.ts",
  "lib/vm-runtime-health.ts",
  "app/api/admin/vms/[id]/edit/route.ts",
]

test("no guest-management file writes a Cloud-Init key into a VM config", () => {
  for (const file of GUEST_MANAGEMENT_FILES) {
    const source = read(file)
    // Strip comments so the explanatory notes about what was removed do not
    // themselves trip the guard.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
    for (const key of ["ciuser", "cipassword", "ipconfig0", "ipconfig1", "searchdomain", "nameserver", "citype", "cicustom"]) {
      const write = new RegExp(String.raw`[\w.[\]]{1,40}\b${key}\s*[:=]`)
      const match = code.match(write)
      assert.equal(
        match,
        null,
        `${file} assigns a Cloud-Init key ("${key}"). Guest configuration must go through the OS template and qm guest.`,
      )
    }
  }
})

test("no guest-management file runs qm cloudinit", () => {
  for (const file of [...GUEST_MANAGEMENT_FILES, "lib/proxmox-console-repair.ts"]) {
    const source = read(file)
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
    assert.equal(
      code.match(/\b(updateCloudInit|dumpCloudInit)\s*\(/),
      null,
      `${file} calls a qm cloudinit helper. Guest automation uses the QEMU guest agent only.`,
    )
  }
})

test("every remaining Cloud-Init reference in the repo is a read, a label, or a redaction", () => {
  /**
   * Files allowed to still name Cloud-Init, each with the reason it is allowed.
   *
   * The requirement is that nothing *depends* on Cloud-Init. Legacy templates
   * may still have it installed, so reads that describe or skip pre-existing
   * Cloud-Init state stay. Removing a read is a test failure; adding a new read
   * is a deliberate edit to this table rather than an accident.
   */
  const allowed = new Map<string, string>([
    // -- legacy reads of pre-adoption VM state --------------------------------
    ["lib/proxmox.ts", "the client methods themselves, kept for read-only legacy inspection"],
    ["lib/vm-ip-discovery.ts", "reads a legacy ipconfig0 when reconciling pre-adoption VMs"],
    ["lib/admin-vm-management.ts", "reads a legacy ipconfig0 to display a VM's configured address"],
    ["lib/production-vps-reconciliation.ts", "reads legacy ipconfig0 to reconcile pre-adoption VMs"],
    ["lib/vm-duplicate-quarantine.ts", "reads legacy ipconfig0 to tell two VMs apart"],

    // -- must keep skipping Cloud-Init drives when picking a disk -------------
    ["lib/provision.ts", "disk-key detection that must keep skipping legacy cloudinit drives"],
    ["lib/proxmox-snapshots.ts", "disk-key detection for snapshot targets"],
    ["lib/vm-deletion.ts", "disk-key detection when detaching storage"],
    ["lib/console-mode.ts", "serial-console resolution for guests that predate guest automation"],
    ["lib/console-resolution.ts", "console-type field naming that flows from console-mode"],
    ["lib/ip-pool.ts", "a persisted column name from before the change"],

    // -- a legacy DB column that is still synced and displayed ----------------
    ["lib/os-template-sync.ts", "the legacy cloudInitSupported column, still synced for history"],
    ["lib/os-template-availability.ts", "the same column, as a fallback when no Proxmox config is loaded"],
    ["lib/vm-db-truth.ts", "the same column, selected for the admin reconciliation view"],
    ["lib/provisioning-status.ts", "customer-facing status text derived from a legacy step name"],

    // -- documentation of the removal itself ----------------------------------
    ["lib/guest-automation/first-boot.ts", "comments describing the host/guest split that replaced it"],
    ["lib/vps-control.ts", "none — asserted to be clean below"],
    ["lib/proxmox-console-repair.ts", "recorded diagnostics explaining the two repair paths that were removed"],
    ["lib/vm-runtime-health.ts", "comments describing the replacement"],
    ["lib/vm-network-orchestrator.ts", "none — asserted to be clean below"],
    ["app/api/admin/compute-nodes/[id]/templates/[templateId]/action/route.ts", "comments describing the replaced action"],
    ["app/api/admin/vms/[id]/edit/route.ts", "comments describing the removed write, plus a config-diff redaction"],
    ["app/api/client/vps/[id]/password/route.ts", "a comment explaining why the Cloud-Init fallback was removed"],
    ["app/admin/compute-nodes/[id]/page.tsx", "the legacy cloudInitSupported column, relabelled as guest-agent readiness"],
    ["lib/provisioning-placement.ts", "a comment describing the check that replaced the Cloud-Init one"],
    ["lib/guest-automation/adoption.ts", "a comment explaining which servers predate the removal"],
    // -- cross-OS guard tokens ----------------------------------------------------
    ["lib/guest-automation/constants.ts", "Linux-only tokens (cloud-init, cloudinit) that Windows must reject"],
    // -- shared Proxmox agent flag helper ----------------------------------------
    ["lib/proxmox-agent-flag.ts", "reads the Proxmox agent flag; no Cloud-Init writes"],
    // -- storage capability detection --------------------------------------------
    ["lib/proxmox/storage-capabilities.ts", "disk-key detection that must keep skipping legacy cloudinit drives when reading real disk formats"],
    // -- Proxmox ACL reference table -------------------------------------------------
    // `VM.Config.Cloudinit` is the name Proxmox itself gives that privilege. It
    // appears here only so the panel can name the privilege it is missing; it is
    // never set on a VM, and granting it is never suggested by any setup guide.
    ["lib/proxmox/permission-requirements.ts", "the Proxmox privilege name VM.Config.Cloudinit, listed as a privilege the panel never requires"],
  ])

  const offenders: string[] = []
  for (const file of walk("lib").concat(walk("app"))) {
    const source = readFileSync(join(ROOT, file), "utf8")
    if (!/cloud-?init|cloudInit|ipconfig0|ciuser|cipassword/i.test(source)) continue
    if (!allowed.has(file)) offenders.push(file)
  }
  assert.deepEqual(offenders, [], `Cloud-Init references outside the allow-list: ${offenders.join(", ")}`)
})

test("vps-control has no Cloud-Init dependency at all", () => {
  const source = read("lib/vps-control.ts")
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
  assert.equal(code.match(/cloud-?init|cloudInit/i), null, "lib/vps-control.ts must not reference Cloud-Init")
  assert.equal(code.match(/ipconfig0|ciuser|cipassword|updateCloudInit|dumpCloudInit/), null, "lib/vps-control.ts must not touch Cloud-Init keys")
})

test("the provisioning gate asks the guest instead of reading injected config", () => {
  const source = read("lib/provision.ts")
  assert.match(source, /guestAgentOnline/)
  assert.match(source, /guestIpApplied/)
  assert.match(source, /guestGatewayApplied/)
  assert.match(source, /guestDnsApplied/)
  // The Cloud-Init evidence object is gone from the gate input.
  assert.doesNotMatch(source, /cloudInitEvidence/)
  assert.match(source, /guestAutomationEvidence/)
})

test("guest automation runs before the service is marked ACTIVE", () => {
  const source = read("lib/provision.ts")
  const configure = source.indexOf("await configureGuestAfterBoot(")
  const gate = source.indexOf("await verifyProvisioningHardGateWithConvergence({")
  const active = source.indexOf("status: mappedStatus")
  assert.ok(configure > -1, "provisioning must configure the guest")
  assert.ok(gate > -1, "provisioning must run the hard gate")
  assert.ok(active > -1, "provisioning must record a mapped status")
  assert.ok(configure < gate, "the guest must be configured before the gate verifies it")
  assert.ok(gate < active, "the gate must pass before the service is marked ACTIVE")
})
