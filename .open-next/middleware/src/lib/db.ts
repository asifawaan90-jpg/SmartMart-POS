import { PrismaClient as PrismaSqlite } from '@prisma/client'
import { PrismaClient as PrismaPg } from '@/generated/postgres'
import { assertDbConfig, dbProvider, normalizePgUrl, type DbProvider } from './db-provider'

const STRING_FILTERS = ['contains', 'startsWith', 'endsWith'] as const

function makePostgresFiltersInsensitive(value: unknown, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 16) return
  if (Array.isArray(value)) {
    value.forEach(item => makePostgresFiltersInsensitive(item, depth + 1))
    return
  }
  const record = value as Record<string, unknown>
  for (const [key, nested] of Object.entries(record)) {
    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      makePostgresFiltersInsensitive(nested, depth + 1)
    } else if ((STRING_FILTERS as readonly string[]).includes(key) && typeof nested === 'string') {
      if (typeof record.mode !== 'string') record.mode = 'insensitive'
    } else if (nested && typeof nested === 'object') {
      makePostgresFiltersInsensitive(nested, depth + 1)
    }
  }
}

type CachedClient = { provider: DbProvider; client: PrismaSqlite }
const globalForDb = globalThis as typeof globalThis & { __smPrisma?: CachedClient }

function makeClient(): PrismaSqlite {
  assertDbConfig()
  if (dbProvider() === 'postgres') {
    const postgres = new PrismaPg({
      datasources: { db: { url: normalizePgUrl() } },
      // log disabled for speed
    })
    const client = postgres.$extends({
      query: {
        $allModels: {
          $allOperations({ args, query }) {
            makePostgresFiltersInsensitive(args)
            return query(args)
          },
        },
      },
    })
    return client as unknown as PrismaSqlite
  }
  return new PrismaSqlite({
    datasources: { db: { url: 'file:../db/custom.db' } },
    // log disabled for speed
  })
}

const provider = dbProvider()
export const db =
  globalForDb.__smPrisma?.provider === provider
    ? globalForDb.__smPrisma.client
    : makeClient()

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__smPrisma = { provider, client: db }
}
