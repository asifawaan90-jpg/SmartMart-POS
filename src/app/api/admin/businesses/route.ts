import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, handleError, num } from '@/lib/api'
import { requireSuperAdmin } from '@/lib/admin'

export const dynamic = 'force-dynamic'

// GET /api/admin/businesses?search=&status=
export async function GET(req: NextRequest) {
  try {
    await requireSuperAdmin(req)
    const url = new URL(req.url)
    const search = url.searchParams.get('search')?.trim() || ''
    const status = url.searchParams.get('status') || ''
    const where = search
      ? { OR: [{ name: { contains: search } }, { email: { contains: search } }, { ownerName: { contains: search } }] }
      : {}
    const businesses = await db.business.findMany({
      where,
      include: {
        subscription: { include: { plan: true } },
        users: { select: { id: true, role: true, lastLoginAt: true }, take: 1 },
        _count: { select: { users: true, products: true, sales: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    })

    // Task 49 — ISP auto-expire convergence: the panel must show the TRUE
    // service state. A past-due TRIAL/ACTIVE subscription is already expired
    // at tenant login (getSubscription flips it), but the raw DB row kept
    // showing ACTIVE/TRIAL here — the owner saw an emerald "ACTIVE" badge with
    // "0d left", read it as "the plan didn't save", while the tenant hit the
    // expired wall on their next login. Persist the flip so the DB, this list,
    // the stats cards and tenant logins all agree from the first panel load.
    const nowMs = Date.now()
    const staleSubIds = businesses
      .filter(b => b.subscription
        && (b.subscription.status === 'TRIAL' || b.subscription.status === 'ACTIVE')
        && b.subscription.endDate && new Date(b.subscription.endDate).getTime() < nowMs)
      .map(b => b.subscription!.id)
    if (staleSubIds.length) {
      await db.subscription.updateMany({ where: { id: { in: staleSubIds } }, data: { status: 'EXPIRED' } })
      for (const b of businesses) {
        if (b.subscription && staleSubIds.includes(b.subscription.id)) b.subscription.status = 'EXPIRED'
      }
    }

    let items = businesses.map(b => ({
      id: b.id, name: b.name, ownerName: b.ownerName, email: b.email, phone: b.phone,
      isActive: b.isActive, createdAt: b.createdAt,
      users: b._count.users, products: b._count.products, sales: b._count.sales,
      subscription: b.subscription && {
        id: b.subscription.id, status: b.subscription.status,
        planName: b.subscription.plan?.name || '', planCode: b.subscription.plan?.code || '',
        price: b.subscription.plan?.price || 0,
        startDate: b.subscription.startDate, endDate: b.subscription.endDate,
        daysRemaining: b.subscription.endDate
          ? Math.max(0, Math.ceil((new Date(b.subscription.endDate).getTime() - Date.now()) / 86400000))
          : null,
      },
      lastLogin: b.users[0]?.lastLoginAt || null,
    }))
    if (status) items = items.filter(i => i.subscription?.status === status)
    void num
    return ok(items)
  } catch (e) {
    return handleError(e)
  }
}
