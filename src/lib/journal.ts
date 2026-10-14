/**
 * Task 61 — append-only data journals + boot replay.
 *
 * THE problem this kills: this app runs on a dev/preview sandbox whose file
 * state can roll back (container checkpoint restore, deploy re-init, db file
 * swap). Forensics on the "subscription changed back / sales lost after Oct 2"
 * report proved the database FILE itself reverted to older copies while
 * append-only tables (AuditLog) kept newer rows — so no snapshot or cloud copy
 * held the lost sales, and admin subscription changes were silently undone.
 *
 * The fix is a write-ahead journal OUTSIDE the db file: every accepted sale
 * and every admin subscription mutation also appends one JSON line to
 * backups/journal/<date>.jsonl. At server boot, AFTER boot-heal restores any
 * rolled-back file, the journal is REPLAYED: journal entries newer than the
 * database are re-applied (sales via the idempotent clientRef createSale path,
 * subscriptions guarded by the row's updatedAt). A rollback can no longer
 * silently eat accepted business data — the boot replay rebuilds it.
 *
 * Design rules:
 *   - appendFileSync best-effort: a journaling failure must NEVER fail the
 *     user's request (console.error only).
 *   - replay is idempotent: sales dedupe on businessId+clientRef (createSale
 *     fast-path returns duplicate), subscription entries apply only when
 *     strictly newer than the row's updatedAt (+2s clock skew).
 *   - derived state is NOT journaled (auto-expire flips EXPIRED) — replaying
 *     it could mask a real renewal; getSubscription re-derives it safely.
 *   - journal files older than JOURNAL_KEEP_DAYS are pruned during replay.
 *   - every replay decision is logged to backups/REPLAY.log.
 */
import fs from 'fs'
import path from 'path'

const BACKUP_DIR = path.join(process.cwd(), 'backups')
const JOURNAL_DIR = path.join(BACKUP_DIR, 'journal')
const REPLAY_LOG = path.join(BACKUP_DIR, 'REPLAY.log')
const JOURNAL_KEEP_DAYS = 120
const SKEW_MS = 2_000

function logReplay(msg: string) {
  const line = `${new Date().toISOString()} ${msg}`
  try { console.log('[journal-replay]', msg) } catch { /* console may be restricted */ }
  try { fs.appendFileSync(REPLAY_LOG, line + '\n') } catch { /* best effort */ }
}

let dirReady = false
function journalFile(kind: 'SALE' | 'SUB', ts = Date.now()): string {
  if (!dirReady) {
    try { fs.mkdirSync(JOURNAL_DIR, { recursive: true }) } catch { /* exists */ }
    dirReady = true
  }
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return path.join(JOURNAL_DIR, `${kind.toLowerCase()}-${y}-${m}-${day}.jsonl`)
}

/** Append one entry. NEVER throws — data writes must not fail because of journaling. */
export function appendJournal(entry: { kind: 'SALE' | 'SUB'; ts?: number; [k: string]: unknown }): void {
  try {
    const line = JSON.stringify({ ts: entry.ts ?? Date.now(), ...entry }) + '\n'
    fs.appendFileSync(journalFile(entry.kind, entry.ts), line)
  } catch (e) {
    try { console.error('[journal] append failed:', (e as Error).message) } catch { /* ignore */ }
  }
}

export interface ReplayStats {
  salesRestored: number
  salesFailed: number
  subsApplied: number
  subsFailed: number
  files: number
}

/**
 * Boot-time replay: re-apply journaled sales/subscriptions that are missing
 * from (or older in) the current database. Idempotent — safe on every boot.
 * `only` scopes the replay to one kind (used by the roundtrip test so an
 * artificial SALE deletion is not "healed" while testing the SUB path).
 */
export async function replayJournals(only?: 'SALE' | 'SUB'): Promise<ReplayStats> {
  const stats: ReplayStats = { salesRestored: 0, salesFailed: 0, subsApplied: 0, subsFailed: 0, files: 0 }
  try {
    if (!fs.existsSync(JOURNAL_DIR)) return stats
    const cut = Date.now() - JOURNAL_KEEP_DAYS * 86400000
    const files = fs.readdirSync(JOURNAL_DIR).filter(f => f.endsWith('.jsonl')).sort()
    for (const f of files) {
      const fp = path.join(JOURNAL_DIR, f)
      try {
        if (fs.statSync(fp).mtimeMs < cut) { fs.unlinkSync(fp); continue } // prune old journals
      } catch { continue }
      let lines: string[]
      try { lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean) } catch { continue }
      for (const line of lines) {
        let e: Record<string, unknown>
        try { e = JSON.parse(line) as Record<string, unknown> } catch { continue }
        const ts = Number(e.ts) || 0
        if (only && e.kind !== only) continue
        try {
          if (e.kind === 'SALE') {
            const { db } = await import('./db')
            const businessId = String(e.businessId || '')
            const input = e.input as { clientRef?: string } | undefined
            const clientRef = String(input?.clientRef || '')
            if (!businessId || !clientRef) continue
            const existing = await db.sale.findUnique({
              where: { businessId_clientRef: { businessId, clientRef } }, select: { id: true },
            })
            if (existing) continue // already in db — normal case after a healthy run
            const { createSale } = await import('./sale-service')
            await createSale({
              businessId,
              userId: String(e.userId || ''),
              cashierName: String(e.cashierName || 'Replay'),
              input: input as Parameters<typeof createSale>[0]['input'],
              prefix: String(e.prefix || 'INV-'),
              // Task 67 — replayed sales are accepted business data; stock may
              // go negative after a db rollback, the sale itself must survive.
              allowNegativeStock: true,
            })
            stats.salesRestored++
            logReplay(`SALE restored from journal: ${clientRef} (business ${businessId.slice(0, 8)}…, journaled ${new Date(ts).toISOString()})`)
          } else if (e.kind === 'SUB') {
            const { db } = await import('./db')
            const subId = String(e.subId || '')
            if (!subId) continue
            const sub = await db.subscription.findUnique({ where: { id: subId } })
            if (!sub) continue // business/subscription row genuinely gone — nothing to heal
            if (ts <= sub.updatedAt.getTime() + SKEW_MS) continue // db row is same or newer — healthy
            await db.subscription.update({
              where: { id: subId },
              data: {
                status: String(e.status || sub.status),
                ...(e.planId ? { planId: String(e.planId) } : {}),
                endDate: e.endDate === null ? null : e.endDate ? new Date(String(e.endDate)) : sub.endDate,
              },
            })
            stats.subsApplied++
            logReplay(`SUB re-applied from journal: ${subId.slice(0, 8)}… → ${e.status} until ${e.endDate ?? '—'} (row was stale at ${sub.updatedAt.toISOString()}, journaled ${new Date(ts).toISOString()})`)
          }
        } catch (err) {
          if (e.kind === 'SALE') stats.salesFailed++
          else if (e.kind === 'SUB') stats.subsFailed++
          logReplay(`replay skip (${e.kind}): ${(err as Error).message}`)
        }
      }
    }
    if (stats.salesRestored || stats.subsApplied || stats.salesFailed || stats.subsFailed) {
      logReplay(`done: sales restored=${stats.salesRestored} failed=${stats.salesFailed}, subs applied=${stats.subsApplied} failed=${stats.subsFailed} across ${files.length} journal file(s)`)
    }
  } catch (e) {
    logReplay(`replay aborted: ${(e as Error).message}`)
  }
  return stats
}
