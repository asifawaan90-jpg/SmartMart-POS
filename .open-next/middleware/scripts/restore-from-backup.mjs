#!/usr/bin/env node
/**
 * SmartMart POS — Restore a full data backup (JSON) into a fresh database.
 *
 * Usage:
 *   node scripts/restore-from-backup.mjs <path/to/backup.json>          # local SQLite
 *
 * Prerequisites:
 *   npm install                     (installs prisma + @prisma/client + bcryptjs)
 *   copy .env.example to .env       (SQLite: DATABASE_URL="file:./db/custom.db")
 *   npx prisma db push              (creates the tables)
 *
 * Notes:
 *   • Restore is CREATE-ONLY: rows that already exist (same id) are skipped,
 *     so running it twice is safe and never overwrites your local edits.
 *   • User passwords are NOT stored in backups (by design). Every restored
 *     user gets the temporary password:  SmartMart@123  — sign in and change
 *     it immediately (Settings → Change password).
 *   • Product images and the shop logo are not included in JSON backups.
 *   • The backup JSON never contains SMTP passwords.
 */
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'

const args = process.argv.slice(2)
let file = args.find(a => !a.startsWith('--'))
if (!file) {
  // no argument given — auto-pick the included data backup
  try {
    const candidates = readdirSync('data-backup').filter(f => f.toLowerCase().endsWith('.json')).sort()
    if (candidates.length) file = join('data-backup', candidates[0])
  } catch {}
}
if (!file || !existsSync(file)) {
  console.error('Usage: node scripts/restore-from-backup.mjs <backup.json>')
  console.error('       (or run "npm run restore" — it auto-picks the file in data-backup/)')
  process.exit(1)
}

const { PrismaClient } = await import('@prisma/client')
const db = new PrismaClient({ datasources: { db: { url: 'file:../db/custom.db' } } })
const data = JSON.parse(readFileSync(file, 'utf8'))
const meta = data.meta || {}
const businessId = meta.businessId
if (!businessId || !data.business?.length) {
  console.error('Not a SmartMart backup file (missing meta.businessId / business).')
  process.exit(1)
}

const DEFAULT_PASSWORD = 'SmartMart@123'
const dt = v => (v ? new Date(v) : null)
const S = v => (v === undefined || v === null ? '' : String(v))
const F = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d)
const B = (v, d = true) => (typeof v === 'boolean' ? v : d)
const warnings = []
const created = {}

/** Ensure a (businessId, value) pair is unique — suffix ANY duplicate,
 *  including empty values (empty string still occupies the unique index). */
function uniq(map, key, value, label, id) {
  const raw = S(value)
  const v = raw || '(empty)'
  const k = `${key}::${v}`
  if (map.has(k)) {
    const fixed = `${raw}~${S(id).slice(-6)}`
    warnings.push(`${label} "${raw}" duplicated → restored as "${fixed}"`)
    map.set(k, true)
    return fixed
  }
  map.set(k, true)
  return raw
}
const mkUniq = () => new Map()
const phoneU = mkUniq(), skuU = mkUniq(), barcodeU = mkUniq(), clientRefU = mkUniq(), invoiceU = mkUniq()

/** Insert-or-skip a row by id (create-only). */
async function put(tx, model, row) {
  const existing = await tx[model].findUnique({ where: { id: row.id }, select: { id: true } })
  if (existing) return false
  await tx[model].create({ data: row })
  created[model] = (created[model] || 0) + 1
  return true
}

console.log(`Restoring "${meta.businessName || businessId}" from ${file}`)
console.log('Target: local SQLite (db/custom.db)\n')

