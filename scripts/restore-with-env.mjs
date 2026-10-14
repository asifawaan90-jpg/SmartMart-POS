#!/usr/bin/env node
/**
 * SmartMart POS — restore-with-env
 * Loads .env manually (works on ANY Node version — no --env-file needed),
 * then runs scripts/restore-from-backup.mjs with the same arguments.
 *
 * Usage:
 *   node scripts/restore-with-env.mjs <path/to/backup.json> [--pg]
 *   node scripts/restore-with-env.mjs                  (auto-picks data-backup/*.json)
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const envPath = join(here, '..', '.env')

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let v = m[2].trim()
    // strip one pair of surrounding quotes and inline comments after unquoted values
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    } else if (v.includes(' #')) {
      v = v.split(' #')[0].trim()
    }
    process.env[m[1]] = v
  }
}

await import('./restore-from-backup.mjs')
