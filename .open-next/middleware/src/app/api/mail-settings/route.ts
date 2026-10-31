import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, handleError, readBody, requireAuth, audit, clientIp, ApiError } from '@/lib/api'
import { platformSmtp } from '@/lib/mailer'

export const dynamic = 'force-dynamic'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function parseSettings(raw: string | null | undefined): Record<string, unknown> {
  try { return raw ? JSON.parse(raw) : {} } catch { return {} }
}

/** Strip the SMTP password before it reaches ANY client; expose computed flags. */
function redactSmtp(smtp: Record<string, unknown>): Record<string, unknown> {
  const out = { ...smtp }
  out.configured = Boolean(out.host) && Boolean(out.pass)
  // an explicit false means OFF; anything else (missing/true) means the one-click switch is ON
  out.active = out.active !== false
  delete out.pass
  return out
}

/**
 * Task 43 — "all user direct setting option".
 *
 * GET /api/mail-settings — the caller's business email settings (SMTP + backup
 * destination). Available to EVERY signed-in user of the business: mail setup
 * is the one settings area that is never role-gated, so any staff member can
 * connect the shop's mailbox, set the App Password and one-click activate
 * email delivery.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth(req)
    const setting = await db.setting.findUnique({ where: { businessId: ctx.businessId } })
    const data = parseSettings(setting?.data)
    return ok({
      smtp: redactSmtp((data.smtp || {}) as Record<string, unknown>),
      backup: (data.backup || {}) as Record<string, unknown>,
      // platform mailbox (Platform Owner Panel / env) — lets the UI keep the
      // one-click "SMTP active" switch working before the shop saves its own
      platformConfigured: Boolean(await platformSmtp()),
    })
  } catch (e) {
    return handleError(e)
  }
}

/**
 * PUT /api/mail-settings { smtp?, backup? } — save email settings, all users.
 * Only the `smtp` and `backup` keys are writable here (everything else in
 * Settings stays behind the 'settings' permission). The SMTP password is
 * write-only: a blank password keeps the saved one.
 */
export async function PUT(req: NextRequest) {
  try {
    const ctx = await requireAuth(req)
    const b = await readBody<{ smtp?: Record<string, unknown>; backup?: Record<string, unknown> }>(req)
    if (!b || (typeof b.smtp !== 'object' && typeof b.backup !== 'object')) {
      throw new ApiError(400, 'VALIDATION', 'Nothing to save — send smtp and/or backup settings.')
    }

    const current = await db.setting.findUnique({ where: { businessId: ctx.businessId } })
    const merged = parseSettings(current?.data)

    if (b.smtp && typeof b.smtp === 'object') {
      const saved = (merged.smtp || {}) as Record<string, unknown>
      const inc: Record<string, unknown> = { ...b.smtp }

      if (inc.user != null) {
        const user = String(inc.user).trim()
        if (user && !EMAIL_RE.test(user)) {
          throw new ApiError(400, 'VALIDATION', 'The SMTP user must be a valid email address, e.g. you@gmail.com')
        }
        inc.user = user
      }
      if (inc.host != null) inc.host = String(inc.host).trim().slice(0, 200)
      if (inc.from != null) inc.from = String(inc.from).trim().slice(0, 200)
      if (inc.port != null) {
        const p = Math.floor(Number(inc.port))
        inc.port = Math.min(65535, Math.max(1, Number.isFinite(p) && p > 0 ? p : 587))
      }
      if (inc.active != null) inc.active = Boolean(inc.active)
      if (inc.pass != null) inc.pass = String(inc.pass)
      // write-only password: blank keeps what is already saved
      if (!inc.pass && saved.pass) inc.pass = saved.pass

      merged.smtp = { ...saved, ...inc }
    }

    if (b.backup && typeof b.backup === 'object') {
      const saved = (merged.backup || {}) as Record<string, unknown>
      const inc: Record<string, unknown> = { ...b.backup }
      if (inc.ownerEmail != null) {
        const mail = String(inc.ownerEmail).trim()
        if (mail && !EMAIL_RE.test(mail)) {
          throw new ApiError(400, 'VALIDATION', 'The backup destination must be a valid email address.')
        }
        inc.ownerEmail = mail
      }
      if (inc.auto != null) inc.auto = Boolean(inc.auto)
      if (inc.ccUser != null) inc.ccUser = Boolean(inc.ccUser)
      if (inc.minIntervalMin != null) {
        const m = Math.floor(Number(inc.minIntervalMin))
        inc.minIntervalMin = Math.min(1440, Math.max(1, Number.isFinite(m) && m > 0 ? m : 30))
      }
      merged.backup = { ...saved, ...inc }
    }

    await db.setting.upsert({
      where: { businessId: ctx.businessId },
      create: { businessId: ctx.businessId, data: JSON.stringify(merged) },
      update: { data: JSON.stringify(merged) },
    })

    await audit(ctx.businessId, ctx.user.uid, 'MAIL_SETTINGS_UPDATED', 'Setting', ctx.businessId,
      { keys: [b.smtp ? 'smtp' : null, b.backup ? 'backup' : null].filter(Boolean) }, clientIp(req))

    return ok({
      smtp: redactSmtp((merged.smtp || {}) as Record<string, unknown>),
      backup: (merged.backup || {}) as Record<string, unknown>,
    })
  } catch (e) {
    return handleError(e)
  }
}
