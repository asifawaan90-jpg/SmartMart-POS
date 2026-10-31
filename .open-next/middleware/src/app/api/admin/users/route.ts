import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { ok, fail, handleError, readBody, clientIp, audit, ApiError } from '@/lib/api'
import { requireSuperAdmin } from '@/lib/admin'

export const dynamic = 'force-dynamic'

const BLOCKED_SUB = new Set(['EXPIRED', 'SUSPENDED', 'DEACTIVATED'])

/** Why a user is currently locked out — ISP-style service state. */
function blockReason(userIsActive: boolean, bizIsActive: boolean, subStatus: string): string {
  if (!userIsActive) return 'USER_DEACTIVATED'
  if (!bizIsActive) return 'BUSINESS_DEACTIVATED'
  if (BLOCKED_SUB.has(subStatus)) return `SUBSCRIPTION_${subStatus}`
  return ''
}

// GET /api/admin/users?search=&businessId=&status=all|active|deactivated|blocked
// Platform owner manages EVERY user across ALL businesses.
export async function GET(req: NextRequest) {
  try {
    await requireSuperAdmin(req)
    const url = new URL(req.url)
    const search = url.searchParams.get('search')?.trim() || ''
    const businessId = url.searchParams.get('businessId') || ''
    const status = url.searchParams.get('status') || 'all'

    const users = await db.user.findMany({
      where: {
        ...(businessId ? { businessId } : {}),
        ...(search ? { OR: [{ name: { contains: search } }, { email: { contains: search } }, { phone: { contains: search } }] } : {}),
      },
      include: {
        business: {
          select: { id: true, name: true, email: true, isActive: true, subscription: { include: { plan: { select: { name: true, code: true } } } } },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
    })

    const items = users.map(u => {
      const sub = u.business?.subscription
      const subStatus = sub?.status || 'NONE'
      const endDate = sub?.endDate ? new Date(sub.endDate) : null
      const daysRemaining = endDate && !BLOCKED_SUB.has(subStatus) && subStatus !== 'LIFETIME'
        ? Math.ceil((endDate.getTime() - Date.now()) / 86400000)
        : (subStatus === 'LIFETIME' ? null : 0)
      const reason = u.role === 'SUPER_ADMIN' ? '' : blockReason(u.isActive, u.business?.isActive ?? true, subStatus)
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        role: u.role,
        isActive: u.isActive,
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
        business: u.business ? {
          id: u.business.id, name: u.business.name, email: u.business.email,
          isActive: u.business.isActive,
          subStatus, planName: sub?.plan?.name || '', planCode: sub?.plan?.code || '',
          endDate: sub?.endDate ? sub.endDate : null,
          daysRemaining,
        } : null,
        blocked: !!reason,
        blockReason: reason,
      }
    })

    const filtered = status === 'active' ? items.filter(i => !i.blocked && i.isActive)
      : status === 'deactivated' ? items.filter(i => !i.isActive)
      : status === 'blocked' ? items.filter(i => i.blocked)
      : items

    const summary = {
      total: items.length,
      active: items.filter(i => !i.blocked).length,
      deactivated: items.filter(i => !i.isActive).length,
      blockedBySub: items.filter(i => i.blocked && i.isActive && i.blockReason !== 'USER_DEACTIVATED').length,
    }
    return ok({ items: filtered, summary })
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/admin/users — activate/deactivate users (single or whole business)
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req)
    const b = await readBody<{ action: string; userId?: string; businessId?: string; isActive?: boolean; password?: string }>(req)

    if (b.action === 'set_user_active') {
      if (!b.userId) return fail(400, 'VALIDATION', 'userId required.')
      const target = await db.user.findUnique({ where: { id: b.userId }, include: { business: { select: { name: true, email: true } } } })
      if (!target) return fail(404, 'NOT_FOUND', 'User not found.')
      if (target.role === 'SUPER_ADMIN') throw new ApiError(400, 'VALIDATION', 'The platform admin account cannot be deactivated here.')
      if (target.id === admin.uid) throw new ApiError(400, 'VALIDATION', 'You cannot deactivate yourself.')
      const next = b.isActive !== false
      if (target.role === 'OWNER' && !next) throw new ApiError(400, 'VALIDATION', 'The business owner account cannot be deactivated — suspend the business instead.')
      await db.user.update({ where: { id: target.id }, data: { isActive: next } })
      await db.notification.create({
        data: {
          businessId: target.businessId as string, type: 'ACCOUNT', emailTo: target.business?.email || '',
          title: next ? 'User access restored' : 'User access revoked',
          body: next
            ? `${target.name} (${target.email}) can sign in again.`
            : `${target.name} (${target.email}) has been deactivated by the platform and can no longer sign in.`,
        },
      })
      await audit(null, admin.uid, next ? 'ADMIN_USER_ACTIVATED' : 'ADMIN_USER_DEACTIVATED', 'User', target.id, { email: target.email }, clientIp(req))
      return ok({ id: target.id, isActive: next })
    }

    if (b.action === 'bulk_business') {
      if (!b.businessId) return fail(400, 'VALIDATION', 'businessId required.')
      const next = b.isActive !== false
      // Never touch the OWNER (they pay the bill) or platform admins.
      const res = await db.user.updateMany({
        where: { businessId: b.businessId, role: { notIn: ['OWNER', 'SUPER_ADMIN'] } },
        data: { isActive: next },
      })
      await db.notification.create({
        data: {
          businessId: b.businessId, type: 'ACCOUNT', emailTo: '',
          title: next ? 'All staff accounts activated' : 'All staff accounts deactivated',
          body: next
            ? `${res.count} staff account(s) can sign in again.`
            : `${res.count} staff account(s) were deactivated by the platform.`,
        },
      })
      await audit(null, admin.uid, next ? 'ADMIN_STAFF_BULK_ACTIVATED' : 'ADMIN_STAFF_BULK_DEACTIVATED', 'User', b.businessId, { count: res.count }, clientIp(req))
      return ok({ count: res.count, isActive: next })
    }

    if (b.action === 'set_password') {
      // Platform owner sets a NEW password for any business user (forgot-password
      // support). The platform admin account is protected — its owner uses the
      // normal change-password flow after signing in.
      if (!b.userId) return fail(400, 'VALIDATION', 'userId required.')
      const password = typeof b.password === 'string' ? b.password : ''
      if (password.length < 6) throw new ApiError(400, 'VALIDATION', 'Password must be at least 6 characters.')
      const target = await db.user.findUnique({ where: { id: b.userId } })
      if (!target) return fail(404, 'NOT_FOUND', 'User not found.')
      if (target.role === 'SUPER_ADMIN') throw new ApiError(400, 'VALIDATION', 'The platform admin password cannot be changed here.')
      await db.user.update({ where: { id: target.id }, data: { passwordHash: await hashPassword(password) } })
      if (target.businessId) {
        await db.notification.create({
          data: {
            businessId: target.businessId, type: 'ACCOUNT',
            emailTo: target.email,
            title: 'Password changed by platform',
            body: `The password for ${target.email} was set by the platform owner. Use the new password to sign in.`,
          },
        })
      }
      await audit(null, admin.uid, 'ADMIN_USER_PASSWORD_SET', 'User', target.id, { email: target.email }, clientIp(req))
      return ok({ id: target.id, message: `Password updated for ${target.name} (${target.email}).` })
    }

    if (b.action === 'delete_user') {
      // Platform owner permanently removes a staff account (e.g. a departed
      // employee or a wrong entry). Destructive and irreversible — the guard
      // rails mirror deactivate, but stricter:
      //   • SUPER_ADMIN  → the platform admin account itself is untouchable
      //   • self         → you cannot delete the account you are signed in with
      //   • OWNER        → the paying owner is the business's root account;
      //                    remove or suspend the BUSINESS instead
      if (!b.userId) return fail(400, 'VALIDATION', 'userId required.')
      const target = await db.user.findUnique({ where: { id: b.userId }, include: { business: { select: { name: true, email: true } } } })
      if (!target) return fail(404, 'NOT_FOUND', 'User not found.')
      if (target.role === 'SUPER_ADMIN') throw new ApiError(400, 'VALIDATION', 'The platform admin account cannot be deleted.')
      if (target.id === admin.uid) throw new ApiError(400, 'VALIDATION', 'You cannot delete yourself.')
      if (target.role === 'OWNER') throw new ApiError(400, 'VALIDATION', 'The business owner account cannot be deleted — suspend or remove the business instead.')
      // Audit logs are forensic history (platform-wide) — they must survive the
      // user. AuditLog.userId is optional WITHOUT cascade, so unlink first
      // (rows keep every detail, only the person link is cleared); Attendance,
      // PayrollItem and PasswordReset cascade away with the user by schema.
      await db.auditLog.updateMany({ where: { userId: target.id }, data: { userId: null } })
      await db.user.delete({ where: { id: target.id } })
      if (target.businessId) {
        await db.notification.create({
          data: {
            businessId: target.businessId, type: 'ACCOUNT', emailTo: target.business?.email || '',
            title: 'User account removed',
            body: `${target.name} (${target.email}) was permanently removed from your business by the platform owner. The email address is now free for a new account.`,
          },
        })
      }
      await audit(null, admin.uid, 'ADMIN_USER_DELETED', 'User', target.id, { email: target.email, name: target.name, role: target.role }, clientIp(req))
      return ok({ id: target.id, message: `User deleted: ${target.name} (${target.email}).` })
    }

    return fail(400, 'VALIDATION', 'Unknown action.')
  } catch (e) {
    return handleError(e)
  }
}
