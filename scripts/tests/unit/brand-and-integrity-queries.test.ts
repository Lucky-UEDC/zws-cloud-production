import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  RECENT_WINDOW_HOURS,
  STALE_JOB_MINUTES,
  STALE_REINSTALL_LOCK_HOURS,
  getDiagnosticsHealth,
} from "@/lib/diagnostics-health"

const source = readFileSync(join(process.cwd(), "lib/diagnostics-health.ts"), "utf8")

/**
 * Strip comments so an assertion about *code* is not satisfied or broken by the
 * prose explaining it. Several of the bugs below are documented in the very
 * lines that mention the wrong spelling, which would make a naive `includes`
 * check meaningless.
 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\S\n]*\/\/.*$/gm, "")
}

const sql = codeOnly(source)

describe("brand identity", () => {
  it("never signs a customer message with a hardcoded product fragment", () => {
    // Each of these paths signed messages with the literal "Cloud" whenever the
    // settings read failed. For an OTP or an invoice notice, that is what the
    // customer sees at the bottom of the message.
    const paths = [
      "app/api/admin/whatsapp/send/route.ts",
      "lib/vm-db-truth.ts",
      "lib/notifications/service.ts",
      "lib/notifications/templates.ts",
      "lib/whatsapp/automation.ts",
      "lib/whatsapp/templates.ts",
      "lib/auth/phone-verification.ts",
      "lib/renewals.ts",
      "scripts/whatsapp-worker.ts",
      "scripts/autoUnsuspend.ts",
    ]
    for (const path of paths) {
      const text = readFileSync(join(process.cwd(), path), "utf8")
      assert.equal(
        /catch\(\(\) => "Cloud"\)/.test(text),
        false,
        `${path} must not fall back to a hardcoded brand`,
      )
    }
  })

  it("resolves branding from configured company/brand/domain, in that order", async () => {
    // Assert the real function, not the prose around it.
    const { resolveBrandIdentity } = await import("@/lib/brand-identity")
    // An explicit override always wins, with no settings read at all.
    assert.equal(await resolveBrandIdentity("Acme Hosting"), "Acme Hosting")
    assert.equal(await resolveBrandIdentity("  Acme Hosting  "), "Acme Hosting")
    assert.equal(await resolveBrandIdentity(""), await resolveBrandIdentity(null))
    // Never a hardcoded fragment, whatever happens.
    const resolved = await resolveBrandIdentity()
    assert.ok(resolved.length > 0, "a brand name must always be produced")
    assert.notEqual(resolved, "Cloud", "the hardcoded fallback must be gone")
  })

  it("derives a usable brand name from the domain rather than a bare TLD", async () => {
    const { brandNameFromDomain } = await import("@/lib/brand-identity")
    assert.equal(brandNameFromDomain("zwscloud.com"), "zwscloud")
    assert.equal(brandNameFromDomain("https://www.zwscloud.com/path"), "zwscloud")
    assert.equal(brandNameFromDomain(""), "")
    assert.equal(brandNameFromDomain(null), "")
    // A single-character label is not a brand; fall back to the host.
    assert.equal(brandNameFromDomain("a.example.com"), "a.example.com")
  })
})

describe("diagnostics integrity queries match the live schema", () => {
  it("uses the real snake_case reinstall lock columns", () => {
    // vps_instances is mixed-case: camelCase almost everywhere, but
    // reinstall_lock / reinstall_locked_at. Quoting them as "reinstallLock" is a
    // Postgres error, so the whole diagnostics page would fail to render.
    assert.ok(sql.includes("reinstall_lock = true"), "the lock column is reinstall_lock in production")
    assert.ok(sql.includes("reinstall_locked_at"), "the timestamp column is reinstall_locked_at")
    assert.equal(sql.includes('"reinstallLock"'), false, "the camelCase spelling does not exist in production")
    assert.equal(sql.includes('"reinstallLockedAt"'), false)
  })

  it("computes every count it reports", () => {
    // A count key that is never selected in SQL reads as a permanent zero,
    // which looks like a healthy system.
    const selected = new Set([...source.matchAll(/AS "(\w+)"/g)].map((match) => match[1]))
    for (const key of [
      "duplicateIps", "duplicateVmids", "duplicateOrders", "duplicatePayments",
      "orderlessInvoices", "missingIpAllocations", "missingProvisioningIdentities",
      "orphanProvisioningIdentities", "orphanIpAllocations", "orphanProvisionJobs",
      "staleReinstallLocks", "failedPayments", "unvalidatedForeignKeys",
      "checkoutProbeInvoices",
    ]) {
      assert.ok(selected.has(key), `${key} is displayed but never computed`)
    }
  })

  it("separates checkout-probe invoices from real orphan invoices", () => {
    // Production holds 13 orderless service invoices, all numbered INV-CHK-*
    // from checkout probes. Reporting them as a financial violation is a false
    // alarm; dropping them silently would be dishonest. Both are shown.
    assert.ok(sql.includes("'INV-CHK-%'"), "probe invoices must be identified by number")
    assert.ok(source.includes('key: "checkoutProbeInvoices"'), "they must still be reported")
    // The exclusion has to sit inside the *same* sub-select as the alias. Assert on
    // the slice between the sub-select and its alias, rather than on the whole
    // statement: the query contains nested parentheses of its own.
    const orderlessStmt = sql.slice(
      sql.indexOf("(SELECT count(*) FROM invoices"),
      sql.indexOf('AS "orderlessInvoices"'),
    )
    assert.ok(orderlessStmt.length > 0, "the orderless-invoice sub-select must exist")
    assert.ok(orderlessStmt.includes("NOT LIKE 'INV-CHK-%'"), "the violation count must exclude probe artifacts")
  })
})

describe("thresholds match what the application actually enforces", () => {
  it("judges a reinstall lock by the reinstall API's own timeout", async () => {
    // The API reclaims a lock only after 6 hours. Reporting a 3-hour-old lock as
    // a violation contradicts the system's own definition of healthy.
    assert.equal(STALE_REINSTALL_LOCK_HOURS, 6)
    const reinstallRoute = readFileSync(join(process.cwd(), "app/api/client/vps/[id]/reinstall/route.ts"), "utf8")
    assert.ok(reinstallRoute.includes("const STALE_REINSTALL_LOCK_MS = 6 * 60 * 60 * 1000"), "the API timeout must not drift away from diagnostics")
  })

  it("does not reuse the job staleness window for reinstall locks", () => {
    assert.notEqual(STALE_REINSTALL_LOCK_HOURS, STALE_JOB_MINUTES, "the two windows are different concepts")
    assert.ok(source.includes("staleReinstallBefore"), "reinstall locks need their own cutoff")
    assert.equal(
      /reinstall_locked_at < \$\{staleBefore\}/.test(source),
      false,
      "reinstall locks must not be judged by the 30-minute job window",
    )
  })

  it("keeps the job staleness window and the recent-failure window distinct", () => {
    assert.equal(STALE_JOB_MINUTES, 30)
    assert.equal(RECENT_WINDOW_HOURS, 24)
  })
})

describe("diagnostics reports what it cannot compute", () => {
  it("does not silently swallow a failed health query", async () => {
    // The page renders a warning when health is null. Assert the module has no
    // catch-all that returns an empty-but-healthy-looking result.
    assert.equal(/getDiagnosticsHealth[\s\S]{0,80}catch/.test(source), false, "a failed health query must propagate to the page")
  })

  it("exposes the thresholds it used so the page can state them", () => {
    assert.ok(source.includes("staleJobMinutes"), "the page must be able to say which window it used")
    assert.ok(source.includes("recentWindowHours"))
  })

  it("is exported for direct verification", () => {
    assert.equal(typeof getDiagnosticsHealth, "function")
  })
})