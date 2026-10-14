import { db } from '@/lib/db'
import { ApiError, r2 } from '@/lib/api'

export interface StockAdjustmentInput {
  productId: string
  type: 'ADJUST_IN' | 'ADJUST_OUT' | 'DAMAGE' | 'RETURN_IN'
  quantity: number
  note?: string
  clientRef?: string
  deviceTs?: string
}

/**
 * Creates a stock adjustment idempotently (clientRef unique per business).
 * Server-authoritative: recalculates stock levels in one DB transaction and
 * writes the InventoryTransaction audit row. Used by POST /api/inventory and
 * by the offline sync engine (kind: STOCK_ADJUSTMENT).
 */
export async function createStockAdjustment(opts: {
  businessId: string
  userId: string
  input: StockAdjustmentInput
}): Promise<{ id: string; duplicate: boolean; stockAfter: number; productName: string }> {
  const { businessId, userId, input } = opts
  const productId = String(input.productId || '')
  const type = String(input.type || 'ADJUST_IN')
  const qty = Math.abs(Number(input.quantity) || 0)
  if (!productId) throw new ApiError(400, 'VALIDATION', 'Product is required.')
  if (qty <= 0) throw new ApiError(400, 'VALIDATION', 'Quantity must be greater than zero.')
  const allowed = ['ADJUST_IN', 'ADJUST_OUT', 'DAMAGE', 'RETURN_IN']
  if (!allowed.includes(type)) throw new ApiError(400, 'VALIDATION', 'Invalid adjustment type.')
  const clientRef = (input.clientRef || '').slice(0, 64)

  // Idempotency fast-path — the same device adjustment never applies twice.
  if (clientRef) {
    const existing = await db.inventoryTransaction.findUnique({
      where: { businessId_clientRef: { businessId, clientRef } },
      select: { id: true, stockAfter: true, product: { select: { name: true } } },
    })
    if (existing) {
      return { id: existing.id, duplicate: true, stockAfter: existing.stockAfter, productName: existing.product.name }
    }
  }

  const result = await db.$transaction(async (tx) => {
    const p = await tx.product.findFirst({ where: { id: productId, businessId } })
    if (!p) throw new ApiError(404, 'NOT_FOUND', 'Product not found.')
    const delta = type === 'ADJUST_OUT' || type === 'DAMAGE' ? -qty : qty
    const after = r2(p.stock + delta)
    if (after < 0) throw new ApiError(400, 'INSUFFICIENT_STOCK', `Adjustment would make stock negative for ${p.name} (current: ${p.stock}).`)
    await tx.product.update({ where: { id: p.id }, data: { stock: after } })
    const txn = await tx.inventoryTransaction.create({
      data: {
        businessId, productId, type,
        quantity: delta, stockBefore: p.stock, stockAfter: after,
        unitCost: p.costPrice, refType: 'Manual',
        note: (input.note || '').slice(0, 300), userId,
        deviceTs: input.deviceTs ? new Date(input.deviceTs) : undefined,
        clientRef: clientRef || null,
      },
    })
    return { txn, productName: p.name, after }
  })

  return { id: result.txn.id, duplicate: false, stockAfter: result.after, productName: result.productName }
}
