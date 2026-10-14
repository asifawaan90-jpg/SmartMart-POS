import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail, handleError, readBody, clientIp, audit, ApiError } from '@/lib/api'
import { requireSuperAdmin } from '@/lib/admin'
import { appendJournal } from '@/lib/journal'

export const dynamic = 'force-dynamic'

// PATCH /api/admin/payments/[id] — approve/reject subscription payment
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireSuperAdmin(req)
    const id = (await params).id || new URL(req.url).searchParams.get('id')
    if (!id) return fail(400, 'VALIDATION', 'Payment id required.')
    const b = await readBody<{ status: 'APPROVED' | 'REJECTED'; note?: string }>(req)
    if (!['APPROVED', 'REJECTED'].includes(b.status)) throw new ApiError(400, 'VALIDATION', 'Invalid status.')
    const payment = await db.subscriptionPayment.findUnique({ where: { id }, include: { plan: true, business: true } })
    if (!payment) return fail(404, 'NOT_FOUND', 'Payment not found.')
    if (payment.status !== 'PENDING') throw new ApiError(400, 'VALIDATION', 'Payment already reviewed.')

    await db.subscriptionPayment.update({
      where: { id },
      data: { status: b.status, reviewedAt: new Date(), note: (b.note || payment.note).slice(0, 300) },
    })

    if (b.status === 'APPROVED') {
      // Paying the bill turns the service back on (ISP model) — clear any
      // platform-level business deactivation flag as well.
      await db.business.update({ where: { id: payment.businessId }, data: { isActive: true } })
      const sub = await db.subscription.findUnique({ where: { businessId: payment.businessId } })
      if (sub) {
        const plan = payment.plan
        if (plan.code === 'LIFETIME') {
          const updated = await db.subscription.update({ where: { id: sub.id }, data: { planId: plan.id, status: 'LIFETIME', endDate: null } })
          // Task 61 — journal the approved plan so a db rollback can never eat it
          appendJournal({ kind: 'SUB', subId: updated.id, businessId: payment.businessId, action: 'payment_approved', status: updated.status, planId: updated.planId, endDate: null })
        } else {
          // Task 57 — no more silent "30 days" fallback: a plan without a real
          // duration can never be approved into a mystery month. Say no plainly.
          if (!(plan.durationDays > 0)) throw new ApiError(400, 'VALIDATION', `Plan ${plan.code} has no duration set — set its days first, then approve.`)
          const base = sub.endDate && new Date(sub.endDate).getTime() > Date.now() && sub.planId === plan.id ? new Date(sub.endDate) : new Date()
          const updated = await db.subscription.update({
            where: { id: sub.id },
            data: { planId: plan.id, status: 'ACTIVE', endDate: new Date(base.getTime() + plan.durationDays * 86400000) },
          })
          // Task 61 — journal the approved renewal
          appendJournal({ kind: 'SUB', subId: updated.id, businessId: payment.businessId, action: 'payment_approved', status: updated.status, planId: updated.planId, endDate: updated.endDate ? updated.endDate.toISOString() : null })
        }
      }
    }

    await db.notification.create({
      data: {
        businessId: payment.businessId, type: 'SUBSCRIPTION', emailTo: payment.business.email,
        title: `Payment ${b.status.toLowerCase()}`,
        body: `Your payment of ${payment.amount} for ${payment.plan.name} was ${b.status.toLowerCase()}.`,
      },
    })
    await audit(null, admin.uid, b.status === 'APPROVED' ? 'ADMIN_PAYMENT_APPROVED' : 'ADMIN_PAYMENT_REJECTED', 'SubscriptionPayment', id, { amount: payment.amount, plan: payment.plan.code }, clientIp(req))
    return ok({ id, status: b.status })
  } catch (e) {
    return handleError(e)
  }
}
