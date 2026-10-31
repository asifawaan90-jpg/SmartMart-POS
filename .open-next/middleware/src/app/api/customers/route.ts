import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, fail, handleError, readBody, requirePerm, requireActiveSub, audit,
  num, r2, ApiError, clientIp, requireStr,
} from '@/lib/api'

export const dynamic = 'force-dynamic'

// GET /api/customers?search=&withDue=1&page=
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'customers')
    const url = new URL(req.url)
    const search = url.searchParams.get('search')?.trim() || ''
    const withDue = url.searchParams.get('withDue') === '1'
    const where: Record<string, unknown> = { businessId: ctx.businessId }
    if (search) {
      where.OR = [{ name: { contains: search } }, { phone: { contains: search } }]
    }
    const customers = await db.customer.findMany({
      where,
      include: { _count: { select: { sales: true } } },
      orderBy: { name: 'asc' },
      take: 1000,
    })
    // compute balances via grouped aggregation
    const txns = await db.customerTransaction.groupBy({
      by: ['customerId'],
      where: { businessId: ctx.businessId },
      _sum: { amount: true },
    })
    const balMap = new Map(txns.map(t => [t.customerId, t._sum.amount || 0]))
    let items = customers.map(c => ({
      ...c,
      balance: r2((balMap.get(c.id) || 0) + c.openingBalance),
    }))
    if (withDue) items = items.filter(c => c.balance > 0.001)
    return ok(items)
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/customers
export async function POST(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'customers')
    await requireActiveSub(ctx)
    const b = await readBody<Record<string, unknown>>(req)
    const name = requireStr(b.name, 'Customer name', 120)
    const phone = typeof b.phone === 'string' ? b.phone.trim().slice(0, 20) : ''
    if (phone) {
      const dup = await db.customer.findFirst({ where: { businessId: ctx.businessId, phone } })
      if (dup) throw new ApiError(409, 'DUPLICATE', `Phone already used by "${dup.name}".`)
    }
    const opening = r2(num(b.openingBalance))
    // NOTE: openingBalance is carried on the customer FIELD only (single source of truth —
    // every balance formula is Σtxns + openingBalance). No OPENING txn is created; the
    // statement UI renders it as a brought-forward row. (Creating an OPENING txn here used
    // to double-count the opening amount in every due.)
    const customer = await db.customer.create({
      data: {
        businessId: ctx.businessId, name, phone,
        address: typeof b.address === 'string' ? b.address.slice(0, 300) : '',
        openingBalance: opening,
        creditLimit: r2(num(b.creditLimit)),
        notes: typeof b.notes === 'string' ? b.notes.slice(0, 300) : '',
      },
    })
    await audit(ctx.businessId, ctx.user.uid, 'CUSTOMER_CREATED', 'Customer', customer.id, { name }, clientIp(req))
    return ok(customer, 201)
  } catch (e) {
    return handleError(e)
  }
}

// PUT /api/customers?id=
export async function PUT(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'customers')
    await requireActiveSub(ctx)
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return fail(400, 'VALIDATION', 'id required.')
    const existing = await db.customer.findFirst({ where: { id, businessId: ctx.businessId } })
    if (!existing) return fail(404, 'NOT_FOUND', 'Customer not found.')
    const b = await readBody<Record<string, unknown>>(req)
    const data: Record<string, unknown> = {}
    if (b.name != null) data.name = requireStr(b.name, 'Customer name', 120)
    if (b.phone !== undefined) data.phone = String(b.phone || '').trim().slice(0, 20)
    if (b.address !== undefined) data.address = String(b.address || '').slice(0, 300)
    if (b.creditLimit != null) data.creditLimit = r2(num(b.creditLimit))
    if (b.notes !== undefined) data.notes = String(b.notes || '').slice(0, 300)
    if (b.isActive !== undefined) data.isActive = b.isActive === true
    const customer = await db.customer.update({ where: { id }, data })
    await audit(ctx.businessId, ctx.user.uid, 'CUSTOMER_UPDATED', 'Customer', id, { name: customer.name }, clientIp(req))
    return ok(customer)
  } catch (e) {
    return handleError(e)
  }
}
void requirePerm
