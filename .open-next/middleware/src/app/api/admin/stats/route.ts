import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, handleError, num } from '@/lib/api'

export const dynamic = 'force-dynamic'

// GET /api/admin/stats — platform owner KPIs
export async function GET(req: NextRequest) {
  try {
    const { requireSuperAdmin } = await import('@/lib/admin')
    await requireSuperAdmin(req)

    const now = new Date()
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    const [totalBusinesses, activeSubs, trialSubs, expiredSubs, suspended, lifetimeSubs, revenueAgg, newThisMonth, expiringSoon, pendingPayments] = await Promise.all([
      db.business.count(),
      db.subscription.count({ where: { status: 'ACTIVE' } }),
      db.subscription.count({ where: { status: 'TRIAL' } }),
      db.subscription.count({ where: { status: 'EXPIRED' } }),
      db.subscription.count({ where: { status: 'SUSPENDED' } }),
      db.subscription.count({ where: { status: 'LIFETIME' } }),
      db.subscriptionPayment.aggregate({ where: { status: 'APPROVED' }, _sum: { amount: true } }),
      db.business.count({ where: { createdAt: { gte: startMonth } } }),
      db.subscription.findMany({
        where: { status: { in: ['TRIAL', 'ACTIVE'] }, endDate: { not: null } },
        select: { endDate: true, status: true, business: { select: { name: true, email: true } } },
      }),
      db.subscriptionPayment.count({ where: { status: 'PENDING' } }),
    ])

    const todayRevenueAgg = await db.subscriptionPayment.aggregate({
      where: { status: 'APPROVED', reviewedAt: { gte: startToday } }, _sum: { amount: true },
    })

    const expiring = expiringSoon
      .filter(s => s.endDate && new Date(s.endDate).getTime() - now.getTime() < 7 * 86400000)
      .map(s => ({ business: s.business, status: s.status, endDate: s.endDate }))

    // registration trend (30 days)
    const businesses = await db.business.findMany({
      where: { createdAt: { gte: new Date(now.getTime() - 30 * 86400000) } },
      select: { createdAt: true },
    })
    const dayMap = new Map<string, number>()
    for (let i = 0; i < 30; i++) {
      const d = new Date(now.getTime() - (29 - i) * 86400000)
      dayMap.set(d.toISOString().slice(0, 10), 0)
    }
    for (const b of businesses) {
      const k = b.createdAt.toISOString().slice(0, 10)
      if (dayMap.has(k)) dayMap.set(k, (dayMap.get(k) || 0) + 1)
    }
    const trend = [...dayMap.entries()].map(([date, count]) => ({ date, count }))

    return ok({
      cards: {
        totalBusinesses,
        activeSubs, trialSubs, expiredSubs, suspended, lifetimeSubs,
        revenue: num(revenueAgg._sum.amount),
        todayRevenue: num(todayRevenueAgg._sum.amount),
        newThisMonth,
        pendingPayments,
      },
      expiring,
      trend,
    })
  } catch (e) {
    return handleError(e)
  }
}
