import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, verifyPassword, signToken, verifyToken } from '@/lib/auth'
import {
  ApiError, ok, fail, handleError, readBody, requireStr,
  rateLimit, clientIp, audit, getSubscription,
} from '@/lib/api'
import { resolveSmtp, sendMail, resetCodeEmail } from '@/lib/mailer'

export const dynamic = 'force-dynamic'

export const DEFAULT_SETTINGS = {
  currency: 'PKR',
  taxEnabled: false,
  defaultTaxRate: 0,
  theme: 'classic',
  receipt: { width: 80, showLogo: true, footer: 'Thank you for shopping with us!', phone: '' },
  invoice: { prefix: 'INV-' },
  purchasePrefix: 'PUR-',
  barcode: { strategy: 'EAN13_INTERNAL', autoGenerate: true, labelWidth: 50, labelHeight: 30, copies: 1 },
  shortcuts: { search: 'F1', newSale: 'F2', hold: 'F4', payment: 'F8', close: 'Escape' },
  notifications: { trialReminders: true, lowStock: true },
  ownerEmail: '',
}

const DEFAULT_UNITS = [
  { name: 'Piece', shortName: 'pcs' }, { name: 'Kilogram', shortName: 'kg' },
  { name: 'Gram', shortName: 'g' }, { name: 'Litre', shortName: 'L' },
  { name: 'Dozen', shortName: 'dzn' }, { name: 'Pack', shortName: 'pack' },
]

const DEFAULT_EXPENSE_CATS = ['Rent', 'Electricity', 'Salary', 'Transport', 'Internet', 'Maintenance', 'Other']

