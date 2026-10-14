import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, handleError, readBody, requirePerm, requireActiveSub, audit, clientIp,
  num,
} from '@/lib/api'
import { createStockAdjustment } from '@/lib/inventory-service'

export const dynamic = 'force-dynamic'

// GET /api/inventory?productId=&type=&from=&to=&page=
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'inventory')
    const url = new URL(req.url)
    const productId = url.searchParams.get('productId') || ''
    const type = url.searchParams.get('type') || ''
    const page = Math.max(1, num(url.searchParams.get('page'), 1))
    const pageSize = Math.min(100, Math.max(5, num(url.searchParams.get('pageSize'), 25)))
    const where: Record<string, unknown> = { businessId: ctx.businessId }
    if (productId) where.productId = productId
    if (type) where.type = type
    const [items, total] = await Promise.all([
      db.inventoryTransaction.findMany({
        where,
        include: { product: { select: { name: true, sku: true, barcode: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.inventoryTransaction.count({ where }),
    ])
    return ok({ items, total, page, pageSize })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/inventory — stock adjustment { productId, type: ADJUST_IN|ADJUST_OUT|DAMAGE|RETURN_IN, quantity, note }
export async function POST(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'inventory')
    await requireActiveSub(ctx)
    const b = await readBody<Record<string, unknown>>(req)
    const result = await createStockAdjustment({
      businessId: ctx.businessId,
      userId: ctx.user.uid,
      input: {
        productId: String(b.productId || ''),
        type: String(b.type || 'ADJUST_IN') as 'ADJUST_IN',
        quantity: num(b.quantity),
        note: String(b.note || ''),
        clientRef: String(b.clientRef || ''),
        deviceTs: String(b.deviceTs || ''),
      },
    })

    if (!result.duplicate) {
      await audit(ctx.businessId, ctx.user.uid, 'STOCK_ADJUSTED', 'Product', String(b.productId),
        { type: b.type, qty: Math.abs(num(b.quantity)), productName: result.productName, stockAfter: result.stockAfter }, clientIp(req))
    }
    return ok(result, result.duplicate ? 200 : 201)
  } catch (e) {
    return handleError(e)
  }
}
