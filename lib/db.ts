/**
 * Database client singleton for Prisma
 * Ensures single connection throughout the application lifecycle
 * Derives Prisma's internal connection URL from split PostgreSQL DB_* fields.
 */

import type { PrismaClient } from '@prisma/client'
import { createRequire } from 'node:module'
import { ensureDatabaseUrl, guardDatabaseConnection } from '@/lib/db-url'

const runtimeRequire = createRequire(import.meta.url)
const SLOW_QUERY_MS = Number(process.env.DB_SLOW_QUERY_MS || 100)

const globalForPrisma = global as unknown as { prisma: PrismaClient | null }

function resolveDatabaseUrl(): string {
  return ensureDatabaseUrl()
}

function isDatabaseConfigured(): boolean {
  return !!resolveDatabaseUrl()
}

function loadPrismaClientConstructor(): new (...args: any[]) => PrismaClient {
  const prismaModule = runtimeRequire("@prisma/client") as {
    PrismaClient?: new (...args: any[]) => PrismaClient
    default?: { PrismaClient?: new (...args: any[]) => PrismaClient }
  }
  const Constructor = prismaModule.PrismaClient || prismaModule.default?.PrismaClient
  if (typeof Constructor !== "function") {
    throw new TypeError("[DB] PrismaClient constructor is not available from @prisma/client")
  }
  return Constructor
}

// Only create PrismaClient if PostgreSQL DB_* fields are complete.
function createPrismaClient(): PrismaClient | null {
  if (!isDatabaseConfigured()) {
    console.warn('[DB] PostgreSQL DB_* configuration missing - database operations will be disabled')
    return null
  }

  // Every query in the process goes through this one constructor, so refusing
  // here is what stops development from reading or writing a declared
  // production database. URL resolution above it stays unguarded so that build
  // tooling, which only reads a connection string, keeps working.
  guardDatabaseConnection()

  const PrismaClientConstructor = loadPrismaClientConstructor()
  const client = new PrismaClientConstructor({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : [{ emit: 'event', level: 'query' }, { emit: 'stdout', level: 'error' }, { emit: 'stdout', level: 'warn' }],
  } as any)

  if (process.env.NODE_ENV === 'production') {
    ;(client as any).$on?.('query', (event: { duration?: number; query?: string }) => {
      const duration = Number(event.duration || 0)
      if (duration < SLOW_QUERY_MS) return
      console.warn('[DB] slow_query', {
        durationMs: duration,
        query: String(event.query || '').replace(/\s+/g, ' ').slice(0, 500),
      })
    })
  }

  return client
}

// Lazy initialization - only create client when accessed
let prismaClient: PrismaClient | null = null

function getPrismaClient(): PrismaClient | null {
  if (prismaClient) return prismaClient
  if (globalForPrisma.prisma) return globalForPrisma.prisma
  
  prismaClient = createPrismaClient()
  
  if (prismaClient && process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prismaClient
  }
  
  return prismaClient
}

// Export a proxy that lazily initializes the client
export const prisma = new Proxy({} as PrismaClient, {
  get(_, prop) {
    const client = getPrismaClient()
    if (!client) {
      // Return a no-op for methods when database is not configured
      if (typeof prop === 'string') {
        return new Proxy({}, {
          get() {
            return async () => {
              console.warn(`[DB] Skipping database operation - PostgreSQL DB_* configuration missing`)
              return null
            }
          }
        })
      }
      return undefined
    }
    return (client as any)[prop]
  }
})

export default prisma

// Helper to check if database is available
export function isDatabaseAvailable(): boolean {
  return isDatabaseConfigured()
}
