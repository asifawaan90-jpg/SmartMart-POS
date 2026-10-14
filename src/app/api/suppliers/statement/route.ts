import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail, handleError, requirePerm, r2 } from '@/lib/api'

export const dynamic = 'force-dynamic'

// GET /api/suppliers/statement?supplierId=
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'suppliers')
    const supplierId = new URL(req.url).searchParams.get('supplierId')
    if (!supplierId) return fail(400, 'VALIDATION', 'supplierId required.')
    const supplier = await db.supplier.findFirst({ where: { id: supplierId, businessId: ctx.businessId } })
    if (!supplier) return fail(404, 'NOT_FOUND', 'Supplier not found.')
    const txns = await db.supplierTransaction.findMany({
      where: { businessId: ctx.businessId, supplierId },
      orderBy: { createdAt: 'desc' },
      take: 500,
    })
    const payable = r2(txns.reduce((s, t) => s + t.amount, 0) + supplier.openingBalance)
    return ok({ supplier, txns, summary: { payable } })
  } catch (e) {
    return handleError(e)
  }
}