await db.$transaction(async tx => {
  // ── 1. Business ──────────────────────────────────────────────
  const biz = data.business[0]
  await put(tx, 'business', {
    id: biz.id, name: S(biz.name) || 'My Store', ownerName: S(biz.ownerName),
    email: S(biz.email), phone: S(biz.phone), bizType: S(biz.bizType) || 'grocery',
    address: S(biz.address), currency: S(biz.currency) || 'PKR', logo: '',
    isActive: B(biz.isActive), createdAt: dt(biz.createdAt) || new Date(),
  })

  // ── 2. Users (temporary password for all) ────────────────────
  const pwHash = bcrypt.hashSync(DEFAULT_PASSWORD, 10)
  const users = data.users || []
  for (const u of users) {
    let email = S(u.email).toLowerCase()
    if (email) {
      const taken = await tx.user.findUnique({ where: { email }, select: { id: true } })
      if (taken && taken.id !== u.id) {
        email = `restored-${S(u.id).slice(-6)}+${email}`
        warnings.push(`user email collision → ${email}`)
      }
    }
    await put(tx, 'user', {
      id: u.id, businessId, name: S(u.name), email, phone: S(u.phone),
      passwordHash: pwHash, role: S(u.role) || 'CASHIER', perms: S(u.perms) || '[]',
      isActive: B(u.isActive), photo: '', cnic: '', salary: 0, joinDate: null,
      bioCredentialId: '', lastLoginAt: dt(u.lastLoginAt), createdAt: dt(u.createdAt) || new Date(),
    })
  }
  const ownerUser = users.find(u => S(u.role) === 'OWNER') || users[0]
  const fallbackUserId = ownerUser ? S(ownerUser.id) : 'SYSTEM'

  // ── 3. Master data ───────────────────────────────────────────
  for (const c of data.categories || []) await put(tx, 'category', { id: c.id, businessId, name: S(c.name), createdAt: dt(c.createdAt) || new Date() })
  for (const b of data.brands || []) await put(tx, 'brand', { id: b.id, businessId, name: S(b.name) })
  for (const u of data.units || []) await put(tx, 'unit', { id: u.id, businessId, name: S(u.name), shortName: S(u.shortName) })
  for (const c of data.expenseCategories || []) await put(tx, 'expenseCategory', { id: c.id, businessId, name: S(c.name) })

  // customers / suppliers — phone is unique per business → dedupe
  for (const c of data.customers || []) {
    await put(tx, 'customer', {
      id: c.id, businessId, name: S(c.name), phone: uniq(phoneU, businessId, c.phone, 'customer phone', c.id),
      address: S(c.address), openingBalance: F(c.openingBalance), creditLimit: F(c.creditLimit),
      notes: S(c.notes), isActive: B(c.isActive), createdAt: dt(c.createdAt) || new Date(),
    })
  }
  for (const s of data.suppliers || []) {
    await put(tx, 'supplier', {
      id: s.id, businessId, name: S(s.name), company: S(s.company),
      phone: uniq(phoneU, businessId, s.phone, 'supplier phone', s.id), address: S(s.address),
      openingBalance: F(s.openingBalance), notes: S(s.notes), isActive: B(s.isActive),
      createdAt: dt(s.createdAt) || new Date(),
    })
  }

  // ── 4. Products (relations were flattened to names in the backup) ──
  const catByName = new Map((data.categories || []).map(c => [S(c.name).trim().toLowerCase(), c.id]))
  const brandByName = new Map((data.brands || []).map(b => [S(b.name).trim().toLowerCase(), b.id]))
  const unitByName = new Map((data.units || []).map(u => [S(u.shortName || u.name).trim().toLowerCase(), u.id]))
  const supByName = new Map((data.suppliers || []).map(s => [S(s.name).trim().toLowerCase(), s.id]))
  const lookup = (map, name) => map.get(S(name).trim().toLowerCase()) || null

  for (const p of data.products || []) {
    await put(tx, 'product', {
      id: p.id, businessId, name: S(p.name), sku: uniq(skuU, businessId, p.sku, 'product sku', p.id),
      barcode: uniq(barcodeU, businessId, p.barcode, 'product barcode', p.id),
      categoryId: lookup(catByName, p.category), brandId: lookup(brandByName, p.brand),
      unitId: lookup(unitByName, p.unit), supplierId: lookup(supByName, p.supplier),
      image: '', costPrice: F(p.costPrice), lastCostPrice: F(p.lastCostPrice),
      retailPrice: F(p.retailPrice), wholesalePrice: F(p.wholesalePrice), minPrice: F(p.minPrice),
      taxRate: F(p.taxRate), stock: F(p.stock), openingStock: F(p.openingStock),
      minStock: F(p.minStock), expiryDate: dt(p.expiryDate), description: S(p.description),
      isActive: B(p.isActive), createdAt: dt(p.createdAt) || new Date(),
    })
  }

  // fallback product for historical line items whose product no longer matches
  // (created lazily — only if some line item really cannot be matched)
  const UNMATCHED_ID = 'restored-unmatched-product'
  let unmatchedReady = false
  async function ensureUnmatched() {
    if (unmatchedReady) return
    await put(tx, 'product', {
      id: UNMATCHED_ID, businessId, name: 'Imported item (unmatched)',
      sku: 'RESTORED-UNMATCHED', barcode: 'RESTORED-UNMATCHED', image: '',
      costPrice: 0, retailPrice: 0, stock: 0, description: 'Placeholder for restored historical line items.',
    })
    unmatchedReady = true
  }
  const prodByBarcode = new Map(), prodBySku = new Map(), prodByName = new Map()
  for (const p of data.products || []) {
    if (S(p.barcode)) prodByBarcode.set(S(p.barcode), p.id)
    if (S(p.sku)) prodBySku.set(S(p.sku), p.id)
    if (S(p.name) && !prodByName.has(S(p.name))) prodByName.set(S(p.name), p.id)
  }
  async function matchProduct(tx, it) {
    const id = prodByBarcode.get(S(it.barcode)) || prodBySku.get(S(it.sku)) || prodByName.get(S(it.product || it.name))
    if (id) return id
    await ensureUnmatched()
    return UNMATCHED_ID
  }

  // ── 5. Purchases ─────────────────────────────────────────────
  for (const p of data.purchases || []) {
    await put(tx, 'purchase', {
      id: p.id, businessId, invoiceNo: uniq(invoiceU, businessId, p.invoiceNo, 'purchase invoiceNo', p.id),
      clientRef: uniq(clientRefU, businessId, S(p.clientRef) || `r-${S(p.id).slice(-12)}`, 'purchase clientRef', p.id),
      supplierId: lookup(supByName, p.supplier), subtotal: F(p.subtotal), discount: F(p.discount),
      tax: F(p.tax), total: F(p.total), paid: F(p.paid), dueAmount: F(p.due),
      status: S(p.status) || 'RECEIVED', note: S(p.note), createdAt: dt(p.date) || new Date(),
    })
  }
  for (const i of data.purchaseItems || []) {
    await put(tx, 'purchaseItem', {
      id: i.id, purchaseId: i.purchaseId, productId: await matchProduct(tx, i), name: S(i.product),
      quantity: F(i.quantity), unitCost: F(i.unitCost), discount: F(i.discount),
      total: F(i.total), returnedQty: F(i.returnedQty),
    })
  }
  for (const r of data.purchaseReturns || []) {
    await put(tx, 'purchaseReturn', {
      id: r.id, businessId, purchaseId: r.purchaseId,
      returnNo: uniq(invoiceU, businessId, r.returnNo, 'purchase returnNo', r.id),
      items: S(r.items), total: F(r.total), reason: S(r.reason), userId: fallbackUserId,
      createdAt: dt(r.createdAt) || new Date(),
    })
  }

  // ── 6. Sales ─────────────────────────────────────────────────
  const custByName = new Map()
  for (const c of data.customers || []) if (S(c.name) && !custByName.has(S(c.name))) custByName.set(S(c.name), c.id)
  for (const s of data.sales || []) {
    const customerName = S(s.customer)
    await put(tx, 'sale', {
      id: s.id, businessId, invoiceNo: uniq(invoiceU, businessId, s.invoiceNo, 'sale invoiceNo', s.id),
      clientRef: uniq(clientRefU, businessId, S(s.clientRef) || `r-${S(s.id).slice(-12)}`, 'sale clientRef', s.id),
      deviceId: S(s.deviceId), customerId: customerName ? custByName.get(customerName) || null : null,
      cashierId: fallbackUserId, cashierName: S(s.cashier),
      subtotal: F(s.subtotal), discount: F(s.discount), discountType: 'AMOUNT', tax: F(s.tax),
      total: F(s.total), paid: F(s.paid), givenCash: F(s.paid), dueAmount: F(s.due),
      profit: F(s.profit), paymentMethod: S(s.paymentMethod) || 'CASH',
      status: S(s.status) || 'COMPLETED', note: S(s.note),
      deviceTs: dt(s.deviceTs), createdAt: dt(s.date) || new Date(),
    })
  }
  for (const i of data.saleItems || []) {
    await put(tx, 'saleItem', {
      id: i.id, saleId: i.saleId, productId: await matchProduct(tx, i), name: S(i.product),
      sku: S(i.sku), barcode: S(i.barcode), quantity: F(i.quantity), price: F(i.price),
      costAtSale: F(i.costAtSale), discount: F(i.discount), taxRate: F(i.taxRate),
      taxAmount: F(i.taxAmount), total: F(i.total), returnedQty: F(i.returnedQty),
    })
  }
  for (const r of data.saleReturns || []) {
    await put(tx, 'saleReturn', {
      id: r.id, businessId, saleId: r.saleId,
      returnNo: uniq(invoiceU, businessId, r.returnNo, 'sale returnNo', r.id),
      items: S(r.items), total: F(r.total), refundMethod: S(r.refundMethod) || 'CASH',
      reason: S(r.reason), userId: fallbackUserId, createdAt: dt(r.createdAt) || new Date(),
    })
  }

  // ── 7. Ledger + inventory + expenses ─────────────────────────
  for (const t of data.inventoryTransactions || []) {
    await put(tx, 'inventoryTransaction', {
      id: t.id, businessId, productId: S(t.productId), type: S(t.type) || 'ADJUST_IN',
      quantity: F(t.quantity), stockBefore: F(t.stockBefore), stockAfter: F(t.stockAfter),
      unitCost: F(t.unitCost), refType: S(t.refType), refId: '', refNo: S(t.refNo),
      note: S(t.note), userId: fallbackUserId, deviceTs: null, clientRef: null,
      createdAt: dt(t.createdAt) || new Date(),
    })
  }
  for (const t of data.customerTransactions || []) {
    await put(tx, 'customerTransaction', {
      id: t.id, businessId, customerId: S(t.customer) ? custByName.get(S(t.customer)) || '' : '',
      type: S(t.type) || 'ADJUST', amount: F(t.amount), balanceAfter: F(t.balanceAfter),
      refType: '', refId: '', refNo: S(t.refNo), note: S(t.note), dueDate: dt(t.dueDate),
      userId: fallbackUserId, clientRef: null, createdAt: dt(t.createdAt) || new Date(),
    })
  }
  for (const t of data.supplierTransactions || []) {
    await put(tx, 'supplierTransaction', {
      id: t.id, businessId, supplierId: supByName.get(S(t.supplier).trim().toLowerCase()) || '',
      type: S(t.type) || 'ADJUST', amount: F(t.amount), balanceAfter: F(t.balanceAfter),
      refType: '', refId: '', refNo: S(t.refNo), note: S(t.note), userId: fallbackUserId,
      createdAt: dt(t.createdAt) || new Date(),
    })
  }
  const expCatByName = new Map((data.expenseCategories || []).map(c => [S(c.name).trim().toLowerCase(), c.id]))
  for (const x of data.expenses || []) {
    await put(tx, 'expense', {
      id: x.id, businessId, categoryId: lookup(expCatByName, x.category), title: S(x.title),
      amount: F(x.amount), kind: 'EXPENSE', isAuto: false, paidTo: S(x.paidTo), receipt: '',
      paymentMethod: S(x.paymentMethod) || 'CASH', note: S(x.note),
      expenseDate: dt(x.date) || new Date(), userId: fallbackUserId,
      createdAt: dt(x.date) || new Date(),
    })
  }

  // ── 8. Settings (SMTP credentials are redacted in backups) ───
  const settingsObj = (data.settings || [])[0]
  if (settingsObj) {
    const { exportedAt, ...clean } = settingsObj
    await tx.setting.upsert({
      where: { businessId },
      create: { id: randomUUID(), businessId, data: JSON.stringify(clean) },
      update: {},
    })
  }
})

console.log('\n── Restore complete ──')
const expected = meta.counts || {}
for (const [model, n] of Object.entries(created)) console.log(`  ${model.padEnd(22)} ${String(n).padStart(4)} created`)
console.log(`\nBusiness: ${meta.businessName || businessId}`)
console.log(`Login:    (any restored user email) / ${DEFAULT_PASSWORD}  ← CHANGE IT AFTER FIRST LOGIN`)
console.log('Skipped rows already existed (create-only restore — safe to re-run).')
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`)
  for (const w of warnings.slice(0, 20)) console.log('  • ' + w)
  if (warnings.length > 20) console.log(`  … and ${warnings.length - 20} more`)
}
await db.$disconnect()
