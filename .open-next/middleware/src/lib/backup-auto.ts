/**
 * Task 40 — automatic cloud backup on data save.
 *
 * When the owner enables it (Settings → Backup → Cloud sync & backup), every
 * meaningful data change (sale, purchase, khata payment, expense, product)
 * triggers an Excel snapshot of ALL business data emailed to:
 *   1. the owner's email (business email, or an explicit owner email), and
 *   2. a copy to the email of the user who saved the data (optional).
 *
 * The data then always lives in the cloud (Gmail/IMAP mail stores) even if the
 * shop device is lost — "user data save in owner mail".
 *
 * Trigger policy:
 * - fire-and-forget from API routes (never blocks or fails the request),
 * - throttled to one auto-email per business per `minIntervalMin` minutes
 *   (in-session edits between emails are captured by the NEXT email),
 * - manual "Send backup now" from Settings always sends immediately,
 * - when SMTP is not configured a single throttled audit row explains why,
 *   so the owner can see the feature needs their SMTP / Gmail App Password.
 */
import { db } from '@/lib/db'
import { collectBackupData } from '@/lib/backup'
import { buildWorkbookBytes, buildSummaryText, backupFilename } from '@/lib/backup-shared'
import { resolveSmtp } from '@/lib/mailer'
import { maybePlatformBackup } from '@/lib/platform-backup'

export interface AutoBackupConfig {
  auto: boolean
  minIntervalMin: number // minutes between automatic cloud backups
  ccUser: boolean        // also send a copy to the user who saved the data
  ownerEmail: string     // explicit owner destination (falls back to business.email)
  lastAutoAt: string     // ISO timestamp of the last automatic backup
}

const DEFAULT_CFG: AutoBackupConfig = {
  auto: true,            // the owner asked for this feature ON by default
  minIntervalMin: 30,
  ccUser: true,
  ownerEmail: '',
  lastAutoAt: '',
}

function readCfg(settings: Record<string, unknown>): AutoBackupConfig {
  const b = (settings.backup || {}) as Partial<AutoBackupConfig>
  return {
    auto: b.auto === undefined ? DEFAULT_CFG.auto : Boolean(b.auto),
    minIntervalMin: Number(b.minIntervalMin) > 0 ? Number(b.minIntervalMin) : DEFAULT_CFG.minIntervalMin,
    ccUser: b.ccUser !== undefined ? Boolean(b.ccUser) : DEFAULT_CFG.ccUser,
    ownerEmail: String(b.ownerEmail || '').trim(),
    lastAutoAt: String(b.lastAutoAt || ''),
  }
}

/**
 * Task 42 — one call now runs BOTH backup pipelines after any data save:
 *   1. per-business backup (business owner mail + acting-user copy), and
 *   2. the PLATFORM backup — ALL businesses' data to the platform owner's
 *      mail (SUPER_ADMIN email, e.g. asifawaan90@gmail.com) + the user-given
 *      mail — independently throttled, fire-and-forget, never blocks.
 */
export async function maybeAutoBackup(
  businessId: string,
  actor: { uid: string; name: string; email: string },
  trigger: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  void maybePlatformBackup(businessId, actor, trigger, detail)
  await maybeTenantBackup(businessId, actor, trigger, detail)
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Per-business automatic cloud backup (owner Gmail + acting-user copy).
 * NEVER throws; safe to call as `void maybeTenantBackup(...)`.
 */
async function maybeTenantBackup(
  businessId: string,
  actor: { uid: string; name: string; email: string },
  trigger: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    const [business, setting] = await Promise.all([
      db.business.findUnique({ where: { id: businessId } }),
      db.setting.findUnique({ where: { businessId } }),
    ])
    if (!business) return
    let settings: Record<string, unknown> = {}
    try { settings = setting ? JSON.parse(setting.data) : {} } catch { settings = {} }
    const cfg = readCfg(settings)
    if (!cfg.auto) return

    // throttle: one automatic cloud backup per interval (manual sends bypass this)
    const now = Date.now()
    const last = cfg.lastAutoAt ? Date.parse(cfg.lastAutoAt) : 0
    if (Number.isFinite(last) && now - last < cfg.minIntervalMin * 60_000) return

    const smtp = await resolveSmtp(businessId)
    if (!smtp) {
      // throttled by the same interval so the audit log is not spammed
      await db.auditLog.create({ data: {
        businessId, userId: actor.uid || undefined,
        action: 'AUTO_BACKUP_SKIPPED', entity: 'Business', entityId: businessId,
        details: JSON.stringify({ reason: 'smtp_not_configured', trigger, ...detail }),
      } }).catch(() => { /* audit failures must never break the shop */ })
      return
    }

    // recipients: owner first, optional copy to the acting user
    const owner = cfg.ownerEmail || business.email
    const to: string[] = []
    if (EMAIL_RE.test(owner)) to.push(owner)
    const cc = actor.email?.trim()
    if (cfg.ccUser && cc && EMAIL_RE.test(cc) && !to.includes(cc)) to.push(cc)
    if (to.length === 0) return

    const data = await collectBackupData(businessId)
    const bytes = buildWorkbookBytes(data)
    const filename = backupFilename(data.meta.businessName, 'xlsx')
    const nodemailer = await import('nodemailer')
    const transporter = nodemailer.createTransport({
      host: smtp.host, port: smtp.port, secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.pass },
    })

    const date = new Date().toLocaleString('en-CA', { hour12: false })
    const triggerLine = Object.entries(detail).map(([k, v]) => `${k}: ${String(v)}`).join(' · ') || trigger
    await transporter.sendMail({
      from: smtp.from || smtp.user,
      to: to.join(', '),
      subject: `SmartMart cloud backup — ${data.meta.businessName} — ${new Date().toLocaleDateString('en-CA')}`,
      text: `${buildSummaryText(data)}\n\nAutomatic cloud backup (every ${cfg.minIntervalMin} min at most)\nTriggered by: ${trigger} — ${actor.name || 'user'}${actor.email ? ` <${actor.email}>` : ''}\n${triggerLine}\nRecipients: ${to.join(', ')}\nSent: ${date}\n\nA full Excel snapshot of ALL tables is attached.`,
      attachments: [{
        filename,
        content: Buffer.from(bytes),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }],
    })

    // record success (read-modify-write the shared settings blob)
    try {
      const fresh = await db.setting.findUnique({ where: { businessId } })
      const freshData: Record<string, unknown> = fresh ? JSON.parse(fresh.data) : {}
      freshData.backup = { ...readCfg(freshData), lastAutoAt: new Date().toISOString() }
      await db.setting.upsert({
        where: { businessId },
        create: { businessId, data: JSON.stringify(freshData) },
        update: { data: JSON.stringify(freshData) },
      })
    } catch { /* timestamp bookkeeping is best-effort */ }

    await db.auditLog.create({ data: {
      businessId, userId: actor.uid || undefined,
      action: 'AUTO_BACKUP_EMAILED', entity: 'Business', entityId: businessId,
      details: JSON.stringify({ to, filename, trigger, ...detail, counts: data.meta.counts }),
    } }).catch(() => { /* */ })
  } catch (e) {
    console.error('[auto-backup]', e instanceof Error ? e.message : e)
    try {
      await db.auditLog.create({ data: {
        businessId, userId: actor?.uid || undefined,
        action: 'AUTO_BACKUP_FAILED', entity: 'Business', entityId: businessId,
        details: JSON.stringify({ error: e instanceof Error ? e.message : String(e), trigger }),
      } })
    } catch { /* */ }
  }
}
