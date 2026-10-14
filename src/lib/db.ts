import { PrismaClient as PrismaSqlite } from '@prisma/client'
// Task 64 — second, provider-differentiated client generated from
// prisma/schema.postgres.prisma (identical models, postgresql datasource).
import { PrismaClient as PrismaPg } from '@/generated/postgres'
import { assertDbConfig, dbProvider, normalizePgUrl, type DbProvider } from './db-provider'

/**
 * Task 64 — one `db` for both worlds.
 *
 *  - DB_PROVIDER=sqlite  → the historical local file client (@prisma/client)
 *  - DB_PROVIDER=postgres → the Supabase client (@/generated/postgres) with
 *    two Postgres-specific behaviors baked in below:
 *      1. CASE-INSENSITIVE SEARCH PARITY — Prisma's `contains` is
 *         case-sensitive on Postgres but was case-insensitive on SQLite;
 *         every contains/startsWith/endsWith filter is transparently marked
 *         `mode: 'insensitive'` so POS search feels exactly the same.
 *      2. POOLER-SAFE URL — transaction-pooler URIs (port 6543) get
 *         pgbouncer=true and TLS is always required (see db-provider.ts).
 *
 * Fail-loud: a broken provider config throws as the client is created
 * instead of silently writing shop data to the wrong database.
 */

const OPS = ['contains', 'startsWith', 'endsWith'] as const

/** Recursively mark string search filters case-insensitive (Postgres only).
 *  Walks AND/OR/NOT and nested relation filters; never touches `equals`,
 *  `in`, or filters that already carry an explicit `mode`. */
function ciDeep(node: unknown, depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 16) return
  if (Array.isArray(node)) { node.forEach(n => ciDeep(n, depth + 1)); return }
  const rec = node as Record<string, unknown>
  for (const [k, v] of Object.entries(rec)) {
    if ((k === 'AND' || k === 'OR' || k === 'NOT') && v !== undefined && v !== null) { ciDeep(v, depth + 1); continue }
    if ((OPS as readonly string[]).includes(k) && typeof v === 'string') {
      if (typeof rec.mode !== 'string') rec.mode = 'insensitive'
      continue
    }
    if (v && typeof v === 'object') ciDeep(v, depth + 1)
  }
}

type ClientCache = { provider: DbProvider; client: PrismaSqlite }
const g = globalThis as unknown as { __smPrisma?: ClientCache }

function makeClient(): PrismaSqlite {
  assertDbConfig() // fail loud on an impossible provider configuration
  if (dbProvider() === 'postgres') {
    const url = normalizePgUrl()
    let host = ''
    try { host = new URL(url).host } catch { /* assert already validated */ }
    console.log(`[db] provider=postgres (Supabase cloud) host=${host}${url.includes('pgbouncer=true') ? ' [transaction-pooler mode]' : ''}`)
    const pg = new PrismaPg({
      datasources: { db: { url } },
      log: ['query'],
    })
    const extended = pg.$extends({
      query: {
        $allModels: {
          $allOperations({ args, query }) {
            ciDeep(args)
            return query(args)
          },
        },
      },
    })
    return extended as unknown as PrismaSqlite
  }
  if ((process.env.SUPABASE_DATABASE_URL || '').trim() && process.env.DB_PROVIDER !== 'postgres') {
    console.log('[db] provider=sqlite (local file) — SUPABASE_DATABASE_URL is present but DB_PROVIDER is not "postgres", so the cloud database is NOT in use yet')
  }
  return new PrismaSqlite({ log: ['query'] })
}

const cachedClient = g.__smPrisma
const currentProvider = dbProvider()
export const db: PrismaSqlite =
  cachedClient && cachedClient.provider === currentProvider ? cachedClient.client : makeClient()

if (process.env.NODE_ENV !== 'production' && (!cachedClient || cachedClient.provider !== currentProvider)) {
  g.__smPrisma = { provider: currentProvider, client: db }
}
