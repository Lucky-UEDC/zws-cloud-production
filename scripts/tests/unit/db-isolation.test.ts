import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  databaseIsolationDiagnostic,
  describeResolvedDatabaseTarget,
  evaluateDatabaseIsolation,
  productionDatabaseNames,
  assertDatabaseIsolation,
  assertSchemaWriteAllowed,
} from "../../../lib/db-isolation"

const baseEnv = (overrides: Record<string, string> = {}) => ({
  DATABASE_URL: "postgresql://appuser:s3cr3t-not-a-real-password@db.internal:5432/zwscloud?schema=public",
  ...overrides,
}) as NodeJS.ProcessEnv

test("the resolved target is reported without ever exposing the password", () => {
  const target = describeResolvedDatabaseTarget(baseEnv())
  assert.equal(target.configured, true)
  assert.equal(target.host, "db.internal")
  assert.equal(target.port, "5432")
  assert.equal(target.database, "zwscloud")
  assert.equal(target.username, "appuser")

  const serialized = JSON.stringify(target)
  assert.ok(!serialized.includes("s3cr3t-not-a-real-password"), `password leaked: ${serialized}`)
  assert.ok(!serialized.includes("postgresql://"), `connection string leaked: ${serialized}`)
})

test("a target matching a declared production database is refused", () => {
  // This is the exact situation found on the development host.
  const verdict = evaluateDatabaseIsolation(baseEnv())
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, "production_database_target")
  assert.equal(verdict.target.database, "zwscloud")
  assert.match(verdict.detail, /declared production database/)
  // The refusal message must not carry the password either.
  assert.ok(!verdict.detail.includes("s3cr3t-not-a-real-password"))
})

test("a genuinely separate development database passes", () => {
  const verdict = evaluateDatabaseIsolation(baseEnv({
    DATABASE_URL: "postgresql://zwscloud_dev:s3cr3t-not-a-real-password@db.internal:5432/zwscloud_dev",
  }))
  assert.equal(verdict.ok, true)
  assert.equal(verdict.reason, "isolated")
  assert.equal(verdict.overridden, false)
})

test("the production database list is configurable and defaults to the main role", () => {
  assert.deepEqual([...productionDatabaseNames({} as NodeJS.ProcessEnv)], ["zwscloud"])
  const custom = productionDatabaseNames({ ZWS_PRODUCTION_DATABASE_NAMES: "prod_main, PROD_LIVE , " } as NodeJS.ProcessEnv)
  assert.deepEqual([...custom].sort(), ["prod_live", "prod_main"])
})

test("a declared production host is refused even with an unexpected database name", () => {
  const verdict = evaluateDatabaseIsolation(baseEnv({
    DATABASE_URL: "postgresql://u:p@prod-db-01:5432/whatever_it_is_called",
    ZWS_PRODUCTION_DATABASE_HOSTS: "prod-db-01,10.0.0.5",
  }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, "production_host_target")
  assert.match(verdict.detail, /declared production database host/)
})

test("schema writes are blocked before a migration can run", () => {
  assert.throws(
    () => assertDatabaseIsolation(baseEnv()),
    /declared production database/
  )
  assert.throws(
    () => assertSchemaWriteAllowed("prisma migrate deploy", baseEnv()),
    /prisma migrate deploy refused/
  )

  // The same operation against an isolated database is permitted.
  const allowed = assertSchemaWriteAllowed("prisma migrate deploy", baseEnv({
    DATABASE_URL: "postgresql://u:p@db.internal:5432/zwscloud_test",
  }))
  assert.equal(allowed.ok, true)
})

test("a restore needs an explicit acknowledgement even on an isolated database", () => {
  const devEnv = baseEnv({ DATABASE_URL: "postgresql://u:p@db.internal:5432/zwscloud_test" })
  assert.throws(() => assertSchemaWriteAllowed("restore", devEnv), /ZWS_ALLOW_RESTORE_IN_DEVELOPMENT/)
  const acknowledged = assertSchemaWriteAllowed("restore", { ...devEnv, ZWS_ALLOW_RESTORE_IN_DEVELOPMENT: "1" } as NodeJS.ProcessEnv)
  assert.equal(acknowledged.ok, true)
})

test("an override is possible but is loud and clearly marked", () => {
  const verdict = evaluateDatabaseIsolation(baseEnv({ ZWS_ALLOW_PRODUCTION_DATABASE_ACCESS: "1" }))
  assert.equal(verdict.ok, true)
  assert.equal(verdict.reason, "override_active")
  assert.equal(verdict.overridden, true)
  assert.match(verdict.detail, /REFUSED BY DEFAULT BUT OVERRIDDEN/)
})

test("an unresolvable or missing database configuration is not silently allowed", () => {
  const missing = evaluateDatabaseIsolation({} as NodeJS.ProcessEnv)
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, "not_configured")

  const broken = evaluateDatabaseIsolation({ DATABASE_URL: "not a url at all" } as NodeJS.ProcessEnv)
  assert.equal(broken.ok, false)
  assert.equal(broken.reason, "unparseable_target")
})

test("the diagnostic is redacted and safe to print at startup", () => {
  const diagnostic = databaseIsolationDiagnostic(baseEnv())
  const serialized = JSON.stringify(diagnostic)
  assert.ok(!serialized.includes("s3cr3t-not-a-real-password"), `password leaked: ${serialized}`)
  assert.equal(diagnostic.database, "zwscloud")
  assert.equal(diagnostic.username, "appuser")
  assert.equal(diagnostic.ok, false)
})

test("every database connection funnels through the guard", () => {
  const source = readFileSync("lib/db-url.ts", "utf8")
  // ensureDatabaseUrl and assertDatabaseUrl are the only entry points the
  // Prisma client uses, so both must be guarded.
  assert.match(source, /export function ensureDatabaseUrl\(\)[\s\S]*?guardAgainstProductionTarget/)
  assert.match(source, /export function assertDatabaseUrl\(\)[\s\S]*?guardAgainstProductionTarget/)

  // The migrate entrypoint must refuse before prisma runs.
  const entrypoint = readFileSync("docker-entrypoint.sh", "utf8")
  const migrateBlock = entrypoint.slice(entrypoint.indexOf("  migrate)"), entrypoint.indexOf("  app)"))
  assert.match(migrateBlock, /assert-db-isolation\.ts/)
  assert.ok(
    migrateBlock.indexOf("assert-db-isolation") < migrateBlock.indexOf("prisma migrate deploy"),
    "the guard must run before migrations, not after"
  )
  assert.match(migrateBlock, /exit 78/)
})

test("the isolation diagnostic never prints a connection string", () => {
  const source = readFileSync("lib/db-isolation.ts", "utf8")
  const body = source.slice(source.indexOf("export function databaseIsolationDiagnostic"))
  assert.ok(!/console\.(log|error|warn)\([^)]*target\.url/.test(body))
  assert.ok(!/resolved\.url/.test(body), "the diagnostic must not touch the raw URL")
})