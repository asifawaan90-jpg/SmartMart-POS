import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, fail, handleError, readBody, requirePerm, requireAuth, requireActiveSub, audit,
  ApiError, clientIp,
} from '@/lib/api'
import { hasPerm } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const LATE_AFTER_UTC_HOUR = 10

// GET /api/attendance?month=YYYY-MM — records + per-staff summary (owner/manager)
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'users')
    const month = new URL(req.url).searchParams.get('month') || new Date().toISOString().slice(0, 7)
    if (!MONTH_RE.test(month)) throw new ApiError(400, 'VALIDATION', 'month must be YYYY-MM.')
    const from = new Date(`${month}-01T00:00:00.000Z`)
    const to = new Date(from)
    to.setUTCMonth(to.getUTCMonth() + 1)
    const records = await db.attendance.findMany({
      where: { businessId: ctx.businessId, date: { gte: `${month}-01`, lt: to.toISOString().slice(0, 10) } },
      orderBy: [{ date: 'desc' }, { userId: 'asc' }],
      take: 1000,
    })
    const summary = new Map<string, { present: number; late: number; half: number; absent: number; minutes: number }>()
    const ensure = (uid: string) => {
      if (!summary.has(uid)) summary.set(uid, { present: 0, late: 0, half: 0, absent: 0, minutes: 0 })
      return summary.get(uid)!
    }
    for (const r of records) {
      const s = ensure(r.userId)
      if (r.status === 'ABSENT') s.absent++
      else if (r.status === 'HALF_DAY') s.half++
      else if (r.status === 'LATE') { s.present++; s.late++ }
      else s.present++
      if (r.checkInAt && r.checkOutAt) s.minutes += Math.max(0, Math.round((r.checkOutAt.getTime() - r.checkInAt.getTime()) / 60000))
    }
    return ok({ month, records, summary: Object.fromEntries(summary) })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/attendance — { action: 'punch'|'mark'|'enroll', ... }
export async function POST(req: NextRequest) {
  try {
    const b = await readBody<Record<string, unknown>>(req)
    const action = String(b.action || 'punch')

    // ── enroll: staff registers their own biometric credential (self-service) ──
    if (action === 'enroll') {
      const ctx = await requireAuth(req)
      await requireActiveSub(ctx)
      const credentialId = String(b.credentialId || '').trim()
      if (!credentialId || credentialId.length > 512) throw new ApiError(400, 'VALIDATION', 'credentialId required.')
      await db.user.update({ where: { id: ctx.user.uid }, data: { bioCredentialId: credentialId } })
      await audit(ctx.businessId, ctx.user.uid, 'BIOMETRIC_ENROLLED', 'User', ctx.user.uid, {}, clientIp(req))
      return ok({ enrolled: true })
    }

    // ── mark: manager manually sets a day's status ──
    if (action === 'mark') {
      const ctx = await requirePerm(req, 'users')
      await requireActiveSub(ctx)
      const userId = String(b.userId || '')
      const date = String(b.date || '')
      const status = String(b.status || '')
      if (!DATE_RE.test(date)) throw new ApiError(400, 'VALIDATION', 'date must be YYYY-MM-DD.')
      if (!['PRESENT', 'ABSENT', 'HALF_DAY', 'LATE'].includes(status)) throw new ApiError(400, 'VALIDATION', 'Invalid status.')
      const user = await db.user.findFirst({ where: { id: userId, businessId: ctx.businessId } })
      if (!user) throw new ApiError(404, 'NOT_FOUND', 'Staff not found.')
      const note = String(b.note || '').slice(0, 200)
      const rec = await db.attendance.upsert({
        where: { businessId_userId_date: { businessId: ctx.businessId, userId, date } },
        create: { businessId: ctx.businessId, userId, date, status, note, checkInMethod: 'MANUAL' },
        update: { status, note },
      })
      await audit(ctx.businessId, ctx.user.uid, 'ATTENDANCE_MARKED', 'Attendance', rec.id, { userId, date, status }, clientIp(req))
      return ok(rec)
    }

    // ── punch: biometric/manual check-in / check-out ──
    const ctx = await requireAuth(req)
    await requireActiveSub(ctx)
    const self = !b.userId || String(b.userId) === ctx.user.uid
    const userId = self ? ctx.user.uid : String(b.userId)
    if (!self && !hasPerm(ctx.user.role, ctx.perms || [], 'users')) {
      throw new ApiError(403, 'FORBIDDEN', 'You can only punch your own attendance.')
    }
    const method = String(b.method || 'MANUAL').toUpperCase() === 'BIOMETRIC' ? 'BIOMETRIC' : 'MANUAL'
    const date = DATE_RE.test(String(b.date || '')) ? String(b.date) : new Date().toISOString().slice(0, 10)

    const user = await db.user.findFirst({ where: { id: userId, businessId: ctx.businessId } })
    if (!user) throw new ApiError(404, 'NOT_FOUND', 'Staff not found.')
    if (!user.isActive) throw new ApiError(400, 'VALIDATION', `${user.name} is deactivated.`)

    // biometric verification: enrolled credential must match the presented one
    if (method === 'BIOMETRIC' && user.bioCredentialId) {
      const presented = String(b.credentialId || '')
      if (presented !== user.bioCredentialId) {
        throw new ApiError(403, 'BIOMETRIC_MISMATCH', 'Fingerprint did not match the enrolled biometric for this staff member.')
      }
    }

    const existing = await db.attendance.findUnique({
      where: { businessId_userId_date: { businessId: ctx.businessId, userId, date } },
    })
    const now = new Date()

    if (!existing) {
      const late = now.getUTCHours() >= LATE_AFTER_UTC_HOUR
      const rec = await db.attendance.create({
        data: {
          businessId: ctx.businessId, userId, date,
          checkInAt: now, checkInMethod: method,
          status: late ? 'LATE' : 'PRESENT',
          note: method === 'BIOMETRIC' && !user.bioCredentialId ? 'Device-simulated scan' : '',
        },
      })
      await audit(ctx.businessId, ctx.user.uid, 'ATTENDANCE_CHECKIN', 'Attendance', rec.id, { userId, name: user.name, method }, clientIp(req))
      return ok({ punch: 'IN', record: rec, user: { id: user.id, name: user.name, photo: user.photo } }, 201)
    }

    if (!existing.checkOutAt) {
      const rec = await db.attendance.update({
        where: { id: existing.id },
        data: { checkOutAt: now, checkOutMethod: method, ...(existing.status === 'ABSENT' ? { status: 'PRESENT' } : {}) },
      })
      await audit(ctx.businessId, ctx.user.uid, 'ATTENDANCE_CHECKOUT', 'Attendance', rec.id, { userId, name: user.name, method }, clientIp(req))
      return ok({ punch: 'OUT', record: rec, user: { id: user.id, name: user.name, photo: user.photo } })
    }

    throw new ApiError(400, 'ALREADY_DONE', `${user.name} already checked in and out on ${date}.`)
  } catch (e) {
    return handleError(e)
  }
}
void fail
