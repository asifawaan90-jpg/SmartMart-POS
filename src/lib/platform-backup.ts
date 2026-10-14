/**
 * Task 42 — PLATFORM-level cloud backup ("save all users data in owner mail").
 *
 * The Platform Owner (SUPER_ADMIN, e.g. asifawaan90@gmail.com) gets an email
 * containing a complete Excel snapshot of EVERY business whenever data is
 * saved anywhere in the platform (throttled separately from the per-business
 * backup), plus a copy to the "user given mail" (the connected email of the
 * business whose data changed / the acting user) when enabled.
 *
 * Config lives in PlatformConfig key 'backup' — managed from the Platform
 * Owner Panel → Data tab. Recipients are derived live from the SUPER_ADMIN
 * user rows, so the owner mail is always the real platform account email.
 *
 * Sending chain (resolveSmtp): env vars → Platform Owner Panel → Email (SMTP)
 * → the triggering business's own Settings → Backup SMTP. Fire-and-forget and
 * never throws: failures are captured into the audit log (PLATFORM_BACKUP_*).
 */
import { db } from '@/lib/db'
import { collectBackupData } from '@/lib/backup'
import { buildWorkbookBytes, buildSummaryText, backupFilename, type BackupData } from '@/lib/backup-shared'
import { resolveSmtp, smtpErrorMessage } from '@/lib/mailer'

export const PLATFORM_BACKUP_KEY = 'backup'

export interface PlatformBackupCfg {
  auto: boolean
  minIntervalMin: number // minutes between automatic platform-wide backups
  ccUserMail: boolean    // also copy the "user given mail" (business/actor email)
  lastAutoAt: string     // ISO timestamp of the last automatic platform backup
}

