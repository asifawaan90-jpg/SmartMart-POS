export type DbProvider = 'sqlite' | 'postgres'

function configuredProvider(): string {
  const provider = (process.env.DB_PROVIDER || '').trim().toLowerCase()
  if (provider) return provider

  const url = (process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL || '').trim().toLowerCase()
  return url.startsWith('postgres://') || url.startsWith('postgresql://') ? 'postgres' : ''
}

export function dbProvider(): DbProvider {
  const provider = configuredProvider()
  if (!provider || provider === 'sqlite') return 'sqlite'
  if (provider === 'postgres' || provider === 'postgresql' || provider === 'supabase') return 'postgres'
  throw new Error(`[db] Unsupported DB_PROVIDER "${provider}". Use "sqlite" or "postgres".`)
}

export function pgUrl(): string {
  return (process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL || '').trim()
}

export function pgUrlLooksValid(url = pgUrl()): boolean {
  try {
    const parsed = new URL(url)
    const credentials = decodeURIComponent(`${parsed.username} ${parsed.password}`)
    return (
      (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
      Boolean(parsed.hostname && parsed.username && parsed.password) &&
      !/your[_-]?(?:project[_-]?(?:id|ref)|password)|xxxxx|placeholder|example/i.test(credentials) &&
      !/[<>]/.test(url)
    )
  } catch {
    return false
  }
}

export function assertDbConfig(): void {
  if (dbProvider() !== 'postgres') return
  if (!pgUrlLooksValid()) {
    throw new Error(
      '[db] DB_PROVIDER is PostgreSQL but no valid PostgreSQL connection URI is configured. ' +
      'Set SUPABASE_DATABASE_URL in .env to the complete Supabase pooler URI, including username and password.',
    )
  }
}

export function normalizePgUrl(url = pgUrl()): string {
  const normalized = new URL(url)
  if (normalized.port === '6543' && !normalized.searchParams.has('pgbouncer')) {
    normalized.searchParams.set('pgbouncer', 'true')
    normalized.searchParams.set('connection_limit', '1')
  }
  if (!normalized.searchParams.has('sslmode')) normalized.searchParams.set('sslmode', 'require')
  return normalized.toString()
}

export function pgHost(): string | null {
  if (!pgUrlLooksValid()) return null
  return new URL(pgUrl()).hostname
}
