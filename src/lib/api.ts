import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { extractToken, verifyToken, type SessionUser } from '@/lib/auth'
import { hasPerm, type Perm } from '@/lib/permissions'

// ── Rate limiting (in-memory) ─────────────────────────────────
const buckets = new Map<string, { count: number; reset: number }>()
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs })
    return true
  }
  b.count++
  return b.count <= max
}

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function ok(data: unknown, init?: number) {
  return NextResponse.json({ ok: true, data }, { status: init || 200 })
}

export function fail(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, code, message }, { status })
}

export function handleError(e: unknown) {
  if (e instanceof ApiError) return fail(e.status, e.code, e.message)
  const msg = e instanceof Error ? e.message : 'Unexpected error'
  if (/Unique constraint/i.test(msg)) {
    const field = /barcode/i.test(msg) ? 'Barcode' : /sku/i.test(msg) ? 'SKU' : /invoice/i.test(msg) ? 'Invoice number' : /phone/i.test(msg) ? 'Phone' : /email/i.test(msg) ? 'Email' : 'Record'
    return fail(409, 'DUPLICATE', `${field} already exists.`)
  }
  console.error('[api]', e)
  return fail(500, 'SERVER_ERROR', 'Something went wrong. Please try again.')
}

export function clientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
}

// ── Context resolution ────────────────────────────────────────

export interface Ctx {
  user: SessionUser
  businessId: string
  role: string
  perms: string[]
  req: Request
}

async function resolve(req: Request, perm?: Perm): Promise<Ctx> {
  const token = extractToken(req)
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.')
  const user = await verifyToken(token)
  if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Session expired. Please sign in again.')

  // Platform super-admin: no business scope, all platform perms
  if (user.role === 'SUPER_ADMIN') {
    if (perm) throw new ApiError(403, 'FORBIDDEN', 'Platform admin has no shop operations access here.')
    return { user, businessId: '', role: user.role, perms: [], req }
  }

  const dbUser = await db.user.findUnique({ where: { id: user.uid } })
  if (!dbUser || !dbUser.isActive) throw new ApiError(403, 'FORBIDDEN', 'Your account has been deactivated.')
  if (!dbUser.businessId) throw new ApiError(403, 'FORBIDDEN', 'Account is not linked to a business.')

  if (perm && !hasPerm(dbUser.role, JSON.parse(dbUser.perms || '[]'), perm)) {
    throw new ApiError(403, 'FORBIDDEN', 'You do not have permission for this action.')
  }

  return {
    user,
    businessId: dbUser.businessId,
    role: dbUser.role,
    perms: JSON.parse(dbUser.perms || '[]'),
    req,
  }
}

export async function requirePerm(req: Request, perm: Perm): Promise<Ctx> {
  return resolve(req, perm)
}

/** Pass when the user holds ANY of the listed perms (used for read endpoints shared
 *  across roles — e.g. the POS catalog, which cashiers need via their 'pos' perm). */
export async function requireAnyPerm(req: Request, perms: Perm[]): Promise<Ctx> {
  const token = extractToken(req)
  const errors: ApiError[] = []
  for (const p of perms) {
    try {
      return await resolve(req, p)
    } catch (e) {
      if (e instanceof ApiError) errors.push(e)
      else throw e
    }
  }
  throw errors[errors.length - 1] || new ApiError(403, 'FORBIDDEN', 'You do not have permission for this action.')
}

export async function requireAuth(req: Request): Promise<Ctx> {
  return resolve(req)
}

// ── Subscription guard ────────────────────────────────────────

export interface SubInfo {
  status: string
  planCode: string
  planName: string
  daysRemaining: number | null
  endDate: string | null
  isLifetime: boolean
}

export async function getSubscription(businessId: string): Promise<SubInfo> {
  const sub = await db.subscription.findUnique({
    where: { businessId },
    include: { plan: true },
  })
  if (!sub) {
    return { status: 'EXPIRED', planCode: 'TRIAL', planName: 'No plan', daysRemaining: 0, endDate: null, isLifetime: false }
  }
  if (sub.status === 'LIFETIME') {
    return { status: 'LIFETIME', planCode: sub.plan.code, planName: sub.plan.name, daysRemaining: null, endDate: null, isLifetime: true }
  }
  if (sub.status === 'TRIAL' || sub.status === 'ACTIVE') {
    const end = sub.endDate ? new Date(sub.endDate) : null
    if (end && end.getTime() < Date.now()) {
      // auto-expire
      await db.subscription.update({ where: { id: sub.id }, data: { status: 'EXPIRED' } })
      return { status: 'EXPIRED', planCode: sub.plan.code, planName: sub.plan.name, daysRemaining: 0, endDate: end.toISOString(), isLifetime: false }
    }
    const daysRemaining = end ? Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86400000)) : null
    return { status: sub.status, planCode: sub.plan.code, planName: sub.plan.name, daysRemaining, endDate: end?.toISOString() || null, isLifetime: false }
  }
  return {
    status: sub.status, planCode: sub.plan.code, planName: sub.plan.name,
    daysRemaining: 0,
    endDate: sub.endDate ? new Date(sub.endDate).toISOString() : null, isLifetime: false,
  }
}

const SUB_BYPASS = new Set(['UNAUTHENTICATED', 'FORBIDDEN'])
const SUB_ALLOWED_PREFIX = ['/api/auth', '/api/subscription', '/api/admin', '/api/settings', '/api/audit']

/** Throws 402 when subscription expired/suspended. Returns SubInfo for context. */
export async function requireActiveSub(ctx: Ctx): Promise<SubInfo> {
  const sub = await getSubscription(ctx.businessId)
  const biz = await db.business.findUnique({ where: { id: ctx.businessId }, select: { isActive: true } })
  if (biz && !biz.isActive) {
    throw new ApiError(402, 'SUBSCRIPTION_BLOCKED', 'Your account is deactivated. Please contact support.')
  }
  if (sub.status === 'EXPIRED' || sub.status === 'SUSPENDED' || sub.status === 'DEACTIVATED') {
    throw new ApiError(402, 'SUBSCRIPTION_BLOCKED',
      sub.status === 'EXPIRED'
        ? 'Your subscription has expired. Renew to continue using SmartMart.'
        : `Your account is ${sub.status.toLowerCase()}. Please contact support.`)
  }
  return sub
}

export async function audit(
  businessId: string | null, userId: string | null, action: string,
  entity = '', entityId = '', details: Record<string, unknown> | string = '', ip = ''
) {
  try {
    await db.auditLog.create({
      data: {
        businessId: businessId || undefined,
        userId: userId || undefined,
        action, entity, entityId,
        details: typeof details === 'string' ? details : JSON.stringify(details),
        ip,
      },
    })
  } catch (e) {
    console.error('[audit]', e)
  }
}

// ── Helpers ───────────────────────────────────────────────────

export async function readBody<T>(req: Request): Promise<T> {
  try { return (await req.json()) as T } catch { throw new ApiError(400, 'BAD_REQUEST', 'Invalid request body.') }
}

export function num(v: unknown, d = 0): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : d
}

export function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function requireStr(v: unknown, field: string, maxLen = 500): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) throw new ApiError(400, 'VALIDATION', `${field} is required.`)
  if (s.length > maxLen) throw new ApiError(400, 'VALIDATION', `${field} is too long.`)
  return s
}

export function nextInvoiceNo(prefix: string, seq: number): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `${prefix}${ymd}-${String(seq).padStart(5, '0')}`
}
