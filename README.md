# SmartMart POS — Complete Source Code (Frontend + Backend)

Full source code of **SmartMart POS**: a multi-tenant grocery / mini-supermarket
management + Point of Sale app. One project contains BOTH the frontend and the
backend (Next.js fullstack). Open it anywhere in the world with VS Code.

Your latest data snapshot is included: `data-backup/smartmart-data-backup-2026-10-10.json`
(551 rows — products, sales, customers, expenses, everything). Follow
**"Restore your data"** below to load it into your copy.

---

## 1. What this app can do

- Point of Sale (POS) with barcode scanner, held carts, discounts, tax
- Offline-first: sells without internet, syncs when back online
- Products, categories, brands, units, suppliers, purchases, stock ledger
- Customers & suppliers khata (credit ledger), customer statements
- Expenses, attendance, payroll, users & roles, audit log
- Reports (sales / profit / stock / expenses) with print + CSV + Excel export
- Thermal receipt printing (58mm / 80mm) + A4 invoices
- English + Urdu (+ more languages), PKR currency
- Installable app (PWA) + ready Android APK/AAB wrapper

---

## 2. Where is the FRONTEND? Where is the BACKEND?

This is a **Next.js fullstack** project — frontend and backend live in one
project and run with one command. This is modern best practice (same as many
production SaaS apps).

| Part      | Folders | What it is |
|-----------|---------|------------|
| **FRONTEND** | `src/app` (pages), `src/components` (UI: views, dialogs, shadcn/ui), `src/stores` (Zustand state), `src/hooks` | React 19 + Tailwind CSS 4 + shadcn/ui |
| **BACKEND**  | `src/app/api` (REST API routes: sales, products, customers, expenses, backup, sync…), `src/lib` (business logic: auth, sale-service, backup, print, export, offline sync), `prisma` (database schema + seed) | Next.js API routes + Prisma ORM |
| **DATABASE** | Local SQLite by default; optional Supabase PostgreSQL | Choose with `DB_PROVIDER`; PostgreSQL uses `SUPABASE_DATABASE_URL` |
| **ANDROID**  | `android/` (TWA wrapper + keystore) | Wraps the PWA into an APK/AAB |
| **DOCS**     | `docs/ARCHITECTURE.md`, `docs/LOCAL-DATABASE.md` | Architecture + local database notes |

---

## 3. Quick start in VS Code (any computer)

You need **Node.js 20 or newer** (download from https://nodejs.org — choose LTS).
Bun also works (`https://bun.sh`) but is optional.

### Option A — one click / one command (recommended)

| Your computer | Do this |
|---|---|
| **Windows** | double-click **`START-WINDOWS.bat`** |
| **macOS** | double-click **`start-mac.command`** (or run `bash start.sh`) |
| **Linux** | run `bash start.sh` |

The macOS/Linux launchers do **everything automatically**:

1. installs the packages (first run only, 2–5 minutes)
2. creates your `.env` (local SQLite mode by default)
3. creates the database tables
4. **restores your included data backup** — products, sales, customers (first run only)
5. starts locally and opens **http://localhost:3000**

The Windows launcher opens the deployed app directly at
**https://smartmart-pos-iota.vercel.app** without starting a local server.
To run the local development copy instead, run `START-WINDOWS.bat local`.

> ⏳ **Please be patient:** on the very first start the whole setup takes
> **2–5 minutes**. After that, every start takes 10–60 seconds.
> The browser opens **by itself** as soon as the app is ready — you do not
> need to type anything. If the browser opens too early on the first run,
> just press **F5** to refresh.
>
> 🛡️ **Windows security note:** if Windows shows *"Open File - Security
> Warning"* or a blue *SmartScreen* message, click **Run** /
> **More info → Run anyway** — this is just because the file has no
> digital signature, not because it is dangerous.

For local development, the app uses the local `db/custom.db` file. The Vercel
website cannot access this computer's local database. To use Supabase Postgres instead, set
`DB_PROVIDER=postgres` and the complete private
`SUPABASE_DATABASE_URL` in `.env`; see [docs/LOCAL-DATABASE.md](./docs/LOCAL-DATABASE.md).
For a new Supabase database, inspect the target and run
`npm run db:push:pg` once to create its tables.

Supabase Storage can also be configured separately for encrypted cloud
backups while the primary database remains SQLite. See
[docs/LOCAL-DATABASE.md](./docs/LOCAL-DATABASE.md) for the required private
service-role and encryption secrets.

Login on first start: `manager@smartmart.app` / `SmartMart@123` —
**change the password immediately** (Settings → Change password).

Stop the app by pressing `Ctrl+C` in the terminal (or closing the window).
Start it again any time with the same file — your data is kept.

### Option B — step by step (manual, for developers)

```bash
# 1. open this folder in VS Code, then open the Terminal (Ctrl+`)
npm install                 # installs all packages (2–5 minutes)

# 2. create your .env file
cp .env.example .env        # Windows: copy .env.example .env

# 3. create the database tables + generate the database client
npx prisma db push
npx prisma generate

