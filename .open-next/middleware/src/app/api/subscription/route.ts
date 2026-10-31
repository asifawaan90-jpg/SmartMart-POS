import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, fail, handleError, readBody, requireAuth, audit, clientIp,
  getSubscription, r2, requireStr, ApiError,
} from '@/lib/api'

export const dynamic = 'force-dynamic'

// GET /api/subscription — current subscription + public plans + payment history
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth(req)
    if (!ctx.businessId) return fail(400, 'BAD_REQUEST', 'Platform admin has no subscription.')
    const [sub, plans, payments, notifications] = await Promise.all([
      getSubscription(ctx.businessId),
      db.subscriptionPlan.findMany({ where: { isPublic: true, isActive: true, code: { not: 'TRIAL' } }, orderBy: { price: 'asc' } }),
      db.subscriptionPayment.findMany({ where: { businessId: ctx.businessId }, orderBy: { createdAt: 'desc' }, take: 20 }),
      db.notification.findMany({ where: { businessId: ctx.businessId }, orderBy: { createdAt: 'desc' }, take: 15 }),
    ])
    return ok({ subscription: sub, plans, payments, notifications })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/subscription — submit a payment request for a plan
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireAuth(req)
    if (!ctx.businessId) return fail(400, 'BAD_REQUEST', 'Platform admin has no subscription.')
    const b = await readBody<{ planId: string; method?: string; reference?: string; note?: string }>(req)
    const plan = await db.subscriptionPlan.findUnique({ where: { id: requireStr(b.planId, 'Plan', 64) } })
    if (!plan || !plan.isActive) throw new ApiError(400, 'VALIDATION', 'Selected plan is unavailable.')
    const payment = await db.subscriptionPayment.create({
      data: {
        businessId: ctx.businessId, planId: plan.id, amount: r2(plan.price),
        method: typeof b.method === 'string' ? b.method.slice(0, 40) : 'BANK_TRANSFER',
        reference: typeof b.reference === 'string' ? b.reference.slice(0, 120) : '',
        note: typeof b.note === 'string' ? b.note.slice(0, 300) : '',
        status: 'PENDING',
      },
    })
    const biz = await db.business.findUnique({ where: { id: ctx.businessId } })
    await db.notification.create({
      data: {
        businessId: ctx.businessId, type: 'SUBSCRIPTION', emailTo: biz?.email || '',
        title: 'Payment submitted',
        body: `Your payment of ${plan.price} ${plan.name} (${payment.method}) is pending approval.`,
      },
    })
    await audit(ctx.businessId, ctx.user.uid, 'SUBSCRIPTION_PAYMENT_SUBMITTED', 'SubscriptionPayment', payment.id, { plan: plan.code, amount: plan.price }, clientIp(req))
    return ok({ id: payment.id, status: payment.status }, 201)
  } catch (e) {
    return handleError(e)
  }
}