const DEFAULT_CFG: PlatformBackupCfg = {
  auto: true,           // platform owner asked for automatic saving
  minIntervalMin: 60,
  ccUserMail: true,
  lastAutoAt: '',
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Safety cap on per-business attachments in one email. */
const MAX_ATTACHMENTS = 40

export function readPlatformBackupCfg(raw: string | null | undefined): PlatformBackupCfg {
  let obj: Record<string, unknown> = {}
  if (raw) { try { obj = JSON.parse(raw) as Record<string, unknown> } catch { obj = {} } }
  const b = (obj.backup || {}) as Partial<PlatformBackupCfg>
  return {
    auto: b.auto === undefined ? DEFAULT_CFG.auto : Boolean(b.auto),
    minIntervalMin: Number(b.minIntervalMin) > 0 ? Number(b.minIntervalMin) : DEFAULT_CFG.minIntervalMin,
    ccUserMail: b.ccUserMail !== undefined ? Boolean(b.ccUserMail) : DEFAULT_CFG.ccUserMail,
    lastAutoAt: String(b.lastAutoAt || ''),
  }
}

export async function getPlatformBackupCfg(): Promise<PlatformBackupCfg> {
  const row = await db.platformConfig.findUnique({ where: { key: PLATFORM_BACKUP_KEY } })
  return readPlatformBackupCfg(row?.data)
}

export async function writePlatformBackupCfg(patch: Partial<PlatformBackupCfg>): Promise<PlatformBackupCfg> {
  const prev = await getPlatformBackupCfg()
  const next: PlatformBackupCfg = {
    auto: patch.auto !== undefined ? Boolean(patch.auto) : prev.auto,
    minIntervalMin: Number(patch.minIntervalMin) > 0 ? Number(patch.minIntervalMin) : prev.minIntervalMin,
    ccUserMail: patch.ccUserMail !== undefined ? Boolean(patch.ccUserMail) : prev.ccUserMail,
    lastAutoAt: patch.lastAutoAt !== undefined ? String(patch.lastAutoAt) : prev.lastAutoAt,
  }
  const data = JSON.stringify({ backup: next })
  await db.platformConfig.upsert({
    where: { key: PLATFORM_BACKUP_KEY },
    create: { key: PLATFORM_BACKUP_KEY, data },
    update: { data },
  })
  return next
}

/** The "owner mail" = every active SUPER_ADMIN account email (platform owner panel login). */
export async function getPlatformOwnerEmails(): Promise<string[]> {
  const admins = await db.user.findMany({
    where: { role: 'SUPER_ADMIN', isActive: true },
    select: { email: true },
  })
  return admins.map(a => a.email.trim()).filter(e => EMAIL_RE.test(e))
}

export interface BusinessSnapshot { id: string; name: string; email: string; data?: BackupData; error?: string }

/** Collect a full BackupData snapshot for EVERY business (per-business error isolation). */
export async function collectAllBusinessesData(): Promise<BusinessSnapshot[]> {
  const businesses = await db.business.findMany({
    select: { id: true, name: true, email: true },
    orderBy: { createdAt: 'asc' },
  })
  return Promise.all(businesses.map(async b => {
    try {
      return { id: b.id, name: b.name, email: b.email, data: await collectBackupData(b.id) }
    } catch (e) {
      return { id: b.id, name: b.name, email: b.email, error: e instanceof Error ? e.message : String(e) }
    }
  }))
}

/** One XLSX attachment per business (unique filenames, capped). */
export function buildPlatformAttachments(list: BusinessSnapshot[]): { filename: string; content: Buffer; contentType: string }[] {
  const out: { filename: string; content: Buffer; contentType: string }[] = []
  for (const b of list) {
    if (!b.data || out.length >= MAX_ATTACHMENTS) break
    const base = backupFilename(b.data.meta.businessName || b.name, 'xlsx').replace(/\.xlsx$/i, '')
    const filename = `${base}-${b.id.slice(0, 8)}.xlsx`
    out.push({
      filename,
      content: Buffer.from(buildWorkbookBytes(b.data)),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
  }
  return out
}

function platformSummaryText(list: BusinessSnapshot[], cfg: PlatformBackupCfg, trigger: string): string {
  const lines = [
    'SmartMart POS — PLATFORM BACKUP (all businesses)',
    `Exported: ${new Date().toLocaleString('en-CA', { hour12: false })}`,
    `Trigger: ${trigger}`,
    `Automatic: ${cfg.auto ? `yes (at most every ${cfg.minIntervalMin} min)` : 'no — manual send'}`,
    '',
    ...list.map(b => b.data
      ? `• ${b.name}: ${Object.entries(b.data.meta.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`
      : `• ${b.name}: COLLECTION FAILED — ${b.error}`),
    '',
    'A full Excel workbook is attached for each business.',
  ]
  return lines.join('\n')
}

async function auditPlatform(action: string, userId: string | undefined, details: Record<string, unknown>) {
  await db.auditLog.create({
    data: { businessId: null, userId: userId || undefined, action, entity: 'PlatformConfig', entityId: PLATFORM_BACKUP_KEY, details: JSON.stringify(details) },
  }).catch(() => { /* audit failures must never break the shop */ })
}

async function sendPlatformBackup(
  actor: { uid: string; name: string; email: string },
  trigger: string,
  detail: Record<string, unknown>,
  opts: { manual?: boolean } = {},
): Promise<{ sent: boolean; to?: string[]; files?: string[]; businesses?: number; error?: string; code?: string }> {
  const cfg = await getPlatformBackupCfg()

  // throttle automatic sends (manual "send now" bypasses)
  if (!opts.manual) {
    const last = cfg.lastAutoAt ? Date.parse(cfg.lastAutoAt) : 0
    if (Number.isFinite(last) && Date.now() - last < cfg.minIntervalMin * 60_000) {
      return { sent: false, error: 'throttled' }
    }
  }

  const owners = await getPlatformOwnerEmails()
  if (owners.length === 0) {
    await auditPlatform('PLATFORM_BACKUP_SKIPPED', actor?.uid, { reason: 'no_super_admin_email', trigger, ...detail })
    return { sent: false, error: 'no platform owner email found', code: 'NO_OWNER_EMAIL' }
  }

  // "also save user given mail": copy the connected mail of the business whose
  // data changed + the acting user's own email.
  const to = [...owners]
  if (cfg.ccUserMail) {
    let bizEmail = ''
    if (detail.businessId) {
      const b = await db.business.findUnique({ where: { id: String(detail.businessId) } })
      const setting = await db.setting.findUnique({ where: { businessId: String(detail.businessId) } }).catch(() => null)
      let backupEmail = ''
      if (setting) { try { backupEmail = String((JSON.parse(setting.data) as { backup?: { ownerEmail?: string } }).backup?.ownerEmail || '') } catch { /* */ } }
      bizEmail = backupEmail || b?.email || ''
    }
    for (const cand of [bizEmail, actor?.email]) {
      const v = String(cand || '').trim()
      if (EMAIL_RE.test(v) && !to.includes(v)) to.push(v)
    }
  }

  const smtp = await resolveSmtp(detail.businessId ? String(detail.businessId) : null)
  if (!smtp) {
    await auditPlatform('PLATFORM_BACKUP_SKIPPED', actor?.uid, { reason: 'smtp_not_configured', trigger, to, ...detail })
    return { sent: false, error: 'smtp_not_configured', code: 'SMTP_NOT_CONFIGURED' }
  }

  const list = await collectAllBusinessesData()
  const okList = list.filter(b => b.data)
  if (okList.length === 0) {
    await auditPlatform('PLATFORM_BACKUP_FAILED', actor?.uid, { error: 'no business data could be collected', trigger })
    return { sent: false, error: 'no business data could be collected', code: 'COLLECT_FAILED' }
  }

  const attachments = buildPlatformAttachments(list)
  const nodemailer = await import('nodemailer')
  const transporter = nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  })

  try {
    await transporter.sendMail({
      from: smtp.from || smtp.user,
      to: to.join(', '),
      subject: `SmartMart platform backup — all businesses — ${new Date().toLocaleDateString('en-CA')}`,
      text: platformSummaryText(list, cfg, trigger),
      attachments,
    })
  } catch (e) {
    await auditPlatform('PLATFORM_BACKUP_FAILED', actor?.uid, { error: smtpErrorMessage(e), raw: e instanceof Error ? e.message : String(e), to, trigger })
    return { sent: false, error: smtpErrorMessage(e), code: 'SMTP_SEND_FAILED' }
  }

  if (!opts.manual) await writePlatformBackupCfg({ lastAutoAt: new Date().toISOString() })
  await auditPlatform('PLATFORM_BACKUP_EMAILED', actor?.uid, {
    to, files: attachments.map(a => a.filename), businesses: okList.length, trigger, ...detail,
  })
  return { sent: true, to, files: attachments.map(a => a.filename), businesses: okList.length }
}

/**
 * Maybe send the platform-wide backup. NEVER throws; safe to call as
 * `void maybePlatformBackup(...)` from any data-save path.
 */
export async function maybePlatformBackup(
  businessId: string | null,
  actor: { uid: string; name: string; email: string } | null,
  trigger: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    const cfg = await getPlatformBackupCfg()
    if (!cfg.auto) return
    await sendPlatformBackup(
      actor || { uid: '', name: 'system', email: '' },
      trigger,
      { businessId: businessId || undefined, ...detail },
      { manual: false },
    )
  } catch (e) {
    console.error('[platform-backup]', e instanceof Error ? e.message : e)
    await auditPlatform('PLATFORM_BACKUP_FAILED', actor?.uid, { error: e instanceof Error ? e.message : String(e), trigger })
  }
}

/** Manual "Email all data now" from the Platform Owner Panel (bypasses throttle). */
export async function emailPlatformBackupNow(
  actor: { uid: string; name: string; email: string },
  trigger = 'manual:panel',
): Promise<{ sent: boolean; to?: string[]; files?: string[]; businesses?: number; error?: string; code?: string }> {
  return sendPlatformBackup(actor, trigger, {}, { manual: true })
}
