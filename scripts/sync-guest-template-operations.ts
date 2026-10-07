/**
 * Sync live guest-automation template operations from the shipped seed defaults.
 *
 * `scripts/seed-guest-templates.ts` deliberately only creates a template or
 * fills in a missing operation; it never rewrites an operation that already
 * exists. That is the right default for a seeder, but it means a corrected
 * command in `default-templates.ts` does not reach the rows the panel actually
 * runs. This script does that sync, through `updateGuestTemplate` -- the same
 * validated path the admin editor uses -- and prints every diff so the change
 * is reviewable rather than silent.
 *
 * Idempotent: a second run reports no differences and writes nothing.
 */
import { prisma } from "@/lib/db"
import { DEFAULT_GUEST_TEMPLATES } from "@/lib/guest-automation/default-templates"
import { updateGuestTemplate } from "@/lib/guest-automation/admin-templates"

const DRY_RUN = process.argv.includes("--dry-run")

type SeedOp = {
  operation: string
  commandType?: string
  shell?: string
  command?: string | null
  verificationCommand?: string | null
  verificationParser?: string | null
  successCondition?: string | null
  rollbackCommand?: string | null
  timeoutSeconds?: number
  enabled?: boolean
  dangerLevel?: string
  notes?: string | null
  stateKey?: string | null
}

async function main() {
  const bySlug = new Map(DEFAULT_GUEST_TEMPLATES.map((template) => [template.slug, template]))
  const stored = await prisma.guestOSTemplate.findMany({ include: { operations: true } })
  let templatesChanged = 0
  let operationsChanged = 0

  for (const row of stored as any[]) {
    const seed: any = bySlug.get(row.slug)
    if (!seed) {
      console.log(`[sync] ${row.slug}: not a shipped default, left alone`)
      continue
    }
    const seedOps = new Map((seed.operations as SeedOp[]).map((operation) => [operation.operation, operation]))
    const diffs: string[] = []

    for (const operation of row.operations as any[]) {
      const wanted = seedOps.get(operation.operation)
      if (!wanted) continue
      if ((wanted.command ?? null) !== (operation.command ?? null)) {
        diffs.push(`      ${operation.operation} command:\n        live: ${operation.command}\n        seed: ${wanted.command}`)
      }
      if ((wanted.rollbackCommand ?? null) !== (operation.rollbackCommand ?? null)) {
        diffs.push(`      ${operation.operation} rollbackCommand:\n        live: ${operation.rollbackCommand}\n        seed: ${wanted.rollbackCommand}`)
      }
    }

    if (!diffs.length) {
      console.log(`[sync] ${row.slug}: already in sync (v${row.version})`)
      continue
    }

    templatesChanged += 1
    operationsChanged += diffs.length
    console.log(`[sync] ${row.slug} (v${row.version}) -> ${diffs.length} difference(s):`)
    for (const line of diffs) console.log(line)
    if (DRY_RUN) continue

    // Rebuild the operation list from the shipped defaults, carrying over the
    // per-row admin state that is not owned by the seed (enabled flag).
    const merged = (seed.operations as SeedOp[]).map((wanted) => {
      const existing = (row.operations as any[]).find((operation) => operation.operation === wanted.operation)
      return {
        ...wanted,
        enabled: existing?.enabled ?? wanted.enabled ?? true,
      }
    })

    const result = await updateGuestTemplate(row.id, {
      name: seed.name,
      slug: seed.slug,
      family: seed.family,
      osIds: seed.osIds ?? [],
      versionPattern: seed.versionPattern ?? null,
      enabled: row.enabled,
      guestAgentRequired: row.guestAgentRequired,
      engine: seed.engine,
      priority: seed.priority ?? 100,
      description: seed.description ?? null,
      osTemplateId: row.osTemplateId ?? null,
      operations: merged,
    } as any)

    if (!result) {
      console.log(`[sync] ${row.slug}: FAILED, update returned null`)
      continue
    }
    if (result.result && (result.result as any).ok === false) {
      console.log(`[sync] ${row.slug}: rejected by validation ${JSON.stringify(result.result)}`)
      continue
    }
    console.log(`[sync] ${row.slug}: updated v${result.previousVersion} -> v${result.row?.version} (versionBumped=${result.versionBumped})`)
  }

  console.log(`[sync] done. templatesChanged=${templatesChanged} differences=${operationsChanged}${DRY_RUN ? " (dry run, nothing written)" : ""}`)
}

main()
  .catch((error) => {
    console.error("[sync] FAILED", error?.message || String(error))
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined)
  })