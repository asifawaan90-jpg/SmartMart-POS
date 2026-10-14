import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, fail, handleError, readBody, requireAuth, requireActiveSub, audit, clientIp,
} from '@/lib/api'
import { collectBackupData } from '@/lib/backup'
import { buildWorkbookBytes, buildSummaryText, backupFilename } from '@/lib/backup-shared'

export const dynamic = 'force-dynamic'

/**
 * POST /api/backup/email  { email?: string, emails?: string[] }
 * Builds a multi-sheet Excel workbook of ALL business data and emails it
 * as an attachment. Default destination: the owner's email (business email);
 * `emails` adds more recipients (e.g. a copy to the acting user's email) —
 * used by both the manual button and the Cloud sync "Send now" button.
 *
 * SMTP comes from Settings → Mail & backup (stored per-business, password
 * write-only) or via platform env vars SMTP_HOST / SMTP_PORT / SMTP_USER /
 * SMTP_PASS / SMTP_FROM. Available to every signed-in user of the business
 * (Task 43 — all-user direct option), audit-logged.
 */
export async function POST(req: NextRequest) {
  try {
    // Task 43 — every signed-in user of the business can email the shop's backup
    const ctx = await requireAuth(req)
    await requireActiveSub(ctx)

    const body = await readBody<{ email?: string; emails?: string[] }>(req).catch(() => ({ email: '', emails: [] }))

    const [business, setting] = await Promise.all([
      db.business.findUnique({ where: { id: ctx.businessId } }),
      db.setting.findUnique({ where: { businessId: ctx.businessId } }),
    ])
    let settings: Record<string, unknown> = {}
    try { settings = setting ? JSON.parse(setting.data) : {} } catch { settings = {} }

    // SMTP config: per-business settings first, platform env as fallback
    const s = (settings.smtp || {}) as Record<string, string | number | boolean>
    const host = String(s.host || process.env.SMTP_HOST || '').trim()
    const port = Number(s.port || process.env.SMTP_PORT || 587)
    const user = String(s.user || process.env.SMTP_USER || '').trim()
    // Gmail App Passwords are shown with spaces — strip whitespace or Gmail rejects the login
    const pass = String(s.pass || process.env.SMTP_PASS || '').replace(/\s+/g, '')
    const from = String(s.from || process.env.SMTP_FROM || user || '').trim()

    if (!host || !user || !pass) {
      return fail(400, 'SMTP_NOT_CONFIGURED',
        'Email backup needs SMTP. Open Settings → Mail & backup, enter your email + App Password and tap "Save & turn on".')
    }

    const to = String(body.email || business?.email || '').trim()
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    const recipients: string[] = []
    const push = (v: unknown) => {
      const s = String(v || '').trim()
      if (EMAIL_RE.test(s) && !recipients.includes(s)) recipients.push(s)
    }
    push(to)
    if (Array.isArray(body.emails)) body.emails.forEach(push)
    if (recipients.length === 0) {
      return fail(400, 'BAD_EMAIL', 'Enter a valid destination email address.')
    }

    // collect + build workbook
    const data = await collectBackupData(ctx.businessId)
    const bytes = buildWorkbookBytes(data)
    const filename = backupFilename(data.meta.businessName, 'xlsx')

    const nodemailer = await import('nodemailer')
    const transporter = nodemailer.createTransport({
      host, port,
      secure: port === 465,
      auth: { user, pass },
    })

    const subject = `SmartMart backup — ${data.meta.businessName} — ${new Date().toLocaleDateString('en-CA')}`
    await transporter.sendMail({
      from: from || user,
      to: recipients.join(', '),
      subject,
      text: buildSummaryText(data),
      attachments: [{
        filename,
        content: Buffer.from(bytes),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }],
    })

    await audit(ctx.businessId, ctx.user.uid, 'BACKUP_EMAILED', 'Business', ctx.businessId,
      { to: recipients, filename, counts: data.meta.counts }, clientIp(req))

    return ok({
      sent: true, to: recipients.join(', '), filename,
      counts: data.meta.counts,
      exportedAt: data.meta.exportedAt,
    })
  } catch (e) {
    // surface common SMTP failures in plain language
    const msg = e instanceof Error ? e.message : ''
    if (/auth|login|credential|535|534/i.test(msg)) {
      return fail(502, 'SMTP_AUTH', 'SMTP rejected the login. Check the email/password (Gmail needs an App Password, not the account password).')
    }
    if (/connect|timeout|ENOTFOUND|ECONNREFUSED/i.test(msg)) {
      return fail(502, 'SMTP_CONNECT', 'Could not reach the SMTP server. Check host/port and your network.')
    }
    return handleError(e)
  }
}
