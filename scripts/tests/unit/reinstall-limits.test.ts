import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  consumeReinstallAllowance,
  DEFAULT_REINSTALL_POLICY,
  evaluateReinstallAllowance,
  monthKeyFor,
  normalizeReinstallPolicy,
  parseReinstallTracking,
  type ReinstallTracking,
} from "@/lib/reinstall-policy"

function at(day: string) {
  return new Date(`${day}T12:00:00.000Z`)
}

function tracking(monthKey: string, used: number, extra: Partial<ReinstallTracking> = {}): ReinstallTracking {
  return { monthKey, used, granted: 5, rollover: 0, lastUsedAt: null, lastOperationId: null, recentOperationIds: [], ...extra }
}

describe("reinstall policy defaults", () => {
  it("defaults to five reinstalls per month in fixed mode", () => {
    const policy = normalizeReinstallPolicy(null)
    assert.equal(policy.monthlyLimit, 5)
    assert.equal(policy.mode, "fixed")
    assert.equal(policy.rolloverCap, 10)
    assert.equal(policy.perVmLimit, 5)
    assert.equal(policy.enabled, true)
    assert.equal(policy.adminBypass, true)
  })

  it("clamps nonsense input instead of trusting it", () => {
    const policy = normalizeReinstallPolicy({ monthlyLimit: -4, mode: "nonsense", cooldownMinutes: 1000000 })
    assert.equal(policy.monthlyLimit, 0)
    assert.equal(policy.mode, DEFAULT_REINSTALL_POLICY.mode)
    assert.ok(policy.cooldownMinutes <= 10080)
  })
})

describe("fixed mode", () => {
  it("counts down 5 -> 0 and then blocks", () => {
    const now = at("2026-10-10")
    const policy = { ...DEFAULT_REINSTALL_POLICY, mode: "fixed" as const, cooldownMinutes: 0 }
    for (const used of [0, 1, 2, 3, 4]) {
      const allowance = evaluateReinstallAllowance({ policy, customerTracking: tracking("2026-10", used), vpsTracking: tracking("2026-10", used), now })
      assert.equal(allowance.remaining, 5 - used)
      assert.equal(allowance.allowed, true)
    }
    const blocked = evaluateReinstallAllowance({ policy, customerTracking: tracking("2026-10", 5), vpsTracking: tracking("2026-10", 5), now })
    assert.equal(blocked.remaining, 0)
    assert.equal(blocked.allowed, false)
    assert.match(String(blocked.reason), /limit reached/i)
  })

  it("resets to the base allowance at the start of the next month and loses unused allowance", () => {
    const policy = { ...DEFAULT_REINSTALL_POLICY, mode: "fixed" as const, cooldownMinutes: 0 }
    const allowance = evaluateReinstallAllowance({
      policy,
      customerTracking: tracking("2026-10", 2),
      vpsTracking: tracking("2026-10", 2),
      now: at("2026-11-01"),
    })
    assert.equal(allowance.monthKey, "2026-11")
    assert.equal(allowance.granted, 5)
    assert.equal(allowance.used, 0)
    assert.equal(allowance.remaining, 5)
    assert.equal(allowance.rollover, 0)
  })
})

describe("rollover mode", () => {
  it("adds unused allowance to the next month", () => {
    const policy = { ...DEFAULT_REINSTALL_POLICY, mode: "rollover" as const, rolloverCap: 10, cooldownMinutes: 0 }
    const monthTwo = evaluateReinstallAllowance({
      policy,
      customerTracking: tracking("2026-10", 2),
      vpsTracking: tracking("2026-10", 2),
      now: at("2026-11-10"),
    })
    assert.equal(monthTwo.granted, 8)
    assert.equal(monthTwo.remaining, 8)

    const monthThree = evaluateReinstallAllowance({
      policy,
      // Month two was granted 8 (5 base + 3 rolled) and used 4.
      customerTracking: tracking("2026-11", 4, { granted: 8, rollover: 3 }),
      vpsTracking: tracking("2026-11", 4, { granted: 5 }),
      now: at("2026-12-10"),
    })
    assert.equal(monthThree.granted, 9, "5 base + 4 unused from month two")
  })

  it("never rolls more than the configured cap", () => {
    const policy = { ...DEFAULT_REINSTALL_POLICY, mode: "rollover" as const, rolloverCap: 6, cooldownMinutes: 0 }
    const allowance = evaluateReinstallAllowance({
      policy,
      // Month one was granted 5 and used 1, so 4 unused - capped at 6? no: 4.
      customerTracking: tracking("2026-10", 1, { granted: 5 }),
      vpsTracking: tracking("2026-10", 1, { granted: 5 }),
      now: at("2026-11-10"),
    })
    assert.equal(allowance.rollover, 4)
    assert.equal(allowance.granted, 9)
  })

  it("clamps the carry to the configured cap even when a month is barely used", () => {
    const capped = evaluateReinstallAllowance({
      policy: { ...DEFAULT_REINSTALL_POLICY, mode: "rollover" as const, rolloverCap: 6, cooldownMinutes: 0 },
      // A month that was granted 12 and used 1 would roll 11 - the cap holds it at 6.
      customerTracking: tracking("2026-10", 1, { granted: 12, rollover: 7 }),
      vpsTracking: tracking("2026-10", 1, { granted: 5 }),
      now: at("2026-11-10"),
    })
    assert.equal(capped.rollover, 6)
    assert.equal(capped.granted, 11)
  })

  it("rolls nothing when the cap is zero", () => {
    const policy = { ...DEFAULT_REINSTALL_POLICY, mode: "rollover" as const, rolloverCap: 0, cooldownMinutes: 0 }
    const allowance = evaluateReinstallAllowance({
      policy,
      customerTracking: tracking("2026-10", 1),
      vpsTracking: tracking("2026-10", 1),
      now: at("2026-11-10"),
    })
    assert.equal(allowance.granted, 5)
  })
})

