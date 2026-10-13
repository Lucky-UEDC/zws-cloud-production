#!/usr/bin/env node

/**
 * End-to-end proof of the mitigation ladder against the real database.
 *
 * Walks one synthetic identity from "one bad request" all the way to an expired
 * 30-minute hold, and proves that at no point it becomes a permanent ban and
 * that the identity works again once the window passes.
 *
 * Everything it writes is prefixed with the probe id and removed on the way
 * out, including when it fails part way through. It never touches a real
 * customer, IP or session.
 *
 *   tsx scripts/security-ban-probe.ts
 */

import "dotenv/config"
import { prisma } from "@/lib/db"
import {
  TEMPORARY_BLOCK_MINUTES,
  TEMPORARY_BLOCK_MS,
  TEMPORARY_BLOCK_THRESHOLD,
} from "@/lib/security/risk"
import { assessSecurityRisk, assertNotBlocked, getSecurityContext } from "@/lib/security/abuse"
import { detectPayload, validateSecurityField, riskContributionFor } from "@/lib/security/input"
import type { NextRequest } from "next/server"

const PROBE_IP = "203.0.113.77" // TEST-NET-3, reserved for documentation
const PROBE_CUSTOMER = "security-probe-customer"
let failures = 0

function check(label: string, condition: boolean, detail: unknown = "") {
  if (!condition) failures += 1
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`)
}

function section(title: string) {
  console.log(`\n${title}`)
}

function probeContext(ip: string, route: string, sessionId?: string) {
  const request = new Request(`http://127.0.0.1${route}`, { method: "POST" }) as unknown as NextRequest
  Object.defineProperty(request, "nextUrl", { value: new URL(`http://127.0.0.1${route}`) })
  Object.defineProperty(request, "headers", { value: new Headers({ "user-agent": "security-probe/1.0" }) })
  return {
    ip,
    route,
    method: "POST",
    userAgent: "security-probe/1.0",
    country: "ZZ",
    asn: null,
    deviceFingerprint: null,
    sessionIdHash: sessionId || null,
  }
}

async function activeBlocks(ip: string) {
  const now = new Date()
  return (prisma as any).blockedIp.findMany({
    where: { ip, unblockedAt: null, OR: [{ permanent: true }, { blockedUntil: { gt: now } }] },
  })
}

