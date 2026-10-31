import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, fail, handleError, readBody, requirePerm, requireActiveSub, audit,
  ApiError, clientIp, r2, num,
} from '@/lib/api'

export const dynamic = 'force-dynamic'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
/** Working-day divisor used for per-day salary (6-day work week). */
const WORK_DAYS = 26

function monthRange(month: string) {
  const from = new Date(`${month}-01T00:00:00.000Z`)
  const to = new Date(from)
  to.setUTCMonth(to.getUTCMonth() + 1)
  return { from, to, toStr: to.toISOString().slice(0, 10) }
}

async function attendanceStats(businessId: string, month: string) {
  const { toStr } = monthRange(month)
  const recs = await db.attendance.findMany({
    where: { businessId, date: { gte: `${month}-01`, lt: toStr } },
    select: { userId: true, status: true },
  })
  const stats = new Map<string, { present: number; absent: number; half: number; late: number }>()
  for (const r of recs) {
    if (!stats.has(r.userId)) stats.set(r.userId, { present: 0, absent: 0, half: 0, late: 0 })
    const s = stats.get(r.userId)!
    if (r.status === 'ABSENT') s.absent++
    else if (r.status === 'HALF_DAY') s.half++
    else if (r.status === 'LATE') { s.present++; s.late++ }
    else s.present++
  }
  return stats
}

// GET /api/payroll?month=YYYY-MM — existing run + live preview data
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'users')
    const month = new URL(req.url).searchParams.get('month') || new Date().toISOString().slice(0, 7)
    if (!MONTH_RE.test(month)) throw new ApiError(400, 'VALIDATION', 'month must be YYYY-MM.')
    const staff = await db.user.findMany({
      where: { businessId: ctx.businessId, isActive: true, salary: { gt: 0 } },
      select: { id: true, name: true, role: true, photo: true, cnic: true, salary: true, joinDate: true },
      orderBy: { name: 'asc' },
    })
    const stats = await attendanceStats(ctx.businessId, month)
    const run = await db.payrollRun.findUnique({
      where: { businessId_month: { businessId: ctx.businessId, month } },
      include: { items: { orderBy: { name: 'asc' } } },
    })
    return ok({
      month, workDays: WORK_DAYS, run, staff,
      stats: Object.fromEntries(stats),
    })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/payroll — { action: 'generate', month, items } | { action: 'pay', runId }
