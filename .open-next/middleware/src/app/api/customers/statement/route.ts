import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail, handleError, requirePerm, r2 } from '@/lib/api'
import { bizDayStart, bizDayEnd } from '@/lib/bizday' // Task 71 — day filters use BUSINESS days (PKT), not UTC

export const dynamic = 'force-dynamic'

// GET /api/customers/statement?customerId=&from=YYYY-MM-DD&to=YYYY-MM-DD
// — khata statement; from/to optional (local-day bounds, same convention as /api/reports).
// Returns filtered txns + brought-forward balance (running balance before `from`) +
// period debit/credit + overall totals.
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'khata')
    const url = new URL(req.url)
    const customerId = url.searchParams.get('customerId')
    if (!customerId) return fail(400, 'VALIDATION', 'customerId required.')
    const customer = await db.customer.findFirst({ where: { id: customerId, businessId: ctx.businessId } })
    if (!customer) return fail(404, 'NOT_FOUND', 'Customer not found.')

    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const range = from || to
      ? {
          ...(from ? { gte: bizDayStart(from) } : {}),
          ...(to ? { lte: bizDayEnd(to) } : {}),
        }
      : undefined

    const txns = await db.customerTransaction.findMany({
      where: { businessId: ctx.businessId, customerId, ...(range ? { createdAt: range } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 500,
    })

    // Brought forward: running balance just before the range starts.
    // (Post-migration: balanceAfter chains start from customer.openingBalance.)
    let opening = customer.openingBalance
    if (from) {
      const prev = await db.customerTransaction.findFirst({
        where: { businessId: ctx.businessId, customerId, createdAt: { lt: bizDayStart(from) } },
        orderBy: { createdAt: 'desc' },
        select: { balanceAfter: true },
      })
      if (prev) opening = prev.balanceAfter
    }

    const periodDebit = r2(txns.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0))
    const periodCredit = r2(txns.filter(t => t.amount < 0).reduce((s, t) => s - t.amount, 0))
    const allTxns = await db.customerTransaction.aggregate({
      where: { businessId: ctx.businessId, customerId },
      _sum: { amount: true },
    })
    const totalDue = r2((allTxns._sum.amount || 0) + customer.openingBalance)
    const overdueCutoff = Date.now() - 30 * 86400000
    const overdueAgg = await db.customerTransaction.aggregate({
      where: { businessId: ctx.businessId, customerId, amount: { gt: 0 }, createdAt: { lt: new Date(overdueCutoff) } },
      _sum: { amount: true },
    })
    const overdue = r2(overdueAgg._sum.amount || 0)
    const paidAgg = await db.customerTransaction.aggregate({
      where: { businessId: ctx.businessId, customerId, amount: { lt: 0 } },
      _sum: { amount: true },
    })
    const paid = r2(-(paidAgg._sum.amount || 0))

    return ok({
      customer,
      txns,
      opening,
      summary: {
        totalDue, overdue, paid, balance: totalDue,
        periodDebit, periodCredit,
        hasRange: Boolean(from || to),
        from: from || '', to: to || '',
      },
    })
  } catch (e) {
    return handleError(e)
  }
}
