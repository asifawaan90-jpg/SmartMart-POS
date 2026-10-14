/**
 * Task 56 — Firebase Realtime Database cloud backup.
 *
 * The platform owner registered https://smart-mart-app-by-asif-default-rtdb.firebaseio.com
 * as an OFF-SITE copy of the app's data, on top of the local snapshot chain
 * (backups/custom-*.db, Task 53/55) and the e-mail backup (Task 42).
 *
 * How it works (zero new dependencies):
 *   1. newest local snapshot  → AES-256-GCM ENCRYPTED with a server-side key
 *      (derived from JWT_SECRET — password hashes / SMTP passes never leave
 *      the machine in readable form, even if the Firebase rules were open)
 *   2. PUT <rtdb>/smartmartBackup/latest.json      (encrypted blob + meta)
 *      PUT <rtdb>/smartmartBackup/history/<ts>.json (meta only)
 *      history pruned to the newest 7
 *   3. status recorded in backups/CLOUD.json so the UI can show it honestly
 *
 * Authentication — three modes, in order of strength:
 *   1. ADMIN (preferred): FIREBASE_SERVICE_ACCOUNT env (inline JSON or path) or
 *     ./firebase-service-account.json  → RS256 JWT → OAuth2 access_token
 *     (admin identity bypasses the rules; rules stay locked)
 *   2. legacy FIREBASE_DB_SECRET → ?auth=<secret>
 *   3. OPEN mode (Task 56 fix — "auto set this"): if NO credential exists we
 *     still try unauthenticated. The owner has since opened the database
 *     rules (probed live: read/write 200), so this just works with ZERO
 *     manual steps. The blob is AES-256-GCM encrypted server-side, so the
 *     CONTENT stays private; the UI honestly flags that open rules let
 *     anyone with the link tamper with the copies and recommends the
 *     service-account key as the upgrade path. If the rules are locked we
 *     report exactly that instead of pretending.
 *
 * Node runtime only (fs/crypto/child_process) — imported from
 * backup-scheduler.ts behind the NEXT_RUNTIME === 'nodejs' guard.
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { isPostgres } from './db-provider'

export interface CloudPushResult { ok: boolean; error?: string; at?: string; size?: number; sha256?: string; skipped?: boolean }
export interface CloudVerifyResult { ok: boolean; error?: string; sha256?: string; size?: number }
export interface CloudStatus {
  url: string | null
  authConfigured: boolean
  authMode: 'service-account' | 'db-secret' | 'open' | 'none'
  /** true when the database accepts unauthenticated access (rules open) */
  openRules: boolean
  last: { at: string; ok: boolean; error?: string; size?: number; sha256?: string; mode?: string } | null
}

const RTDB = (process.env.FIREBASE_RTDB_URL || '').replace(/\/+$/, '') || null
const BACKUP_DIR = path.join(process.cwd(), 'backups')
const STATE_FILE = path.join(BACKUP_DIR, 'CLOUD.json')
const BASE = 'smartmartBackup'
const HISTORY_KEEP = 7
const FETCH_TIMEOUT_MS = 60_000

// ---------- auth ----------

function serviceAccount(): Record<string, unknown> | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  try {
    if (raw && raw.trim().startsWith('{')) return JSON.parse(raw)
    const file = raw && raw.trim() ? raw.trim() : path.join(process.cwd(), 'firebase-service-account.json')
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    console.warn('[cloud-backup] service account unreadable:', (e as Error).message)
  }
  return null
}

type G = typeof globalThis & { __smCloudToken?: { token: string; exp: number } }
const g = globalThis as G

