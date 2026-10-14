import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail, handleError, readBody, requirePerm, requireActiveSub, num } from '@/lib/api'

export const dynamic = 'force-dynamic'

// GET /api/sales/hold — list held sales for business
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'pos')
    const items = await db.heldSale.findMany({
      where: { businessId: ctx.businessId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    return ok(items)
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/sales/hold — hold current cart
export async function POST(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'pos')
    await requireActiveSub(ctx)
    const b = await readBody<{ label?: string; customerId?: string | null; cart: unknown }>(req)
    const held = await db.heldSale.create({
      data: {
        businessId: ctx.businessId,
        label: (b.label || `Held ${new Date().toLocaleTimeString()}`).slice(0, 80),
        customerId: b.customerId || null,
        cart: JSON.stringify(b.cart || []),
        userId: ctx.user.uid,
      },
    })
    return ok(held, 201)
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/sales/hold?id=
export async function DELETE(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'pos')
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return fail(400, 'VALIDATION', 'id required.')
    const held = await db.heldSale.findFirst({ where: { id, businessId: ctx.businessId } })
    if (!held) return fail(404, 'NOT_FOUND', 'Held sale not found.')
    await db.heldSale.delete({ where: { id } })
    void num
    return ok({ id })
  } catch (e) {
    return handleError(e)
  }
}
