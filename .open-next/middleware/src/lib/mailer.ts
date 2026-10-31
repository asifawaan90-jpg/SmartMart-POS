import { db } from '@/lib/db'

export type SmtpConfig = {
  host: string
  port: number
  user: string
  pass: string
  from: string
}

/** PlatformConfig key holding the owner-managed SMTP config (JSON SmtpConfig). */
export const PLATFORM_SMTP_KEY = 'smtp'

/** Validate/normalize a stored JSON blob into an SmtpConfig (null when incomplete). */
export function parseSmtpData(raw: string): SmtpConfig | null {
  let s: Record<string, unknown>
  try { s = JSON.parse(raw) as Record<string, unknown> } catch { return null }
  const host = String(s.host || '').trim()
  const user = String(s.user || '').trim()
  // Gmail App Passwords are shown as "xxxx xxxx xxxx xxxx" — Google's SMTP rejects
  // them when the spaces are sent verbatim, so strip all whitespace (Task 40).
  const pass = String(s.pass || '').replace(/\s+/g, '')
  if (!host || !user || !pass) return null
  return {
    host,
    port: Number(s.port || 587),
    user,
    pass,
    from: String(s.from || user).trim(),
  }
}

/**
 * Platform-level SMTP: env vars first (SMTP_HOST/PORT/USER/PASS/FROM), then the
 * owner-managed config from the Platform Owner Panel (PlatformConfig 'smtp').
 * This mailbox belongs to the platform owner and delivers mail for every shop
 * that has not connected one of its own — so the per-user one-click "SMTP
 * active" switch always has something real to turn on.
 */
export async function platformSmtp(): Promise<SmtpConfig | null> {
  const envHost = String(process.env.SMTP_HOST || '').trim()
  const envUser = String(process.env.SMTP_USER || '').trim()
  const envPass = String(process.env.SMTP_PASS || '').replace(/\s+/g, '')
  if (envHost && envUser && envPass) {
    return {
      host: envHost,
      port: Number(process.env.SMTP_PORT || 587),
      user: envUser,
      pass: envPass,
      from: String(process.env.SMTP_FROM || envUser).trim(),
    }
  }

  // Owner-managed platform config (Platform Owner Panel → Email).
  const stored = await db.platformConfig.findUnique({ where: { key: PLATFORM_SMTP_KEY } })
  if (stored) {
    const cfg = parseSmtpData(stored.data)
    if (cfg) return cfg
  }
  return null
}

/**
 * Resolve SMTP configuration for sending mail:
 * 1. Platform mailbox (env vars or Platform Owner Panel) — see platformSmtp()
 * 2. Per-business settings (Settings → Mail & backup → Email delivery), when a businessId is given
 *
 * Used by password-reset emails (pre-login, no session), automatic backups and
 * the per-user test-email flow.
 */
export async function resolveSmtp(businessId?: string | null): Promise<SmtpConfig | null> {
  const plat = await platformSmtp()
  if (plat) return plat

  if (!businessId) return null
  const setting = await db.setting.findUnique({ where: { businessId } })
  let settings: Record<string, unknown> = {}
  try { settings = setting ? JSON.parse(setting.data) : {} } catch { settings = {} }
  const s = (settings.smtp || {}) as Record<string, string | number | boolean>
  // Task 43 — the shop's one-click "SMTP active" switch: an explicit OFF skips
  // this business's own SMTP (env / platform configs above are unaffected —
  // the platform owner's delivery must not be breakable per-tenant).
  if (s.active === false) return null
  const host = String(s.host || '').trim()
  const user = String(s.user || '').trim()
  const pass = String(s.pass || '').replace(/\s+/g, '')
  if (!host || !user || !pass) return null
  return {
    host,
    port: Number(s.port || 587),
    user,
    pass,
    from: String(s.from || user).trim(),
  }
}

