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

test("a build or CI database on a local address is not mistaken for production", () => {
  // The project's own CI points at a disposable instance on 127.0.0.1 that
  // happens to share the production database *name*. Name matching alone would
  // refuse every build, so a local address is exempt.
  const ci = evaluateDatabaseIsolation(baseEnv({
    DATABASE_URL: "postgresql://zwscloud_app:pw@127.0.0.1:5432/zwscloud?schema=public",
  }))
  assert.equal(ci.ok, true, "a loopback database must not be refused on name alone")
  assert.equal(ci.reason, "isolated")

  assert.equal(evaluateDatabaseIsolation(baseEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/zwscloud" })).ok, true)
  assert.equal(evaluateDatabaseIsolation(baseEnv({ DATABASE_URL: "postgresql://u:p@postgres:5432/zwscloud" })).ok, true)

  // The exemption is not a loophole: declaring the host as production wins.
  const declared = evaluateDatabaseIsolation(baseEnv({
    DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/zwscloud",
    ZWS_PRODUCTION_DATABASE_HOSTS: "127.0.0.1",
  }))
  assert.equal(declared.ok, false)
  assert.equal(declared.reason, "production_host_target")
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

test("the guard has no dependencies, so it can always load", () => {
  const source = readFileSync("lib/db-isolation.ts", "utf8")
  // The guard consults db-url; if it also imported it, the two would form a
  // cycle and the guard would fail to load in any context that resolves
  // modules outside the bundler alias. It broke `next build` once already.
  assert.doesNotMatch(source, /^import .*from ["'](?:@\/lib\/db-url|\.\/db-url)["']/m)
  // db-url reaches it with a relative import for the same reason.
  const urlSource = readFileSync("lib/db-url.ts", "utf8")
  assert.match(urlSource, /import \{ assertDatabaseIsolation \} from "\.\/db-isolation"/)
  assert.doesNotMatch(urlSource, /require\(["']@\/lib\/db-isolation/)
})

test("every database connection funnels through the guard", () => {
  // The guard must sit on the connection path, not on URL resolution: a module
  // that reads the connection string at import time is imported by `next build`
  // while collecting page data, and must not fail the build there.
  const source = readFileSync("lib/db-url.ts", "utf8")
  assert.match(source, /export function guardDatabaseConnection/)
  // ensureDatabaseUrl/assertDatabaseUrl resolve a string and must not throw.
  assert.match(source, /export function ensureDatabaseUrl\(\)[\s\S]{0,300}?resolveDatabaseUrlFromEnv\(\)/)
  assert.doesNotMatch(source, /export function ensureDatabaseUrl\(\)[\s\S]{0,300}?assertDatabaseIsolation\(\)/)

  // Every query goes through the single Prisma constructor, so that is where
  // the check has to be.
  const db = readFileSync("lib/db.ts", "utf8")
  assert.match(db, /guardDatabaseConnection\(\)/)
  const constructor = db.slice(db.indexOf("function createPrismaClient("), db.indexOf("return new PrismaClientConstructor"))
  assert.ok(
    constructor.indexOf("guardDatabaseConnection()") > -1,
    "the Prisma client must be refused before it is constructed"
  )
  assert.ok(
    constructor.indexOf("guardDatabaseConnection()") < constructor.indexOf("loadPrismaClientConstructor()"),
    "the guard must run before the client is built"
  )

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