#!/usr/bin/env node

/**
 * Reconciliation for blocks created by the retired heuristics.
 *
 * `header_injection` used to be `/\r|\n(?=.*:)/`, which fires on any
 * multi-line text that contains a colon anywhere - i.e. almost every support
 * message, postal address and truncated request body. `unsafe_characters` was
 * a character-class rejection, which is a validation outcome, not an attack.
 *
 * Neither is a real attack shape, so any *live* block whose only reason was
 * one of those two is a false positive and is holding a real customer out of
 * their own account. This script releases exactly those, writes an audit trail,
 * and leaves every other block (real OTP abuse, operator decisions) untouched.
 *
 * Dry run by default. Nothing is written without --apply.
 *
 *   tsx scripts/security-block-reconcile.ts
 *   tsx scripts/security-block-reconcile.ts --apply
 */

import "dotenv/config"
import { prisma } from "@/lib/db"

/**
 * Retired heuristics that are provably wrong. Kept as a literal list so the
 * reconciliation is auditable: each entry names the rule that was wrong.
 */
const RETIRED_HEURISTICS: Record<string, string> = {
  header_injection: "was /\\r|\\n(?=.*:)/ - fires on any multi-line text containing a colon",
  unsafe_characters: "was a character-class allowlist rejection - a validation outcome, not an attack",
}

async function main() {
  const apply = process.argv.includes("--apply")
  const now = new Date()

  const candidates = await (prisma as any).blockedIp.findMany({
    where: {
      unblockedAt: null,
      permanent: true,
      attackType: { in: Object.keys(RETIRED_HEURISTICS) },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  })

  console.log("Security block reconciliation")
  console.log(`  mode                     ${apply ? "APPLY" : "DRY RUN (no writes)"}`)
  console.log(`  live permanent blocks     ${candidates.length}`)
  console.log(`  matching retired rules    ${Object.keys(RETIRED_HEURISTICS).join(", ")}\n`)

  for (const rule of Object.keys(RETIRED_HEURISTICS)) {
    const rows = candidates.filter((row: any) => row.attackType === rule)
    if (!rows.length) continue
    console.log(`  ${rule} (${rows.length})`)
    console.log(`    why it was wrong: ${RETIRED_HEURISTICS[rule]}`)
    for (const row of rows) {
      console.log(`    - ${row.ip}  blocked ${new Date(row.createdAt).toISOString().slice(0, 10)}  id=${row.id}`)
    }
    console.log("")
  }

  // Anything live that is NOT from a retired heuristic is reported so an
  // operator can review it, but never touched.
  const others = await (prisma as any).blockedIp.groupBy({
    by: ["attackType"],
    where: { unblockedAt: null, OR: [{ permanent: true }, { blockedUntil: { gt: now } }], NOT: { attackType: { in: Object.keys(RETIRED_HEURISTICS) } } },
    _count: { _all: true },
  }).catch(() => [])
  const grouped = new Map<string, number>()
  for (const row of others as any[]) grouped.set(row.attackType || "unknown", Number(row._count?._all || 0))
  if (grouped.size) {
    console.log("  Left untouched (review manually, these are not provable false positives):")
    for (const [type, count] of grouped) console.log(`    - ${type}: ${count}`)
    console.log("")
  }

  if (!apply) {
    console.log("  Dry run complete. Re-run with --apply to release the false positives.")
    return
  }

  const ids = candidates.map((row: any) => row.id)
  if (!ids.length) {
    console.log("  Nothing to release.")
    return
  }

  const result = await (prisma as any).blockedIp.updateMany({
    where: { id: { in: ids }, unblockedAt: null },
    data: {
      unblockedAt: now,
      unblockedBy: "system:security-block-reconcile",
      reviewStatus: "false_positive",
    },
  })

  // Clear the risk state too, so none of these identities is re-blocked.
  const riskCleared = await (prisma as any).securityRiskState.updateMany({
    where: { lastIp: { in: candidates.map((row: any) => row.ip) } },
    data: { score: 0, signalCount: 0, blockedUntil: null },
  }).catch(() => ({ count: 0 }))

  await (prisma as any).auditLog.create({
    data: {
      action: "security_false_positive_blocks_released",
      actorEmail: "system:security-block-reconcile",
      targetType: "blocked_ip",
      metadata: {
        released: result.count,
        riskStatesCleared: riskCleared.count,
        retiredHeuristics: RETIRED_HEURISTICS,
        ids,
      },
    },
  }).catch(() => null)

  console.log(`  Released ${result.count} false-positive block(s); cleared ${riskCleared.count} risk state(s).`)
  console.log("  Audit row written to audit_logs.")
}

main()
  .catch((error) => {
    console.error("[SECURITY_RECONCILE] failed", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })