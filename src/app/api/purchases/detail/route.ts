import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, fail, handleError, readBody, requirePerm, requireActiveSub, audit,
  num, r2, ApiError, clientIp,
} from '@/lib/api'

export const dynamic = 'force-dynamic'

// GET /api/purchases/detail?id=
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'purchases')
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return fail(400, 'VALIDATION', 'id required.')
    const purchase = await db.purchase.findFirst({
      where: { id, businessId: ctx.businessId },
      include: { items: true, supplier: true, returns: true },
    })
    if (!purchase) return fail(404, 'NOT_FOUND', 'Purchase not found.')
    return ok(purchase)
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/purchases/detail?id= — purchase return { items: [{purchaseItemId, quantity}], reason }
export async function POST(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'purchases')
    await requireActiveSub(ctx)
    const id = new URL(req.url).searchParams.get('id')
    if (!id) throw new ApiError(400, 'VALIDATION', 'id required.')
    const b = await readBody<{ items: { purchaseItemId: string; quantity: number }[]; reason?: string }>(req)

    const purchase = await db.purchase.findFirst({ where: { id, businessId: ctx.businessId }, include: { items: true } })
    if (!purchase) return fail(404, 'NOT_FOUND', 'Purchase not found.')
    if (!Array.isArray(b.items) || b.items.length === 0) throw new ApiError(400, 'VALIDATION', 'No return items provided.')

    const itemMap = new Map(purchase.items.map(i => [i.id, i]))
    let returnTotal = 0
    const lines: { purchaseItemId: string; productId: string; name: string; qty: number; unitCost: number }[] = []
    for (const ri of b.items) {
      const item = itemMap.get(ri.purchaseItemId)
      if (!item) throw new ApiError(400, 'VALIDATION', 'Return item does not belong to this purchase.')
      const qty = num(ri.quantity)
      const returnable = r2(item.quantity - item.returnedQty)
      if (qty <= 0 || qty > returnable) throw new ApiError(400, 'INVALID_QTY', `Invalid return quantity for ${item.name} (max ${returnable}).`)
      returnTotal = r2(returnTotal + r2(qty * item.unitCost))
      lines.push({ purchaseItemId: item.id, productId: item.productId, name: item.name, qty, unitCost: item.unitCost })
    }
    if (returnTotal <= 0) throw new ApiError(400, 'VALIDATION', 'Return total must be positive.')

    const count = await db.purchaseReturn.count({ where: { businessId: ctx.businessId } })
    const returnNo = `PRET-${String(count + 1).padStart(6, '0')}`

    await db.$transaction(async (tx) => {
      await tx.purchaseReturn.create({
        data: {
          businessId: ctx.businessId, purchaseId: id, returnNo,
          items: JSON.stringify(lines.map(({ purchaseItemId: _p, ...rest }) => rest)),
          total: returnTotal, reason: (b.reason || '').slice(0, 300), userId: ctx.user.uid,
        },
      })
      for (const line of lines) {
        await tx.purchaseItem.update({ where: { id: line.purchaseItemId }, data: { returnedQty: r2(purchase.items.find(i => i.id === line.purchaseItemId)!.returnedQty + line.qty) } })
        const p = await tx.product.findUnique({ where: { id: line.productId } })
        if (p) {
          const before = p.stock
          const after = r2(before - line.qty)
          if (after < 0) throw new ApiError(400, 'INSUFFICIENT_STOCK', `Cannot return ${line.qty} of ${p.name}; stock is only ${before}.`)
          await tx.product.update({ where: { id: p.id }, data: { stock: after } })
          await tx.inventoryTransaction.create({
            data: {
              businessId: ctx.businessId, productId: p.id, type: 'RETURN_OUT',
              quantity: -line.qty, stockBefore: before, stockAfter: after,
              unitCost: line.unitCost, refType: 'PurchaseReturn', refId: id, refNo: returnNo,
              note: `Purchase return ${returnNo}`, userId: ctx.user.uid,
            },
          })
        }
      }
      const refreshed = await tx.purchase.findUnique({ where: { id }, include: { items: true } })
      const fully = refreshed!.items.every(i => i.returnedQty >= i.quantity)
      const payableRelief = r2(Math.min(returnTotal, refreshed!.dueAmount))
      await tx.purchase.update({
        where: { id },
        data: {
          status: fully ? 'RETURNED' : 'PARTIALLY_RETURNED',
          total: r2(refreshed!.total - returnTotal),
          dueAmount: r2(refreshed!.dueAmount - payableRelief),
          paid: r2(Math.max(0, refreshed!.paid - (returnTotal - payableRelief))),
        },
      })
      if (purchase.supplierId && payableRelief > 0) {
        const agg = await tx.supplierTransaction.aggregate({ where: { businessId: ctx.businessId, supplierId: purchase.supplierId }, _sum: { amount: true } })
        const sup = await tx.supplier.findUnique({ where: { id: purchase.supplierId } })
        const balBefore = r2((agg._sum.amount || 0) + (sup?.openingBalance || 0))
        await tx.supplierTransaction.create({
          data: {
            businessId: ctx.businessId, supplierId: purchase.supplierId, type: 'RETURN',
            amount: -payableRelief, balanceAfter: r2(balBefore - payableRelief),
            refType: 'PurchaseReturn', refId: id, refNo: returnNo,
            note: `Return against ${purchase.invoiceNo}`, userId: ctx.user.uid,
          },
        })
      }
    })

    await audit(ctx.businessId, ctx.user.uid, 'PURCHASE_RETURNED', 'Purchase', id, { returnNo, returnTotal }, clientIp(req))
    return ok({ returnNo, returnTotal }, 201)
  } catch (e) {
    return handleError(e)
  }
}