export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params
  const ip = clientIp(req)
  try {
    const body = action === 'logout' ? {} : await readBody<Record<string, unknown>>(req)

    // ── REGISTER ───────────────────────────────────────────────
    if (action === 'register') {
      if (!rateLimit(`reg:${ip}`, 5, 3600_000)) return fail(429, 'RATE_LIMIT', 'Too many attempts. Try again later.')
      const name = requireStr(body.name, 'Owner name', 100)
      const bizName = requireStr(body.businessName, 'Business name', 120)
      const email = requireStr(body.email, 'Email', 200).toLowerCase()
      const phone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 30) : ''
      const password = requireStr(body.password, 'Password', 100)
      const bizType = typeof body.bizType === 'string' ? body.bizType : 'grocery'
      if (password.length < 6) throw new ApiError(400, 'VALIDATION', 'Password must be at least 6 characters.')
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, 'VALIDATION', 'Please enter a valid email address.')

      const existing = await db.user.findUnique({ where: { email } })
      if (existing) return fail(409, 'DUPLICATE', 'An account with this email already exists.')

      const trialPlan = await db.subscriptionPlan.upsert({
        where: { code: 'TRIAL' },
        update: {},
        create: {
          code: 'TRIAL',
          name: 'Free Trial',
          price: 0,
          durationDays: 7,
          sortOrder: 0,
          features: JSON.stringify(['All features for 7 days', 'POS + Inventory + Reports', 'No credit card required']),
          limits: JSON.stringify({ users: 3, products: 500 }),
        },
      })

      const passwordHash = await hashPassword(password)
      const days = trialPlan.durationDays > 0 ? trialPlan.durationDays : 7
      const endDate = new Date(Date.now() + days * 86400000)

      const business = await db.business.create({
        data: {
          name: bizName, ownerName: name, email, phone, bizType,
          users: { create: { name, email, phone, passwordHash, role: 'OWNER' } },
          subscription: {
            create: {
              planId: trialPlan.id, status: 'TRIAL',
              startDate: new Date(), endDate,
            },
          },
          settings: { create: { data: JSON.stringify({ ...DEFAULT_SETTINGS, ownerEmail: email }) } },
          categories: { create: ['Grocery', 'Beverages', 'Snacks', 'Dairy', 'Bakery', 'Household', 'Personal Care', 'Stationery'].map(n => ({ name: n })) },
          units: { create: DEFAULT_UNITS.map(u => ({ ...u })) },
          notifications: {
            create: {
              type: 'TRIAL', emailTo: email,
              title: 'Welcome to SmartMart!',
              body: `Your ${days}-day free trial has started. It expires on ${endDate.toLocaleDateString()}.`,
            },
          },
        },
      })
      await db.expenseCategory.createMany({
        data: DEFAULT_EXPENSE_CATS.map(n => ({ businessId: business.id, name: n })),
      })

      const user = await db.user.findFirst({ where: { businessId: business.id, email } })
      if (!user) throw new ApiError(500, 'REG_FAIL', 'Registration failed. Please try again.')

      await audit(business.id, user.id, 'REGISTER', 'Business', business.id, { bizName, email }, ip)
      await audit(business.id, user.id, 'TRIAL_STARTED', 'Subscription', business.id, { days, endDate: endDate.toISOString() }, ip)

      const token = await signToken({ uid: user.id, bid: business.id, role: user.role, name: user.name, email: user.email })
      // Task 57 — return the fresh subscription like login does, so the store
      // holds the true TRIAL state immediately (no null gap after registering).
      const subscription = await getSubscription(business.id)
      return ok({ token, user: safeUser(user), subscription })
    }

    // ── LOGIN ──────────────────────────────────────────────────
    if (action === 'login') {
      // Task 61 — dual limiter: the old IP-only bucket (10/15min) shared ONE
      // budget across every staff member behind the same shop router, so a
      // busy shop locked ITSELF out (the owner's Oct 2–4 LOGIN_FAILED trail
      // shows exactly that). Now: a generous per-IP ceiling (NAT-friendly)
      // PLUS a strict per-account wall that still caps brute-force at 10
      // tries per 15 minutes for any single email.
      if (!rateLimit(`login:${ip}`, 30, 15 * 60_000)) {
        return fail(429, 'RATE_LIMIT', 'Too many login attempts from this network. Please wait 15 minutes.')
      }
      const email = requireStr(body.email, 'Email', 200).toLowerCase()
      if (!rateLimit(`login:acct:${email}`, 10, 15 * 60_000)) {
        return fail(429, 'RATE_LIMIT', `Too many login attempts for ${email}. Please wait 15 minutes.`)
      }
      const password = requireStr(body.password, 'Password', 100)
      const remember = body.remember === true
      const user = await db.user.findUnique({ where: { email } })
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        await audit(null, null, 'LOGIN_FAILED', 'User', email, { email }, ip)
        return fail(401, 'BAD_CREDENTIALS', 'Incorrect email or password.')
      }
      if (!user.isActive) return fail(403, 'INACTIVE', 'Your account has been deactivated. Contact support.')

      // ISP-style access control — check the SERVICE state of the business account
      // after credentials are valid. Deactivated business → nobody signs in.
      // Subscription past its due date (expired/suspended) → staff locked out;
      // the OWNER still gets in so they can pay the bill and reactivate.
      let sub: Awaited<ReturnType<typeof getSubscription>> | null = null
      if (user.businessId) {
        const biz = await db.business.findUnique({ where: { id: user.businessId }, select: { isActive: true } })
        if (biz && !biz.isActive) {
          return fail(403, 'ACCOUNT_BLOCKED', 'This account has been deactivated by the platform. Please contact support.')
        }
        sub = await getSubscription(user.businessId)
        const serviceOff = sub.status === 'EXPIRED' || sub.status === 'SUSPENDED' || sub.status === 'DEACTIVATED'
        if (serviceOff && user.role !== 'OWNER') {
          const due = sub.endDate ? ` (was due ${new Date(sub.endDate).toLocaleDateString()})` : ''
          return fail(402, 'SUBSCRIPTION_BLOCKED', `Subscription ${sub.status.toLowerCase()}${due}. Only the business owner can sign in to pay and reactivate.`)
        }
      }

      await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
      await audit(user.businessId, user.id, 'LOGIN', 'User', user.id, {}, ip)
      const token = await signToken(
        { uid: user.id, bid: user.businessId, role: user.role, name: user.name, email: user.email },
        remember ? '30d' : '7d'
      )
      return ok({ token, user: safeUser(user), subscription: sub })
    }

    // ── FORGOT PASSWORD ────────────────────────────────────────
    if (action === 'forgot-password') {
      if (!rateLimit(`fp:${ip}`, 5, 15 * 60_000)) return fail(429, 'RATE_LIMIT', 'Too many attempts. Try later.')
      const email = requireStr(body.email, 'Email', 200).toLowerCase()
      const user = await db.user.findUnique({ where: { email } })
      if (!user) {
        // Keep account existence private, and do not claim that a code was generated.
        return ok({ message: 'If an account uses that email, a reset code will be sent when email delivery is configured.' })
      }
      const code = String(Math.floor(100000 + Math.random() * 900000))
      const codeHash = await hashPassword(code)
      await db.passwordReset.upsert({
        where: { userId: user.id },
        create: { userId: user.id, codeHash, expiresAt: new Date(Date.now() + 30 * 60_000) },
        update: { codeHash, expiresAt: new Date(Date.now() + 30 * 60_000), usedAt: null },
      })
      await audit(user.businessId, user.id, 'PASSWORD_RESET_REQUESTED', 'User', user.id, {}, ip)
      // Email the code to the account address: platform SMTP env first, then the
      // user's business SMTP (Settings → Backup). Without any SMTP, devCode is
      // returned so the demo flow stays usable; no code leaks once mail is on.
      // If SMTP IS configured but sending fails, devCode still returns (with the
      // mailError reason) so nobody is ever locked out.
      const smtp = await resolveSmtp(user.businessId)
      const mail = smtp
        ? await sendMail(smtp, {
            to: user.email,
            subject: 'SmartMart POS — password reset code',
            ...resetCodeEmail(code, user.name),
          })
        : null
      if (mail?.ok) console.log(`[auth] reset code emailed to ${email}`)
      return ok({
        message: mail?.ok
          ? `A 6-digit reset code was sent to ${email}. It expires in 30 minutes.`
          : mail?.error
            ? 'Email delivery failed. Use the reset code shown below to continue.'
            : 'Email delivery is not configured. Use the reset code shown below to continue.',
        ...(mail?.ok ? {} : { devCode: code, ...(mail?.error ? { mailError: mail.error } : {}) }),
      })
    }

    // ── RESET PASSWORD ─────────────────────────────────────────
    if (action === 'reset-password') {
      if (!rateLimit(`rp:${ip}`, 10, 15 * 60_000)) return fail(429, 'RATE_LIMIT', 'Too many attempts.')
      const email = requireStr(body.email, 'Email', 200).toLowerCase()
      const code = requireStr(body.code, 'Reset code', 10)
      const password = requireStr(body.password, 'New password', 100)
      if (password.length < 6) throw new ApiError(400, 'VALIDATION', 'Password must be at least 6 characters.')
      const user = await db.user.findUnique({ where: { email }, include: { resets: true } })
      const reset = user?.resets?.[0]
      if (!user || !reset || reset.usedAt || reset.expiresAt.getTime() < Date.now() || !(await verifyPassword(code, reset.codeHash))) {
        return fail(400, 'INVALID_CODE', 'Invalid or expired reset code.')
      }
      const passwordHash = await hashPassword(password)
      await db.$transaction([
        db.user.update({ where: { id: user.id }, data: { passwordHash } }),
        db.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
      ])
      await audit(user.businessId, user.id, 'PASSWORD_RESET', 'User', user.id, {}, ip)
      return ok({ message: 'Password updated. You can now sign in.' })
    }

    // ── CHANGE PASSWORD (authed) ───────────────────────────────
    if (action === 'change-password') {
      const session = await verifyToken((req.headers.get('authorization') || '').replace('Bearer ', ''))
      if (!session) return fail(401, 'UNAUTHENTICATED', 'Please sign in.')
      const user = await db.user.findUnique({ where: { id: session.uid } })
      if (!user) return fail(401, 'UNAUTHENTICATED', 'Please sign in.')
      const current = requireStr(body.currentPassword, 'Current password', 100)
      const next = requireStr(body.newPassword, 'New password', 100)
      if (next.length < 6) throw new ApiError(400, 'VALIDATION', 'New password must be at least 6 characters.')
      if (!(await verifyPassword(current, user.passwordHash))) return fail(400, 'BAD_CREDENTIALS', 'Current password is incorrect.')
      await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(next) } })
      await audit(user.businessId, user.id, 'PASSWORD_CHANGED', 'User', user.id, {}, ip)
      return ok({ message: 'Password changed.' })
    }

    if (action === 'logout') {
      return ok({ message: 'Signed out.' })
    }

    return fail(404, 'NOT_FOUND', 'Unknown auth action.')
  } catch (e) {
    return handleError(e)
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params
  try {
    if (action !== 'me') return fail(404, 'NOT_FOUND', 'Unknown auth action.')
    const session = await verifyToken((req.headers.get('authorization') || '').replace('Bearer ', ''))
    if (!session) return fail(401, 'UNAUTHENTICATED', 'Session expired. Please sign in again.')
    const user = await db.user.findUnique({ where: { id: session.uid } })
    if (!user || !user.isActive) return fail(401, 'UNAUTHENTICATED', 'Account unavailable.')
    let sub: Awaited<ReturnType<typeof getSubscription>> | null = null
    let business: Awaited<ReturnType<typeof db.business.findUnique>> = null
    let settings: unknown = null
    if (user.businessId) {
      sub = await getSubscription(user.businessId)
      business = await db.business.findUnique({ where: { id: user.businessId } })
      const s = await db.setting.findUnique({ where: { businessId: user.businessId } })
      settings = s ? JSON.parse(s.data) : DEFAULT_SETTINGS
    }
    return ok({
      user: safeUser(user), subscription: sub,
      business: business ? {
        id: business.id, name: business.name, ownerName: business.ownerName, email: business.email,
        phone: business.phone, address: business.address, currency: business.currency, logo: business.logo, bizType: business.bizType,
      } : null,
      settings,
    })
  } catch (e) {
    return handleError(e)
  }
}

function safeUser(u: { id: string; name: string; email: string; role: string; businessId: string | null; phone: string }) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, businessId: u.businessId, phone: u.phone }
}
