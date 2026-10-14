# SmartMart POS — System Architecture

Grocery / Mini-Mart Management & POS platform. Offline-first, multi-tenant, subscription-driven.

## 1. Technology Stack

| Layer | Technology | Notes |
|---|---|---|
| Web/Desktop/Mobile UI | Next.js 16 + React 19 + TypeScript (SPA shell at `/`) | Responsive — same UI serves PC (keyboard/shortcuts) and phones (touch, camera scanner). Installable PWA. |
| Styling | Tailwind CSS 4 + shadcn/ui + 7 themes via CSS variables | Classic, Modern, Ocean, Emerald, Royal, Sunset, Dark |
| Backend | Next.js API routes (Node runtime) | REST, JSON |
| ORM/DB | Prisma + SQLite (dev) | Schema is portable to PostgreSQL for production clusters — swap `provider` and types. |
| Auth | JWT (jose, HS256) + bcryptjs password hashing | Header-token auth (CSRF-safe), rate-limited login, audit-logged. |
| Offline | localStorage cache + offline queue (zustand persist) + idempotent `/api/sync` | ClientRef UUIDs, PENDING/SYNCING/SYNCED/FAILED states, automatic retry. |
| Exports | SheetJS (XLSX), native CSV, print-to-PDF views | |
| Barcode | EAN-13 generator + JsBarcode renderer + @zxing camera scanner + USB/Bluetooth scanner keyboards | |
| Charts | Recharts (lightweight) | |

## 2. Multi-Tenancy & Data Isolation

- Every business row (products, sales, customers, …) carries `businessId`.
- All API handlers resolve the caller's `businessId` from the verified JWT — **never** from request input.
- Every Prisma query is scoped by `businessId` (enforced in `src/lib/api.ts` helpers).
- Composite unique constraints (`businessId+barcode`, `businessId+sku`, `businessId+invoiceNo`, `businessId+clientRef`) prevent cross-tenant collisions and duplicate syncs.
- Platform owner (super admin) is a separate role outside any business.

## 3. Subscription Architecture

- `SubscriptionPlan` rows (TRIAL / MONTHLY / LIFETIME) are **data, not code** — the owner admin panel edits price, duration, name, features, limits. No hard-coded prices.
- `Subscription` per business: status `TRIAL | ACTIVE | EXPIRED | SUSPENDED | DEACTIVATED | LIFETIME`, computed `daysRemaining`.
- `requireSubscription` guard blocks data-mutating APIs when expired/suspended (402) while still allowing auth + subscription + read settings.
- Payments: submitted by customer (bank transfer/gateway/manual) → `PENDING` → owner approves/rejects in admin panel → subscription activated/extended. No raw card data stored.

## 4. Offline-First Sync

```
ONLINE  : POS → POST /api/sales (idempotent, server invoice numbering)
OFFLINE : POS → local queue (clientRef, deviceTs, PENDING) → UI keeps working
RECONNECT: engine drains queue → POST /api/sync { sales:[…] } → per-item result
```

- **Idempotency**: every sale carries a UUID `clientRef`; unique per business; server upserts and returns the original on replay — **duplicates are impossible**.
- **Stock**: mutations happen only server-side inside a DB transaction using weighted-average costing. Offline sales decrement on sync.
- **Conflicts**: sales are append-only (no conflict). Edits are server-authoritative; products cache is refreshed after each sync.
- **Status indicator**: ONLINE / OFFLINE / SYNCING / SYNC ERROR in the top bar.

## 5. Inventory Costing

Weighted moving average: on each confirmed purchase
`newAvg = (oldQty·oldAvg + qty·unitCost) / (oldQty+qty)`. Sales store `costAtSale` per item → profit = revenue − actual cost. Every stock change writes an `InventoryTransaction` (SALE / PURCHASE / ADJUST / DAMAGE / RETURN_IN / RETURN_OUT / OPENING).

## 6. Roles & Permissions

Roles: OWNER, MANAGER, CASHIER, INVENTORY_STAFF, ACCOUNTANT + platform SUPER_ADMIN.
Permission matrix in `src/lib/permissions.ts`, enforced **server-side** per API group (`pos`, `products`, `inventory`, `sales`, `purchases`, `customers`, `khata`, `suppliers`, `expenses`, `reports`, `settings`, `users`).

## 7. Security

bcrypt(10) hashes, JWT 7d expiry, in-memory rate limiting (login 10/15min), Zod input validation, Prisma parameterized queries (SQLi-safe), tenant scoping, audit log of every critical action, secure headers via Next defaults, secrets only in `.env` (never committed; `.env.example` provided).

## 8. Folder Structure

```
prisma/          schema.prisma + seed.ts
src/lib/         db, auth, api helpers, permissions, subscription, barcode, sync, exports
src/app/api/     REST endpoints (auth, products, sales, sync, reports, admin, …)
src/app/page.tsx SPA entry (auth gate → app shell)
src/components/  views/* (Dashboard, POS, Products, …), shared/*, print/*
src/stores/      zustand: auth, cart, offline queue, theme, settings
public/          manifest.webmanifest, sw.js (offline shell)
docs/            this file
```

## 9. Screen Map

Login/Register/Forgot → **App Shell** (sidebar nav, sync badge, theme switcher, trial banner)
→ Dashboard · POS · Products · Inventory · Sales · Purchases · Customers · Khata · Suppliers · Expenses · Reports · Users · Settings · Subscription
→ **Owner Admin** (businesses, payments, plans) — separate view for SUPER_ADMIN.

## 10. Keyboard Shortcuts (POS, configurable in Settings)

F1 Search · F2 New Sale · F4 Hold · F8 Payment · ESC Close · F9 Camera scan · +/- qty · Del remove line.
