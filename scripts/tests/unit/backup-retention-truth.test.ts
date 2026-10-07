import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { effectiveBackupLimit, selectBackupsToPrune } from "@/lib/backups-retention-limit"

describe("effective backup limit", () => {
  it("takes the stricter of max and retention", () => {
    // The live production plan: maxBackups 15, retentionCount 10. Retention is
    // the promise about what survives, so 10 is the real limit.
    assert.equal(effectiveBackupLimit({ maxBackups: 15, retentionCount: 10 }), 10)
    assert.equal(effectiveBackupLimit({ maxBackups: 10, retentionCount: 15 }), 10)
  })

  it("returns null only when the plan sets no limit at all", () => {
    assert.equal(effectiveBackupLimit({ maxBackups: null, retentionCount: null }), null)
  })

  it("honours whichever single limit exists", () => {
    assert.equal(effectiveBackupLimit({ maxBackups: 12, retentionCount: null }), 12)
    assert.equal(effectiveBackupLimit({ maxBackups: null, retentionCount: 4 }), 4)
  })

  it("treats zero as a real limit, not as absent", () => {
    // 0 means "keep nothing"; falling back to the other number would silently
    // grant storage the admin never approved.
    assert.equal(effectiveBackupLimit({ maxBackups: 0, retentionCount: 10 }), 0)
    assert.equal(effectiveBackupLimit({ maxBackups: 10, retentionCount: 0 }), 0)
  })

  it("clamps negatives rather than reporting them", () => {
    assert.equal(effectiveBackupLimit({ maxBackups: -5, retentionCount: 10 }), 0)
  })
})

describe("selecting backups to prune", () => {
  const at = (iso: string) => new Date(iso)
  const rows = [
    { id: "a", createdAt: at("2026-01-01T00:00:00Z") },
    { id: "b", createdAt: at("2026-01-02T00:00:00Z") },
    { id: "c", createdAt: at("2026-01-03T00:00:00Z") },
    { id: "d", createdAt: at("2026-01-04T00:00:00Z") },
  ]

  it("prunes the oldest first", () => {
    assert.deepEqual(selectBackupsToPrune({ completedBackups: rows, limit: 2 }).map((row) => row.id), ["a", "b"])
  })

  it("prunes nothing when under the limit", () => {
    assert.deepEqual(selectBackupsToPrune({ completedBackups: rows, limit: 4 }), [])
    assert.deepEqual(selectBackupsToPrune({ completedBackups: rows, limit: 99 }), [])
  })

  it("prunes nothing when the plan has no limit", () => {
    assert.deepEqual(selectBackupsToPrune({ completedBackups: rows, limit: null }), [])
  })

  it("does not depend on input order", () => {
    const shuffled = [rows[2], rows[0], rows[3], rows[1]]
    assert.deepEqual(selectBackupsToPrune({ completedBackups: shuffled, limit: 2 }).map((row) => row.id), ["a", "b"])
  })
})

