/**
 * Task 53 — backup scheduler (Node runtime only; imported from
 * instrumentation.ts inside the NEXT_RUNTIME === 'nodejs' guard).
 *
 * Takes a consistent SQLite snapshot of db/custom.db:
 *   - on boot whenever the newest snapshot is older than 30 minutes, and
 *   - every 6 hours afterwards.
 *
 * Task 55 — the throttle dropped from 20h to 30min because an app
 * update/publish is EXACTLY the moment the user fears for their data: every
 * publish restarts the server, so every publish now leaves a dated safety
 * snapshot (30 retained in backups/ instead of 14 — ~1MB each). Rapid dev
 * restarts within 30min still never spam snapshots.
 *
 * Snapshots use SQLite's online backup API (safe while the server writes),
 * are self-checked by re-reading them, and are pruned. Failures log to
 * backups/BACKUP.log — they can never take the app down.
 *
 * Task 64 — disabled entirely when the backend runs on the Supabase cloud
 * database (no local file exists; see isPostgres() guard below).
 */
import { isPostgres } from './db-provider'

export function startBackups() {
  const g = globalThis as unknown as { __smBackupTimer?: boolean }
  if (g.__smBackupTimer) return // dev hot-reload / double-register guard
  g.__smBackupTimer = true

  // Task 64 — the scheduler's snapshots are FILE copies of db/custom.db and
  // its cloud push uploads those .db files. With the Supabase cloud database
  // there is no db file to snapshot: the database itself lives off-site
  // (multi-AZ Postgres with automated backups), and the Excel/e-mail backup
  // chain (backup.ts, Prisma-based) keeps working unchanged.
  if (isPostgres()) {
    console.log('[db-backup] provider=postgres (Supabase) — local .db snapshots & Firebase file push disabled; the cloud database IS the off-site copy')
    return
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFile } = require('child_process') as typeof import('child_process')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path')

  const run = (why: string) => {
    execFile(
      'python3',
      [path.join(process.cwd(), 'scripts', 'db-backup.py'), '30'],
      (err, stdout) => {
        if (err) console.warn('[db-backup] failed:', err.message)
        else if (stdout?.trim()) console.log('[db-backup]', why, '→', stdout.trim().split('\n')[1] || 'done')
        // Task 56 — every successful local snapshot also lands an ENCRYPTED
        // copy in the owner's Firebase Realtime Database (off-site copy).
        // Fire-and-forget: a Firebase outage can never affect the local chain.
        if (!err) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const fb = require('./firebase-backup') as typeof import('./firebase-backup')
            fb.pushCloudBackup('auto').then(r => { if (!r.ok && r.error && !/not configured/.test(r.error)) console.warn('[cloud-backup] auto push:', r.error) })
          } catch (e) { console.warn('[cloud-backup] unavailable:', (e as Error).message) }
        }
      },
    )
  }

  const lastAgeHours = () => {
    try {
      const dir = path.join(process.cwd(), 'backups')
      const files = fs.readdirSync(dir).filter(f => f.startsWith('custom-') && f.endsWith('.db'))
      if (!files.length) return Infinity
      const newest = Math.max(...files.map(f => fs.statSync(path.join(dir, f)).mtimeMs))
      return (Date.now() - newest) / 3600_000
    } catch {
      return Infinity
    }
  }

  // boot backup — every publish/restart leaves a dated safety point
  if (lastAgeHours() >= 0.5) setTimeout(() => run('boot'), 15_000)

  // steady rhythm: one snapshot every 6 hours
  const iv = setInterval(() => {
    if (lastAgeHours() >= 6) run('6h')
  }, 60 * 60_000)
  ;(iv as unknown as { unref?: () => void }).unref?.()
}
