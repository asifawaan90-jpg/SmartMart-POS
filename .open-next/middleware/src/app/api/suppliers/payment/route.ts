import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, fail, handleError, readBody, requirePerm, requireActiveSub, audit,
  num, r2, ApiError, clientIp,
} from '@/lib/api'

export const dynamic = 'force-dynamic'

// POST /api/suppliers/payment?supplierId= — pay supplier { amount, note }
export async function POST(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'purchases')
    await requireActiveSub(ctx)
    const supplierId = new URL(req.url).searchParams.get('supplierId')
    if (!supplierId) throw new ApiError(400, 'VALIDATION', 'supplierId required.')
    const b = await readBody<{ amount: number; note?: string }>(req)
    const amount = r2(num(b.amount))
    if (amount <= 0) throw new ApiError(400, 'VALIDATION', 'Amount must be greater than zero.')

    const result = await db.$transaction(async (tx) => {
      const supplier = await tx.supplier.findFirst({ where: { id: supplierId, businessId: ctx.businessId } })
      if (!supplier) throw new ApiError(404, 'NOT_FOUND', 'Supplier not found.')
      const agg = await tx.supplierTransaction.aggregate({ where: { businessId: ctx.businessId, supplierId }, _sum: { amount: true } })
      const balanceBefore = r2((agg._sum.amount || 0) + supplier.openingBalance)
      const payNo = `PAY-S-${Date.now().toString(36).toUpperCase()}`
      const txn = await tx.supplierTransaction.create({
        data: {
          businessId: ctx.businessId, supplierId, type: 'PAYMENT',
          amount: -amount, balanceAfter: r2(balanceBefore - amount),
          refType: 'Manual', refNo: payNo,
          note: (b.note || 'Supplier payment').slice(0, 300), userId: ctx.user.uid,
        },
      })
      return { txn, supplier }
    })

    await audit(ctx.businessId, ctx.user.uid, 'SUPPLIER_PAYMENT', 'Supplier', supplierId,
      { amount, supplier: result.supplier.name }, clientIp(req))
    return ok(result.txn, 201)
  } catch (e) {
    return handleError(e)
  }
}