async function accessToken(sa: Record<string, unknown>): Promise<string> {
  if (g.__smCloudToken && g.__smCloudToken.exp > Date.now() + 60_000) return g.__smCloudToken.token
  const now = Math.floor(Date.now() / 1000)
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const header = b64({ alg: 'RS256', typ: 'JWT' })
  const claims = b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3300,
  })
  const private_key = String(sa.private_key).replace(/\\n/g, '\n')
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(`${header}.${claims}`)
  const sig = signer.sign(private_key, 'base64url')
  const jwt = `${header}.${claims}.${sig}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const j = (await res.json()) as { access_token?: string; error_description?: string }
  if (!res.ok || !j.access_token) throw new Error(`Firebase auth failed: ${j.error_description || res.status}`)
  g.__smCloudToken = { token: j.access_token, exp: Date.now() + 3000_000 }
  return j.access_token
}

type ProbeG = typeof globalThis & { __smCloudProbe?: { at: number; openRules: boolean } }
const pg = globalThis as ProbeG

/** Cheap unauthenticated reachability/openness probe (cached 2 min) — powers the honest UI badges. */
async function probeOpenRules(): Promise<boolean> {
  if (pg.__smCloudProbe && Date.now() - pg.__smCloudProbe.at < 120_000) return pg.__smCloudProbe.openRules
  let open = false
  try {
    const res = await fetch(`${RTDB}/${BASE}/latest.json`, { signal: AbortSignal.timeout(8_000) })
    // 200/404 → readable without credentials (404 only when nothing stored yet)
    open = res.status === 200 || res.status === 404
  } catch { /* unreachable → not open */ }
  pg.__smCloudProbe = { at: Date.now(), openRules: open }
  return open
}

async function rtdbFetch(pathAndQuery: string, init?: { method?: string; body?: string }) {
  const secret = process.env.FIREBASE_DB_SECRET
  let url = `${RTDB}/${pathAndQuery}`
  if (secret) url += (url.includes('?') ? '&' : '?') + `auth=${encodeURIComponent(secret)}`
  else {
    const sa = serviceAccount()
    if (sa) url += (url.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(await accessToken(sa))}`
    // no credential → unauthenticated attempt (open-rules mode; a locked
    // database answers 401 which callers surface honestly)
  }
  return fetch(url, {
    method: init?.method || 'GET',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    body: init?.body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
}

// ---------- crypto ----------

function encKey(): Buffer {
  const seed = process.env.BACKUP_ENCRYPTION_KEY || process.env.JWT_SECRET || 'smartmart-dev-secret-change-in-production-0123456789'
  return crypto.scryptSync(seed, 'smartmart-cloud-backup-v1', 32)
}

function encrypt(buf: Buffer) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv)
  const data = Buffer.concat([cipher.update(buf), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

function decrypt(payload: { iv: string; tag: string; data: string }): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(payload.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()])
}

const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex')

// ---------- helpers ----------

function newestSnapshot(): { file: string; buf: Buffer } | null {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^custom-\d{8}-\d{6}\.db$/.test(f))
    if (!files.length) return null
    const file = path.join(BACKUP_DIR, files.sort().at(-1) as string)
    return { file, buf: fs.readFileSync(file) }
  } catch { return null }
}

const stateKey = (iso: string) => iso.replace(/[:.]/g, '-')

function readState(): CloudStatus['last'] {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return null }
}
function writeState(s: CloudStatus['last']) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)) } catch { /* never fatal */ }
}

export async function cloudStatus(): Promise<CloudStatus> {
  const authConfigured = !!process.env.FIREBASE_DB_SECRET || !!serviceAccount()
  const openRules = authConfigured ? true : RTDB ? await probeOpenRules() : false
  return {
    url: RTDB,
    authConfigured,
    openRules,
    authMode: serviceAccount() ? 'service-account' : process.env.FIREBASE_DB_SECRET ? 'db-secret' : openRules ? 'open' : 'none',
    last: readState(),
  }
}

/** Take a FRESH local snapshot (same self-checking script the scheduler uses), then return it. */
async function freshSnapshot(): Promise<{ file: string; buf: Buffer } | null> {
  const { execFile } = await import('child_process')
  await new Promise<void>(resolve => {
    execFile('python3', [path.join(process.cwd(), 'scripts', 'db-backup.py'), '30'], () => resolve())
  })
  return newestSnapshot()
}

// ---------- public actions ----------