describe("retention is enforced, not just advertised", () => {
  it("runs on the account-wide scope, not only per (schedule, vmid)", () => {
    const source = readFileSync(join(process.cwd(), "lib/proxmox-backup.ts"), "utf8")
    // Per-policy retention is scoped to one schedule+vmid. Usage is counted per
    // customer, so without an account-wide pass a multi-VM customer can never
    // get back under maxBackups.
    assert.ok(source.includes("pruneBackupsToRetention"), "the completion path must prune account-wide too")
    assert.ok(source.includes("row.customerId"), "the account-wide prune must be scoped to the backup's customer")
  })

  it("never lets a failed storage listing silently disable pruning", () => {
    const source = readFileSync(join(process.cwd(), "lib/proxmox-backup.ts"), "utf8")
    const fn = source.slice(source.indexOf("export async function enforceVmBackupRetention"))
    // The bug: an empty set made every candidate look "not on storage", so every
    // candidate was skipped and retention did nothing while appearing to succeed.
    assert.ok(fn.includes("let existing: Set<string> | null"), "the listing result must be nullable so failure is distinguishable from empty")
    assert.ok(fn.includes("if (existing && volid && !existing.has"), "the already-gone shortcut must only apply when the listing worked")
    assert.ok(/catch \(error: any\) \{\s*\n\s*\/\/ The listing/.test(fn), "a failed listing must be logged, not swallowed")
  })

  it("deletes the artifact before reducing the recorded usage", () => {
    const retention = readFileSync(join(process.cwd(), "lib/backups-retention.ts"), "utf8")
    const deleteIdx = retention.indexOf("await deleteArtifact(candidate)")
    const updateIdx = retention.indexOf("status: \"cancelled\"")
    assert.ok(deleteIdx > 0 && updateIdx > deleteIdx, "the row may only be marked cancelled after storage confirms deletion")
  })

  it("leaves the row in place for the audit trail", () => {
    const retention = readFileSync(join(process.cwd(), "lib/backups-retention.ts"), "utf8")
    assert.equal(retention.includes("deleteMany"), false, "pruning must never hard-delete backup history")
    assert.ok(retention.includes("prunedByRetention"), "the reason must be recorded on the row")
  })

  it("reports what it could not prune instead of pretending", () => {
    const retention = readFileSync(join(process.cwd(), "lib/backups-retention.ts"), "utf8")
    assert.ok(retention.includes("unpruned"), "unreachable storage must be reported")
    assert.ok(/node_unavailable/.test(retention), "an unreachable node must be a named reason")
  })

  it("never prunes a running or failed backup", () => {
    const retention = readFileSync(join(process.cwd(), "lib/backups-retention.ts"), "utf8")
    assert.ok(
      /status: \{ in: \[\.\.\.COUNTED_STATUSES\] \}/.test(retention),
      "only completed backups may be selected for pruning",
    )
  })
})

describe("plan surfaces agree on the limit", () => {
  it("the customer usage summary reports the effective limit", () => {
    const entitlements = readFileSync(join(process.cwd(), "lib/billing/entitlements.ts"), "utf8")
    assert.ok(entitlements.includes("effectiveBackupLimit"), "backupsRemaining must be derived from the effective limit")
    assert.ok(entitlements.includes("planMaxBackups"), "the raw plan limit must still be exposed for diagnostics")
    // The old line computed remaining straight off maxBackups and ignored
    // retention entirely.
    assert.equal(
      /backupsRemaining = entitlement\.maxBackups == null \? null : Math\.max\(0, entitlement\.maxBackups/.test(entitlements),
      false,
      "backupsRemaining must not be computed from maxBackups alone",
    )
  })

  it("the plan card does not advertise two different limits", () => {
    const plans = readFileSync(join(process.cwd(), "app/client-area/backup-plans/page.tsx"), "utf8")
    assert.equal(plans.includes("Retention: latest"), false, "the second, contradictory limit must not be shown")
    assert.ok(plans.includes("planBackupLimit(plan)"), "the card must show the effective limit")
  })

  it("the admin form exposes retention instead of hiding it", () => {
    const admin = readFileSync(join(process.cwd(), "app/admin/billing/backup-plans/page.tsx"), "utf8")
    assert.ok(admin.includes("setRetentionCount"), "an admin must be able to see and set retention")
    assert.ok(admin.includes("retentionCount: gb(retentionCount)"), "retention must be saved, not left at its seed value")
  })

  it("the pure retention arithmetic stays free of server-only imports", () => {
    // A customer page imports this module; pulling prisma or the Proxmox client
    // into it would break the client bundle.
    const source = readFileSync(join(process.cwd(), "lib/backups-retention-limit.ts"), "utf8")
    for (const forbidden of ["@/lib/db", "@/lib/proxmox", "prisma.", "createProxmoxClient"]) {
      assert.equal(source.includes(forbidden), false, `retention arithmetic must not import ${forbidden}`)
    }
  })
})