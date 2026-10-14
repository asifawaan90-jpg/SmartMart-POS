import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail, handleError, readBody, audit, ApiError, requireStr } from '@/lib/api'
import { requireSuperAdmin } from '@/lib/admin'
import {
  PLATFORM_SMTP_KEY, parseSmtpData, resolveSmtp, sendMail,
} from '@/lib/mailer'

export const dynamic = 'force-dynamic'

// GET /api/admin/smtp — current email-delivery status (password never returned).
export async function GET(req: NextRequest) {
  try {
    await requireSuperAdmin(req)
    const envActive = Boolean(
      String(process.env.SMTP_HOST || '').trim()
      && String(process.env.SMTP_USER || '').trim()
      && String(process.env.SMTP_PASS || ''),
    )
    const stored = await db.platformConfig.findUnique({ where: { key: PLATFORM_SMTP_KEY } })
    const dbCfg = stored ? parseSmtpData(stored.data) : null
    return ok({
      // What the owner typed into this panel (masked) — independent of env.
      saved: dbCfg
        ? { configured: true, source: 'database', host: dbCfg.host, port: dbCfg.port, user: dbCfg.user, from: dbCfg.from, passSet: true }
        : { configured: false, source: 'database', host: '', port: 587, user: '', from: '', passSet: false },
      envActive,
      effectiveConfigured: Boolean(await resolveSmtp(null)),
      effectiveSource: envActive ? 'environment' : dbCfg ? 'database' : 'none',
    })
  } catch (e) {
    return handleError(e)
  }
}

// PUT /api/admin/smtp — save the owner's SMTP config (blank password keeps the saved one).
export async function PUT(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req)
    const b = await readBody<Record<string, unknown>>(req)
    const host = requireStr(b.host, 'SMTP host', 200).trim()
    const user = requireStr(b.user, 'SMTP user', 200).trim()
    const port = Math.min(65535, Math.max(1, Math.floor(Number(b.port) || 587)))
    const from = typeof b.from === 'string' ? b.from.trim().slice(0, 200) : ''
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(user)) throw new ApiError(400, 'VALIDATION', 'SMTP user must be a valid email address.')

    const existing = await db.platformConfig.findUnique({ where: { key: PLATFORM_SMTP_KEY } })
    const prev = existing ? (JSON.parse(existing.data) as Record<string, unknown>) : {}
    const pass = typeof b.pass === 'string' && b.pass ? b.pass : String(prev.pass || '')
    if (!pass) throw new ApiError(400, 'VALIDATION', 'SMTP password / app password is required.')

    const data = JSON.stringify({ host, port, user, pass, from: from || user })
    await db.platformConfig.upsert({
      where: { key: PLATFORM_SMTP_KEY },
      create: { key: PLATFORM_SMTP_KEY, data },
      update: { data },
    })
    await audit(null, admin.uid, 'ADMIN_SMTP_SAVED', 'PlatformConfig', PLATFORM_SMTP_KEY, { host, port, user }, req.headers.get('x-forwarded-for') || '')
    return ok({ message: 'Email delivery settings saved.' })
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/admin/smtp — remove the saved config (falls back to env, then dev-code flow).
export async function DELETE(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req)
    await db.platformConfig.deleteMany({ where: { key: PLATFORM_SMTP_KEY } })
    await audit(null, admin.uid, 'ADMIN_SMTP_REMOVED', 'PlatformConfig', PLATFORM_SMTP_KEY, {}, req.headers.get('x-forwarded-for') || '')
    return ok({ message: 'Email delivery settings removed.' })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/admin/smtp — send a test email using the effective config (env or saved).
export async function POST(req: NextRequest) {
  try {
    await requireSuperAdmin(req)
    const b = await readBody<Record<string, unknown>>(req)
    const to = requireStr(b.to, 'Test recipient', 200).trim().toLowerCase()
    const cfg = await resolveSmtp(null)
    if (!cfg) throw new ApiError(400, 'NO_SMTP', 'No email delivery configured yet — save your SMTP settings first.')
    const r = await sendMail(cfg, {
      to,
      subject: 'SmartMart POS — test email',
      html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:20px">
        <h2 style="color:#0c59d8;margin:0 0 8px">Email delivery works!</h2>
        <p style="color:#374151;font-size:14px;line-height:1.6">This is a test email from your SmartMart POS platform.
        Password-reset codes and business notifications will now arrive from <b>${cfg.user}</b>.</p>
      </div>`,
      text: 'SmartMart POS — email delivery works. Password-reset codes will arrive from ' + cfg.user + '.',
    })
    if (!r.ok) {
      return fail(502, 'SEND_FAILED', r.error || 'Sending failed — check host/port/user/app password.')
    }
    return ok({ message: `Test email sent to ${to} — check the inbox (and spam folder).` })
  } catch (e) {
    return handleError(e)
  }
}
