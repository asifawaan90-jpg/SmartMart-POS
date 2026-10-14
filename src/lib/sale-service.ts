import { db } from '@/lib/db'
import { appendJournal } from '@/lib/journal'
import { ApiError, r2, num } from '@/lib/api'
import { uuid } from '@/lib/uid'

export interface CartItemInput {
  productId: string
  name?: string
  quantity: number
  price: number
  discount?: number
  taxRate?: number
}

export interface SaleInput {
  clientRef?: string
  deviceId?: string
  customerId?: string | null
  items: CartItemInput[]
  discount?: number
  discountType?: 'AMOUNT' | 'PERCENT'
  paid?: number
  /** Cash handed by the customer at the till — may exceed total (change returned). CASH only. */
  givenCash?: number
  paymentMethod?: string
  note?: string
  deviceTs?: string
}

export interface SaleResult {
  id: string
  invoiceNo: string
  total: number
  paid: number
  givenCash: number
  dueAmount: number
  duplicate: boolean
  createdAt: string
}

function round2(n: number) { return r2(n) }

/**
 * Creates a sale idempotently (clientRef unique per business).
 * Server-authoritative: recalculates totals from DB prices+costs, decrements stock,
 * writes inventory transactions, khata ledger entries and audit trail — all in one DB transaction.
 */
