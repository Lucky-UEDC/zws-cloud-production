/**
 * Refuse to run the test suite against a declared production database.
 *
 * The unit tests are mostly pure, but a suite that imports a module touching
 * Prisma would silently inherit whatever `DATABASE_URL` happens to point at.
 * On a development host that used to be the production-named database, so a
 * test that grew a query would have written to it. This runs before the tests,
 * fails closed, and prints only a redacted diagnostic.
 *
 * When `TEST_DATABASE_URL` is configured it is used as the effective target, so
 * a database-backed test runs against the dedicated test database and the
 * development database is never at risk either.
 */
import "dotenv/config"
import { evaluateDatabaseIsolation } from "@/lib/db-isolation"

const testUrl = String(process.env.TEST_DATABASE_URL || "").trim()
const effective = testUrl ? { ...process.env, DATABASE_URL: testUrl } : process.env

const verdict = evaluateDatabaseIsolation(effective)

if (!verdict.ok) {
  console.error(
    `[test-db-guard] refusing to run tests: ${verdict.detail}\n` +
      `[test-db-guard] target database=${verdict.target.database} host=${verdict.target.host} ` +
      `role=${verdict.target.username} (passwords and connection strings are never printed)`
  )
  process.exit(78)
}

console.log(
  `[test-db-guard] tests will run against database=${verdict.target.database} ` +
    `host=${verdict.target.host} role=${verdict.target.username || "(none)"} ` +
    `source=${testUrl ? "TEST_DATABASE_URL" : "DATABASE_URL"}`
)
