import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, fail, handleError, readBody, requirePerm, requireActiveSub, audit,
  num, r2, ApiError, clientIp,
} from '@/lib/api'

export const dynamic = 'force-dynamic'

// POST /api/sales/return?id=...  body: { items:[{saleItemId, quantity}], reason, refundMethod }
export async function POST(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'sales_return')
    await requireActiveSub(ctx)
    const url = new URL(req.url)
    const saleId = url.searchParams.get('id')
    if (!saleId) throw new ApiError(400, 'VALIDATION', 'Sale id required.')
    const b = await readBody<{ items: { saleItemId: string; quantity: number }[]; reason?: string; refundMethod?: string }>(req)

    const sale = await db.sale.findFirst({ where: { id: saleId, businessId: ctx.businessId }, include: { items: true } })
    if (!sale) return fail(404, 'NOT_FOUND', 'Sale not found.')
    if (sale.status === 'RETURNED') throw new ApiError(400, 'ALREADY_RETURNED', 'This sale has already been fully returned.')
    if (!Array.isArray(b.items) || b.items.length === 0) throw new ApiError(400, 'VALIDATION', 'No return items provided.')

    // Validate quantities & compute refund
    const itemMap = new Map(sale.items.map(i => [i.id, i]))
    let refundTotal = 0
    let profitDelta = 0 // negative
    const returnLines: { saleItemId: string; productId: string; name: string; qty: number; price: number }[] = []
    for (const ri of b.items) {
      const item = itemMap.get(ri.saleItemId)
      if (!item) throw new ApiError(400, 'VALIDATION', 'Return item does not belong to this sale.')
      const qty = num(ri.quantity)
      if (qty <= 0) continue
      const returnable = r2(item.quantity - item.returnedQty)
      if (qty > returnable) throw new ApiError(400, 'INVALID_QTY', `Cannot return ${qty} of ${item.name}. Only ${returnable} returnable.`)
      const lineBase = r2(qty * item.price - item.discount * (qty / Math.max(1, item.quantity)))
      refundTotal = r2(refundTotal + lineBase)
      profitDelta -= r2(lineBase - item.costAtSale * qty)
      returnLines.push({ saleItemId: item.id, productId: item.productId, name: item.name, qty, price: item.price })
    }
    if (refundTotal <= 0) throw new ApiError(400, 'VALIDATION', 'Return total must be greater than zero.')

    const count = await db.saleReturn.count({ where: { businessId: ctx.businessId } })
    const returnNo = `RET-${String(count + 1).padStart(6, '0')}`

    await db.$transaction(async (tx) => {
      await tx.saleReturn.create({
        data: {
          businessId: ctx.businessId, saleId, returnNo,
          items: JSON.stringify(returnLines.map(({ saleItemId: _s, ...rest }) => rest)),
          total: refundTotal,
          refundMethod: b.refundMethod || 'CASH',
          reason: (b.reason || '').slice(0, 300), userId: ctx.user.uid,
        },
      })
      // restore stock + mark returned quantities
      for (const line of returnLines) {
        await tx.saleItem.update({ where: { id: line.saleItemId }, data: { returnedQty: r2(sale.items.find(i => i.id === line.saleItemId)!.returnedQty + line.qty) } })
        const p = await tx.product.findUnique({ where: { id: line.productId } })
        if (p) {
          const before = p.stock
          const after = r2(before + line.qty)
          await tx.product.update({ where: { id: p.id }, data: { stock: after } })
          await tx.inventoryTransaction.create({
            data: {
              businessId: ctx.businessId, productId: p.id, type: 'RETURN_IN',
              quantity: line.qty, stockBefore: before, stockAfter: after,
              unitCost: p.costPrice, refType: 'SaleReturn', refId: saleId, refNo: returnNo,
              note: `Return for ${sale.invoiceNo}`, userId: ctx.user.uid,
            },
          })
        }
      }
      const refreshed = await tx.sale.findUnique({ where: { id: saleId }, include: { items: true } })
      const fullyReturned = refreshed!.items.every(i => i.returnedQty >= i.quantity)
      const creditRelief = r2(Math.min(refundTotal, refreshed!.dueAmount))
      const newDue = r2(refreshed!.dueAmount - creditRelief)
      const cashRefund = r2(refundTotal - creditRelief)
      const newPaid = r2(Math.max(0, refreshed!.paid - cashRefund))
      await tx.sale.update({
        where: { id: saleId },
        data: {
          status: fullyReturned ? 'RETURNED' : 'PARTIALLY_RETURNED',
          total: r2(refreshed!.total - refundTotal),
          paid: newPaid, dueAmount: newDue,
          profit: r2(refreshed!.profit + profitDelta),
        },
      })
      // khata reversal when the sale had credit outstanding
      if (sale.customerId && creditRelief > 0) {
        const agg = await tx.customerTransaction.aggregate({ where: { businessId: ctx.businessId, customerId: sale.customerId }, _sum: { amount: true } })
        const cust = await tx.customer.findUnique({ where: { id: sale.customerId } })
        const balBefore = r2((agg._sum.amount || 0) + (cust?.openingBalance || 0))
        await tx.customerTransaction.create({
          data: {
            businessId: ctx.businessId, customerId: sale.customerId, type: 'RETURN',
            amount: -creditRelief, balanceAfter: r2(balBefore - creditRelief),
            refType: 'SaleReturn', refId: saleId, refNo: returnNo,
            note: `Return against ${sale.invoiceNo}`, userId: ctx.user.uid,
          },
        })
      }
    })

    await audit(ctx.businessId, ctx.user.uid, 'SALE_RETURNED', 'Sale', saleId, { returnNo, refundTotal }, clientIp(req))
    return ok({ returnNo, refundTotal }, 201)
  } catch (e) {
    return handleError(e)
  }
}