export async function createSale(opts: {
  businessId: string
  userId: string
  cashierName: string
  input: SaleInput
  prefix: string
  forceMethod?: string
  /** Task 67 — offline sync / journal replay: the goods already left the shop,
   *  so the sale must be RECORDED even when server stock is lower than the
   *  sold quantity (stock may go negative; the inventory ledger then shows the
   *  true deficit to restock). Before this flag, any stock drift between the
   *  phone and the server (offline selling, a db rollback, a restore) made the
   *  queued sale fail with INSUFFICIENT_STOCK on EVERY retry — the sale was
   *  real but never reached the database, i.e. "data lost next day". */
  allowNegativeStock?: boolean
}): Promise<SaleResult> {
  const { businessId, userId, input } = opts
  const clientRef = (input.clientRef || uuid()).slice(0, 64)

  // Idempotency fast-path
  const existing = await db.sale.findUnique({ where: { businessId_clientRef: { businessId, clientRef } } })
  if (existing) {
    return {
      id: existing.id, invoiceNo: existing.invoiceNo, total: existing.total,
      paid: existing.paid, givenCash: existing.givenCash, dueAmount: existing.dueAmount, duplicate: true,
      createdAt: existing.createdAt.toISOString(),
    }
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError(400, 'EMPTY_CART', 'Cart is empty.')
  }

  // Load products for validation + cost capture
  const ids = [...new Set(input.items.map(i => String(i.productId)))]
  const products = await db.product.findMany({ where: { id: { in: ids }, businessId } })
  const pmap = new Map(products.map(p => [p.id, p]))

  // Pre-validate stock outside transaction (fail fast, clear message)
  const qtyNeeded = new Map<string, number>()
  for (const it of input.items) {
    const p = pmap.get(String(it.productId))
    if (!p) throw new ApiError(400, 'PRODUCT_NOT_FOUND', 'A product in your cart no longer exists. Please refresh.')
    qtyNeeded.set(p.id, (qtyNeeded.get(p.id) || 0) + num(it.quantity))
  }
  for (const [pid, qty] of qtyNeeded) {
    const p = pmap.get(pid)!
    if (qty <= 0) throw new ApiError(400, 'INVALID_QTY', `Invalid quantity for ${p.name}.`)
    if (!opts.allowNegativeStock && p.stock < qty) {
      throw new ApiError(400, 'INSUFFICIENT_STOCK', `Not enough stock for ${p.name}. Available: ${p.stock}`)
    }
  }

  const settingsRow = await db.setting.findUnique({ where: { businessId } })
  const settings = JSON.parse(settingsRow?.data || '{}')

  // Compute on server
  let subtotal = 0, taxTotal = 0
  const lines = input.items.map(it => {
    const p = pmap.get(String(it.productId))!
    const qty = num(it.quantity)
    const price = it.price != null ? num(it.price) : p.retailPrice
    const disc = num(it.discount)
    const taxRate = it.taxRate != null ? num(it.taxRate) : p.taxRate
    const lineBase = round2(qty * price - disc)
    const lineTax = round2(lineBase * (taxRate / 100))
    subtotal += round2(qty * price)
    taxTotal += lineTax
    return {
      productId: p.id, name: p.name, sku: p.sku, barcode: p.barcode,
      quantity: qty, price: round2(price), costAtSale: p.costPrice,
      discount: round2(disc), taxRate, taxAmount: lineTax, total: round2(lineBase + lineTax),
      returnedQty: 0,
    }
  })
  subtotal = round2(subtotal)
  taxTotal = round2(taxTotal)

  let discount = num(input.discount)
  if (input.discountType === 'PERCENT') discount = round2((subtotal - 0) * (discount / 100))
  discount = Math.min(round2(discount), round2(subtotal + taxTotal))
  const total = round2(subtotal - discount + taxTotal)

  let paymentMethod = opts.forceMethod || input.paymentMethod || 'CASH'
  let paid = input.paid != null ? round2(num(input.paid)) : total
  let dueAmount = round2(total - paid)
  if (dueAmount < 0) { paid = total; dueAmount = 0 } // overpay → change returned, not stored as paid
  if (dueAmount > 0 && paymentMethod !== 'KHATA') paymentMethod = 'MIXED'
  // Cash tendered (only meaningful for CASH): what the customer physically handed over
  const givenCash = paymentMethod === 'CASH' || paymentMethod === 'MIXED'
    ? Math.max(0, round2(num(input.givenCash) || paid))
    : 0

  const customerId = input.customerId || null
  if (customerId) {
    const cust = await db.customer.findFirst({ where: { id: customerId, businessId } })
    if (!cust) throw new ApiError(400, 'CUSTOMER_NOT_FOUND', 'Selected customer not found.')
    if (dueAmount > 0 && cust.creditLimit > 0) {
      const agg = await db.customerTransaction.aggregate({
        where: { businessId, customerId }, _sum: { amount: true },
      })
      const currentDue = (agg._sum.amount || 0) + cust.openingBalance
      if (currentDue + dueAmount > cust.creditLimit) {
        throw new ApiError(400, 'CREDIT_LIMIT', `Credit limit exceeded for ${cust.name}. Limit: ${cust.creditLimit}, current due: ${round2(currentDue)}.`)
      }
    }
  }

  // Server invoice number — per-day sequence (Task 67): the sequence is
  // derived from THIS DAY's invoices only. The old code seeded from the GLOBAL
  // sale count, so after any history the numbers jumped (e.g. 59 total sales
  // → next invoice "INV-...-00060" instead of the day's 00001).
  const prefixStr = settings?.invoice?.prefix || opts.prefix || 'INV-'
  const invoiceNo = await nextSaleInvoice(businessId, prefixStr)

  const result = await db.$transaction(async (tx) => {
    const sale = await tx.sale.create({
      data: {
        businessId, invoiceNo, clientRef,
        deviceId: (input.deviceId || '').slice(0, 64),
        customerId, cashierId: userId, cashierName: opts.cashierName,
        subtotal, discount, discountType: input.discountType || 'AMOUNT',
        tax: taxTotal, total, paid, givenCash, dueAmount,
        profit: 0, // fill below
        paymentMethod, status: 'COMPLETED',
        note: (input.note || '').slice(0, 500),
        deviceTs: input.deviceTs ? new Date(input.deviceTs) : undefined,
      },
    })

    let profit = 0
    for (const l of lines) {
      await tx.saleItem.create({ data: { ...l, saleId: sale.id } })
      const p = await tx.product.findUnique({ where: { id: l.productId } })
      if (!p) continue
      const before = p.stock
      const after = r2(before - l.quantity)
      await tx.product.update({ where: { id: p.id }, data: { stock: after } })
      await tx.inventoryTransaction.create({
        data: {
          businessId, productId: p.id, type: 'SALE',
          quantity: -l.quantity, stockBefore: before, stockAfter: after,
          unitCost: l.costAtSale, refType: 'Sale', refId: sale.id, refNo: invoiceNo,
          note: `POS sale ${invoiceNo}`, userId,
        },
      })
      profit += (l.price - l.discount / Math.max(1, l.quantity) - l.costAtSale) * l.quantity
    }
    profit = round2(profit - discount) // store-level discount reduces profit; tax is pass-through
    await tx.sale.update({ where: { id: sale.id }, data: { profit } })

    // Khata ledger for credit portion
    if (customerId && dueAmount > 0) {
      const agg = await tx.customerTransaction.aggregate({
        where: { businessId, customerId }, _sum: { amount: true },
      })
      const cust = await tx.customer.findUnique({ where: { id: customerId } })
      const balBefore = r2((agg._sum.amount || 0) + (cust?.openingBalance || 0))
      await tx.customerTransaction.create({
        data: {
          businessId, customerId, type: 'SALE_CREDIT', amount: dueAmount,
          balanceAfter: r2(balBefore + dueAmount), refType: 'Sale', refId: sale.id,
          refNo: invoiceNo, note: `Credit sale ${invoiceNo}`, userId,
        },
      })
    }

    // decrement stock — done above per item
    return sale
  })

  // Task 61 — write-ahead journal: this sale is now accepted business data.
  // One append-only JSON line OUTSIDE the db file means a db rollback can
  // never silently eat it — the boot replay re-creates it (idempotent by
  // clientRef). Best-effort, never fails the sale.
  appendJournal({
    kind: 'SALE',
    businessId, userId, cashierName: opts.cashierName,
    prefix: opts.prefix,
    invoiceNo: result.invoiceNo,
    input: { ...input, clientRef },
  })

  return {
    id: result.id, invoiceNo: result.invoiceNo, total: result.total,
    paid: result.paid, givenCash: result.givenCash, dueAmount: result.dueAmount, duplicate: false,
    createdAt: result.createdAt.toISOString(),
  }
}

export async function nextSaleInvoice(businessId: string, prefix: string): Promise<string> {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const base = `${prefix}${ymd}-`
  // Per-day count: how many invoices already exist for THIS date prefix.
  const dayCount = await db.sale.count({ where: { businessId, invoiceNo: { startsWith: base } } })
  for (let i = dayCount + 1; i < dayCount + 50; i++) {
    const candidate = `${base}${String(i).padStart(5, '0')}`
    const exists = await db.sale.findUnique({
      where: { businessId_invoiceNo: { businessId, invoiceNo: candidate } },
      select: { id: true },
    })
    if (!exists) return candidate
  }
  return `${base}${Date.now().toString(36).toUpperCase()}` // collision fallback
}