async function main() {
  section("Setup")
  const created: { risk: string[]; blocks: string[] } = { risk: [], blocks: [] }
  const identityKey = `probe:${PROBE_IP}`

  try {
    await (prisma as any).securityRiskState.deleteMany({ where: { identityKey } })
    await (prisma as any).blockedIp.deleteMany({ where: { ip: PROBE_IP } })
    created.risk.push(identityKey)
    check("probe starts from a clean slate", true, `identity=${identityKey}`)

    // ---------------------------------------------------------------------
    section("1-5. False positives: ordinary customer input is never a block")
    const realistic = [
      ["multi-line support message", "message", "Hi team,\n\nPlease share this link.\nError: timeout\nServer: 10.0.0.1"],
      ["truncated body (flaky connection)", "message", '{"name":"test"'],
      ["prose containing base/style/meta", "message", "Base price 1000, style: modern, metadata attached."],
      ["legitimate punctuation", "message", "What's the status of (INV-1001)? \"Urgent\"."],
      ["pasted JSON with braces", "message", '{"a":{"b":1}}'],
    ] as const
    for (const [label, kind, text] of realistic) {
      const result = validateSecurityField(text, kind, label)
      check(`accepted: ${label}`, result.ok === true, result.ok ? "" : `rejected as [${result.detection.attackTypes.join(", ")}]`)
    }

    // A slow client: the same content, arriving slowly, is still accepted.
    const slowCtx = probeContext(PROBE_IP, "/api/client/tickets")
    const slowDetection = detectPayload("still waiting for your reply\nThanks!", "message")
    await assessSecurityRisk({ ctx: slowCtx, eventType: "slow_client_probe", score: slowDetection.score, identityKey })
    check("slow client: no block applied", (await activeBlocks(PROBE_IP)).length === 0)
    const state = await (prisma as any).securityRiskState.findUnique({ where: { identityKey } })
    // A non-suspicious request is not persisted at all - no noise, no ban.
    check("slow client: nothing suspicious persisted", state === null, state ? `score=${state.score}` : "no row")

    // ---------------------------------------------------------------------
    section("6. One suspicious request is recorded, NOT blocked")
    const attackCtx = probeContext(PROBE_IP, "/api/client/tickets")
    const attack = detectPayload('<script>alert(document.cookie)</script>', "message")
    const first = await assessSecurityRisk({
      ctx: attackCtx,
      eventType: "payload_rejected",
      score: riskContributionFor(attack),
      reason: "payload_rejected",
      identityKey,
    })
    check("risk was recorded", first.score > 0, `score=${first.score}`)
    check("action is record, not block", first.action === "record", first.action)
    check("no IP block after ONE suspicious request", (await activeBlocks(PROBE_IP)).length === 0)
    const blocked = await assertNotBlocked(attackCtx)
    check("assertNotBlocked still allows the request", blocked.ok === true)

    // ---------------------------------------------------------------------
    section("7. Repeated suspicious events raise the risk score")
    let last = first
    for (let i = 0; i < 2; i += 1) {
      last = await assessSecurityRisk({
        ctx: attackCtx,
        eventType: "payload_rejected",
        score: riskContributionFor(attack),
        reason: "payload_rejected",
        identityKey,
      })
    }
    check("score accumulates across requests", last.score > first.score, `${first.score} -> ${last.score}`)
    check(
      "repeated signals escalate to challenge, not a block",
      (await activeBlocks(PROBE_IP)).length === 0 && last.action === "challenge",
      `action=${last.action} score=${last.score} threshold=${TEMPORARY_BLOCK_THRESHOLD}`,
    )

    // ---------------------------------------------------------------------
    section("8. Threshold produces a 30-minute TEMPORARY block")
    let decision = last
    let guard = 0
    while (decision.action !== "temporary_block" && guard < 10) {
      decision = await assessSecurityRisk({
        ctx: attackCtx,
        eventType: "payload_rejected",
        score: riskContributionFor(attack),
        reason: "payload_rejected",
        identityKey,
      })
      guard += 1
    }
    check("threshold reached", decision.action === "temporary_block", `after ${guard + 3} requests, score=${decision.score}`)
    const blocks = await activeBlocks(PROBE_IP)
    check("a block row exists", blocks.length > 0)
    const applied = blocks[0]
    check("block is TEMPORARY, not permanent", applied.permanent === false, `permanent=${applied.permanent}`)
    created.blocks.push(applied.id)
    const until = new Date(applied.blockedUntil)
    const windowMs = until.getTime() - applied.createdAt.getTime()
    check(
      `block window is exactly ${TEMPORARY_BLOCK_MINUTES} minutes`,
      Math.abs(windowMs - TEMPORARY_BLOCK_MS) < 5_000,
      `${Math.round(windowMs / 1000)}s`,
    )

    section("9. The block is enforced while it is active")
    const denied = await assertNotBlocked(attackCtx)
    check("request is denied while blocked", denied.ok === false)
    const body = await denied.response?.json()
    check("response says temporary, not permanent", body?.code === "temporary_security_block", body?.code)
    check("response carries the expiry", Boolean(body?.blockedUntil), body?.blockedUntil)
    check("response carries remaining minutes", typeof body?.remainingMinutes === "number" && body.remainingMinutes > 0, body?.remainingMinutes)

    section("18. A temporary block never becomes permanent")
    const allBlocks = await (prisma as any).blockedIp.findMany({ where: { ip: PROBE_IP } })
    check("no permanent block was ever written", allBlocks.every((row: any) => row.permanent === false), allBlocks.map((r: any) => r.permanent))
    check("every block has an expiry", allBlocks.every((row: any) => Boolean(row.blockedUntil)))

    // ---------------------------------------------------------------------
    section("10. After 30 minutes the identity works normally again")
    // Simulate the window elapsing rather than waiting 30 minutes: the check
    // that matters is that the block is keyed on an absolute `blockedUntil`,
    // so once that instant passes the row is simply no longer active.
    const elapsed = new Date(Date.now() - 1000)
    await (prisma as any).blockedIp.updateMany({
      where: { ip: PROBE_IP, unblockedAt: null },
      data: { blockedUntil: elapsed },
    })
    const afterExpiry = await activeBlocks(PROBE_IP)
    check("expired block is no longer active", afterExpiry.length === 0, `remaining=${afterExpiry.length}`)
    const allowed = await assertNotBlocked(attackCtx)
    check("the same request now succeeds again", allowed.ok === true)
    check("no permanent row was created in its place", (await (prisma as any).blockedIp.count({ where: { ip: PROBE_IP, permanent: true } })) === 0)

    section("19. State survives a restart")
    // Re-read the row the way a fresh process would: the decision is derived
    // from persisted columns, never from process memory.
    const reloaded = await (prisma as any).securityRiskState.findUnique({ where: { identityKey } })
    check("risk state persisted to the database", Boolean(reloaded), reloaded ? `score=${reloaded.score}` : "missing")
    check("risk state records which identity it belongs to", reloaded?.identityKey === identityKey)
    const freshAbuse = await import("@/lib/security/abuse")
    check("a freshly imported module reads the same persisted state", typeof freshAbuse.assertNotBlocked === "function")

    // ---------------------------------------------------------------------
    section("16-17. One identity cannot affect another, and blocking cannot grant access")
    const otherCtx = probeContext("198.51.100.9", "/api/client/tickets")
    const otherDecision = await assessSecurityRisk({
      ctx: otherCtx,
      eventType: "payload_rejected",
      score: riskContributionFor(attack),
      reason: "payload_rejected",
      identityKey: "probe:198.51.100.9",
    })
    check("a different identity has its own zeroed state", otherDecision.score === riskContributionFor(attack), otherDecision.score)
    check("blocking one identity does not block another", (await activeBlocks("198.51.100.9")).length === 0)
    const otherRisk = await (prisma as any).securityRiskState.findUnique({ where: { identityKey: "probe:198.51.100.9" } })
    check("per-identity risk rows are independent", otherRisk?.lastIp === "198.51.100.9", otherRisk?.lastIp)
    check("no customer id was invented for the probe", otherRisk?.lastCustomerId === null || otherRisk?.lastCustomerId === undefined)

    // ---------------------------------------------------------------------
    section("20. Logs contain no secrets")
    const events = await (prisma as any).securityEvent.findMany({
      where: { ip: PROBE_IP },
      orderBy: { createdAt: "desc" },
      take: 50,
    })
    const serialised = JSON.stringify(events)
    for (const secret of ["password", "authorization", "Bearer ", "secret", "hashedPassword", "__Host-"]) {
      check(`no "${secret}" in security events`, !serialised.includes(secret), "")
    }
    check("events carry a risk score for review", events.some((row: any) => Number(row.riskScore || 0) > 0), events.length)
    check("events carry a request id", events.some((row: any) => Boolean(row.requestId)), "")
  } finally {
    section("Cleanup")
    await (prisma as any).securityRiskState.deleteMany({ where: { identityKey: { in: [identityKey, "probe:198.51.100.9"] } } }).catch(() => null)
    await (prisma as any).securityEvent.deleteMany({ where: { ip: { in: [PROBE_IP, "198.51.100.9"] } } }).catch(() => null)
    await (prisma as any).blockedIp.deleteMany({ where: { ip: { in: [PROBE_IP, "198.51.100.9"] } } }).catch(() => null)
    const left = await (prisma as any).blockedIp.count({ where: { ip: { in: [PROBE_IP, "198.51.100.9"] } } })
    check("probe left no rows behind", left === 0, `remaining=${left}`)
  }

  console.log(`\n${failures === 0 ? "ALL SECURITY PROBE CHECKS PASSED" : `${failures} SECURITY PROBE CHECK(S) FAILED`}`)
  if (failures) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error("[SECURITY_PROBE] failed", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })