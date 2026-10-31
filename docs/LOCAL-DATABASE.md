# Database configuration

SmartMart defaults to local SQLite at:

```text
db/custom.db
```

By default, the Windows launcher opens "http://localhost:3000"
without starting a local server. Run `START-WINDOWS.bat local` for local
development. Isn SQLite mode, existing records are preserved during normal
startup; the local launcher only creates the schema on the first run when the
database file is absent. If an existing
`.env` has no database URL and no PostgreSQL provider configured, local
development uses the default local SQLite database without replacing the rest
of `.env`.

## Supabase PostgreSQL

To use Supabase instead of the local SQLite file:

1. Copy the Session Pooler URI from Supabase Project Settings → Database.
2. Set `DB_PROVIDER=postgres` and put the complete URI in `DATABASE_URL` in
   the private `.env` file. Never commit or share the URI; it contains the
   database password.
   If `DB_PROVIDER` is omitted, the app and Windows launcher infer PostgreSQL
   when either database URL starts with `postgres://` or `postgresql://`.
3. For a new, empty Supabase database only, inspect the target and run
   `npm run db:push:pg` once to create the schema. This does not migrate data
   from `db/custom.db`.
4. Restart the app. PostgreSQL mode skips SQLite file recovery, journal replay,
   and file snapshots.

Do not run the schema push against a database containing important data until
you have a verified backup and have reviewed the Prisma changes. The publishable
Supabase key is not a PostgreSQL connection URI.

The Vercel deployment also needs `DB_PROVIDER=postgres` and
`SUPABASE_DATABASE_URL` configured in its private environment settings.

Back up `db/custom.db` or export data from within the app before moving the
local database to another computer.
