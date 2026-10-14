#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = join(root, '.env')
const defaultBackup = join(root, 'data-backup', 'smartmart-data-backup-2026-10-10.json')
const backupPath = resolve(root, process.argv[2] || defaultBackup)
let prisma

function loadEnv() {
  if (!existsSync(envPath)) throw new Error('Missing .env. Copy .env.example to .env and configure SUPABASE_DATABASE_URL locally.')
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    } else if (value.includes(' #')) {
      value = value.split(' #')[0].trim()
    }
    process.env[match[1]] = value
  }
}

function configuredPostgresUrl() {
  const candidates = [
    process.env.SUPABASE_DATABASE_URL,
    process.env.DATABASE_URL?.startsWith('postgres') ? process.env.DATABASE_URL : '',
    process.env.DIRECT_URL,
  ]
  const value = candidates.find(candidate => candidate?.trim())?.trim()
  if (!value && process.env.DATABASE_URL?.startsWith('file:')) {
    throw new Error('DATABASE_URL currently points to local SQLite. Keep it, and add SUPABASE_DATABASE_URL with the full PostgreSQL URI from Supabase → Connect.')
  }
  if (!value) {
    throw new Error('Add the Supabase PostgreSQL connection URI to .env as SUPABASE_DATABASE_URL (do not use the https:// project API URL).')
  }

  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('The Supabase connection setting is not a valid URL. Copy the full PostgreSQL URI from Supabase → Connect.')
  }

  const isSupabaseDatabaseHost =
    url.hostname.endsWith('.pooler.supabase.com') ||
    /^db\.[a-z0-9-]+\.supabase\.co$/i.test(url.hostname)
  if (
    url.protocol === 'https:' &&
    isSupabaseDatabaseHost &&
    url.username &&
    url.password &&
    url.pathname === '/postgres'
  ) {
    url = new URL(value.replace(/^https:/i, 'postgresql:'))
  }

  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.password ||
    url.pathname !== '/postgres' ||
    /YOUR-PASSWORD|YOUR_|xxxxx|<.*>|placeholder|example/i.test(value)
  ) {
    throw new Error('The Supabase setting must be the complete PostgreSQL URI from Connect, including its username, database password and /postgres path. Do not use the https:// project URL.')
  }

  if (url.port === '6543' && !url.searchParams.has('pgbouncer')) {
    url.searchParams.set('pgbouncer', 'true')
    url.searchParams.set('connection_limit', '1')
  }

  const normalized = url.toString()
  process.env.SUPABASE_DATABASE_URL = normalized
  return normalized
}

function runPrisma(command) {
  const cli = join(root, 'node_modules', 'prisma', 'build', 'index.js')
  if (!existsSync(cli)) throw new Error('Prisma CLI is missing. Run npm install first.')
  const result = spawnSync(process.execPath, [cli, ...command, '--schema', 'prisma/schema.postgres.prisma'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Prisma ${command[0]} failed${result.status === null ? '' : ` (exit ${result.status})`}.`)
}

function activatePostgres(databaseUrl) {
  const contents = readFileSync(envPath, 'utf8')
  const newline = contents.includes('\r\n') ? '\r\n' : '\n'
  const lines = contents.split(/\r?\n/)
  const settings = new Map([
    ['DB_PROVIDER', 'DB_PROVIDER=postgres'],
    ['SUPABASE_DATABASE_URL', `SUPABASE_DATABASE_URL="${databaseUrl}"`],
  ])
  for (const [key, setting] of settings) {
    const index = lines.findIndex(line => new RegExp(`^\\s*(?:#\\s*)?${key}\\s*=`).test(line))
    if (index >= 0) lines[index] = setting
    else {
      while (lines.length && lines[lines.length - 1] === '') lines.pop()
      lines.push(setting)
    }
  }
  const updated = lines.join(newline) + (contents.endsWith('\n') ? newline : '')
  const temporaryPath = `${envPath}.tmp`
  writeFileSync(temporaryPath, updated, 'utf8')
  renameSync(temporaryPath, envPath)
}

async function ensurePlanCatalog() {
  const plans = [
    {
      code: 'TRIAL', name: 'Free Trial', price: 0, durationDays: 7, sortOrder: 0,
      features: ['All features for 7 days', 'POS + Inventory + Reports', 'No credit card required'],
      limits: { users: 3, products: 500 },
    },
    {
      code: 'MONTHLY', name: 'Monthly — PKR 3,000 / Month', price: 3000, durationDays: 30, sortOrder: 1,
      features: ['Unlimited sales & invoicing', 'Inventory + Barcode system', 'Khata / Credit ledger', 'Full reports & exports', 'Thermal & PDF printing', 'Cloud sync + backup'],
      limits: { users: 10, products: 10000 },
    },
    {
      code: 'LIFETIME', name: 'Lifetime — PKR 250,000 (one-time)', price: 250000, durationDays: -1, sortOrder: 2,
      features: ['Everything in Monthly, forever', 'Priority support', 'Free onboarding & training', 'All future updates included'],
      limits: { users: 25, products: 100000 },
    },
  ]
  for (const plan of plans) {
    const { features, limits, ...fields } = plan
    await prisma.subscriptionPlan.upsert({
      where: { code: plan.code },
      update: {},
      create: { ...fields, features: JSON.stringify(features), limits: JSON.stringify(limits) },
    })
  }
}

async function main() {
  loadEnv()
  const databaseUrl = configuredPostgresUrl()
  if (!existsSync(backupPath)) throw new Error(`Backup file not found: ${backupPath}`)
  const data = JSON.parse(readFileSync(backupPath, 'utf8'))
  const businessId = data?.meta?.businessId
  if (!businessId || !Array.isArray(data.business) || data.business.length === 0) {
    throw new Error('The selected file is not a SmartMart backup with a business record.')
  }

  console.log('Preparing the Supabase schema and PostgreSQL client...')
  runPrisma(['generate'])
  runPrisma(['db', 'push'])

  const generated = await import('../src/generated/postgres/index.js')
  const PrismaClient = generated.default ?? generated.PrismaClient
  prisma = new PrismaClient()
  const businesses = await prisma.business.findMany({ select: { id: true } })
  const unrelated = businesses.filter(business => business.id !== businessId)
  if (unrelated.length > 0) {
    throw new Error('The configured Supabase database already contains other businesses. Restore stopped without importing data.')
  }

  const restoreScript = join(root, 'scripts', 'restore-from-backup.mjs')
  const restore = spawnSync(process.execPath, [restoreScript, backupPath, '--pg'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  })
  if (restore.error) throw restore.error
  if (restore.status !== 0) throw new Error(`Backup restore failed${restore.status === null ? '' : ` (exit ${restore.status})`}.`)

  await ensurePlanCatalog()
  activatePostgres(databaseUrl)
  console.log('\nSupabase restore complete. No subscription was assigned; the platform owner can assign one.')
  console.log('Restart the app to begin using the Supabase database.')
}

main()
  .catch(error => {
    console.error(`Supabase restore failed: ${error.message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    if (prisma) await prisma.$disconnect()
  })
