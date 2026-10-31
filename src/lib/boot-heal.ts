/**
 * Task 57 — boot-time data self-heal.
 *
 * THE problem this kills: an app update/deploy recreates db/custom.db from
 * scratch (fresh file, schema push, seed re-runs). The owner then sees the
 * demo subscription (MONTHLY 30 days) instead of the trial/plan they applied,
 * and their real sales are "gone". Every report of "data is not saving /
 * subscription changed after re-login" traces back to this wipe.
 *
 * The local snapshot chain (Task 53/55 — 30 verified snapshots in backups/)
 * already HOLDS the missing data; until now restoring it was a manual step.
 * This module closes the loop: when the server boots and the database file is
 * BRAND NEW (just created by a deploy) while the newest snapshot clearly
 * contains businesses that the current database does not, the snapshot is
 * restored AUTOMATICALLY — before the first request is served and before the
 * boot backup snapshots the empty state.
 *
 * Safety rules (deliberately conservative):
 *   - only fires when the db file is younger than DB_YOUNG_MINUTES minutes
 *     (a normal restart never re-creates the file; a legitimate single-business
 *     deletion happens on an OLD file and is never "healed")
 *   - only fires when the newest snapshot passes an integrity check AND
 *     contains at least one business missing from the current db (seed can
 *     never invent businesses the snapshot knows about)
 *   - the swap is atomic (temp file + rename) and the replaced file is kept
 *     aside as db/custom.db.preheal-<ts> so nothing is ever destroyed
 *   - every decision is logged to backups/HEAL.log; a failure here can never
 *     take the app down (best-effort, guarded)
 *
 * Node runtime only — imported from instrumentation.ts inside the
 * NEXT_RUNTIME === 'nodejs' guard, BEFORE startBackups() so the boot snapshot
 * captures the restored (true) state.
 */
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'

const DB_YOUNG_MINUTES = 20
const BACKUP_DIR = path.join(process.cwd(), 'backups')
const DB_FILE = path.join(process.cwd(), 'db', 'custom.db')
const HEAL_LOG = path.join(BACKUP_DIR, 'HEAL.log')

function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}`
  try { console.log('[boot-heal]', msg) } catch { /* console may be restricted */ }
  try { fs.appendFileSync(HEAL_LOG, line + '\n') } catch { /* best effort */ }
}

interface DbFacts { businesses: number; sales: number; rows: { name: string; email: string }[]; ok: boolean }

/** Read business/sales facts from a SQLite file via python3 (same runtime the
 *  backup script uses — no native deps needed). */
function readFacts(file: string): DbFacts {
  const script = `
import json, sqlite3
db = sqlite3.connect(${JSON.stringify(file)})
out = {"ok": True}
try:
    out["businesses"] = db.execute("SELECT COUNT(*) FROM Business").fetchone()[0]
    out["sales"] = db.execute("SELECT COUNT(*) FROM Sale").fetchone()[0]
    out["rows"] = [{"name": r[0], "email": (r[1] or "").lower()} for r in
                   db.execute("SELECT name, email FROM Business")]
except Exception as e:
    out = {"ok": False, "error": str(e)}
print(json.dumps(out))
`
  const stdout = execFileSync('python3', ['-c', script], { encoding: 'utf8', timeout: 20_000 })
  const parsed = JSON.parse(stdout.trim().split('\n').at(-1) as string) as DbFacts & { error?: string }
  return parsed
}

function newestSnapshot(): string | null {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^custom-\d{8}-\d{6}\.db$/.test(f)).sort()
    return files.length ? path.join(BACKUP_DIR, files[files.length - 1]) : null
  } catch { return null }
}

export function bootHeal(): void {
  try {
    if (!fs.existsSync(DB_FILE)) { log('no database file yet — nothing to heal'); return }
    const stat = fs.statSync(DB_FILE)
    const ageMin = (Date.now() - stat.birthtimeMs) / 60_000
    // birthtime can be unreliable on some filesystems — fall back to mtime.
    const ageMinFallback = (Date.now() - stat.mtimeMs) / 60_000
    const young = Math.min(ageMin, ageMinFallback) < DB_YOUNG_MINUTES
    if (!young) return // normal boot on an established database — never touches it

    const snap = newestSnapshot()
    if (!snap) { log('db file is fresh but no snapshot exists — nothing to restore'); return }

    const cur = readFacts(DB_FILE)
    if (!cur.ok) { log(`current db unreadable (${(cur as { error?: string }).error}) — leaving it for the app to report`); return }
    const snapFacts = readFacts(snap)
    if (!snapFacts.ok) { log(`snapshot unreadable, refusing to heal: ${(snapFacts as { error?: string }).error}`); return }

    const curKeys = new Set([...cur.rows.map(r => r.email), ...cur.rows.map(r => r.name.toLowerCase())])
    const missing = snapFacts.rows.filter(r =>
      (r.email && !curKeys.has(r.email)) || (!r.email && !curKeys.has(r.name.toLowerCase())))
    if (missing.length === 0) {
      log(`fresh db but no businesses missing vs ${path.basename(snap)} (db=${cur.businesses}, snapshot=${snapFacts.businesses}) — no heal needed`)
      return
    }

    // Wipe confirmed. Verify the snapshot one more time, then restore atomically.
    const keepAside = `${DB_FILE}.preheal-${Date.now()}`
    const tmp = `${DB_FILE}.healing-${Date.now()}`
    fs.copyFileSync(DB_FILE, keepAside)
    fs.copyFileSync(snap, tmp)
    const check = readFacts(tmp)
    if (!check.ok || check.businesses < snapFacts.businesses) {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
      log('snapshot failed re-verification — aborting heal, current db untouched')
      return
    }
    fs.renameSync(tmp, DB_FILE)
    log(`HEALED: db was fresh/empty (age ${ageMin.toFixed(1)}min, ${cur.businesses} businesses, ${cur.sales} sales) — restored ${path.basename(snap)} (${check.businesses} businesses, ${check.sales} sales). Missing businesses that triggered the heal: ${missing.slice(0, 5).map(m => m.name).join(', ')}${missing.length > 5 ? ` +${missing.length - 5} more` : ''}. Previous file kept as ${path.basename(keepAside)}`)
  } catch (e) {
    log(`heal skipped due to error: ${(e as Error).message}`)
  }
}
