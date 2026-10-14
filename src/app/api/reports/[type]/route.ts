import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail, handleError, requirePerm, num, r2 } from '@/lib/api'
import { bizDayStart, bizDayEnd } from '@/lib/bizday' // Task 71 — day filters use BUSINESS days (PKT), not UTC

export const dynamic = 'force-dynamic'

/**
 * GET /api/reports/[type]?from=&to=&page=&pageSize=
 * types: sales | purchases | profit | expense | inventory | low-stock | customer |
 *        khata | supplier | payment | product | sales-return | purchase-return
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  try {
    const { type } = await params
    const ctx = await requirePerm(req, 'reports')
    const bid = ctx.businessId
    const url = new URL(req.url)
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const range = from || to
      ? {
          ...(from ? { gte: bizDayStart(from) } : {}),
          ...(to ? { lte: bizDayEnd(to) } : {}),
        }
      : undefined
    const pageSize = Math.min(5000, Math.max(10, num(url.searchParams.get('pageSize'), 500)))
    const page = Math.max(1, num(url.searchParams.get('page'), 1))

    switch (type) {
      case 'sales': {
        const where = { businessId: bid, ...(range ? { createdAt: range } : {}), status: { not: 'HELD' } }
        const [items, total, agg] = await Promise.all([
          db.sale.findMany({ where, include: { customer: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
          db.sale.count({ where }),
          db.sale.aggregate({ where, _sum: { total: true, paid: true, dueAmount: true, profit: true, tax: true, discount: true }, _count: true }),
        ])
        return ok({ items, total, summary: { count: agg._count, total: r2(agg._sum.total || 0), paid: r2(agg._sum.paid || 0), due: r2(agg._sum.dueAmount || 0), profit: r2(agg._sum.profit || 0), tax: r2(agg._sum.tax || 0), discount: r2(agg._sum.discount || 0) } })
      }
      case 'purchases': {
        const where = { businessId: bid, ...(range ? { createdAt: range } : {}) }
        const [items, total, agg] = await Promise.all([
          db.purchase.findMany({ where, include: { supplier: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
          db.purchase.count({ where }),
          db.purchase.aggregate({ where, _sum: { total: true, paid: true, dueAmount: true }, _count: true }),
        ])
        return ok({ items, total, summary: { count: agg._count, total: r2(agg._sum.total || 0), paid: r2(agg._sum.paid || 0), due: r2(agg._sum.dueAmount || 0) } })
      }
      case 'profit': {
        // P&L: revenue (excl. tax), COGS (costAtSale*qty sold), expenses, returns
        const sales = await db.sale.findMany({
          where: { businessId: bid, ...(range ? { createdAt: range } : {}), status: { in: ['COMPLETED', 'PARTIALLY_RETURNED'] } },
          select: { total: true, tax: true, discount: true, profit: true, createdAt: true, invoiceNo: true },
        })
        const expenses = await db.expense.aggregate({ where: { businessId: bid, ...(range ? { expenseDate: range } : {}) }, _sum: { amount: true } })
        const revenue = r2(sales.reduce((s, x) => s + x.total - x.tax, 0))
        const grossProfit = r2(sales.reduce((s, x) => s + x.profit, 0))
        const netProfit = r2(grossProfit - (expenses._sum.amount || 0))
        return ok({
          summary: { revenue, grossProfit, expenses: r2(expenses._sum.amount || 0), netProfit, invoices: sales.length },
          rows: sales.slice(0, pageSize).map(s => ({ invoiceNo: s.invoiceNo, date: s.createdAt, revenue: r2(s.total - s.tax), profit: s.profit })),
        })
      }
      case 'expense': {
        const where = { businessId: bid, ...(range ? { expenseDate: range } : {}) }
        const [items, agg, byCat] = await Promise.all([
          db.expense.findMany({ where, include: { category: true }, orderBy: { expenseDate: 'desc' }, take: pageSize }),
          db.expense.aggregate({ where, _sum: { amount: true }, _count: true }),
          db.expense.groupBy({ by: ['categoryId'], where, _sum: { amount: true } }),
        ])
        const cats = await db.expenseCategory.findMany({ where: { businessId: bid } })
        const catMap = new Map(cats.map(c => [c.id, c.name]))
        return ok({
          items, total: agg._count, summary: { total: r2(agg._sum.amount || 0), count: agg._count },
          byCategory: byCat.map(c => ({ name: c.categoryId ? catMap.get(c.categoryId) || 'Other' : 'Other', amount: r2(c._sum.amount || 0) })),
        })
      }
      case 'inventory': {
        const items = await db.product.findMany({
          where: { businessId: bid },
          include: { category: true },
          orderBy: { name: 'asc' },
        })
        const stockValue = r2(items.reduce((s, p) => s + p.stock * p.costPrice, 0))
        const retailValue = r2(items.reduce((s, p) => s + p.stock * p.retailPrice, 0))
        return ok({ items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, summary: { stockValue, retailValue, count: items.length } })
      }
      case 'low-stock': {
        const items = await db.product.findMany({ where: { businessId: bid, isActive: true }, include: { category: true }, orderBy: { stock: 'asc' } })
        const low = items.filter(p => p.stock <= p.minStock)
        return ok({ items: low, total: low.length, summary: { count: low.length } })
      }
      case 'customer': {
        const [customers, txns] = await Promise.all([
          db.customer.findMany({ where: { businessId: bid }, orderBy: { name: 'asc' } }),
          db.customerTransaction.groupBy({ by: ['customerId'], where: { businessId: bid }, _sum: { amount: true } }),
        ])
        const balMap = new Map(txns.map(t => [t.customerId, t._sum.amount || 0]))
        const rows = customers.map(c => ({ id: c.id, name: c.name, phone: c.phone, purchases: null, due: r2((balMap.get(c.id) || 0) + c.openingBalance), createdAt: c.createdAt }))
        const salesAgg = await db.sale.groupBy({ by: ['customerId'], where: { businessId: bid }, _sum: { total: true }, _count: true })
        const salesMap = new Map(salesAgg.map(s => [s.customerId, { total: r2(s._sum.total || 0), count: s._count }]))
        return ok({ items: rows.map(r => ({ ...r, purchases: salesMap.get(r.id)?.total ?? 0, invoiceCount: salesMap.get(r.id)?.count ?? 0 })), total: rows.length, summary: { totalDue: r2(rows.reduce((s, x) => s + Math.max(0, x.due), 0)) } })
      }
      case 'khata': {
        const [customers, txns] = await Promise.all([
          db.customer.findMany({ where: { businessId: bid }, orderBy: { name: 'asc' } }),
          db.customerTransaction.groupBy({ by: ['customerId'], where: { businessId: bid }, _sum: { amount: true } }),
        ])
        const balMap = new Map(txns.map(t => [t.customerId, t._sum.amount || 0]))
        const rows = customers
          .map(c => ({ name: c.name, phone: c.phone, due: r2((balMap.get(c.id) || 0) + c.openingBalance), creditLimit: c.creditLimit }))
          .filter(c => c.due > 0.001)
        return ok({ items: rows, total: rows.length, summary: { totalDue: r2(rows.reduce((s, x) => s + x.due, 0)) } })
      }
      case 'supplier': {
        const [suppliers, txns] = await Promise.all([
          db.supplier.findMany({ where: { businessId: bid }, orderBy: { name: 'asc' } }),
          db.supplierTransaction.groupBy({ by: ['supplierId'], where: { businessId: bid }, _sum: { amount: true } }),
        ])
        const balMap = new Map(txns.map(t => [t.supplierId, t._sum.amount || 0]))
        const rows = suppliers.map(s => ({ id: s.id, name: s.name, company: s.company, phone: s.phone, payable: r2((balMap.get(s.id) || 0) + s.openingBalance) }))
        return ok({ items: rows, total: rows.length, summary: { totalPayable: r2(rows.reduce((s, x) => s + Math.max(0, x.payable), 0)) } })
      }
      case 'payment': {
        const [salesByMethod, subPayments] = await Promise.all([
          db.sale.groupBy({
            by: ['paymentMethod'],
            where: { businessId: bid, ...(range ? { createdAt: range } : {}), status: { in: ['COMPLETED', 'PARTIALLY_RETURNED'] } },
            _sum: { total: true, paid: true, dueAmount: true }, _count: true,
          }),
          db.customerTransaction.groupBy({
            by: ['type'],
            where: { businessId: bid, ...(range ? { createdAt: range } : {}), type: 'PAYMENT' },
            _sum: { amount: true },
          }),
        ])
        return ok({
          items: salesByMethod.map(m => ({ method: m.paymentMethod, amount: r2(m._sum.total || 0), paid: r2(m._sum.paid || 0), due: r2(m._sum.dueAmount || 0), count: m._count })),
          khataCollections: r2(subPayments.reduce((s, p) => s + (p._sum.amount || 0), 0)),
          summary: { collected: r2(salesByMethod.reduce((s, m) => s + (m._sum.paid || 0), 0)) },
        })
      }
      case 'product': {
        const since30 = new Date(Date.now() - 30 * 86400000)
        const sales = await db.sale.findMany({ where: { businessId: bid, createdAt: range ? range : { gte: since30 } }, select: { id: true } })
        const items = await db.saleItem.groupBy({
          by: ['productId', 'name'],
          where: { saleId: { in: sales.map(s => s.id) } },
          _sum: { quantity: true, total: true },
          orderBy: { _sum: { total: 'desc' } },
        })
        return ok({ items: items.map(i => ({ name: i.name, qty: r2(i._sum.quantity || 0), revenue: r2(i._sum.total || 0) })), total: items.length, summary: { revenue: r2(items.reduce((s, i) => s + (i._sum.total || 0), 0)) } })
      }
      case 'sales-return': {
        const where = { businessId: bid, ...(range ? { createdAt: range } : {}) }
        const [items, agg] = await Promise.all([
          db.saleReturn.findMany({ where, orderBy: { createdAt: 'desc' }, take: pageSize }),
          db.saleReturn.aggregate({ where, _sum: { total: true }, _count: true }),
        ])
        return ok({ items, total: agg._count, summary: { total: r2(agg._sum.total || 0), count: agg._count } })
      }
      case 'purchase-return': {
        const where = { businessId: bid, ...(range ? { createdAt: range } : {}) }
        const [items, agg] = await Promise.all([
          db.purchaseReturn.findMany({ where, orderBy: { createdAt: 'desc' }, take: pageSize }),
          db.purchaseReturn.aggregate({ where, _sum: { total: true }, _count: true }),
        ])
        return ok({ items, total: agg._count, summary: { total: r2(agg._sum.total || 0), count: agg._count } })
      }
      case 'tax': {
        const where = { businessId: bid, ...(range ? { createdAt: range } : {}), status: { in: ['COMPLETED', 'PARTIALLY_RETURNED'] } }
        const agg = await db.sale.aggregate({ where, _sum: { tax: true, total: true }, _count: true })
        return ok({ summary: { taxCollected: r2(agg._sum.tax || 0), taxableSales: r2(agg._sum.total || 0), invoices: agg._count } })
      }
      default:
        return fail(404, 'NOT_FOUND', `Unknown report type: ${type}`)
    }
  } catch (e) {
    return handleError(e)
  }
}

function txnsSum(txns: { _sum: { amount: number | null } }[]): number {
  return r2(txns.reduce((s, t) => s + Math.abs(t._sum.amount || 0), 0))
}
