// Offline sign-in: lets a signed-out device sign back in with NO internet,
// using credentials the device has already verified online before.
//
// How it works: after every successful ONLINE sign-in (and again at sign-out)
// the device stores, per email, a salted SHA-256 hash of the password plus a
// snapshot of the session (token, user, subscription, business, settings).
// With no internet, typing the same email + password is verified against that
// local hash and the saved session is restored — the app boots straight into
// offline mode and everything syncs when the connection returns.
//
// The plain password is never stored; the hash only unlocks an
// already-issued session token on the device that created it (the token
// itself lives in localStorage anyway, so this does not lower the device
// trust boundary). The server still re-validates the token on reconnect and
// a rejected session is never cached.

import type { AuthUser, BusinessInfo, SubInfo } from '@/stores/auth'

export interface OfflineSessionSnapshot {
  token: string
  user: AuthUser
  subscription: SubInfo | null
  business: BusinessInfo | null
  settings: Record<string, unknown>
  savedAt: number
}

interface OfflineCredRecord extends OfflineSessionSnapshot {
  salt: string
  hash: string
}

const KEY = 'smartmart-offline-login'
const MAX_RECORDS = 5

function readAll(): Record<string, OfflineCredRecord> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Record<string, OfflineCredRecord>) : {}
  } catch { return {} }
}

function writeAll(map: Record<string, OfflineCredRecord>) {
  try { window.localStorage.setItem(KEY, JSON.stringify(map)) } catch { /* storage unavailable */ }
}

const keyOf = (email: string) => email.trim().toLowerCase()

// ── SHA-256 ────────────────────────────────────────────────────────────────
// WebCrypto only exists in secure contexts (https / localhost). Shop phones
// commonly open the app over plain http://LAN-IP where crypto.subtle is
// missing — so a pure-JS SHA-256 is kept as the fallback.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(x: number, n: number): number { return (x >>> n) | (x << (32 - n)) }

export function sha256Pure(input: string): string {
  const msg = new TextEncoder().encode(input)
  const bitLen = msg.length * 8
  const total = (((msg.length + 8) >> 6) + 1) << 6
  const buf = new Uint8Array(total)
  buf.set(msg)
  buf[msg.length] = 0x80
  const dv = new DataView(buf.buffer)
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000))
  dv.setUint32(total - 4, bitLen >>> 0)
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  const w = new Uint32Array(64)
  for (let i = 0; i < total; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4)
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3)
      const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10)
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[j] + w[j]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
  }
  let hex = ''
  for (const x of [h0, h1, h2, h3, h4, h5, h6, h7]) hex += x.toString(16).padStart(8, '0')
  return hex
}

async function sha256Hex(input: string): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
      let hex = ''
      for (const b of new Uint8Array(d)) hex += b.toString(16).padStart(2, '0')
      return hex
    }
  } catch { /* fall through to the pure-JS implementation */ }
  return sha256Pure(input)
}

function randSalt(): string {
  try {
    const a = new Uint8Array(16)
    crypto.getRandomValues(a)
    let hex = ''
    for (const b of a) hex += b.toString(16).padStart(2, '0')
    return hex
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Store (or replace) the offline sign-in record for an email, right after a successful ONLINE login/registration. */
export async function rememberOfflineLogin(
  email: string,
  password: string,
  session: Omit<OfflineSessionSnapshot, 'savedAt'>,
): Promise<void> {
  if (!email || !password || !session?.token || !session?.user) return
  const map = readAll()
  const salt = randSalt()
  map[keyOf(email)] = {
    token: session.token,
    user: session.user,
    subscription: session.subscription ?? null,
    business: session.business ?? null,
    settings: session.settings ?? {},
    savedAt: Date.now(),
    salt,
    hash: await sha256Hex(`${salt}:${password}`),
  }
  // bound storage: keep only the most recent devices' accounts
  const keys = Object.keys(map)
  if (keys.length > MAX_RECORDS) {
    keys.sort((x, y) => (map[x].savedAt || 0) - (map[y].savedAt || 0))
    for (const k of keys.slice(0, keys.length - MAX_RECORDS)) delete map[k]
  }
  writeAll(map)
}

/** Refresh only the session snapshot for an email that already has a saved record (e.g. at sign-out, with the latest business/settings). */
export function refreshOfflineSession(email: string, patch: Partial<OfflineSessionSnapshot>): void {
  if (!email) return
  const map = readAll()
  const rec = map[keyOf(email)]
  if (!rec) return
  map[keyOf(email)] = { ...rec, ...patch, savedAt: Date.now() }
  writeAll(map)
}

/** Verify an email+password against the device's saved record; returns the restorable session snapshot, or null. */
export async function matchOfflineLogin(email: string, password: string): Promise<OfflineSessionSnapshot | null> {
  if (!email || !password) return null
  const rec = readAll()[keyOf(email)]
  if (!rec || !rec.hash || !rec.token || !rec.user) return null
  const hash = await sha256Hex(`${rec.salt}:${password}`)
  if (hash !== rec.hash) return null
  const snap: OfflineSessionSnapshot = {
    token: rec.token,
    user: rec.user,
    subscription: rec.subscription,
    business: rec.business,
    settings: rec.settings,
    savedAt: rec.savedAt,
  }
  return snap
}

/** Emails that can sign in offline on this device (for the login-page hints). */
export function getSavedOfflineEmails(): string[] {
  return Object.keys(readAll()).sort()
}

export function hasSavedOfflineLogin(email: string): boolean {
  return !!readAll()[keyOf(email)]
}

/** Task 58 — remove one saved sign-in from this device (login-page "Forget" ×). */
export function forgetOfflineLogin(email: string): void {
  if (!email) return
  const map = readAll()
  delete map[keyOf(email)]
  writeAll(map)
}

/** Task 58 — the most recently saved email on this device, for pre-filling the login form. */
export function lastSavedEmail(): string {
  const map = readAll()
  let best = ''
  let bestAt = -1
  for (const [k, rec] of Object.entries(map)) {
    const at = rec.savedAt || 0
    if (at > bestAt) { bestAt = at; best = k }
  }
  return best
}
