import { NextRequest } from 'next/server'
import { ok, fail, handleError, readBody, audit } from '@/lib/api'
import { requireSuperAdmin } from '@/lib/admin'
import {
  getPlatformBackupCfg, writePlatformBackupCfg, getPlatformOwnerEmails,
  emailPlatformBackupNow, collectAllBusinessesData,
} from '@/lib/platform-backup'
import { resolveSmtp } from '@/lib/mailer'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/backup — platform cloud-backup status for the Owner Panel:
 * config, the derived "owner mail" recipients (SUPER_ADMIN emails), the
 * business list covered by the backup, and whether a mail path is configured.
 */
export async function GET(req: NextRequest) {
  try {
    await requireSuperAdmin(req)
    const [cfg, owners, businesses, smtp] = await Promise.all([
      getPlatformBackupCfg(),
      getPlatformOwnerEmails(),
      collectAllBusinessesData(),
      resolveSmtp(null),
    ])
    return ok({
      cfg,
      ownerEmails: owners,
      businesses: businesses.map(b => ({
        id: b.id, name: b.name, email: b.email,
        counts: b.data ? b.data.meta.counts : null,
        error: b.error || null,
      })),
      smtpConfigured: Boolean(smtp),
      smtpUser: smtp?.user || '',
    })
  } catch (e) {
    return handleError(e)
  }
}

/**
 * PUT /api/admin/backup — save the automatic platform backup configuration.
 * Body: { auto?: boolean, minIntervalMin?: number, ccUserMail?: boolean }
 */
export async function PUT(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req)
    const b = await readBody<Record<string, unknown>>(req)
    const patch: Record<string, unknown> = {}
    if (typeof b.auto === 'boolean') patch.auto = b.auto
    if (b.minIntervalMin !== undefined) patch.minIntervalMin = Number(b.minIntervalMin)
    if (typeof b.ccUserMail === 'boolean') patch.ccUserMail = b.ccUserMail
    const cfg = await writePlatformBackupCfg(patch)
    await audit(null, admin.uid, 'PLATFORM_BACKUP_CFG_SAVED', 'PlatformConfig', 'backup', { ...cfg }, req.headers.get('x-forwarded-for') || '')
    return ok({ cfg })
  } catch (e) {
    return handleError(e)
  }
}

/**
 * POST /api/admin/backup — "save all users data in owner mail" right now:
 * collects EVERY business's full snapshot and emails one Excel attachment per
 * business to the platform owner mail (SUPER_ADMIN emails) + the user-given
 * mail (ccUserMail). Bypasses the automatic throttle. Audit-logged.
 */
export async function POST(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req)
    const r = await emailPlatformBackupNow(
      { uid: admin.uid, name: admin.name || '', email: admin.email || '' },
      'manual:platform-panel',
    )
    if (!r.sent) {
      const map: Record<string, { status: number; msg: string }> = {
        SMTP_NOT_CONFIGURED: { status: 400, msg: 'Email delivery is not configured yet. Open Platform Owner Panel → Email and save your SMTP / Gmail App Password (or set SMTP_* env vars).' },
        NO_OWNER_EMAIL: { status: 400, msg: 'No platform owner email found — create an active SUPER_ADMIN account first.' },
        COLLECT_FAILED: { status: 500, msg: 'Could not collect business data for the backup.' },
        SMTP_SEND_FAILED: { status: 502, msg: r.error || 'The mail server rejected the backup email.' },
      }
      const m = map[r.code || ''] || { status: 500, msg: r.error || 'Backup email failed.' }
      return fail(m.status, r.code || 'BACKUP_FAILED', m.msg)
    }
    await audit(null, admin.uid, 'PLATFORM_BACKUP_SENT_MANUAL', 'PlatformConfig', 'backup', { to: r.to, files: r.files, businesses: r.businesses }, req.headers.get('x-forwarded-for') || '')
    return ok({ sent: true, to: r.to, files: r.files, businesses: r.businesses })
  } catch (e) {
    return handleError(e)
  }
}
