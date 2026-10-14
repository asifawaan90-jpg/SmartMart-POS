import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, fail, handleError, readBody, requirePerm, requireAuth, requireActiveSub, audit,
  ApiError, requireStr, clientIp,
} from '@/lib/api'

export const dynamic = 'force-dynamic'

const ENTITIES: Record<string, { perm: Parameters<typeof requirePerm>[1]; model: keyof typeof db; label: string }> = {
  categories: { perm: 'products', model: 'category', label: 'Category' },
  brands: { perm: 'products', model: 'brand', label: 'Brand' },
  units: { perm: 'products', model: 'unit', label: 'Unit' },
  'expense-categories': { perm: 'expenses', model: 'expenseCategory', label: 'Expense category' },
}

// GET /api/master/categories
export async function GET(req: NextRequest, { params }: { params: Promise<{ entity: string }> }) {
  try {
    const { entity } = await params
    const spec = ENTITIES[entity]
    if (!spec) return fail(404, 'NOT_FOUND', 'Unknown entity.')
    const ctx = await requireAuth(req)
    const items = await (db[spec.model] as unknown as { findMany: (a: object) => Promise<unknown[]> }).findMany({
      where: { businessId: ctx.businessId },
      orderBy: { name: 'asc' },
    })
    return ok(items)
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/master/categories
export async function POST(req: NextRequest, { params }: { params: Promise<{ entity: string }> }) {
  try {
    const { entity } = await params
    const spec = ENTITIES[entity]
    if (!spec) return fail(404, 'NOT_FOUND', 'Unknown entity.')
    const ctx = await requirePerm(req, spec.perm)
    await requireActiveSub(ctx)
    const b = await readBody<Record<string, unknown>>(req)
    const name = requireStr(b.name, 'Name', 100)
    const model = db[spec.model] as unknown as { create: (a: object) => Promise<unknown> }
    const item = await model.create({ data: { businessId: ctx.businessId, name, ...(spec.model === 'unit' ? { shortName: typeof b.shortName === 'string' ? b.shortName : name } : {}) } })
    await audit(ctx.businessId, ctx.user.uid, `${spec.label.toUpperCase()}_CREATED`, spec.label, '', { name }, clientIp(req))
    return ok(item, 201)
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/master/categories?id=
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ entity: string }> }) {
  try {
    const { entity } = await params
    const spec = ENTITIES[entity]
    if (!spec) return fail(404, 'NOT_FOUND', 'Unknown entity.')
    const ctx = await requirePerm(req, spec.perm)
    await requireActiveSub(ctx)
    const id = new URL(req.url).searchParams.get('id')
    if (!id) throw new ApiError(400, 'VALIDATION', 'id is required.')
    const finder = db[spec.model] as unknown as { findFirst: (a: object) => Promise<{ id: string } | null> }
    const owned = await finder.findFirst({ where: { id, businessId: ctx.businessId } })
    if (!owned) throw new ApiError(404, 'NOT_FOUND', `${spec.label} not found.`)
    const model = db[spec.model] as unknown as { delete: (a: object) => Promise<unknown> }
    try {
      await model.delete({ where: { id } })
    } catch {
      throw new ApiError(409, 'IN_USE', `${spec.label} is in use and cannot be deleted.`)
    }
    await audit(ctx.businessId, ctx.user.uid, `${spec.label.toUpperCase()}_DELETED`, spec.label, id, {}, clientIp(req))
    return ok({ id })
  } catch (e) {
    return handleError(e)
  }
}
