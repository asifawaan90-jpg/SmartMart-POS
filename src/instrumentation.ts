/**
 * Task 53 — Next instrumentation entry.
 *
 * The backup scheduler is Node-only (child_process/fs/path), so it is
 * imported strictly inside the NEXT_RUNTIME === 'nodejs' guard per the Next
 * documented pattern — the Edge bundle never touches it (no bundler
 * warnings) and the Node server gets automatic daily DB snapshots.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Task 57 — BEFORE anything else: if a deploy just wiped/recreated the
    // database, restore the newest verified snapshot automatically so the
    // owner never wakes up to demo data (trial → monthly, sales gone).
    try {
      const { bootHeal } = await import('./lib/boot-heal')
      bootHeal()
    } catch (e) { console.warn('[boot-heal] unavailable:', (e as Error).message) }
    // Task 61 — then replay the append-only journals: any sale or saved
    // subscription the db file rolled back over is rebuilt here, before the
    // first request and before the boot snapshot captures the healed state.
    try {
      const { replayJournals } = await import('./lib/journal')
      const stats = await replayJournals()
      if (stats.salesRestored || stats.subsApplied) {
        console.log(`[journal-replay] healed: ${stats.salesRestored} sale(s) restored, ${stats.subsApplied} subscription state(s) re-applied`)
      }
    } catch (e) { console.warn('[journal-replay] unavailable:', (e as Error).message) }
    const { startBackups } = await import('./lib/backup-scheduler')
    startBackups()
  }
}
