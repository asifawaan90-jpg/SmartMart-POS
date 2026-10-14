import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, fail, handleError, readBody, requirePerm, requireActiveSub, audit,
  num, r2, ApiError, clientIp, requireStr,
} from '@/lib/api'

export const dynamic = 'force-dynamic'

// GET /api/suppliers?search=
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'suppliers')
    const search = new URL(req.url).searchParams.get('search')?.trim() || ''
    const where: Record<string, unknown> = { businessId: ctx.businessId }
    if (search) where.OR = [{ name: { contains: search } }, { phone: { contains: search } }, { company: { contains: search } }]
    const suppliers = await db.supplier.findMany({ where, orderBy: { name: 'asc' }, take: 1000 })
    const txns = await db.supplierTransaction.groupBy({
      by: ['supplierId'], where: { businessId: ctx.businessId }, _sum: { amount: true },
    })
    const balMap = new Map(txns.map(t => [t.supplierId, t._sum.amount || 0]))
    const items = suppliers.map(s => ({ ...s, payable: r2((balMap.get(s.id) || 0) + s.openingBalance) }))
    return ok(items)
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/suppliers
export async function POST(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'suppliers')
    await requireActiveSub(ctx)
    const b = await readBody<Record<string, unknown>>(req)
    const name = requireStr(b.name, 'Supplier name', 120)
    const phone = typeof b.phone === 'string' ? b.phone.trim().slice(0, 20) : ''
    if (phone) {
      const dup = await db.supplier.findFirst({ where: { businessId: ctx.businessId, phone } })
      if (dup) throw new ApiError(409, 'DUPLICATE', `Phone already used by "${dup.name}".`)
    }
    const opening = r2(num(b.openingBalance))
    const supplier = await db.$transaction(async (tx) => {
      const s = await tx.supplier.create({
        data: {
          businessId: ctx.businessId, name, phone,
          company: typeof b.company === 'string' ? b.company.slice(0, 120) : '',
          address: typeof b.address === 'string' ? b.address.slice(0, 300) : '',
          openingBalance: opening,
          notes: typeof b.notes === 'string' ? b.notes.slice(0, 300) : '',
        },
      })
      if (opening > 0) {
        await tx.supplierTransaction.create({
          data: {
            businessId: ctx.businessId, supplierId: s.id, type: 'OPENING',
            amount: opening, balanceAfter: opening, refNo: 'OPENING',
            note: 'Opening payable', userId: ctx.user.uid,
          },
        })
      }
      return s
    })
    await audit(ctx.businessId, ctx.user.uid, 'SUPPLIER_CREATED', 'Supplier', supplier.id, { name }, clientIp(req))
    return ok(supplier, 201)
  } catch (e) {
    return handleError(e)
  }
}

// PUT /api/suppliers?id=
export async function PUT(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'suppliers')
    await requireActiveSub(ctx)
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return fail(400, 'VALIDATION', 'id required.')
    const existing = await db.supplier.findFirst({ where: { id, businessId: ctx.businessId } })
    if (!existing) return fail(404, 'NOT_FOUND', 'Supplier not found.')
    const b = await readBody<Record<string, unknown>>(req)
    const data: Record<string, unknown> = {}
    if (b.name != null) data.name = requireStr(b.name, 'Supplier name', 120)
    if (b.company !== undefined) data.company = String(b.company || '').slice(0, 120)
    if (b.phone !== undefined) data.phone = String(b.phone || '').trim().slice(0, 20)
    if (b.address !== undefined) data.address = String(b.address || '').slice(0, 300)
    if (b.notes !== undefined) data.notes = String(b.notes || '').slice(0, 300)
    if (b.isActive !== undefined) data.isActive = b.isActive === true
    const supplier = await db.supplier.update({ where: { id }, data })
    await audit(ctx.businessId, ctx.user.uid, 'SUPPLIER_UPDATED', 'Supplier', id, { name: supplier.name }, clientIp(req))
    return ok(supplier)
  } catch (e) {
    return handleError(e)
  }
}
