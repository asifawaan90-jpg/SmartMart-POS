import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, fail, handleError, readBody, requireAuth, requirePerm, requireActiveSub, audit, clientIp,
} from '@/lib/api'
import { platformSmtp } from '@/lib/mailer'

export const dynamic = 'force-dynamic'

/** Strip SMTP password from settings before they reach ANY client (password is write-only). */
function redactSettings(s: Record<string, unknown>): Record<string, unknown> {
  if (s && typeof s === 'object' && s.smtp && typeof s.smtp === 'object') {
    const smtp = { ...(s.smtp as Record<string, unknown>) }
    smtp.configured = Boolean(smtp.host) && Boolean(smtp.pass)
    delete smtp.pass
    return { ...s, smtp }
  }
  return s
}

// GET /api/settings — business + settings JSON (Task 43: any signed-in user can
// load this — the Settings view now opens for every role; the SMTP password is
// always redacted below, and saves stay behind the 'settings' permission).
// `mail.platformConfigured` tells the UI the platform mailbox (Platform Owner
// Panel / env) is available, so the one-click SMTP switch works even before
// the shop connects its own App Password.
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth(req)
    const [business, setting] = await Promise.all([
      db.business.findUnique({ where: { id: ctx.businessId } }),
      db.setting.findUnique({ where: { businessId: ctx.businessId } }),
    ])
    return ok({
      business: business && {
        id: business.id, name: business.name, ownerName: business.ownerName, email: business.email,
        phone: business.phone, address: business.address, currency: business.currency, logo: business.logo, bizType: business.bizType,
      },
      settings: redactSettings(setting ? JSON.parse(setting.data) : {}),
      mail: { platformConfigured: Boolean(await platformSmtp()) },
    })
  } catch (e) {
    return handleError(e)
  }
}

// PUT /api/settings — update business info and/or settings sections
export async function PUT(req: NextRequest) {
  try {
    const b = await readBody<{
      business?: Record<string, unknown>
      settings?: Record<string, unknown>
    }>(req)
    // Task 54 — a patch that carries ONLY the account-wide UI language is
    // allowed for EVERY signed-in user: the language picker lives in the
    // app-shell account menu and Settings, where non-privileged roles
    // (cashier etc.) must be able to switch language without holding the
    // 'settings' permission. Values are validated against the shipped set.
    const langPatch = b.settings && !b.business
      && Object.keys(b.settings).length === 1 && typeof b.settings.lang === 'string'
      ? (b.settings.lang as string) : null
    const VALID_LANGS = new Set(['en', 'ur', 'ar', 'hi', 'bn', 'tr', 'fr', 'es'])
    if (langPatch !== null && !VALID_LANGS.has(langPatch)) {
      return fail(400, 'VALIDATION', 'Unknown language.')
    }
    const ctx = langPatch !== null ? await requireAuth(req) : await requirePerm(req, 'settings')
    if (langPatch === null) await requireActiveSub(ctx)

    if (b.business) {
      const data: Record<string, unknown> = {}
      const bb = b.business
      if (bb.name != null) data.name = String(bb.name).slice(0, 120)
      if (bb.ownerName != null) data.ownerName = String(bb.ownerName).slice(0, 100)
      if (bb.phone != null) data.phone = String(bb.phone).slice(0, 30)
      if (bb.address != null) data.address = String(bb.address).slice(0, 300)
      if (bb.currency != null) data.currency = String(bb.currency).slice(0, 10)
      if (bb.bizType != null) data.bizType = String(bb.bizType).slice(0, 40)
      if (bb.logo !== undefined) data.logo = typeof bb.logo === 'string' ? bb.logo.slice(0, 500_000) : ''
      await db.business.update({ where: { id: ctx.businessId }, data })
    }

    if (b.settings && Object.keys(b.settings).length > 0) {
      const current = await db.setting.findUnique({ where: { businessId: ctx.businessId } })
      const currentData: Record<string, unknown> = current ? JSON.parse(current.data) : {}
      // SMTP password is write-only: if the client sends smtp without a password, keep the saved one
      if (b.settings.smtp && typeof b.settings.smtp === 'object') {
        const incoming = b.settings.smtp as Record<string, unknown>
        const saved = (currentData.smtp || {}) as Record<string, unknown>
        if (!incoming.pass && saved.pass) incoming.pass = saved.pass
      }
      // Task 54 — never let the narrow lang-only patch CLOBBER anything: it
      // merges one key into the existing blob like any other section patch.
      const merged = { ...currentData, ...b.settings }
      await db.setting.upsert({
        where: { businessId: ctx.businessId },
        create: { businessId: ctx.businessId, data: JSON.stringify(merged) },
        update: { data: JSON.stringify(merged) },
      })
    }

    await audit(ctx.businessId, ctx.user.uid, 'SETTINGS_UPDATED', 'Setting', ctx.businessId, { keys: Object.keys(b.settings || b.business || {}) }, clientIp(req))
    const setting = await db.setting.findUnique({ where: { businessId: ctx.businessId } })
    const business = await db.business.findUnique({ where: { id: ctx.businessId } })
    return ok({
      business: business && {
        id: business.id, name: business.name, ownerName: business.ownerName, email: business.email,
        phone: business.phone, address: business.address, currency: business.currency, logo: business.logo, bizType: business.bizType,
      },
      settings: redactSettings(setting ? JSON.parse(setting.data) : {}),
      mail: { platformConfigured: Boolean(await platformSmtp()) },
    })
  } catch (e) {
    return handleError(e)
  }
}
void fail
