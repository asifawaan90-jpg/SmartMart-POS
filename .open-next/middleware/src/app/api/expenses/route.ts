import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, fail, handleError, readBody, requirePerm, requireActiveSub, audit,
  num, r2, ApiError, clientIp, requireStr,
} from '@/lib/api'
import { maybeAutoBackup } from '@/lib/backup-auto'
import { bizDayStart, bizDayEnd } from '@/lib/bizday' // Task 71 — day filters use BUSINESS days (PKT), not UTC

export const dynamic = 'force-dynamic'

// GET /api/expenses?from=&to=&categoryId=&kind=&page=
// Returns the mixed ledger + automatic sales income summary for the period.
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'expenses')
    const url = new URL(req.url)
    const categoryId = url.searchParams.get('categoryId') || ''
    const kind = url.searchParams.get('kind') || ''
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const page = Math.max(1, num(url.searchParams.get('page'), 1))
    const pageSize = Math.min(100, Math.max(5, num(url.searchParams.get('pageSize'), 20)))
    const where: Record<string, unknown> = { businessId: ctx.businessId }
    if (categoryId) where.categoryId = categoryId
    if (kind === 'INCOME' || kind === 'EXPENSE') where.kind = kind
    if (from || to) {
      where.expenseDate = {
        ...(from ? { gte: bizDayStart(from) } : {}),
        ...(to ? { lte: bizDayEnd(to) } : {}),
      }
    }
    const [items, total, expenseSum, incomeSum] = await Promise.all([
      db.expense.findMany({
        where, include: { category: true },
        orderBy: { expenseDate: 'desc' },
        skip: (page - 1) * pageSize, take: pageSize,
      }),
      db.expense.count({ where }),
      db.expense.aggregate({ where: { ...where, kind: 'EXPENSE' }, _sum: { amount: true } }),
      db.expense.aggregate({ where: { ...where, kind: 'INCOME' }, _sum: { amount: true } }),
    ])

    // ── automatic income from POS sales (net of returns) over the same period ──
    const range = from || to ? {
      createdAt: {
        ...(from ? { gte: bizDayStart(from) } : {}),
        ...(to ? { lte: bizDayEnd(to) } : {}),
      },
    } : {}
    const [sales, returns] = await Promise.all([
      db.sale.findMany({
        where: { businessId: ctx.businessId, status: { in: ['COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED'] }, ...range },
        select: { total: true, createdAt: true },
      }),
      db.saleReturn.findMany({
        where: { businessId: ctx.businessId, ...range },
        select: { total: true, createdAt: true },
      }),
    ])
    const dayMap = new Map<string, { date: string; invoices: number; gross: number; returns: number; net: number }>()
    const day = (iso: Date) => iso.toISOString().slice(0, 10)
    for (const s of sales) {
      const k = day(s.createdAt)
      if (!dayMap.has(k)) dayMap.set(k, { date: k, invoices: 0, gross: 0, returns: 0, net: 0 })
      const row = dayMap.get(k)!
      row.invoices++; row.gross += s.total
    }
    for (const r of returns) {
      const k = day(r.createdAt)
      if (!dayMap.has(k)) dayMap.set(k, { date: k, invoices: 0, gross: 0, returns: 0, net: 0 })
      dayMap.get(k)!.returns += r.total
    }
    const byDay = Array.from(dayMap.values()).map(d => ({ ...d, gross: r2(d.gross), returns: r2(d.returns), net: r2(d.gross - d.returns) }))
      .sort((a, b) => a.date.localeCompare(b.date))
    const incomeSales = r2(byDay.reduce((t, d) => t + d.net, 0))
    const totalAmount = r2(expenseSum._sum.amount || 0)   // expenses only (kept for compatibility)
    const incomeManual = r2(incomeSum._sum.amount || 0)   // manual INCOME entries
    const totalIncome = r2(incomeManual + incomeSales)
    const netProfit = r2(totalIncome - totalAmount)

    return ok({ items, total, page, pageSize, totalAmount, incomeManual, incomeSales, totalIncome, netProfit, byDay })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/expenses
export async function POST(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'expenses')
    await requireActiveSub(ctx)
    const b = await readBody<Record<string, unknown>>(req)
    const title = requireStr(b.title, 'Title', 200)
    const amount = r2(num(b.amount))
    if (amount <= 0) throw new ApiError(400, 'VALIDATION', 'Amount must be greater than zero.')
    const kind = String(b.kind || 'EXPENSE').toUpperCase() === 'INCOME' ? 'INCOME' : 'EXPENSE'
    const expense = await db.expense.create({
      data: {
        businessId: ctx.businessId,
        categoryId: b.categoryId ? String(b.categoryId) : null,
        title, amount, kind,
        paidTo: typeof b.paidTo === 'string' ? b.paidTo.slice(0, 120) : '',
        receipt: typeof b.receipt === 'string' ? b.receipt.slice(0, 400_000) : '',
        paymentMethod: typeof b.paymentMethod === 'string' ? b.paymentMethod : 'CASH',
        note: typeof b.note === 'string' ? b.note.slice(0, 300) : '',
        expenseDate: b.expenseDate ? new Date(String(b.expenseDate)) : new Date(),
        userId: ctx.user.uid,
      },
    })
    await audit(ctx.businessId, ctx.user.uid, kind === 'INCOME' ? 'INCOME_CREATED' : 'EXPENSE_CREATED', 'Expense', expense.id, { title, amount, kind }, clientIp(req))
    void maybeAutoBackup(ctx.businessId, ctx.user, kind === 'INCOME' ? 'income saved' : 'expense saved', { title, amount, kind })
    return ok(expense, 201)
  } catch (e) {
    return handleError(e)
  }
}

// PUT /api/expenses?id=
export async function PUT(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'expenses')
    await requireActiveSub(ctx)
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return fail(400, 'VALIDATION', 'id required.')
    const existing = await db.expense.findFirst({ where: { id, businessId: ctx.businessId } })
    if (!existing) return fail(404, 'NOT_FOUND', 'Expense not found.')
    const b = await readBody<Record<string, unknown>>(req)
    const data: Record<string, unknown> = {}
    if (b.title != null) data.title = requireStr(b.title, 'Title', 200)
    if (b.amount != null) data.amount = r2(num(b.amount))
    if (b.categoryId !== undefined) data.categoryId = b.categoryId ? String(b.categoryId) : null
    if (b.paidTo !== undefined) data.paidTo = String(b.paidTo || '').slice(0, 120)
    if (b.paymentMethod !== undefined) data.paymentMethod = String(b.paymentMethod || 'CASH')
    if (b.note !== undefined) data.note = String(b.note || '').slice(0, 300)
    if (b.expenseDate != null) data.expenseDate = new Date(String(b.expenseDate))
    const expense = await db.expense.update({ where: { id }, data })
    await audit(ctx.businessId, ctx.user.uid, 'EXPENSE_UPDATED', 'Expense', id, { title: expense.title }, clientIp(req))
    return ok(expense)
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/expenses?id=
export async function DELETE(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'expenses')
    await requireActiveSub(ctx)
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return fail(400, 'VALIDATION', 'id required.')
    const existing = await db.expense.findFirst({ where: { id, businessId: ctx.businessId } })
    if (!existing) return fail(404, 'NOT_FOUND', 'Expense not found.')
    await db.expense.delete({ where: { id } })
    await audit(ctx.businessId, ctx.user.uid, 'EXPENSE_DELETED', 'Expense', id, { title: existing.title }, clientIp(req))
    return ok({ id })
  } catch (e) {
    return handleError(e)
  }
}
