import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, fail, handleError, readBody, requirePerm, requireActiveSub, audit,
  num, r2, ApiError, clientIp,
} from '@/lib/api'
import { createPurchase } from '@/lib/purchase-service'
import { maybeAutoBackup } from '@/lib/backup-auto'

export const dynamic = 'force-dynamic'

// GET /api/purchases?search=&supplierId=&from=&to=&page=
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'purchases')
    const url = new URL(req.url)
    const search = url.searchParams.get('search')?.trim() || ''
    const supplierId = url.searchParams.get('supplierId') || ''
    const page = Math.max(1, num(url.searchParams.get('page'), 1))
    const pageSize = Math.min(100, Math.max(5, num(url.searchParams.get('pageSize'), 20)))
    const where: Record<string, unknown> = { businessId: ctx.businessId }
    if (supplierId) where.supplierId = supplierId
    if (search) where.invoiceNo = { contains: search }
    const [items, total] = await Promise.all([
      db.purchase.findMany({
        where,
        include: { supplier: { select: { name: true } }, _count: { select: { items: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.purchase.count({ where }),
    ])
    return ok({ items, total, page, pageSize })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/purchases — save purchase; increases inventory + supplier payable + updates avg cost
export async function POST(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'purchases')
    await requireActiveSub(ctx)
    const b = await readBody<{
      clientRef?: string; supplierId?: string | null; items: { productId: string; quantity: number; unitCost: number; discount?: number }[]
      discount?: number; tax?: number; paid?: number; note?: string
    }>(req)
    const result = await createPurchase({ businessId: ctx.businessId, userId: ctx.user.uid, input: b })
    if (!result.duplicate) {
      await audit(ctx.businessId, ctx.user.uid, 'PURCHASE_CREATED', 'Purchase', result.id, { invoiceNo: result.invoiceNo, total: result.total }, clientIp(req))
      void maybeAutoBackup(ctx.businessId, ctx.user, 'purchase saved', { invoiceNo: result.invoiceNo, total: result.total })
    }
    return ok({ id: result.id, invoiceNo: result.invoiceNo, duplicate: result.duplicate }, result.duplicate ? 200 : 201)
  } catch (e) {
    return handleError(e)
  }
}

// GET single purchase detail: /api/purchases?id=
// handled via query param in GET above? Provide detail via ?id=
export async function PUT(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'purchases')
    await requireActiveSub(ctx)
    const b = await readBody<{ purchaseId: string; amount: number }>(req)
    const amount = r2(num(b.amount))
    if (amount <= 0) throw new ApiError(400, 'VALIDATION', 'Amount must be positive.')
    const purchase = await db.purchase.findFirst({ where: { id: b.purchaseId, businessId: ctx.businessId } })
    if (!purchase) return fail(404, 'NOT_FOUND', 'Purchase not found.')
    if (purchase.dueAmount <= 0) throw new ApiError(400, 'VALIDATION', 'This purchase is already fully paid.')
    const pay = r2(Math.min(amount, purchase.dueAmount))
    await db.$transaction(async (tx) => {
      await tx.purchase.update({ where: { id: purchase.id }, data: { paid: r2(purchase.paid + pay), dueAmount: r2(purchase.dueAmount - pay) } })
      if (purchase.supplierId) {
        const agg = await tx.supplierTransaction.aggregate({ where: { businessId: ctx.businessId, supplierId: purchase.supplierId }, _sum: { amount: true } })
        const sup = await tx.supplier.findUnique({ where: { id: purchase.supplierId } })
        const balBefore = r2((agg._sum.amount || 0) + (sup?.openingBalance || 0))
        await tx.supplierTransaction.create({
          data: {
            businessId: ctx.businessId, supplierId: purchase.supplierId, type: 'PAYMENT',
            amount: -pay, balanceAfter: r2(balBefore - pay),
            refType: 'Purchase', refId: purchase.id, refNo: purchase.invoiceNo,
            note: `Payment for ${purchase.invoiceNo}`, userId: ctx.user.uid,
          },
        })
      }
    })
    await audit(ctx.businessId, ctx.user.uid, 'SUPPLIER_PAYMENT', 'Purchase', purchase.id, { invoiceNo: purchase.invoiceNo, amount: pay }, clientIp(req))
    void maybeAutoBackup(ctx.businessId, ctx.user, 'supplier payment saved', { invoiceNo: purchase.invoiceNo, amount: pay })
    return ok({ paid: pay })
  } catch (e) {
    return handleError(e)
  }
}
