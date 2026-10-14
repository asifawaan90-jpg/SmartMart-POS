/**
 * Task 64 — single source of truth for WHICH database the backend uses.
 *
 *   DB_PROVIDER=sqlite  (default) → db/custom.db file (local mode)
 *   DB_PROVIDER=postgres          → SUPABASE_DATABASE_URL (Supabase cloud)
 *
 * The Supabase URI itself is stored in .env as SUPABASE_DATABASE_URL and is
 * opt-in: merely pasting it does NOT switch the app (no accidental
 * split-brain where some data lands in the cloud and some stays local).
 * Going live is explicit: DB_PROVIDER=postgres — normally set for you by
 * scripts/task64-supabase-connect.sh, which also pushes the schema and
 * migrates all existing data first.
 *
 * This module imports NOTHING except node:fs (for the 64m self-heal probe —
 * no Prisma, no project modules) so every layer — the client factory,
 * boot-heal, backup scheduler, firebase backup, API routes — can depend on it
 * without cycles or heavy imports.
 */

import fs from 'fs'

export type DbProvider = 'sqlite' | 'postgres'

const PG_URL_KEY = 'SUPABASE_DATABASE_URL'

/** Task 64m — self-heal for platform reprovisions.
 *  The container reprovision (2026-10-09 01:59 UTC) regenerated .env from its
 *  template and wiped DB_PROVIDER=postgres + SUPABASE_DATABASE_URL, silently
 *  reverting the app to the local sqlite file. scripts/ survives those resets,
 *  so on first provider lookup we restore the cloud keys from the durable
 *  backup file — but ONLY when it is explicitly ACTIVE=1 (the opt-in stays
 *  explicit; no accidental split-brain). Runs once per process. */
const CLOUD_ENV_FILE = '/home/z/my-project/scripts/task64-env-cloud.env'
let cloudEnvProbeDone = false
function loadCloudEnvBackup(): void {
  if (cloudEnvProbeDone) return
  cloudEnvProbeDone = true
  try {
    const raw = fs.readFileSync(CLOUD_ENV_FILE, 'utf8')
    const kv: Record<string, string> = {}
    let active = false
    for (const line of raw.split('\n')) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (!m) continue
      if (m[1] === 'ACTIVE') active = m[2] === '1'
      else kv[m[1]] = m[2]
    }
    if (!active) return
    let healed = false
    if (!process.env.SUPABASE_DATABASE_URL?.trim() && kv.SUPABASE_DATABASE_URL) {
      process.env.SUPABASE_DATABASE_URL = kv.SUPABASE_DATABASE_URL
      healed = true
    }
    if (!process.env.DB_PROVIDER?.trim() && kv.DB_PROVIDER) {
      process.env.DB_PROVIDER = kv.DB_PROVIDER
      healed = true
    }
    if (healed) console.log('[db-provider] self-heal: .env lost the Supabase keys — restored them from scripts/task64-env-cloud.env')
  } catch {
    /* backup file absent or unreadable → plain env-driven behavior */
  }
}

export function pgUrl(): string {
  loadCloudEnvBackup()
  return (process.env[PG_URL_KEY] || '').trim()
}

export function pgUrlLooksValid(url?: string): boolean {
  const u = (url ?? pgUrl()).trim()
  if (!u.startsWith('postgresql://') && !u.startsWith('postgres://')) return false
  try {
    const parsed = new URL(u)
    const credentials = decodeURIComponent(`${parsed.username} ${parsed.password}`)
    const hasPlaceholder = /your[_-]?(?:project[_-]?(?:id|ref)|password)|xxxxx|placeholder|example/i.test(credentials)
    return !!parsed.hostname && !!parsed.username && !!parsed.password && !hasPlaceholder && !/[<>]/.test(u)
  } catch {
    return false
  }
}

export function isPostgres(): boolean {
  loadCloudEnvBackup() // 69-fix: probe FIRST — otherwise a wiped env short-circuits on DB_PROVIDER and the heal never runs
  if (process.env.DB_PROVIDER !== 'postgres') return false
  assertDbConfig()
  return true
}

export function dbProvider(): DbProvider {
  return isPostgres() ? 'postgres' : 'sqlite'
}

/** Hostname only (never the password) — safe for logs and UI chips. */
export function pgHost(): string {
  try { return new URL(pgUrl()).hostname } catch { return '' }
}

/** Fail LOUD at boot on an impossible configuration — silent fallback would
 *  silently split data between the local file and the cloud, which is the
 *  one failure mode this app must never have. */
export function assertDbConfig(): void {
  loadCloudEnvBackup() // 69-fix: ensure the probe ran before judging the config
  if (process.env.DB_PROVIDER !== 'postgres') return
  const u = pgUrl()
  if (!u) {
    throw new Error(
      '[db] DB_PROVIDER=postgres but SUPABASE_DATABASE_URL is empty. ' +
      'Paste your Supabase connection string into .env ' +
      '(Supabase Dashboard → Connect → Session pooler URI), then run: ' +
      "./scripts/task64-supabase-connect.sh '<the-uri>'",
    )
  }
  if (!pgUrlLooksValid(u)) {
    throw new Error(
      '[db] SUPABASE_DATABASE_URL is not a valid PostgreSQL connection URI ' +
      '(it must include a real hostname, username, and password, not template values such as YOUR_PROJECT_ID or YOUR_PASSWORD). ' +
      'Copy the PostgreSQL URI from Supabase → Connect, update .env locally, and restart.',
    )
  }
}

/** Prisma URL hardening for Supabase poolers:
 *  - transaction pooler (port 6543) breaks prepared statements → pgbouncer=true
 *  - demand TLS for remote hosts (Supabase rejects plaintext) — but never for
 *    loopback/direct-IP databases (local rehearsal PGs have no TLS)
 *  Idempotent: never duplicates an existing parameter. */
export function normalizePgUrl(url = pgUrl()): string {
  let u = url.trim()
  if (!u) return u
  const has = (k: string) => u.includes(`${k}=`)
  const sep = u.includes('?') ? '&' : '?'
  if (u.includes(':6543/') && !has('pgbouncer')) u += `${sep}pgbouncer=true&connection_limit=1`
  let remote = true
  try {
    const h = new URL(u).hostname
    remote = !/^(localhost|127\.|::1|\[::1\])/.test(h) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(h)
  } catch { /* keep remote=true → TLS demanded */ }
  if (remote && !has('sslmode')) u += `${u.includes('?') ? '&' : '?'}sslmode=require`
  return u
}
