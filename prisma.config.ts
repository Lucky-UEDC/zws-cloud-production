import "dotenv/config"
import { defineConfig } from "prisma/config"
import { resolveDatabaseUrlFromEnv } from "./lib/db-url"

/**
 * Prisma tooling configuration.
 *
 * `prisma generate` is code generation: it reads the schema and emits a client,
 * and it never connects to the database or touches a row. It therefore must not
 * be subject to the write-isolation guard, or the project becomes impossible to
 * build while development correctly refuses to write to production. Connecting
 * is gated separately, in `ensureDatabaseUrl` / `assertDatabaseUrl`.
 *
 * A placeholder is supplied when nothing is configured so generation still works
 * on a fresh checkout with no environment at all.
 */
const resolved = resolveDatabaseUrlFromEnv()

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: resolved.configured ? resolved.url : "postgresql://placeholder:placeholder@localhost:5432/placeholder",
  },
})