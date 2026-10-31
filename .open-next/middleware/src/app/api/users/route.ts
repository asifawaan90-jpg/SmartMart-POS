import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, fail, handleError, readBody, requirePerm, requireActiveSub, audit,
  ApiError, clientIp, requireStr, num, r2,
} from '@/lib/api'
import { hashPassword } from '@/lib/auth'
import { ALL_ROLES, hasPerm } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

const CNIC_RE = /^\d{5}-\d{7}-\d$/
function cleanCnic(v: unknown): string {
  const digits = String(v || '').replace(/\D/g, '')
  if (!digits) return ''
  if (digits.length !== 13) throw new ApiError(400, 'VALIDATION', 'CNIC must be exactly 13 digits.')
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`
}
function optSalary(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = num(v)
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, 'VALIDATION', 'Salary must be zero or positive.')
  return r2(n)
}

// GET /api/users — staff list (owner/manager)
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'users')
    const users = await db.user.findMany({
      where: { businessId: ctx.businessId },
      select: { id: true, name: true, email: true, phone: true, role: true, perms: true, isActive: true, lastLoginAt: true, createdAt: true,
        photo: true, cnic: true, salary: true, joinDate: true, bioCredentialId: true },
      orderBy: { createdAt: 'asc' },
    })
    return ok(users)
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/users — create staff
export async function POST(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'users')
    await requireActiveSub(ctx)
    const b = await readBody<Record<string, unknown>>(req)
    const name = requireStr(b.name, 'Name', 100)
    const email = requireStr(b.email, 'Email', 200).toLowerCase()
    const password = requireStr(b.password, 'Password', 100)
    const role = String(b.role || 'CASHIER').toUpperCase()
    if (password.length < 6) throw new ApiError(400, 'VALIDATION', 'Password must be at least 6 characters.')
    if (!ALL_ROLES.includes(role)) throw new ApiError(400, 'VALIDATION', 'Invalid role.')
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, 'VALIDATION', 'Invalid email.')
    const existing = await db.user.findUnique({ where: { email } })
    if (existing) throw new ApiError(409, 'DUPLICATE', 'Email already in use.')
    const user = await db.user.create({
      data: {
        businessId: ctx.businessId, name, email,
        phone: typeof b.phone === 'string' ? b.phone.slice(0, 30) : '',
        passwordHash: await hashPassword(password),
        role: role === 'OWNER' ? 'MANAGER' : role, // only one OWNER
        perms: JSON.stringify(Array.isArray(b.perms) ? b.perms : []),
        photo: typeof b.photo === 'string' && b.photo.length <= 400_000 ? b.photo : '',
        cnic: b.cnic != null ? cleanCnic(b.cnic) : '',
        salary: optSalary(b.salary) ?? 0,
        joinDate: b.joinDate ? new Date(String(b.joinDate)) : null,
      },
    })
    await audit(ctx.businessId, ctx.user.uid, 'USER_CREATED', 'User', user.id, { name, email, role }, clientIp(req))
    return ok({ id: user.id, name: user.name, email: user.email, role: user.role }, 201)
  } catch (e) {
    return handleError(e)
  }
}

// PUT /api/users?id= — update staff role/perms/active/password
export async function PUT(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'users')
    await requireActiveSub(ctx)
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return fail(400, 'VALIDATION', 'id required.')
    const target = await db.user.findFirst({ where: { id, businessId: ctx.businessId } })
    if (!target) return fail(404, 'NOT_FOUND', 'User not found.')
    const b = await readBody<Record<string, unknown>>(req)
    const data: Record<string, unknown> = {}
    if (b.name != null) data.name = String(b.name).slice(0, 100)
    if (b.phone !== undefined) data.phone = String(b.phone || '').slice(0, 30)
    if (b.role != null) {
      const role = String(b.role).toUpperCase()
      if (!ALL_ROLES.includes(role)) throw new ApiError(400, 'VALIDATION', 'Invalid role.')
      if (target.role === 'OWNER' && role !== 'OWNER') throw new ApiError(400, 'VALIDATION', 'The business owner role cannot be changed.')
      if (role === 'OWNER') throw new ApiError(400, 'VALIDATION', 'Only one owner is allowed.')
      data.role = role
    }
    if (b.perms !== undefined) data.perms = JSON.stringify(Array.isArray(b.perms) ? b.perms : [])
    if (b.isActive !== undefined) {
      if (target.id === ctx.user.uid) throw new ApiError(400, 'VALIDATION', 'You cannot deactivate yourself.')
      data.isActive = b.isActive === true
    }
    if (b.password) {
      const pw = String(b.password)
      if (pw.length < 6) throw new ApiError(400, 'VALIDATION', 'Password must be at least 6 characters.')
      data.passwordHash = await hashPassword(pw)
    }
    if (b.photo !== undefined) data.photo = typeof b.photo === 'string' && b.photo.length <= 400_000 ? b.photo : ''
    if (b.cnic !== undefined) data.cnic = cleanCnic(b.cnic)
    const salary = optSalary(b.salary)
    if (salary !== undefined) data.salary = salary
    if (b.joinDate !== undefined) data.joinDate = b.joinDate ? new Date(String(b.joinDate)) : null
    if (b.bioCredentialId !== undefined) {
      const cid = String(b.bioCredentialId || '').slice(0, 512)
      if (target.id !== ctx.user.uid && !hasPerm(ctx.user.role, ctx.perms || [], 'users')) {
        throw new ApiError(403, 'FORBIDDEN', 'You cannot change another user\'s biometric enrollment.')
      }
      data.bioCredentialId = cid
    }
    await db.user.update({ where: { id }, data })
    await audit(ctx.businessId, ctx.user.uid, 'USER_UPDATED', 'User', id, { fields: Object.keys(data).filter(k => k !== 'passwordHash') }, clientIp(req))
    return ok({ id })
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/users?id=
export async function DELETE(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'users')
    await requireActiveSub(ctx)
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return fail(400, 'VALIDATION', 'id required.')
    if (id === ctx.user.uid) throw new ApiError(400, 'VALIDATION', 'You cannot delete yourself.')
    const target = await db.user.findFirst({ where: { id, businessId: ctx.businessId } })
    if (!target) return fail(404, 'NOT_FOUND', 'User not found.')
    if (target.role === 'OWNER') throw new ApiError(400, 'VALIDATION', 'The owner account cannot be deleted.')
    await db.user.delete({ where: { id } })
    await audit(ctx.businessId, ctx.user.uid, 'USER_DELETED', 'User', id, { email: target.email }, clientIp(req))
    return ok({ id })
  } catch (e) {
    return handleError(e)
  }
}
void num
