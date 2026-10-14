import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail, handleError, requirePerm } from '@/lib/api'

export const dynamic = 'force-dynamic'

// GET /api/sales/detail?id=... — full invoice with items
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'sales')
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    const invoiceNo = url.searchParams.get('invoiceNo')
    if (!id && !invoiceNo) return fail(400, 'VALIDATION', 'Sale id or invoiceNo required.')
    const sale = await db.sale.findFirst({
      where: { businessId: ctx.businessId, ...(id ? { id } : { invoiceNo: invoiceNo! }) },
      include: { items: true, customer: true, returns: true },
    })
    if (!sale) return fail(404, 'NOT_FOUND', 'Sale not found.')
    return ok(sale)
  } catch (e) {
    return handleError(e)
  }
}
