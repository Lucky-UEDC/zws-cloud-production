import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { classifyFailedJob } from "@/lib/diagnostics-health"
import { humanizeId } from "@/components/admin/diagnostics-format"

const base = {
  attempts: 1,
  maxAttempts: 5,
  orderStatus: "paid",
  provisioningStatus: "QUEUED",
  vmsInstanceCount: 0,
  identityPhase: null,
  hasVmId: false,
}

describe("failed job classification", () => {
  it("treats a job behind an already-active order as history, not an outage", () => {
    // This is the production case: 957 failed rows, 5 orders, every one of
    // those orders already ACTIVE. Rendering that as a live outage was the bug.
    const result = classifyFailedJob({ ...base, provisioningStatus: "ACTIVE", orderStatus: "active" })
    assert.equal(result.classification, "historical")
    assert.match(result.reason, /already provisioned/i)
  })

  it("never calls a job with an existing VM merely retryable", () => {
    const result = classifyFailedJob({ ...base, hasVmId: true, vmsInstanceCount: 1, identityPhase: "READY" })
    assert.equal(result.classification, "stale")
    assert.match(result.reason, /never clone a new one/i)
  })

  it("flags duplicate server rows as unsafe to retry", () => {
    const result = classifyFailedJob({ ...base, vmsInstanceCount: 2 })
    assert.equal(result.classification, "duplicate")
  })

  it("marks an exhausted retry limit as permanently failed", () => {
    const result = classifyFailedJob({ ...base, attempts: 5, maxAttempts: 5 })
    assert.equal(result.classification, "permanently_failed")
  })

  it("marks a cancelled order as cancelled, not broken", () => {
    assert.equal(classifyFailedJob({ ...base, provisioningStatus: "CANCELLED" }).classification, "cancelled")
  })

  it("marks a completed order as completed", () => {
    assert.equal(classifyFailedJob({ ...base, provisioningStatus: "SERVICE_ACTIVE" }).classification, "completed")
  })

  it("calls a paid order with no server at all safely retryable", () => {
    assert.equal(classifyFailedJob(base).classification, "recoverable")
  })
})

describe("diagnostics page semantics", () => {
  const page = readFileSync(join(process.cwd(), "app/admin/diagnostics/page.tsx"), "utf8")

  it("reports the windows each count covers", () => {
    for (const label of ["Active now", "Waiting for admin", "Failed all-time", "Completed", "Stale (in flight)"]) {
      assert.ok(page.includes(label), `missing the "${label}" figure`)
    }
  })

  it("shows distinct orders behind the failures, not just the retry count", () => {
    assert.ok(page.includes("failedRecentOrders"), "the recent-failure card must state how many orders are affected")
    assert.ok(page.includes("Failed orders, all-time"), "an operator needs the order count, not the attempt count")
  })

  it("never labels the historical total a live outage", () => {
    assert.ok(page.includes("Historical, across"), "the all-time figure must be described as historical")
  })

  it("only lists failures from the recent window", () => {
    assert.ok(
      page.includes('status: "failed", updatedAt: { gte:'),
      "the job table must be windowed so old failures are not listed as current",
    )
  })

  it("classifies every integrity check rather than showing a bare number", () => {
    const health = readFileSync(join(process.cwd(), "lib/diagnostics-health.ts"), "utf8")
    assert.ok(health.includes('severity: "violation"'))
    assert.ok(health.includes('severity: "expected"'))
    assert.ok(health.includes('severity: "informational"'))
  })

  it("keeps the historical read-only", () => {
    for (const danger of ["deleteMany", "updateMany", "prisma.$transaction"]) {
      assert.equal(page.includes(danger), false, `Diagnostics must not ${danger}`)
      assert.equal(readFileSync(join(process.cwd(), "lib/diagnostics-health.ts"), "utf8").includes(danger), false)
    }
  })
})

describe("diagnostics id formatting", () => {
  it("abbreviates a long cuid but keeps it distinguishable", () => {
    const id = "cmuabc123def456ghi789jkl012mno345"
    const short = humanizeId(id)
    assert.ok(short.includes("…"))
    assert.ok(short.startsWith("cmuabc12"))
    assert.ok(short.endsWith(id.slice(-4)), "the tail must be the real tail of the id")
  })

  it("leaves a short id untouched and renders empty as a dash", () => {
    assert.equal(humanizeId("short"), "short")
    assert.equal(humanizeId(null), "-")
  })
})
