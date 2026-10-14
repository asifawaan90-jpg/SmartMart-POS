import fs from 'fs'
import path from 'path'
import { ok } from '@/lib/api'
import { dbProvider, pgHost } from '@/lib/db-provider'

export const dynamic = 'force-dynamic'

// Task 47 — tiny public endpoint that reports the RUNNING server build id.
// The client app stores it and re-checks on focus/visibility + every minute:
// when the value changes, the device is running an older build than the
// server (the classic "iPhone stayed on the old app while Android/PC got the
// fix" problem — iOS PWAs can skip service-worker update checks for days).
// The app then reloads itself ONCE and lands on the new build — no user
// action, no manual cache clearing, ever.
//
// Version resolution:
//   1. production build → `.next/BUILD_ID` (stable per deploy)
//   2. dev server       → per-process boot id stored on globalThis (changes
//      on every server restart — exactly when chunk names change and stale
//      device sessions would otherwise crash on missing chunks). Survives
//      module hot-re-evaluation, so hot edits do NOT churn the id.
let cached: string | null = null
function buildId(): string {
  if (cached) return cached
  try {
    const b = fs.readFileSync(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim()
    if (b) { cached = b; return cached }
  } catch { /* dev mode — no BUILD_ID */ }
  const g = globalThis as unknown as { __smBootId?: string }
  if (!g.__smBootId) g.__smBootId = `boot-${Date.now().toString(36)}-${process.pid}`
  cached = g.__smBootId
  return cached
}

export async function GET() {
  // Task 64 — report which database the backend is running on so the UI can
  // show it honestly (dashboard SyncCard chip) and go-live verification can
  // assert the switch actually happened. Only the host is exposed — never
  // credentials.
  const provider = dbProvider()
  return ok({
    version: buildId(),
    db: {
      provider,
      cloud: provider === 'postgres',
      host: provider === 'postgres' ? pgHost() : null,
    },
  })
}
