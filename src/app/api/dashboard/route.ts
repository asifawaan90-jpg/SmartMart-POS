import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, handleError, requirePerm, r2 } from '@/lib/api'
import { getSubscription } from '@/lib/api'

export const dynamic = 'force-dynamic'

// GET /api/dashboard — KPI cards + chart data
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'reports')
    const bid = ctx.businessId
    const now = new Date()
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const endToday = new Date(startToday.getTime() + 86400000)

    const [todaySalesAgg, todayPurchAgg, todayExpAgg, productCount, lowStockCount, customerCount, custDueAgg, supDueAgg, stockValueAgg] = await Promise.all([
      db.sale.aggregate({
        where: { businessId: bid, status: { in: ['COMPLETED', 'PARTIALLY_RETURNED'] }, createdAt: { gte: startToday, lt: endToday } },
        _sum: { total: true, profit: true, paid: true, dueAmount: true }, _count: true,
      }),
      db.purchase.aggregate({
        where: { businessId: bid, createdAt: { gte: startToday, lt: endToday } },
        _sum: { total: true },
      }),
      db.expense.aggregate({
        where: { businessId: bid, expenseDate: { gte: startToday, lt: endToday } },
        _sum: { amount: true },
      }),
      db.product.count({ where: { businessId: bid, isActive: true } }),
      db.product.findMany({ where: { businessId: bid, isActive: true }, select: { stock: true, minStock: true } })
        .then(list => list.filter(p => p.stock <= p.minStock).length),
      db.customer.count({ where: { businessId: bid } }),
      db.customerTransaction.groupBy({ by: ['customerId'], where: { businessId: bid }, _sum: { amount: true } }),
      db.supplierTransaction.groupBy({ by: ['supplierId'], where: { businessId: bid }, _sum: { amount: true } }),
      db.product.findMany({ where: { businessId: bid, isActive: true }, select: { stock: true, costPrice: true } }),
    ])

    // opening balances for dues
    const custs = await db.customer.findMany({ where: { businessId: bid }, select: { id: true, openingBalance: true } })
    const sups = await db.supplier.findMany({ where: { businessId: bid }, select: { id: true, openingBalance: true } })
    const custOpen = new Map(custs.map(c => [c.id, c.openingBalance]))
    const supOpen = new Map(sups.map(s => [s.id, s.openingBalance]))
    const customerDue = r2(custDueAgg.reduce((s, t) => s + (t._sum.amount || 0) + (custOpen.get(t.customerId) || 0), 0))
    const supplierDue = r2(supDueAgg.reduce((s, t) => s + (t._sum.amount || 0) + (supOpen.get(t.supplierId) || 0), 0))
    const stockValue = r2(stockValueAgg.reduce((s, p) => s + p.stock * p.costPrice, 0))

    // 14-day sales + profit trend
    const since = new Date(startToday.getTime() - 13 * 86400000)
    const sales = await db.sale.findMany({
      where: { businessId: bid, status: { in: ['COMPLETED', 'PARTIALLY_RETURNED'] }, createdAt: { gte: since } },
      select: { createdAt: true, total: true, profit: true, paymentMethod: true },
    })
    const dayMap = new Map<string, { sales: number; profit: number }>()
    for (let i = 0; i < 14; i++) {
      const d = new Date(since.getTime() + i * 86400000)
      dayMap.set(d.toISOString().slice(0, 10), { sales: 0, profit: 0 })
    }
    const payMethods: Record<string, number> = {}
    for (const s of sales) {
      const key = s.createdAt.toISOString().slice(0, 10)
      const e = dayMap.get(key)
      if (e) { e.sales = r2(e.sales + s.total); e.profit = r2(e.profit + s.profit) }
      payMethods[s.paymentMethod] = r2((payMethods[s.paymentMethod] || 0) + s.total)
    }
    const trend = [...dayMap.entries()].map(([date, v]) => ({ date, ...v }))

    // top products (30 days)
    const since30 = new Date(now.getTime() - 30 * 86400000)
    const saleIds = await db.sale.findMany({ where: { businessId: bid, createdAt: { gte: since30 } }, select: { id: true } })
    const items = await db.saleItem.groupBy({
      by: ['productId', 'name'],
      where: { saleId: { in: saleIds.map(s => s.id) } },
      _sum: { quantity: true, total: true },
      orderBy: { _sum: { total: 'desc' } },
      take: 8,
    })
    const topProducts = items.map(i => ({ name: i.name, qty: r2(i._sum.quantity || 0), revenue: r2(i._sum.total || 0) }))

    const sub = await getSubscription(bid)

    return ok({
      cards: {
        todaySales: r2(todaySalesAgg._sum.total || 0),
        todayProfit: r2(todaySalesAgg._sum.profit || 0),
        todayInvoices: todaySalesAgg._count,
        todayPurchases: r2(todayPurchAgg._sum.total || 0),
        todayExpenses: r2(todayExpAgg._sum.amount || 0),
        products: productCount,
        lowStock: lowStockCount,
        customers: customerCount,
        customerDue, supplierDue, stockValue,
      },
      trend, topProducts, payMethods, subscription: sub,
    })
  } catch (e) {
    return handleError(e)
  }
}