describe("per-server limit, cooldown and disabled policy", () => {
  it("blocks when the single server is out of allowance even with customer allowance left", () => {
    const policy = { ...DEFAULT_REINSTALL_POLICY, perVmLimit: 5, cooldownMinutes: 0 }
    const allowance = evaluateReinstallAllowance({
      policy,
      customerTracking: tracking("2026-10", 1),
      vpsTracking: tracking("2026-10", 5),
      now: at("2026-10-10"),
    })
    assert.equal(allowance.allowed, false)
    assert.match(String(allowance.reason), /server/i)
  })

  it("enforces the cooldown between two accepted reinstalls", () => {
    const policy = { ...DEFAULT_REINSTALL_POLICY, cooldownMinutes: 60 }
    const allowance = evaluateReinstallAllowance({
      policy,
      customerTracking: tracking("2026-10", 1, { lastUsedAt: at("2026-10-10").toISOString() }),
      vpsTracking: tracking("2026-10", 1),
      now: at("2026-10-10"),
    })
    assert.equal(allowance.allowed, false)
    assert.equal(allowance.cooldownRemainingMinutes, 60)
  })

  it("blocks everything when reinstalls are disabled", () => {
    const policy = { ...DEFAULT_REINSTALL_POLICY, enabled: false }
    const allowance = evaluateReinstallAllowance({ policy, customerTracking: tracking("2026-10", 0), vpsTracking: tracking("2026-10", 0), now: at("2026-10-10") })
    assert.equal(allowance.allowed, false)
  })
})

describe("consumption", () => {
  const policy = { ...DEFAULT_REINSTALL_POLICY, mode: "fixed" as const, cooldownMinutes: 0, perVmLimit: 5 }

  it("consumes exactly one allowance and records the operation id", () => {
    const first = consumeReinstallAllowance({ policy, customerTracking: tracking("2026-10", 1), vpsTracking: tracking("2026-10", 1), operationId: "op-1", now: at("2026-10-10") })
    assert.equal(first.allowed, true)
    assert.equal(first.duplicate, false)
    assert.equal(first.customerTracking.used, 2)
    assert.equal(first.vpsTracking.used, 2)
  })

  it("never consumes twice for the same operation id", () => {
    const consumed = consumeReinstallAllowance({ policy, customerTracking: tracking("2026-10", 1), vpsTracking: tracking("2026-10", 1), operationId: "op-1", now: at("2026-10-10") })
    const retry = consumeReinstallAllowance({
      policy,
      customerTracking: consumed.customerTracking,
      vpsTracking: consumed.vpsTracking,
      operationId: "op-1",
      now: at("2026-10-10"),
    })
    assert.equal(retry.duplicate, true)
    assert.equal(retry.allowed, true)
    assert.equal(retry.customerTracking.used, 2, "a retry must not burn another reinstall")
  })

  it("refuses without writing counters when nothing is left", () => {
    const decision = consumeReinstallAllowance({ policy, customerTracking: tracking("2026-10", 5), vpsTracking: tracking("2026-10", 5), operationId: "op-x", now: at("2026-10-10") })
    assert.equal(decision.allowed, false)
    assert.equal(decision.customerTracking.used, 5)
    assert.equal(decision.customerTracking.lastOperationId, null)
  })

  it("admin bypass does not consume allowance but is still recorded", () => {
    const decision = consumeReinstallAllowance({ policy, customerTracking: tracking("2026-10", 5), vpsTracking: tracking("2026-10", 5), operationId: "op-admin", now: at("2026-10-10"), bypass: true })
    assert.equal(decision.allowed, true)
    assert.equal(decision.customerTracking.used, 5)
    assert.equal(decision.customerTracking.lastOperationId, "op-admin")
  })

  it("requires an operation id", () => {
    const decision = consumeReinstallAllowance({ policy, customerTracking: tracking("2026-10", 0), vpsTracking: tracking("2026-10", 0), operationId: "", now: at("2026-10-10") })
    assert.equal(decision.allowed, false)
  })
})

describe("tracking parsing", () => {
  it("never trusts a hand-edited counter", () => {
    const parsed = parseReinstallTracking({ monthKey: "2026-10", used: -12, rollover: "abc", recentOperationIds: "nope" })
    assert.equal(parsed.used, 0)
    assert.equal(parsed.rollover, 0)
    assert.deepEqual(parsed.recentOperationIds, [])
  })

  it("keys months in UTC so the boundary is stable", () => {
    assert.equal(monthKeyFor(new Date("2026-01-31T23:59:59.000Z")), "2026-01")
    assert.equal(monthKeyFor(new Date("2026-02-01T00:00:00.000Z")), "2026-02")
  })
})
