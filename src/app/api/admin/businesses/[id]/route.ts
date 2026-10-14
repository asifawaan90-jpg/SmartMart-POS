import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail, handleError, readBody, clientIp, audit, ApiError } from '@/lib/api'
import { requireSuperAdmin } from '@/lib/admin'
import { appendJournal } from '@/lib/journal'

export const dynamic = 'force-dynamic'

const sameInstant = (a?: Date | string | null, b?: Date | string | null) =>
  (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null)

// GET /api/admin/businesses/[id] — subscription change history for the Manage
// dialog (Task 57): whenever a plan/date "mysteriously" changes, the owner can
// SEE which action changed it and when instead of suspecting data loss.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSuperAdmin(req)
    const id = (await params).id || new URL(req.url).searchParams.get('id')
    if (!id) return fail(400, 'VALIDATION', 'Business id required.')
    // business-scoped audits (TRIAL_STARTED / payment submitted / admin plan actions)
    const own = await db.auditLog.findMany({
      where: {
        OR: [
          { businessId: id, action: { in: ['TRIAL_STARTED', 'SUBSCRIPTION_PAYMENT_SUBMITTED'] } },
          { businessId: null, entity: 'Business', entityId: id, action: 'ADMIN_SUBSCRIPTION_ACTION' },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 12,
    })
    // payment reviews are audited with businessId null — scope them through
    // this business's payment ids so no other business's events can leak in
    const payIds = (
      await db.subscriptionPayment.findMany({ where: { businessId: id }, select: { id: true }, take: 20 })
    ).map(p => p.id)
    const reviews = payIds.length
      ? await db.auditLog.findMany({
          where: { entity: 'SubscriptionPayment', entityId: { in: payIds }, action: { startsWith: 'ADMIN_PAYMENT' } },
          orderBy: { createdAt: 'desc' },
          take: 12,
        })
      : []
    const merged = [...own, ...reviews]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 12)
      .map(e => ({ at: e.createdAt.toISOString(), action: e.action, details: e.details || '' }))
    return ok(merged)
  } catch (e) { return handleError(e) }
}

