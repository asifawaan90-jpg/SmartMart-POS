import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail, handleError, readBody, clientIp, audit, ApiError, r2 } from '@/lib/api'
import { requireSuperAdmin } from '@/lib/admin'

export const dynamic = 'force-dynamic'

// GET /api/admin/plans — all plans (editable)
export async function GET(req: NextRequest) {
  try {
    await requireSuperAdmin(req)
    const plans = await db.subscriptionPlan.findMany({ orderBy: { sortOrder: 'asc' } })
    return ok(plans)
  } catch (e) {
    return handleError(e)
  }
}

// PUT /api/admin/plans?id= — edit plan (price, duration, name, features, limits)
export async function PUT(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req)
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return fail(400, 'VALIDATION', 'Plan id required.')
    const b = await readBody<Record<string, unknown>>(req)
    const plan = await db.subscriptionPlan.findUnique({ where: { id } })
    if (!plan) return fail(404, 'NOT_FOUND', 'Plan not found.')
    const data: Record<string, unknown> = {}
    if (b.name != null) data.name = String(b.name).slice(0, 80)
    if (b.price != null) data.price = r2(Number(b.price) || 0)
    if (b.durationDays != null) {
      // Task 57 — explicit durations only: an emptied editor used to save 0
      // (a plan that can no longer grant a period). A duration is either a
      // whole number of days (>=1) or -1 for "no expiry" — never a silent 0.
      const d = Math.floor(Number(b.durationDays))
      if (!Number.isFinite(d) || (d !== -1 && d < 1)) {
        throw new ApiError(400, 'VALIDATION', 'durationDays must be a whole number of days (at least 1), or -1 for no expiry.')
      }
      data.durationDays = d
    }
    if (b.features !== undefined) data.features = JSON.stringify(Array.isArray(b.features) ? b.features.map(String) : [])
    if (b.limits !== undefined) data.limits = JSON.stringify(typeof b.limits === 'object' && b.limits ? b.limits : {})
    if (b.isActive !== undefined) data.isActive = b.isActive === true
    if (b.isPublic !== undefined) data.isPublic = b.isPublic === true
    const updated = await db.subscriptionPlan.update({ where: { id }, data })
    await audit(null, admin.uid, 'ADMIN_PLAN_UPDATED', 'SubscriptionPlan', id, { code: plan.code, changes: Object.keys(data) }, clientIp(req))
    return ok(updated)
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/admin/plans — create plan
export async function POST(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req)
    const b = await readBody<Record<string, unknown>>(req)
    const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9_]/g, '')
    if (!code) throw new ApiError(400, 'VALIDATION', 'Plan code required.')
    const exists = await db.subscriptionPlan.findUnique({ where: { code } })
    if (exists) throw new ApiError(409, 'DUPLICATE', 'Plan code already exists.')
    const plan = await db.subscriptionPlan.create({
      data: {
        code, name: String(b.name || code).slice(0, 80),
        price: r2(Number(b.price) || 0),
        // Task 57 — new plans also require an explicit duration (no silent
        // 30-day default): the creator must state what the plan grants.
        durationDays: (() => {
          const d = Math.floor(Number(b.durationDays))
          if (!Number.isFinite(d) || (d !== -1 && d < 1)) {
            throw new ApiError(400, 'VALIDATION', 'durationDays must be a whole number of days (at least 1), or -1 for no expiry.')
          }
          return d
        })(),
        features: JSON.stringify(Array.isArray(b.features) ? b.features.map(String) : []),
        limits: JSON.stringify(typeof b.limits === 'object' && b.limits ? b.limits : {}),
        sortOrder: Math.floor(Number(b.sortOrder) || 10),
      },
    })
    await audit(null, admin.uid, 'ADMIN_PLAN_CREATED', 'SubscriptionPlan', plan.id, { code }, clientIp(req))
    return ok(plan, 201)
  } catch (e) {
    return handleError(e)
  }
}