export async function POST(req: NextRequest) {
  try {
    const b = await readBody<Record<string, unknown>>(req)
    const action = String(b.action || '')

    // ── generate / regenerate DRAFT run (attendance numbers always recomputed server-side) ──
    if (action === 'generate') {
      const ctx = await requirePerm(req, 'users')
      await requireActiveSub(ctx)
      const month = String(b.month || '')
      if (!MONTH_RE.test(month)) throw new ApiError(400, 'VALIDATION', 'month must be YYYY-MM.')
      const existing = await db.payrollRun.findUnique({
        where: { businessId_month: { businessId: ctx.businessId, month } },
      })
      if (existing?.status === 'PAID') throw new ApiError(400, 'ALREADY_PAID', `Payroll for ${month} is already paid.`)

      const staff = await db.user.findMany({
        where: { businessId: ctx.businessId, isActive: true, salary: { gt: 0 } },
      })
      const stats = await attendanceStats(ctx.businessId, month)
      const incoming = new Map<string, Record<string, unknown>>(
        Array.isArray(b.items) ? (b.items as { userId?: string }[]).filter(i => i && typeof i.userId === 'string').map(i => [String(i.userId), i as Record<string, unknown>]) : [],
      )

      const rows = staff.map(u => {
        const s = stats.get(u.id) || { present: 0, absent: 0, half: 0, late: 0 }
        const perDay = r2(u.salary / WORK_DAYS)
        const autoDeduction = r2(s.absent * perDay + s.half * perDay * 0.5)
        const inp = incoming.get(u.id) || {}
        const bonus = Math.max(0, r2(num(inp.bonus)))
        const advance = Math.max(0, r2(num(inp.advance)))
        const deduction = Math.max(0, r2(num(inp.deduction, autoDeduction)))
        const netPay = Math.max(0, r2(u.salary - deduction + bonus - advance))
        return {
          userId: u.id, name: u.name, role: u.role,
          baseSalary: r2(u.salary), perDay,
          presentDays: s.present, absentDays: s.absent, halfDays: s.half, lateCount: s.late,
          bonus, advance, deduction, netPay,
          method: ['CASH', 'BANK', 'DIGITAL'].includes(String(inp.method)) ? String(inp.method) : 'CASH',
          note: String(inp.note || '').slice(0, 200),
        }
      })
      const totalNet = r2(rows.reduce((t, r) => t + r.netPay, 0))

      const run = await db.payrollRun.upsert({
        where: { businessId_month: { businessId: ctx.businessId, month } },
        create: {
          businessId: ctx.businessId, month, status: 'DRAFT', totalNet, createdById: ctx.user.uid,
          items: { create: rows.map(r => ({ ...r, businessId: ctx.businessId })) },
        },
        update: {
          status: 'DRAFT', totalNet, createdById: ctx.user.uid, paidAt: null,
          items: { deleteMany: {} , create: rows.map(r => ({ ...r, businessId: ctx.businessId })) },
        },
        include: { items: { orderBy: { name: 'asc' } } },
      })
      await audit(ctx.businessId, ctx.user.uid, 'PAYROLL_GENERATED', 'PayrollRun', run.id, { month, staff: rows.length, totalNet }, clientIp(req))
      return ok(run)
    }

    // ── pay: mark PAID + post each salary as an auto Expense ──
    if (action === 'pay') {
      const ctx = await requirePerm(req, 'users')
      await requireActiveSub(ctx)
      const runId = String(b.runId || '')
      const run = await db.payrollRun.findFirst({
        where: { id: runId, businessId: ctx.businessId },
        include: { items: true },
      })
      if (!run) throw new ApiError(404, 'NOT_FOUND', 'Payroll run not found.')
      if (run.status === 'PAID') throw new ApiError(400, 'ALREADY_PAID', `Payroll for ${run.month} is already paid.`)
      if (run.items.length === 0) throw new ApiError(400, 'VALIDATION', 'Generate the payroll first.')

      const cat = await db.expenseCategory.upsert({
        where: { businessId_name: { businessId: ctx.businessId, name: 'Salaries' } },
        create: { businessId: ctx.businessId, name: 'Salaries' },
        update: {},
      })
      const now = new Date()
      const expenseIds: string[] = []
      const updated = await db.$transaction(async (tx) => {
        for (const item of run.items) {
          const exp = await tx.expense.create({
            data: {
              businessId: ctx.businessId,
              categoryId: cat.id,
              title: `Salary — ${item.name} — ${run.month}`,
              amount: item.netPay,
              kind: 'EXPENSE',
              isAuto: true,
              paidTo: item.name,
              paymentMethod: item.method,
              note: `Payroll ${run.month} · present ${item.presentDays}d · absent ${item.absentDays}d · half ${item.halfDays}d`,
              expenseDate: now,
              userId: ctx.user.uid,
            },
          })
          expenseIds.push(exp.id)
          await tx.payrollItem.update({ where: { id: item.id }, data: { paidAt: now } })
        }
        return tx.payrollRun.update({
          where: { id: run.id },
          data: { status: 'PAID', paidAt: now },
          include: { items: { orderBy: { name: 'asc' } } },
        })
      })
      await audit(ctx.businessId, ctx.user.uid, 'PAYROLL_PAID', 'PayrollRun', run.id, { month: run.month, total: run.totalNet, expenses: expenseIds.length }, clientIp(req))
      return ok({ run: updated, expenseIds })
    }

    throw new ApiError(400, 'VALIDATION', 'Unknown action.')
  } catch (e) {
    return handleError(e)
  }
}
