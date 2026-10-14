/**
 * Fail fast when the configured database is a declared production database.
 *
 * Invoked from the container entrypoint before any schema change, and usable
 * on its own for diagnostics:
 *
 *   tsx scripts/assert-db-isolation.ts "prisma migrate deploy"
 *   tsx scripts/assert-db-isolation.ts          # report only, always exit 0
 *
 * Exits 78 (EX_CONFIG) on refusal so a compose dependency fails loudly instead
 * of silently running a migration against the wrong database.
 */
import "dotenv/config"
import { assertSchemaWriteAllowed, databaseIsolationDiagnostic } from "@/lib/db-isolation"

const operation = process.argv[2] || ""

function main() {
  // Report mode: always print, never fail. Used for diagnostics and for the
  // startup banner.
  if (!operation) {
    const diagnostic = databaseIsolationDiagnostic()
    // The diagnostic is redacted by construction: it carries host, port,
    // database and role, never a password or a connection string.
    console.log(`[db-isolation] ${JSON.stringify(diagnostic)}`)
    return
  }

  const verdict = assertSchemaWriteAllowed(operation)
  const diagnostic = databaseIsolationDiagnostic()
  console.log(`[db-isolation] ${operation} allowed: ${JSON.stringify(diagnostic)}`)
  if (verdict.overridden) {
    console.warn(`[db-isolation] WARNING: ${verdict.detail}`)
  }
}

try {
  main()
} catch (error: any) {
  console.error(`[db-isolation] ${error?.message || String(error)}`)
  process.exit(78)
}