# SmartMart POS with Supabase

The app supports Supabase PostgreSQL as its primary database. SQLite remains
the default until `DB_PROVIDER=postgres` is set.

## Restore the included backup to Supabase

1. Create a Supabase project and wait for database provisioning to finish.
2. In the Dashboard, select **Connect** and copy the PostgreSQL connection URI.
   Set `SUPABASE_DATABASE_URL` in the project-root `.env`, replacing the
   password placeholder locally. The restore also accepts a PostgreSQL
   `DATABASE_URL` or `DIRECT_URL`; if `DATABASE_URL` points to SQLite, keep it
   and add `SUPABASE_DATABASE_URL` separately. Do not paste the password into
   chat or commit `.env`.
3. Run `npm run supabase:restore` from the project root. The command generates
   the PostgreSQL client, creates the schema, and restores
   `data-backup/smartmart-data-backup-2026-10-10.json`. It refuses to import
   into a database that contains a different business. To select another
   backup, run `npm run supabase:restore -- path/to/backup.json`.
4. After a successful restore, the command sets `DB_PROVIDER=postgres` in
   `.env`. It creates the standard plan catalog but does not assign a
   subscription to the restored business. Restart the app and confirm the sync
   card shows **"Cloud database · Supabase"**; the platform owner can then
   assign a plan.

If the app does not connect, confirm that the URI contains your project's real
database username and password; values such as `YOUR_PROJECT_ID` and
`YOUR_PASSWORD` are examples, not valid credentials. Keep `DB_PROVIDER=postgres`
and `SUPABASE_DATABASE_URL` in the project-root `.env`, then fully restart the
server. The app now rejects template credentials instead of treating them as a
working cloud connection.

The restore script is create-only and can be rerun for the same backup after a
partial restore; existing rows with matching IDs are skipped. It never deletes
cloud records. Passwords are not in the backup, so restored users receive the
temporary password `SmartMart@123` and should change it immediately.

If a pooler connection was saved with an `https://` prefix by mistake, the
restore command corrects it to PostgreSQL only when the host, credentials, and
database path match a Supabase connection URI.

## Password-reset email delivery

Password-reset emails require SMTP; connecting a database or Supabase project
does not configure email. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`, and `SMTP_FROM` in the app server's environment, then restart it.
Alternatively, a signed-in platform owner can save a mailbox in **Platform
Owner Panel → Email**. For Gmail, use a Google App Password rather than the
regular account password. Never commit or share SMTP credentials.

If an email address is not registered in the database currently used by the
app, the reset endpoint intentionally returns a generic response to avoid
revealing account existence; no reset code is created or sent for that address.

## Runtime behavior and rollback

- All devices configured with the same Supabase project use the same live
  database.
- The local `db/custom.db` file is left untouched by the Supabase restore.
- Excel/email backups continue to work; local SQLite snapshot features do not
  represent a Supabase database backup.
- To switch back, set `DB_PROVIDER=sqlite` in `.env` and restart the app.
  Changes made in Supabase are not copied back to SQLite automatically.

## Implementation

| Piece | Path |
| --- | --- |
| Browser-side Supabase client (requires the public URL and anon/publishable key in `.env`) | `src/lib/supabase.ts` |
| PostgreSQL schema (generated from `prisma/schema.prisma`) | `prisma/schema.postgres.prisma` |
| Provider selection and validation | `src/lib/db-provider.ts`, `src/lib/db.ts` |
| Backup import and provider switch | `scripts/restore-to-supabase.mjs` |
| Low-level backup restore | `scripts/restore-from-backup.mjs` |
