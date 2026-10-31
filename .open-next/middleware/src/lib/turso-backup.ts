import { createClient } from '@libsql/client'
import fs from 'fs'
import path from 'path'

function getClient() {
  const url = process.env.TURSO_DATABASE_URL
  const token = process.env.TURSO_AUTH_TOKEN
  if (!url || !token) throw new Error('TURSO env missing')
  return createClient({ url, authToken: token })
}

async function ensureTable(client:any) {
  await client.execute(`CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, size INTEGER, created_at TEXT)`)
}

export async function pushToTurso() {
  const backupsDir = path.join(process.cwd(), 'backups')
  const files = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter(f=>f.endsWith('.db')).sort().reverse() : []
  if (!files.length) throw new Error('backups/ me koi .db file nahi - pehle python db-backup.py chalao')
  const latest = files[0]
  const buf = fs.readFileSync(path.join(backupsDir, latest))
  const client = getClient()
  await ensureTable(client)
  await client.execute({ sql: 'INSERT INTO backups (name, size, created_at) VALUES (?, ?, ?)', args: [latest, buf.length, new Date().toISOString()] })
  return { ok: true, name: latest, size: buf.length }
}

export async function verifyTurso() {
  const client = getClient()
  await ensureTable(client)
  const res = await client.execute('SELECT * FROM backups ORDER BY id DESC LIMIT 5')
  return { ok: true, count: res.rows.length, rows: res.rows }
}