// PATCH /api/admin/businesses/[id] — activate/deactivate/suspend/extend/change plan
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireSuperAdmin(req)
    const id = (await params).id || new URL(req.url).searchParams.get('id')
    if (!id) return fail(400, 'VALIDATION', 'Business id required.')
    const b = await readBody<{ action: string; days?: number; planId?: string }>(req)
    const business = await db.business.findUnique({ where: { id }, include: { subscription: true } })
    if (!business) return fail(404, 'NOT_FOUND', 'Business not found.')
    if (!business.subscription) throw new ApiError(400, 'VALIDATION', 'Business has no subscription record.')

    let sub = business.subscription
    // Task 55 — a no-op action must not touch the row at all: re-applying the
    // package a user already runs keeps the dates EXACTLY as applied — no
    // silent reset, not even an updatedAt bump.
    let changed = true
    switch (b.action) {
      case 'activate': {
        // Task 55 — re-enable the service WITHOUT rewriting the applied dates:
        // the old code reset endDate to now + duration on every activate, so
        // re-activating a suspended business silently moved its paid end date.
        // A fresh period is granted ONLY when the old one is already over.
        // Task 47 — a TRIAL-plan business still comes back as TRIAL (not
        // ACTIVE): the "Trial Users" stat, the tenant trial banner and the
        // auto-expire all key off status === 'TRIAL'.
        const plan = await db.subscriptionPlan.findUnique({ where: { id: sub.planId } })
        // Task 57 — a period is only granted from the plan's REAL duration; a
        // plan without a valid duration can never silently become "30 days".
        const periodRunning = sub.endDate ? new Date(sub.endDate).getTime() > Date.now() : false
        if (plan?.code !== 'LIFETIME' && !(plan?.durationDays && plan.durationDays > 0) && !periodRunning) {
          throw new ApiError(400, 'VALIDATION', `Plan ${plan?.code || '?'} has no duration set — extend the subscription manually, then activate.`)
        }
        const nextStatus = plan?.code === 'LIFETIME' ? 'LIFETIME' : plan?.code === 'TRIAL' ? 'TRIAL' : 'ACTIVE'
        const nextEnd = plan?.code === 'LIFETIME'
          ? null
          : periodRunning
            ? sub.endDate
            : new Date(Date.now() + (plan?.durationDays as number) * 86400000)
        if (nextStatus === sub.status && sameInstant(nextEnd, sub.endDate)) {
          changed = false
        } else {
          sub = await db.subscription.update({
            where: { id: sub.id },
            data: { status: nextStatus, endDate: nextEnd },
          })
        }
        break
      }
      case 'suspend':
        sub = await db.subscription.update({ where: { id: sub.id }, data: { status: 'SUSPENDED' } })
        break
      case 'deactivate':
        sub = await db.subscription.update({ where: { id: sub.id }, data: { status: 'DEACTIVATED' } })
        break
      case 'set_expired':
        sub = await db.subscription.update({ where: { id: sub.id }, data: { status: 'EXPIRED' } })
        break
      case 'extend': {
        // Task 57 — explicit days only: no silent +30 default at the API layer.
        const days = Math.floor(Number(b.days))
        if (!Number.isFinite(days) || days < 1) throw new ApiError(400, 'VALIDATION', 'days must be a positive number.')
        const base = sub.endDate && new Date(sub.endDate).getTime() > Date.now() ? new Date(sub.endDate) : new Date()
        sub = await db.subscription.update({
          where: { id: sub.id },
          data: { status: 'ACTIVE', endDate: new Date(base.getTime() + days * 86400000) },
        })
        break
      }
      case 'change_plan': {
        if (!b.planId) throw new ApiError(400, 'VALIDATION', 'planId required.')
        const plan = await db.subscriptionPlan.findUnique({ where: { id: b.planId } })
        if (!plan) throw new ApiError(404, 'NOT_FOUND', 'Plan not found.')
        // Task 47 — TRIAL is a real service state, not just a price: assigning
        // the trial plan now sets status TRIAL with a FRESH clock (now + trial
        // duration), so re-granting a trial to an expired/active business
        // visibly works and stays consistent everywhere (panel badge, Trial
        // Users stat, tenant trial banner, auto-expiry at end of trial).
        const nextStatus =
          plan.code === 'LIFETIME' ? 'LIFETIME'
          : plan.code === 'TRIAL' ? 'TRIAL'
          : sub.status === 'TRIAL' || sub.status === 'EXPIRED' ? 'ACTIVE'
          : sub.status
        // Task 55 — THE HEADLINE FIX ("subscription date changed"): re-applying
        // the SAME paid plan while its period is still running used to reset
        // endDate to now + duration, silently deleting every day the user had
        // already applied/paid for (18 days lost in the live repro). The
        // applied date is now sacred: re-selecting the running package is a
        // NO-OP (returned as changed:false — the UI confirms "dates kept").
        // Only a DIFFERENT package starts a fresh clock from now, matching the
        // payment-approval route; same-plan renewals stack there because real
        // money was approved.
        const samePaidPlanRunning =
          sub.planId === plan.id && plan.code !== 'TRIAL' &&
          !!sub.endDate && new Date(sub.endDate).getTime() > Date.now()
        const nextEnd =
          plan.code === 'LIFETIME' ? null
          : samePaidPlanRunning ? sub.endDate
          : plan.durationDays > 0 ? new Date(Date.now() + plan.durationDays * 86400000)
          : sub.endDate
        if (sub.planId === plan.id && nextStatus === sub.status && sameInstant(nextEnd, sub.endDate)) {
          changed = false
        } else {
          sub = await db.subscription.update({
            where: { id: sub.id },
            data: { planId: plan.id, status: nextStatus, endDate: nextEnd },
          })
        }
        break
      }
      case 'set_active_flag':
        await db.business.update({ where: { id }, data: { isActive: b.days === 1 } })
        break
      default:
        throw new ApiError(400, 'VALIDATION', 'Unknown action.')
    }

    const savedPlan = await db.subscriptionPlan.findUnique({ where: { id: sub.planId } })
    const subPayload = { status: sub.status, planCode: savedPlan?.code || '', endDate: sub.endDate }
    if (!changed) {
      // Task 55 — nothing was modified: no notification, no audit write, no
      // row touch. The owner gets an honest "already applied — dates kept".
      return ok({ changed: false, subscription: subPayload })
    }
    // Task 61 — journal the owner's saved subscription OUTSIDE the db file:
    // if the db ever rolls back to an older copy, the boot replay re-applies
    // this exact state instead of letting the revert win.
    appendJournal({
      kind: 'SUB', subId: sub.id, businessId: id, action: b.action,
      status: sub.status, planId: sub.planId,
      endDate: sub.endDate ? new Date(sub.endDate).toISOString() : null,
    })
    await db.notification.create({
      data: {
        businessId: id, type: 'SUBSCRIPTION', emailTo: business.email,
        title: `Subscription ${sub.status}`,
        // Task 55 — unambiguous ISO date: a server-locale string (e.g.
        // "10/20/2026") could disagree by a day with the browser-local dates
        // shown in the app and read as "the date changed again".
        body: `Your plan is now: ${savedPlan?.name || sub.status} (${sub.status})${sub.endDate ? ` — valid until ${new Date(sub.endDate).toISOString().slice(0, 10)}` : ''}.`,
      },
    })
    await audit(null, admin.uid, 'ADMIN_SUBSCRIPTION_ACTION', 'Business', id, { action: b.action, plan: savedPlan?.code || '', status: sub.status, endDate: sub.endDate ? new Date(sub.endDate).toISOString() : null }, clientIp(req))
    return ok({ changed: true, subscription: subPayload })
  } catch (e) {
    return handleError(e)
  }
}
