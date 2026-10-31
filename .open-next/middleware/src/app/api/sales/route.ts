import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, fail, handleError, readBody, requirePerm, requireActiveSub, audit,
  num, r2, ApiError, clientIp,
} from '@/lib/api'
import { createSale, type SaleInput } from '@/lib/sale-service'
import { maybeAutoBackup } from '@/lib/backup-auto'
import { bizDayStart, bizDayEnd } from '@/lib/bizday' // Task 71 — day filters use BUSINESS days (PKT), not UTC

export const dynamic = 'force-dynamic'

// GET /api/sales?search=&customerId=&from=&to=&page=&pageSize=
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'sales')
    const url = new URL(req.url)
    const search = url.searchParams.get('search')?.trim() || ''
    const customerId = url.searchParams.get('customerId') || ''
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const page = Math.max(1, num(url.searchParams.get('page'), 1))
    const pageSize = Math.min(100, Math.max(5, num(url.searchParams.get('pageSize'), 20)))

    const where: Record<string, unknown> = { businessId: ctx.businessId }
    if (customerId) where.customerId = customerId
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: bizDayStart(from) } : {}),
        ...(to ? { lte: bizDayEnd(to) } : {}),
      }
    }
    if (search) where.invoiceNo = { contains: search }

    const [items, total] = await Promise.all([
      db.sale.findMany({
        where,
        include: { customer: { select: { name: true, phone: true } }, _count: { select: { items: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.sale.count({ where }),
    ])
    return ok({ items, total, page, pageSize })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/sales — POS checkout (idempotent via clientRef)
export async function POST(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'pos')
    const sub = await requireActiveSub(ctx)
    const input = await readBody<SaleInput>(req)
    const settings = await db.setting.findUnique({ where: { businessId: ctx.businessId } })
    const prefix = settings ? (JSON.parse(settings.data)?.invoice?.prefix ?? 'INV-') : 'INV-'
    const sale = await createSale({
      businessId: ctx.businessId,
      userId: ctx.user.uid,
      cashierName: ctx.user.name,
      input,
      prefix,
    })
    if (!sale.duplicate) {
      await audit(ctx.businessId, ctx.user.uid, 'SALE_CREATED', 'Sale', sale.id, { invoiceNo: sale.invoiceNo, total: sale.total }, clientIp(req))
      void maybeAutoBackup(ctx.businessId, ctx.user, 'sale saved', { invoiceNo: sale.invoiceNo, total: sale.total })
    }
    void sub
    return ok(sale, sale.duplicate ? 200 : 201)
  } catch (e) {
    return handleError(e)
  }
}
void r2; void ApiError
