import "dotenv/config"
import { resolveDatabaseUrlFromEnv } from "@/lib/db-url"

/**
 * Development / production database isolation guard.
 *
 * The problem this exists to prevent is specific and already observed: the
 * development stack is configured against the `main` role database, and a
 * development host is *not* evidence that the database is a development
 * database. A migration run from a dev box against a shared production
 * database is the single most damaging mistake available in this codebase,
 * because it takes out live orders, invoices and customer records.
 *
 * Everything here is derived from configuration alone. The guard never opens
 * a connection to ask "is this production?" - by then it would already be
 * connected. Production identity is declared explicitly via environment
 * variables, and any connection whose target matches a declared production
 * identity is refused unless an operator overrides it deliberately.
 */

export type ResolvedDatabaseTarget = {
  configured: boolean
  source: "database-url" | "db-fields" | "missing"
  protocol: string
  host: string
  port: string
  database: string
  username: string
  missing: string[]
}

/**
 * Describe the connection target without ever exposing the password.
 *
 * Only the parsed pieces are returned. The full URL is deliberately not part
 * of this type so it cannot be logged by accident.
 */
export function describeResolvedDatabaseTarget(env: NodeJS.ProcessEnv = process.env): ResolvedDatabaseTarget {
  const resolved = resolveDatabaseUrlFromEnv(env)
  if (!resolved.configured || !resolved.url) {
    return {
      configured: false,
      source: resolved.source,
      protocol: "",
      host: "",
      port: "",
      database: "",
      username: "",
      missing: resolved.missing,
    }
  }
  try {
    const url = new URL(resolved.url)
    return {
      configured: true,
      source: resolved.source,
      protocol: url.protocol.replace(":", ""),
      host: url.hostname,
      port: url.port || "5432",
      database: decodeURIComponent(url.pathname.replace(/^\//, "")),
      username: decodeURIComponent(url.username || ""),
      missing: [],
    }
  } catch {
    // An unparseable URL is itself a reason to refuse, so report it honestly.
    return {
      configured: false,
      source: resolved.source,
      protocol: "",
      host: "",
      port: "",
      database: "",
      username: "",
      missing: ["unparseable DATABASE_URL"],
    }
  }
}

function csv(value: string | undefined) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Databases that must never be written to from a non-production context.
 *
 * `zwscloud` is included by default because `database_registry` designates it
 * as the `main` (production) role. Override with
 * `ZWS_PRODUCTION_DATABASE_NAMES` to match your own naming.
 */
export function productionDatabaseNames(env: NodeJS.ProcessEnv = process.env) {
  const configured = csv(env.ZWS_PRODUCTION_DATABASE_NAMES)
  return new Set(configured.length ? configured : ["zwscloud"])
}

/** Hosts that are known to serve production. Empty means "no host restriction". */
export function productionDatabaseHosts(env: NodeJS.ProcessEnv = process.env) {
  return new Set(csv(env.ZWS_PRODUCTION_DATABASE_HOSTS))
}

export type IsolationVerdict = {
  ok: boolean
  /** Machine-readable reason, safe to log and to assert on in tests. */
  reason:
    | "isolated"
    | "not_configured"
    | "production_database_target"
    | "production_host_target"
    | "unparseable_target"
    | "override_active"
  target: ResolvedDatabaseTarget
  /** Set when the connection was refused. */
  detail: string
  /** True when the operator has explicitly overridden the guard. */
  overridden: boolean
  productionDatabases: string[]
  productionHosts: string[]
}

/**
 * Decide whether the configured target is safe to use for writes.
 *
 * A target is refused when its database name matches a declared production
 * name, or when its host is a declared production host and the database name
 * is not an explicit development name. Matching on name alone would be too
 * blunt across self-hosted setups, so host entries are honoured too.
 */
export function evaluateDatabaseIsolation(env: NodeJS.ProcessEnv = process.env): IsolationVerdict {
  const target = describeResolvedDatabaseTarget(env)
  const productionDatabases = [...productionDatabaseNames(env)]
  const productionHosts = [...productionDatabaseHosts(env)]
  const base = { target, productionDatabases, productionHosts }

  if (!target.configured) {
    // An unparseable URL is a different fault from "nothing was configured":
    // the first means a typo that must not silently disable the guard, the
    // second means there is simply no database yet.
    const unparseable = target.missing.some((entry) => entry.toLowerCase().includes("unparseable"))
    return {
      ...base,
      ok: false,
      reason: unparseable ? "unparseable_target" : "not_configured",
      detail: target.missing.length
        ? `Database target could not be resolved: ${target.missing.join(", ")}`
        : "No database is configured, so isolation cannot be established.",
      overridden: false,
    }
  }

  const database = target.database.toLowerCase()
  const host = target.host.toLowerCase()
  const hitsProductionName = productionDatabaseNames(env).has(database)
  const hitsProductionHost = productionDatabaseHosts(env).has(host)
  const refused = hitsProductionName || hitsProductionHost

  const overrideRequested = csv(env.ZWS_ALLOW_PRODUCTION_DATABASE_ACCESS).includes("1") ||
    String(env.ZWS_ALLOW_PRODUCTION_DATABASE_ACCESS || "").trim().toLowerCase() === "true"

  if (refused) {
    const detail = [
      hitsProductionName ? `database "${target.database}" is a declared production database` : null,
      hitsProductionHost ? `host "${target.host}" is a declared production database host` : null,
    ]
      .filter(Boolean)
      .join("; ")
    return {
      ...base,
      ok: overrideRequested,
      // Report which rule actually matched: "wrong database on the right host"
      // and "right database on the wrong host" need different fixes.
      reason: overrideRequested
        ? "override_active"
        : hitsProductionName
          ? "production_database_target"
          : "production_host_target",
      detail: overrideRequested
        ? `REFUSED BY DEFAULT BUT OVERRIDDEN: ${detail}. Development is writing to a production database.`
        : `${detail}. Refusing to open a write-capable connection. Point development at its own database, or set ZWS_ALLOW_PRODUCTION_DATABASE_ACCESS=1 only if this is genuinely the production host.`,
      overridden: overrideRequested,
    }
  }

  return {
    ...base,
    ok: true,
    reason: "isolated",
    detail: `Target ${target.database} on ${target.host}:${target.port} as ${target.username} does not match any declared production identity.`,
    overridden: false,
  }
}

/**
 * Refuse to continue when the target is a declared production database.
 *
 * Intended for startup and for the migration entrypoint. The throw message
 * names the target but never the password.
 */
export function assertDatabaseIsolation(env: NodeJS.ProcessEnv = process.env): IsolationVerdict {
  const verdict = evaluateDatabaseIsolation(env)
  if (!verdict.ok) {
    throw new Error(`[db-isolation] ${verdict.detail}`)
  }
  return verdict
}

/**
 * Gate for destructive or schema-changing work.
 *
 * Migrations, `db push` and restore operations call this first. Even when the
 * target is isolated, a restore additionally requires
 * `ZWS_ALLOW_RESTORE_IN_DEVELOPMENT=1`, so a restore cannot be triggered by a
 * stray command or a compromised admin session against a development database
 * that is still being worked in.
 */
export function assertSchemaWriteAllowed(operation: string, env: NodeJS.ProcessEnv = process.env): IsolationVerdict {
  const verdict = evaluateDatabaseIsolation(env)
  if (!verdict.ok) {
    throw new Error(`[db-isolation] ${operation} refused: ${verdict.detail}`)
  }
  const restoreRequested = csv(env.ZWS_ALLOW_RESTORE_IN_DEVELOPMENT).includes("1")
  if (/restore/i.test(operation) && !restoreRequested) {
    throw new Error(
      `[db-isolation] ${operation} refused: a restore must target an explicit restoration database. Set ` +
        `DATABASE_URL/DB_DATABASE to a dedicated restoration target, or set ZWS_ALLOW_RESTORE_IN_DEVELOPMENT=1 to acknowledge this explicitly.`
    )
  }
  return verdict
}

/** Single-line, redacted diagnostic safe to print in logs and startup output. */
export function databaseIsolationDiagnostic(env: NodeJS.ProcessEnv = process.env) {
  const verdict = evaluateDatabaseIsolation(env)
  return {
    ok: verdict.ok,
    reason: verdict.reason,
    overridden: verdict.overridden,
    host: verdict.target.host,
    port: verdict.target.port,
    database: verdict.target.database,
    username: verdict.target.username,
    source: verdict.target.source,
    productionDatabases: verdict.productionDatabases,
    detail: verdict.detail,
  }
}