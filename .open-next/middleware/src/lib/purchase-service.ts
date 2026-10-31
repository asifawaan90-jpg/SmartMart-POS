import { db } from '@/lib/db'
import { ApiError, num, r2 } from '@/lib/api'

export interface PurchaseLineInput {
  productId: string
  quantity: number
  unitCost: number
  discount?: number
}

export interface PurchaseInput {
  clientRef?: string
  supplierId?: string | null
  items: PurchaseLineInput[]
  discount?: number
  tax?: number
  paid?: number
  note?: string
}

/**
 * Creates a purchase idempotently (clientRef unique per business).
 * Server-authoritative: recalculates totals, increases stock with weighted
 * moving-average cost, writes inventory transactions and the supplier payable
 * ledger — all in one DB transaction. Used by POST /api/purchases and by the
 * offline sync engine (kind: PURCHASE).
 */
export async function createPurchase(opts: {
  businessId: string
  userId: string
  input: PurchaseInput
}): Promise<{ id: string; invoiceNo: string; total: number; duplicate: boolean }> {
  const { businessId, userId, input: b } = opts
  if (!Array.isArray(b.items) || b.items.length === 0) throw new ApiError(400, 'VALIDATION', 'Purchase must contain at least one product.')

  const ids = [...new Set(b.items.map(i => String(i.productId)))]
  const products = await db.product.findMany({ where: { id: { in: ids }, businessId } })
  const pmap = new Map(products.map(p => [p.id, p]))

  let subtotal = 0
  const lines = b.items.map(it => {
    const p = pmap.get(String(it.productId))
    if (!p) throw new ApiError(400, 'PRODUCT_NOT_FOUND', 'A product in the purchase no longer exists.')
    const qty = num(it.quantity)
    const cost = r2(num(it.unitCost))
    if (qty <= 0 || cost < 0) throw new ApiError(400, 'VALIDATION', `Invalid quantity or cost for ${p.name}.`)
    const disc = r2(num(it.discount))
    const lineTotal = r2(qty * cost - disc)
    subtotal += lineTotal
    return { productId: p.id, name: p.name, quantity: qty, unitCost: cost, discount: disc, total: lineTotal, returnedQty: 0 }
  })
  subtotal = r2(subtotal)
  const discount = r2(Math.min(num(b.discount), subtotal))
  const tax = r2(num(b.tax))
  const total = r2(subtotal - discount + tax)
  const paid = r2(num(b.paid))
  const dueAmount = r2(total - paid)

  const clientRef = (b.clientRef || '').slice(0, 64)
  if (clientRef) {
    const dup = await db.purchase.findUnique({ where: { businessId_clientRef: { businessId, clientRef } } })
    if (dup) return { id: dup.id, invoiceNo: dup.invoiceNo, total: dup.total, duplicate: true }
  }

  const count = await db.purchase.count({ where: { businessId } })
  const settings = await db.setting.findUnique({ where: { businessId } })
  const pPrefix = settings ? (JSON.parse(settings.data)?.purchasePrefix ?? 'PUR-') : 'PUR-'
  const invoiceNo = await uniqueInvoice(businessId, pPrefix, count)

  const result = await db.$transaction(async (tx) => {
    const purchase = await tx.purchase.create({
      data: {
        businessId, invoiceNo, clientRef,
        supplierId: b.supplierId || null,
        subtotal, discount, tax, total, paid, dueAmount,
        status: 'RECEIVED', note: (b.note || '').slice(0, 300),
      },
    })
    for (const l of lines) {
      await tx.purchaseItem.create({ data: { ...l, purchaseId: purchase.id } })
      const p = await tx.product.findUnique({ where: { id: l.productId } })
      if (!p) continue
      const before = p.stock
      const after = r2(before + l.quantity)
      // weighted moving average cost
      const totalValue = r2(before * p.costPrice + l.quantity * l.unitCost - l.discount)
      const newAvg = after > 0 ? r2(totalValue / after) : l.unitCost
      await tx.product.update({
        where: { id: p.id },
        data: { stock: after, costPrice: newAvg, lastCostPrice: l.unitCost },
      })
      await tx.inventoryTransaction.create({
        data: {
          businessId, productId: p.id, type: 'PURCHASE',
          quantity: l.quantity, stockBefore: before, stockAfter: after,
          unitCost: l.unitCost, refType: 'Purchase', refId: purchase.id, refNo: invoiceNo,
          note: `Purchase ${invoiceNo}`, userId,
        },
      })
    }
    // supplier payable ledger
    if (b.supplierId) {
      const agg = await tx.supplierTransaction.aggregate({ where: { businessId, supplierId: b.supplierId }, _sum: { amount: true } })
      const sup = await tx.supplier.findUnique({ where: { id: b.supplierId } })
      const balBefore = r2((agg._sum.amount || 0) + (sup?.openingBalance || 0))
      await tx.supplierTransaction.create({
        data: {
          businessId, supplierId: b.supplierId, type: 'PURCHASE_CREDIT',
          amount: total, balanceAfter: r2(balBefore + total),
          refType: 'Purchase', refId: purchase.id, refNo: invoiceNo,
          note: `Purchase ${invoiceNo}`, userId,
        },
      })
      if (paid > 0) {
        const agg2 = await tx.supplierTransaction.aggregate({ where: { businessId, supplierId: b.supplierId }, _sum: { amount: true } })
        const sup2 = await tx.supplier.findUnique({ where: { id: b.supplierId } })
        const bal2 = r2((agg2._sum.amount || 0) + (sup2?.openingBalance || 0))
        await tx.supplierTransaction.create({
          data: {
            businessId, supplierId: b.supplierId, type: 'PAYMENT',
            amount: -paid, balanceAfter: bal2,
            refType: 'Purchase', refId: purchase.id, refNo: invoiceNo,
            note: `Paid with purchase ${invoiceNo}`, userId,
          },
        })
      }
    }
    return purchase
  })

  return { id: result.id, invoiceNo, total, duplicate: false }
}

async function uniqueInvoice(businessId: string, prefix: string, count: number): Promise<string> {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const base = `${prefix}${ymd}-`
  for (let i = count + 1; i < count + 50; i++) {
    const candidate = `${base}${String(i).padStart(5, '0')}`
    const exists = await db.purchase.findUnique({ where: { businessId_invoiceNo: { businessId, invoiceNo: candidate } }, select: { id: true } })
    if (!exists) return candidate
  }
  return `${base}${Date.now().toString(36).toUpperCase()}`
}