/** Friendly reason for a failed SMTP attempt (used by UI + fallback messaging). */
export function smtpErrorMessage(e: unknown): string {
  const err = e as { code?: string; response?: string; message?: string }
  const raw = [err?.code, err?.response, err?.message].filter(Boolean).join(' ')
  if (/535|534|5\.7|EAUTH|BadCredentials|Username and Password not accepted|Invalid login|authentication/i.test(raw)) {
    return 'The mail server rejected the login. For Gmail you must use a 16-character App Password (Google Account → Security → 2-Step Verification → App passwords), not your normal account password.'
  }
  if (/ETIMEDOUT|ESOCKET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|connect|timeout|network/i.test(raw)) {
    return 'Could not reach the mail server — check the host and port, and that the server has internet access.'
  }
  if (/self[- ]signed|certificate|TLS|SSL|wrong version number/i.test(raw)) {
    return 'Secure connection to the mail server failed — use port 587 (STARTTLS) or 465 (SSL).'
  }
  if (/550|551|553|recipient|relay/i.test(raw)) {
    return 'The mail server refused the recipient — verify the "From" address matches the SMTP user.'
  }
  return 'Sending failed — check the host, port, user and app password.'
}

/** Send an email via SMTP. Returns ok=false (with a friendly error) when unconfigured or delivery failed. */
export async function sendMail(
  cfg: SmtpConfig,
  opts: { to: string; subject: string; html: string; text: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const nodemailer = await import('nodemailer')
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,
      auth: { user: cfg.user, pass: cfg.pass },
    })
    await transporter.sendMail({ from: cfg.from || cfg.user, ...opts })
    return { ok: true }
  } catch (e) {
    console.error('[mail] send failed:', e instanceof Error ? e.message : e)
    return { ok: false, error: smtpErrorMessage(e) }
  }
}

/** Branded password-reset-code email (HTML + plain-text fallback). */
export function resetCodeEmail(code: string, name: string, minutes = 30) {
  const html = `\
<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f5;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:480px;margin:0 auto;padding:24px 16px">
    <div style="background:#14532d;border-radius:12px 12px 0 0;padding:18px 24px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="background:#ffffff;color:#14532d;font-size:18px;font-weight:bold;border-radius:8px;width:32px;height:32px;text-align:center;vertical-align:middle">S</td>
        <td style="color:#ffffff;font-size:17px;font-weight:bold;padding-left:10px">SmartMart POS</td>
      </tr></table>
    </div>
    <div style="background:#ffffff;border-radius:0 0 12px 12px;padding:28px 24px;border:1px solid #e5e7eb;border-top:none">
      <p style="margin:0 0 6px;font-size:16px;font-weight:bold;color:#111827">Hi ${escapeHtml(name || 'there')},</p>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#374151">
        We received a request to reset your SmartMart POS password. Use the verification code below to set a new password:
      </p>
      <div style="text-align:center;margin:0 0 18px">
        <div style="display:inline-block;background:#f0fdf4;border:1px dashed #14532d;border-radius:10px;padding:14px 28px;font-size:30px;font-weight:bold;letter-spacing:8px;color:#14532d">${escapeHtml(code)}</div>
      </div>
      <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#374151">
        This code expires in <b>${minutes} minutes</b> and can be used once.
      </p>
      <p style="margin:0 0 0;font-size:13px;line-height:1.6;color:#6b7280">
        Didn't request a reset? You can safely ignore this email — your current password keeps working.
      </p>
    </div>
    <p style="text-align:center;margin:14px 0 0;font-size:11px;color:#9ca3af">SmartMart POS — offline-first grocery billing</p>
  </div>
</body></html>`

  const text = `Hi ${name || 'there'},\n\nYour SmartMart POS password reset code is: ${code}\n\nIt expires in ${minutes} minutes and can be used once.\nIf you didn't request a reset, you can safely ignore this email.\n\n— SmartMart POS`

  return { html, text }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c))
}
