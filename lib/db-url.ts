import "dotenv/config"

export type DbUrlResolution = {
  configured: boolean
  url: string
  source: "database-url" | "db-fields" | "missing"
  missing: string[]
}

const POSTGRES_CONNECTIONS = new Set(["postgresql", "postgres", "pgsql"])

function readEnv(key: string) {
  return String(process.env[key] || "").trim()
}

function withPoolLimits(rawUrl: string): string {
  if (!rawUrl) return rawUrl
  try {
    const url = new URL(rawUrl)
    if (!POSTGRES_CONNECTIONS.has(url.protocol.replace(/:$/, "").toLowerCase())) return rawUrl
    if (!url.searchParams.has("connection_limit")) {
      url.searchParams.set("connection_limit", readEnv("DB_CONNECTION_LIMIT") || "3")
    }
    if (!url.searchParams.has("pool_timeout")) {
      url.searchParams.set("pool_timeout", readEnv("DB_POOL_TIMEOUT") || "20")
    }
    if (!url.searchParams.has("connect_timeout")) {
      url.searchParams.set("connect_timeout", readEnv("DB_CONNECT_TIMEOUT") || "10")
    }
    if (!url.searchParams.has("statement_timeout")) {
      url.searchParams.set("statement_timeout", readEnv("DB_STATEMENT_TIMEOUT_MS") || "10000")
    }
    return url.toString()
  } catch {
    return rawUrl
  }
}

export function resolveDatabaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): DbUrlResolution {
  const readEnv = (key: string) => String(env[key] || "").trim()
  const configuredDatabaseUrl = readEnv("DATABASE_URL")
  if (configuredDatabaseUrl) {
    return {
      configured: true,
      url: withPoolLimits(configuredDatabaseUrl),
      source: "database-url",
      missing: [],
    }
  }

  const connection = readEnv("DB_CONNECTION").toLowerCase()
  const host = readEnv("DB_HOST")
  const port = readEnv("DB_PORT") || "5432"
  const database = readEnv("DB_DATABASE")
  const username = readEnv("DB_USERNAME")
  const password = env.DB_PASSWORD || ""
  const schema = readEnv("DB_SCHEMA") || "public"

  const missing: string[] = []
  if (!connection) missing.push("DB_CONNECTION")
  if (connection && !POSTGRES_CONNECTIONS.has(connection)) missing.push("DB_CONNECTION=postgresql")
  if (!host) missing.push("DB_HOST")
  if (!database) missing.push("DB_DATABASE")
  if (!username) missing.push("DB_USERNAME")
  if (!password) missing.push("DB_PASSWORD")

  if (missing.length > 0) {
    return { configured: false, url: "", source: "missing", missing }
  }

  const url = new URL(`postgresql://${host}:${port}/${database}`)
  url.username = username
  url.password = password
  url.searchParams.set("schema", schema)

  return {
    configured: true,
    url: withPoolLimits(url.toString()),
    source: "db-fields",
    missing: [],
  }
}

export function sanitizePostgresUrlForPgDump(raw: string) {
  try {
    const url = new URL(raw)
    const sslmode = url.searchParams.get("sslmode")
    url.search = ""
    if (sslmode) url.searchParams.set("sslmode", sslmode)
    return url.toString()
  } catch {
    return raw
  }
}

/**
 * Assert the resolved target is not a declared production database.
 *
 * Every database connection in the process funnels through `ensureDatabaseUrl`,
 * so guarding here is what makes the check impossible to forget at a call
 * site. Read-only callers that legitimately need to inspect configuration
 * should use `resolveDatabaseUrlFromEnv` directly.
 */
function guardAgainstProductionTarget(url: string) {
  // Imported lazily to keep this module free of a cycle: db-isolation resolves
  // its target through this file.
  const { assertDatabaseIsolation } = require("@/lib/db-isolation") as typeof import("@/lib/db-isolation")
  assertDatabaseIsolation()
  return url
}

export function ensureDatabaseUrl(): string {
  const resolved = resolveDatabaseUrlFromEnv()
  if (resolved.configured) {
    process.env.DATABASE_URL = resolved.url
    return guardAgainstProductionTarget(resolved.url)
  }
  return ""
}

export function assertDatabaseUrl(): string {
  const resolved = resolveDatabaseUrlFromEnv()
  if (!resolved.configured) {
    throw new Error(`PostgreSQL DATABASE_URL or DB_* configuration is incomplete: ${resolved.missing.join(", ")}`)
  }
  process.env.DATABASE_URL = resolved.url
  return guardAgainstProductionTarget(resolved.url)
}