# 4. start the app
npm run dev
```

Open **http://localhost:3000** in your browser. Done!

> VS Code will suggest helpful extensions (Prisma, Tailwind CSS IntelliSense,
> ESLint) — install them for a better experience.

Option A restores the included backup automatically on first start
(`data-backup/smartmart-data-backup-2026-10-10.json`). With Option B the database
starts empty unless `db/custom.db` already exists — to load the included data,
use the restore step below.

---

---

## 4. Restore your data (products, sales, customers — everything)

The file `data-backup/smartmart-data-backup-2026-10-10.json` is your full
business snapshot exported on 2026-10-10.

```bash
npm run restore
```

(This auto-loads your `.env` and auto-picks the backup file in `data-backup/`.
You can also point it at any backup file explicitly:
`node scripts/restore-from-backup.mjs path/to/backup.json`.)

This fills your local database with **all** your data: business profile, users,
categories, brands, units, products, stock history, sales + line items, returns,
purchases, customers, suppliers, ledger transactions, expenses, settings.

It is **create-only and idempotent** — running it again never duplicates or
overwrites anything.

**Login after restore:** every restored user gets the temporary password:

```
SmartMart@123
```

Sign in with your normal email (example: `manager@smartmart.app`) and
**change the password immediately** (Menu → Change password).

---

## 5. Save / download all app data (backup)

**Inside the app (works on phone too):**
Settings → **Mail & backup** tab → download the full snapshot as
**Excel / CSV / PDF / JSON**, or connect email to get an automatic backup by
email after every sale day. The JSON file is the same format used by the
restore tool in this package.

**From the command line:**
any JSON backup produced by the app can be restored with:

```bash
node scripts/restore-from-backup.mjs <your-backup-file.json>
```

Backups contain your full business data but **never** user passwords or SMTP
email passwords.

---

## 6. Production build (run on a server / VPS)

```bash
npm run build
npm start          # serves on http://localhost:3000
```

Put it behind Nginx/Caddy with HTTPS and your PWA becomes installable from the
browser. (Optional: add `output: "standalone"` in `next.config.ts` for a
Docker-friendly build.)

---

## 8. Android app (APK / AAB)

A prebuilt `SmartMart-pos-v1.1.0.apk` and `.aab` are provided with this project
(separately, in the same download folder) — install the APK directly on any
Android phone.

To rebuild the Android app yourself: the TWA wrapper project is in `android/twa/`
(open in **Android Studio**, or use JDK 17 + Android SDK with `gradlew`).
Signing files are included:

- `android/smartmart.keystore` — your signing key
- `android/keystore.env` — keystore passwords

**Keep both files private.** If you lose them you cannot update your app on
Google Play. The app points to whatever URL is set in
`android/twa/twa-manifest.json` — change it to your own domain when you host
the app yourself.

> **Note about Flutter:** this app is built with **Next.js (TypeScript)**, not
> Flutter — so it does not open in the Flutter tool. It does not need to: it
> runs in any browser, installs on phones as a PWA ("Add to Home screen" in
> Chrome), and ships as a real Android app via the included APK/TWA wrapper.
> The frontend logic (React) and backend logic (API routes) are all here in
> this one package.

---

## 9. Project structure (developer map)

```
smartmart-pos/
├── START-WINDOWS.bat    # ★ one-click start (Windows)
├── start.sh             # ★ one-command start (macOS/Linux)
├── start-mac.command    # ★ one-click start (macOS)
├── src/
│   ├── app/
│   │   ├── page.tsx              # the whole app entry (client)
│   │   └── api/                  # ★ BACKEND: REST endpoints
│   │       ├── auth/             #   login, register, forgot/reset password
│   │       ├── sales/            #   create/list/detail/return/hold
│   │       ├── products/         #   catalog CRUD
│   │       ├── customers/ …      #   khata, payments, statements
│   │       ├── purchases/ …      #   stock-in
│   │       ├── expenses/ …       #   expense tracking
│   │       ├── reports/          #   sales/profit/stock reports (paged)
│   │       ├── backup/           #   full data snapshot (JSON)
│   │       ├── sync/             #   offline queue push/pull
│   │       └── admin/ …          #   platform admin (plans, businesses)
│   ├── components/views/         # ★ FRONTEND: one file per screen
│   │   ├── pos-view.tsx, sales-view.tsx, products-view.tsx, …
│   ├── components/shared/        # dialogs: print preview, scanner, statements
│   ├── components/ui/            # shadcn/ui component library
│   ├── lib/                      # ★ shared logic (used by both sides)
│   │   ├── auth.ts, permissions.ts, i18n.ts (EN/UR/AR…)
│   │   ├── sale-service.ts, product-service.ts, inventory-service.ts
│   │   ├── db.ts                 # local SQLite database client
│   │   ├── backup.ts             # backup engine (server)
│   │   ├── print.ts, export.ts   # thermal/A4 printing, CSV/Excel export
│   │   └── offline.ts (stores/)  # offline queue + sync engine
│   └── generated/                # prisma clients (created by npx prisma generate)
├── prisma/schema.prisma          # ★ database schema (single source of truth)
├── prisma/seed.ts                # demo data seeder (optional: bun prisma/seed.ts)
├── scripts/restore-from-backup.mjs  # ★ data restore tool
├── data-backup/                  # your included data snapshot
├── public/                       # icons, manifest, service worker (PWA)
└── android/                      # Android TWA wrapper + keystore
```

---

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| `prisma generate` errors on first run | run `npm install` first, then `npx prisma generate` again |
| "Cannot find module '@prisma/client'" | run `npx prisma generate` |
| Port 3000 already in use | `npm run dev -- -p 3001` |
| Login says wrong password after restore | use `SmartMart@123` (temporary restore password), then change it |
| Local database cannot be opened | keep `db/custom.db` in place and run `npx prisma db push` to sync its tables |
| Supabase database cannot be opened | set `DB_PROVIDER=postgres`, verify the private `SUPABASE_DATABASE_URL`, and check that the Supabase schema is initialized |

---

## 11. Security notes

- `.env` holds database credentials — **never commit it to a public repository**
- `android/keystore.env` + `android/smartmart.keystore` — keep private
- Backups contain business data, never passwords (users or SMTP)
- All exports/backup downloads are audit-logged inside the app