export async function pushCloudBackup(mode: 'auto' | 'manual' = 'auto'): Promise<CloudPushResult> {
  // Task 64 — with the Supabase cloud database the .db-snapshot chain does
  // not exist (no local file); the live database itself is already off-site.
  if (isPostgres()) return { ok: false, skipped: true, error: 'Cloud database (Supabase) is active — Firebase .db-snapshot backups are disabled; the live database is already stored off-site' }
  const started = Date.now()
  const finish = async (r: CloudPushResult) => {
    writeState({ at: new Date().toISOString(), ok: r.ok, error: r.error, size: r.size, sha256: r.sha256, mode })
    return r
  }
  if (!RTDB) return finish({ ok: false, error: 'FIREBASE_RTDB_URL not set' })
  // No credential → we still TRY (open-rules auto mode, Task 56 fix). If the
  // rules are locked the PUT below answers 401 and we report honestly.
  const snap = mode === 'manual' ? await freshSnapshot() : newestSnapshot()
  if (!snap) return finish({ ok: false, error: 'no local snapshot found' })
  const { buf } = snap
  const size = buf.length
  const digest = sha256(buf)
  if (size > 12 * 1024 * 1024) return finish({ ok: false, error: `snapshot too large for Realtime Database (${(size / 1048576).toFixed(1)} MB)` })

  try {
    const at = new Date().toISOString()
    const blob = { at, name: path.basename(snap.file), size, sha256: digest, enc: encrypt(buf) }
    const res = await rtdbFetch(`${BASE}/latest.json`, { method: 'PUT', body: JSON.stringify(blob) })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const locked = res.status === 401 || res.status === 403
      return finish({
        ok: false,
        error: locked
          ? 'database rules are LOCKED and no admin key found — add firebase-service-account.json (Project settings → Service accounts → Generate new private key) or FIREBASE_DB_SECRET, or open the rules'
          : `Firebase PUT ${res.status}: ${text.slice(0, 200)}`,
        size, sha256: digest,
      })
    }
    if (!process.env.FIREBASE_DB_SECRET && !serviceAccount())
      console.log('[cloud-backup] connected in OPEN-rules mode (no key) — add firebase-service-account.json to lock this down')
    await rtdbFetch(`${BASE}/history/${stateKey(at)}.json`, { method: 'PUT', body: JSON.stringify({ at, name: blob.name, size, sha256: digest }) })
    // prune history to newest HISTORY_KEEP
    try {
      const shallow = await rtdbFetch(`${BASE}/history.json?shallow=true`)
      if (shallow.ok) {
        const keys = Object.keys((await shallow.json()) || {}).sort()
        for (const k of keys.slice(0, Math.max(0, keys.length - HISTORY_KEEP))) {
          await rtdbFetch(`${BASE}/history/${k}.json`, { method: 'DELETE' })
        }
      }
    } catch { /* prune is best-effort */ }
    console.log(`[cloud-backup] ${mode} → pushed ${(size / 1024).toFixed(0)}KB sha256:${digest.slice(0, 12)} in ${Date.now() - started}ms`)
    return finish({ ok: true, at, size, sha256: digest })
  } catch (e) {
    return finish({ ok: false, error: (e as Error).message, size, sha256: digest })
  }
}

/** Download the cloud copy, decrypt it, and prove it matches the stored hash — never touches the live DB. */
export async function verifyCloudBackup(): Promise<CloudVerifyResult> {
  // Task 64 — nothing to verify while the Supabase cloud database is active.
  if (isPostgres()) return { ok: false, error: 'Cloud database (Supabase) is active — Firebase .db-snapshot backups are disabled' }
  if (!RTDB) return { ok: false, error: 'FIREBASE_RTDB_URL not set' }
  try {
    const res = await rtdbFetch(`${BASE}/latest.json`)
    if (!res.ok) {
      const locked = res.status === 401 || res.status === 403
      return {
        ok: false,
        error: locked
          ? 'database rules are LOCKED and no admin key found — add firebase-service-account.json (Project settings → Service accounts → Generate new private key) or FIREBASE_DB_SECRET'
          : `Firebase GET ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`,
      }
    }
    const blob = (await res.json()) as { at: string; size: number; sha256: string; enc: { iv: string; tag: string; data: string } } | null
    if (!blob?.enc) return { ok: false, error: 'no cloud backup stored yet' }
    const buf = decrypt(blob.enc)
    const digest = sha256(buf)
    if (digest !== blob.sha256) return { ok: false, error: 'decrypted hash mismatch — cloud copy corrupted', sha256: digest, size: buf.length }
    // park the verified plaintext copy locally for a true restore path
    try { fs.writeFileSync(path.join(BACKUP_DIR, `restored-from-cloud-${stateKey(blob.at)}.db`), buf) } catch { /* best effort */ }
    return { ok: true, sha256: digest, size: buf.length }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
