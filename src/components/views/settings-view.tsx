'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuthStore, hasPerm } from '@/stores/auth'
import { useThemeStore, THEMES } from '@/stores/theme'
import { api, errMsg } from '@/lib/client'
import { printHTML } from '@/lib/export'
import {
  type BackupData, type BackupTable, BACKUP_SHEETS,
  buildWorkbookBytes, backupFilename, tableToCsv, backupPdfHtml,
} from '@/lib/backup-shared'
import { PageHeader, LoadingBlock, ErrorBanner } from '@/components/shared/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Loader2, Upload, Trash2, Store, ReceiptText, ScanBarcode, Keyboard, Palette, Save,
  DatabaseBackup, FileSpreadsheet, FileText, FileJson, Table2, Mail, Send, ShieldCheck, KeyRound,
  CloudUpload, Clock3, UserRound, MailCheck, CircleCheck, CircleAlert, Eye, EyeOff, Zap,
} from 'lucide-react'
import { useLangStore, useT } from '@/stores/lang'
import { LANGUAGES, type Lang } from '@/lib/i18n'
import { CURRENCIES, currencyInfo } from '@/lib/currency'
import ChangePasswordDialog from '@/components/change-password-dialog'

interface BizForm { name: string; ownerName: string; phone: string; address: string; currency: string; logo: string; email?: string }
interface SettingsShape {
  receipt?: { width?: number; showLogo?: boolean; border?: boolean; footer?: string }
  invoice?: { prefix: string }
  purchasePrefix?: string
  shortcuts?: { search?: string; newSale?: string; hold?: string; payment?: string; close?: string }
  notifications?: { trialReminders: boolean; lowStock: boolean }
  theme?: string
  smtp?: { host?: string; port?: number | string; user?: string; from?: string; configured?: boolean; active?: boolean }
  backup?: { auto?: boolean; minIntervalMin?: number; ccUser?: boolean; ownerEmail?: string; lastAutoAt?: string }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Task 43 — one-tap provider presets for the Email delivery card
const SMTP_PROVIDERS = [
  { label: 'Gmail', host: 'smtp.gmail.com', port: '465' },
  { label: 'Outlook / 365', host: 'smtp.office365.com', port: '587' },
  { label: 'Yahoo', host: 'smtp.mail.yahoo.com', port: '465' },
  { label: 'Zoho', host: 'smtp.zoho.com', port: '465' },
]

function downloadBlob(filename: string, data: BlobPart, mime: string) {
  const blob = new Blob([data], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 300)
}

export default function SettingsView({ initialTab }: { initialTab?: string } = {}) {
  const { business, setBusiness, settings, setSettings, user } = useAuthStore()
  // Task 50 — per-device language (instant switch, no save needed)
  const { lang, setLang } = useLangStore()
  const t = useT()
  // Task 43 — every user gets the Mail & backup tab; the other tabs stay role-gated
  const canManage = hasPerm(user, 'settings')
  const { theme, setTheme } = useThemeStore()
  const [biz, setBiz] = useState<BizForm>({ name: '', ownerName: '', phone: '', address: '', currency: 'PKR', logo: '' })
  const [s, setS] = useState<SettingsShape>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<string>('')
  const logoRef = useRef<HTMLInputElement>(null)

  // backup state
  const [bkBusy, setBkBusy] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [csvTable, setCsvTable] = useState('sales')
  const [bkEmail, setBkEmail] = useState('')
  const [smtpF, setSmtpF] = useState({ host: '', port: '587', user: '', pass: '', from: '' })
  const [cloud, setCloud] = useState<NonNullable<SettingsShape['backup']>>({ auto: true, minIntervalMin: 30, ccUser: true, ownerEmail: '', lastAutoAt: '' })
  const [emailDraft, setEmailDraft] = useState('') // Task 41 — unsaved “connect your email” input
  const [askOpen, setAskOpen] = useState(false)   // Task 41 — “Enable data backup?” question after connecting
  const [connecting, setConnecting] = useState(false)
  const [pwOpen, setPwOpen] = useState(false)
  // Task 43 — one-click “SMTP active” switch + app-password visibility
  const [smtpActive, setSmtpActive] = useState(true)
  const [showPass, setShowPass] = useState(false)
  // Task 44 — the platform mailbox (Platform Owner Panel / env) is available:
  // the one-click switch must stay usable even before the shop saves its own.
  const [platformSmtp, setPlatformSmtp] = useState(false)
  // Task 59 — the Account menu can open Settings directly on the Mail tab
  // ("Connect email for data backup"); otherwise the tab follows the role default.
  const [tab, setTab] = useState<string>(initialTab || (canManage ? 'business' : 'mail'))
  // re-syncs on every initialTab change: 'mail' from the account menu, undefined
  // (→ role default) when the user opens Settings from the normal nav
  useEffect(() => { setTab(initialTab || (canManage ? 'business' : 'mail')) }, [initialTab, canManage])

  const loadLocal = useCallback(async () => {
    try {
      const data = await api<{ business: BizForm | null; settings: SettingsShape; mail?: { platformConfigured?: boolean } }>('/api/settings')
      if (data.business) setBiz({
        name: data.business.name || '', ownerName: data.business.ownerName || '',
        phone: data.business.phone || '', address: data.business.address || '',
        currency: data.business.currency || 'PKR', logo: data.business.logo || '',
      })
      setS(data.settings || {})
      setPlatformSmtp(Boolean(data.mail?.platformConfigured))
      const sm = data.settings?.smtp || {}
      setSmtpF({ host: sm.host || '', port: String(sm.port || 587), user: sm.user || '', pass: '', from: sm.from || '' })
      setBkEmail(data.business?.email || '')
      const cb = data.settings?.backup || {}
      setCloud({ auto: cb.auto !== false, minIntervalMin: Number(cb.minIntervalMin) > 0 ? Number(cb.minIntervalMin) : 30, ccUser: cb.ccUser !== false, ownerEmail: cb.ownerEmail || data.business?.email || '', lastAutoAt: cb.lastAutoAt || '' })
      setEmailDraft(cb.ownerEmail || data.business?.email || '')
      setSmtpActive(data.settings?.smtp?.active !== false)
    } catch (e) { setError(errMsg(e)) } finally { setLoading(false) }
  }, [])

  useEffect(() => { loadLocal() }, [loadLocal])

  const saveBusiness = async () => {
    setSaving('biz')
    try {
      const data = await api<{ business: BizForm }>('/api/settings', { method: 'PUT', body: { business: biz } })
      if (data.business) setBusiness({ ...business, ...data.business } as typeof business)
      alert('Business info saved.')
    } catch (e) { alert(errMsg(e)) } finally { setSaving('') }
  }

  const saveSettings = async (patch: Partial<SettingsShape>) => {
    setSaving('settings')
    try {
      const next = { ...s, ...patch }
      setS(next)
      const data = await api<{ settings: SettingsShape }>('/api/settings', { method: 'PUT', body: { settings: patch } })
      setSettings({ ...settings, ...(data.settings as Record<string, unknown>) })
      setS(prev => ({ ...prev, ...(data.settings as SettingsShape) }))
    } catch (e) { alert(errMsg(e)) } finally { setSaving('') }
  }

  const onLogoPick = (file: File) => {
    const reader = new FileReader()
    reader.onload = async () => {
      // downscale to max 256px for storage efficiency
      const img = new Image()
      img.onload = async () => {
        const canvas = document.createElement('canvas')
        const scale = Math.min(1, 256 / Math.max(img.width, img.height))
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
        const dataUrl = canvas.toDataURL('image/png')
        setBiz(b => ({ ...b, logo: dataUrl }))
        try {
          await api('/api/settings', { method: 'PUT', body: { business: { logo: dataUrl } } })
          setBusiness({ ...business, logo: dataUrl } as typeof business)
          alert('Logo updated — it will appear on receipts and invoices.')
        } catch (e) { alert(errMsg(e)) }
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  }

  // ─── Backup ────────────────────────────────────────────────────
  const loadBackup = async (): Promise<BackupData> => {
    const params = new URLSearchParams()
    if (dateFrom) params.set('from', dateFrom)
    if (dateTo) params.set('to', dateTo)
    const qs = params.toString()
    return api<BackupData>(`/api/backup${qs ? `?${qs}` : ''}`)
  }

  const doBackup = async (kind: 'xlsx' | 'csv' | 'pdf' | 'json') => {
    setBkBusy(kind)
    try {
      const data = await loadBackup()
      const name = data.meta.businessName
      if (kind === 'xlsx') {
        downloadBlob(backupFilename(name, 'xlsx'), buildWorkbookBytes(data) as BlobPart,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      } else if (kind === 'csv') {
        const rows = data[csvTable as keyof Omit<BackupData, 'meta'>] as BackupTable
        downloadBlob(`SmartMart-${csvTable}-${(name || 'store').replace(/\s+/g, '-')}.csv`,
          '\uFEFF' + tableToCsv(rows), 'text/csv;charset=utf-8;')
      } else if (kind === 'pdf') {
        printHTML(`Backup ${name}`, backupPdfHtml(data))
      } else if (kind === 'json') {
        downloadBlob(backupFilename(name, 'json'), JSON.stringify(data, null, 2), 'application/json')
      }
    } catch (e) { alert(errMsg(e)) } finally { setBkBusy('') }
  }

  const sendBackupEmail = async () => {
    setBkBusy('email')
    try {
      const r = await api<{ sent: boolean; to: string; filename: string }>('/api/backup/email', {
        method: 'POST', body: { email: bkEmail },
      })
      alert(`Backup emailed to ${r.to}\nAttachment: ${r.filename}`)
    } catch (e) { alert(errMsg(e)) } finally { setBkBusy('') }
  }

  // Task 43 — every user saves email settings through /api/mail-settings
  // (any signed-in user); the role-gated PUT /api/settings stays for the rest.
  const mailPut = async (patch: { smtp?: Record<string, unknown>; backup?: Record<string, unknown> }) => {
    const data = await api<{ smtp: SettingsShape['smtp']; backup: Partial<SettingsShape['backup']> }>('/api/mail-settings', { method: 'PUT', body: patch })
    setS(prev => ({ ...prev, smtp: data.smtp as SettingsShape['smtp'], backup: data.backup as SettingsShape['backup'] }))
    if (data.smtp) setSmtpActive(data.smtp.active !== false)
    return data
  }

  // “Save & turn on” — one click saves the mailbox and activates email delivery
  const saveSmtp = async () => {
    const host = smtpF.host.trim()
    const mailUser = smtpF.user.trim()
    if (!EMAIL_RE.test(mailUser)) { alert('Please enter a valid email address for the SMTP login, e.g. you@gmail.com'); return }
    if (!host) { alert('Tap your provider above (Gmail, Outlook…) to fill the host, or add it under Advanced.'); return }
    if (!smtpF.pass && !s.smtp?.configured) {
      alert('Enter your App Password — for Gmail: Google Account → Security → 2-Step Verification → App passwords (16 characters).')
      return
    }
    setBkBusy('smtp')
    try {
      const payload: Record<string, unknown> = { host, port: smtpF.port || 587, user: mailUser, from: smtpF.from.trim(), active: true }
      if (smtpF.pass) payload.pass = smtpF.pass
      await mailPut({ smtp: payload })
      setSmtpF(f => ({ ...f, pass: '' }))
      alert(`Email delivery is ON — backups will be sent from ${mailUser}. Use “Send test email” to double-check.`)
    } catch (e) { alert(errMsg(e)) } finally { setBkBusy('') }
  }

  // Best-effort provider defaults from the typed email address (Gmail, Outlook,
  // Yahoo, Zoho) — so the one-click switch can save a mailbox with no host typed.
  const guessProvider = (email: string): { host: string; port: string } | null => {
    if (/gmail|googlemail/i.test(email)) return { host: 'smtp.gmail.com', port: '465' }
    if (/outlook|hotmail|live\.|office365|msn/i.test(email)) return { host: 'smtp.office365.com', port: '587' }
    if (/yahoo/i.test(email)) return { host: 'smtp.mail.yahoo.com', port: '465' }
    if (/zoho/i.test(email)) return { host: 'smtp.zoho.com', port: '465' }
    return null
  }

  // One-click "SMTP active" switch — works in EVERY state (Task 44 fix: it used
  // to refuse to turn on until a mailbox was saved, which felt broken):
  //  • email + App Password typed → this click ALWAYS saves that mailbox and
  //    activates it — whether the switch was on or off
  //  • something typed but incomplete (e.g. no App Password yet) → helpful
  //    guidance, never a silent toggle; activates via the platform mailbox if
  //    one exists
  //  • nothing typed → normal on/off toggle of the saved setup (own mailbox,
  //    or the SmartMart platform mailbox when none is saved)
  const toggleSmtpActive = async (v: boolean) => {
    const u = smtpF.user.trim(), p = smtpF.pass.trim(), h = smtpF.host.trim()
    // 1) a complete mailbox is typed → save + activate in this very click
    if (u && p) {
      if (!EMAIL_RE.test(u)) { alert('Please enter a valid email address, e.g. you@gmail.com'); return }
      const g = h ? null : guessProvider(u)
      if (!h && !g) { alert('Tap your email provider above (Gmail, Outlook…) to fill the host, or add it under Advanced.'); return }
      const host = h || g!.host
      const port = smtpF.port.trim() || g!.port || '587'
      setBkBusy('smtp')
      try {
        await mailPut({ smtp: { host, port, user: u, from: smtpF.from.trim(), active: true, pass: p } })
        setSmtpF(f => ({ ...f, host, port, pass: '' }))
        alert(`Email delivery is ON — emails will send from ${u}. Use “Send test email” to double-check.`)
      } catch (e) { alert(errMsg(e)) } finally { setBkBusy('') }
      return
    }
    // 2) something typed but incomplete → guide, never silently toggle off
    if (u || p) {
      if (p && !u) { alert('Enter your email address too — it is the SMTP login.'); return }
      if (!EMAIL_RE.test(u)) { alert('Please enter a valid email address, e.g. you@gmail.com'); return }
      if (s.smtp?.configured) {
        alert('Enter your App Password too, then tap this switch or “Save & turn on” — for Gmail: Google Account → Security → 2-Step Verification → App passwords (16 characters).')
        return
      }
      if (platformSmtp) {
        try {
          await mailPut({ smtp: { active: true } })
          alert('Email delivery is ON via the SmartMart platform mailbox. Add your App Password below to send from your own address instead.')
        } catch (e) { alert(errMsg(e)) }
        return
      }
      alert('Enter your App Password too — for Gmail: Google Account → Security → 2-Step Verification → App passwords (16 characters).')
      return
    }
    // 3) nothing typed → plain on/off toggle of the saved delivery setup
    if (!v) { // OFF is always allowed — opt out of email delivery entirely
      const prev = smtpActive
      setSmtpActive(false)
      try { await mailPut({ smtp: { active: false } }) }
      catch (e) { setSmtpActive(prev); alert(errMsg(e)) }
      return
    }
    // mailbox already saved → resume it
    if (s.smtp?.configured) {
      const prev = smtpActive
      setSmtpActive(true)
      try { await mailPut({ smtp: { active: true } }) }
      catch (e) { setSmtpActive(prev); alert(errMsg(e)) }
      return
    }
    // nothing saved but the platform mailbox delivers → activate via it
    if (platformSmtp) {
      try { await mailPut({ smtp: { active: true } }) } catch (e) { alert(errMsg(e)) }
      return
    }
    // genuinely nothing to send with yet
    alert('Save your email + App password below first — after that this switch works in one click.')
  }

  const sendTestEmail = async () => {
    setBkBusy('test')
    try {
      // default recipient: the typed mailbox, else the signed-in user's own email
      const r = await api<{ sent: boolean; to: string; message: string }>('/api/mail-settings/test', { method: 'POST', body: { to: smtpF.user.trim() || user?.email || '' } })
      alert(r.message || `Test email sent to ${r.to} — check the inbox.`)
    } catch (e) { alert(errMsg(e)) } finally { setBkBusy('') }
  }

  const saveCloud = async (patch: Partial<SettingsShape['backup']>) => {
    const next = { ...cloud, ...patch }
    setCloud(next)
    try {
      await mailPut({ backup: next as Record<string, unknown> })
    } catch (e) { alert(errMsg(e)) }
  }

  // Task 41 — “connect your email” flow: connecting a mail address never changes
  // the backup switch silently; it opens the enable / not-now question instead.
  const connectEmail = async () => {
    const email = emailDraft.trim()
    if (!EMAIL_RE.test(email)) {
      alert('Please enter a valid email address, e.g. owner@gmail.com')
      return
    }
    setConnecting(true)
    try {
      await saveCloud({ ownerEmail: email })
      setAskOpen(true)
    } finally {
      setConnecting(false)
    }
  }

  const answerBackup = (enable: boolean) => {
    setAskOpen(false)
    void saveCloud({ auto: enable })
    alert(enable
      ? `Data backup enabled — every save will email a full snapshot to ${cloud.ownerEmail}${cloud.ccUser !== false && user?.email ? ` and ${user.email}` : ''}.`
      : 'Email connected. Automatic data backup stays OFF — turn it on anytime with the switch or by connecting again.')
  }

  const sendCloudNow = async () => {
    setBkBusy('cloud')
    try {
      const emails = [cloud.ownerEmail, user?.email].filter((v): v is string => !!v)
      const r = await api<{ sent: boolean; to: string; filename: string }>('/api/backup/email', {
        method: 'POST', body: { emails },
      })
      alert(`Cloud backup emailed to ${r.to}\nAttachment: ${r.filename}`)
    } catch (e) { alert(errMsg(e)) } finally { setBkBusy('') }
  }

  if (loading) return <div className="p-6"><LoadingBlock /></div>

  const busyBtn = (k: string) => bkBusy === k
  // Task 43/44 — delivery is “on” when the switch is on AND a mailbox exists:
  // the shop's own saved mailbox, or the SmartMart platform mailbox otherwise.
  const smtpOn = Boolean(s.smtp?.configured || platformSmtp) && smtpActive

  return (
    <div className="p-4 md:p-6">
      <PageHeader title={t('set.title')} subtitle={t('set.subtitle')} />
      {error ? <ErrorBanner message={error} onRetry={loadLocal} /> : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap h-auto gap-1">
          {canManage ? <TabsTrigger value="business" className="text-xs"><Store className="h-3.5 w-3.5 mr-1" />{t('set.tabBusiness')}</TabsTrigger> : null}
          <TabsTrigger value="account" className="text-xs"><KeyRound className="h-3.5 w-3.5 mr-1" />{t('set.tabAccount')}</TabsTrigger>
          {canManage ? (<>
            <TabsTrigger value="receipt" className="text-xs"><ReceiptText className="h-3.5 w-3.5 mr-1" />{t('set.tabReceipt')}</TabsTrigger>
            <TabsTrigger value="barcode" className="text-xs"><ScanBarcode className="h-3.5 w-3.5 mr-1" />{t('set.tabBarcode')}</TabsTrigger>
            <TabsTrigger value="shortcuts" className="text-xs"><Keyboard className="h-3.5 w-3.5 mr-1" />{t('set.tabShortcuts')}</TabsTrigger>
            <TabsTrigger value="theme" className="text-xs"><Palette className="h-3.5 w-3.5 mr-1" />{t('set.tabTheme')}</TabsTrigger>
          </>) : null}
          <TabsTrigger value="mail" className="text-xs" data-testid="tab-mail"><Mail className="h-3.5 w-3.5 mr-1" />{t('set.tabMail')}</TabsTrigger>
          {canManage ? <TabsTrigger value="backup" className="text-xs"><DatabaseBackup className="h-3.5 w-3.5 mr-1" />{t('set.tabExport')}</TabsTrigger> : null}
        </TabsList>

        <TabsContent value="business">
          <div className="rounded-lg border bg-card p-4 max-w-2xl space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>{t('set.bizName')}</Label><Input value={biz.name} onChange={e => setBiz({ ...biz, name: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>{t('set.ownerName')}</Label><Input value={biz.ownerName} onChange={e => setBiz({ ...biz, ownerName: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>{t('set.phone')}</Label><Input value={biz.phone} onChange={e => setBiz({ ...biz, phone: e.target.value })} /></div>
              <div className="space-y-1.5">
                <Label>{t('set.currency')}</Label>
                <Select value={biz.currency} onValueChange={v => setBiz({ ...biz, currency: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {/* Task 50 — full world currency registry (56 currencies with
                        proper symbols); the selection drives EVERY money display
                        and every printed receipt/invoice/payslip. */}
                    {CURRENCIES.map(c => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.code} — {c.name} ({currencyInfo(c.code).symbol})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {biz.currency ? (
                  <p className="text-[11px] text-muted-foreground">
                    Preview: <b>{currencyInfo(biz.currency).symbol} 1,250</b>
                  </p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label>Language / زبان / اللغة</Label>
                <Select value={lang} onValueChange={v => setLang(v as Lang)} data-testid="lang-select">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {LANGUAGES.map(l => <SelectItem key={l.id} value={l.id}>{l.name} · {l.english}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">{t('set.languageHint')}</p>
              </div>
              <div className="space-y-1.5 sm:col-span-2"><Label>{t('set.address')} (printed on receipts)</Label><Input value={biz.address} onChange={e => setBiz({ ...biz, address: e.target.value })} /></div>
            </div>
            <div className="flex items-center gap-3">
              {biz.logo ? (
                <div className="relative">
                  { }
                  <img src={biz.logo} alt="Store logo" className="h-16 w-16 rounded-lg border object-contain bg-white" />
                  <button className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-destructive text-white grid place-items-center" onClick={() => setBiz({ ...biz, logo: '' })}><Trash2 className="h-3 w-3" /></button>
                </div>
              ) : (
                <div className="h-16 w-16 rounded-lg border-2 border-dashed grid place-items-center text-muted-foreground"><Upload className="h-5 w-5" /></div>
              )}
              <div className="space-y-1">
                <input ref={logoRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onLogoPick(f); e.target.value = '' }} />
                <Button variant="outline" size="sm" onClick={() => logoRef.current?.click()}><Upload className="h-4 w-4 mr-1" /> Upload logo</Button>
                <p className="text-[11px] text-muted-foreground">PNG/JPG · appears on thermal receipts & PDF invoices</p>
              </div>
            </div>
            <Button onClick={saveBusiness} disabled={saving === 'biz'}>
              {saving === 'biz' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4 mr-1" />} Save Business Info
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="account">
          <div className="rounded-lg border bg-card p-4 max-w-2xl space-y-4">
            <div className="flex items-center gap-3">
              <span className="grid place-items-center h-11 w-11 rounded-full bg-primary text-primary-foreground text-base font-bold">
                {(user?.name || 'U').slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{user?.name}</p>
                <p className="text-xs text-muted-foreground truncate">{user?.email} · {user?.role.replace('_', ' ')}</p>
              </div>
            </div>
            <div className="border-t pt-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Password</p>
                <p className="text-xs text-muted-foreground">Change your own sign-in password. You&apos;ll be asked for the current one first.</p>
              </div>
              <Button onClick={() => setPwOpen(true)}><KeyRound className="h-4 w-4 mr-1" /> Change password</Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="receipt">
          <div className="rounded-lg border bg-card p-4 max-w-2xl space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Thermal paper width</Label>
                <Select value={String(s.receipt?.width || 80)} onValueChange={v => saveSettings({ receipt: { ...s.receipt, width: parseInt(v) } })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="80">80mm (most common)</SelectItem>
                    <SelectItem value="58">58mm (compact)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Invoice number prefix</Label>
                <Input defaultValue={s.invoice?.prefix || 'INV-'} onBlur={e => saveSettings({ invoice: { prefix: e.target.value || 'INV-' } })} />
              </div>
              <div className="space-y-1.5">
                <Label>Purchase number prefix</Label>
                <Input defaultValue={s.purchasePrefix || 'PUR-'} onBlur={e => saveSettings({ purchasePrefix: e.target.value || 'PUR-' })} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Receipt footer message</Label>
                <Input defaultValue={s.receipt?.footer || ''} onBlur={e => saveSettings({ receipt: { ...s.receipt, footer: e.target.value } })} placeholder="Thank you for shopping with us!" />
              </div>
              <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
                Show logo on receipts
                <Switch checked={s.receipt?.showLogo !== false} onCheckedChange={v => saveSettings({ receipt: { ...s.receipt, showLogo: v } })} />
              </label>
              <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
                Print border around receipts & invoices
                <Switch checked={s.receipt?.border !== false} onCheckedChange={v => saveSettings({ receipt: { ...s.receipt, border: v } })} />
              </label>
            </div>
            {saving === 'settings' ? <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Saving…</p> : null}
          </div>
        </TabsContent>

        <TabsContent value="barcode">
          <div className="rounded-lg border bg-card p-4 max-w-2xl space-y-3 text-sm">
            <p className="text-muted-foreground">Barcodes use the EAN-13 in-store range (20xxxxxxxxxx) with valid checksums — scannable by camera, USB and Bluetooth scanners. Leave the barcode field empty when creating a product and a unique code is generated automatically. Duplicate barcodes are rejected by the server.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Default label copies</Label>
                <Input type="number" min={1} max={20} defaultValue="3" readOnly className="opacity-60" />
                <p className="text-[10px] text-muted-foreground">Ask at print time; bulk printing prints 1 per product (add copies during label print).</p>
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="shortcuts">
          <div className="rounded-lg border bg-card p-4 max-w-2xl space-y-3">
            <p className="text-sm text-muted-foreground">POS keyboard shortcuts (PC). Click a field and press the new key.</p>
            {(['search', 'newSale', 'hold', 'payment', 'close'] as const).map(k => (
              <div key={k} className="grid grid-cols-2 items-center gap-3">
                <Label className="text-sm capitalize">{k === 'newSale' ? 'New sale' : k}</Label>
                <Input
                  className="w-32 font-mono text-center"
                  defaultValue={s.shortcuts?.[k] || ''}
                  readOnly
                  onKeyDown={e => {
                    e.preventDefault()
                    saveSettings({ shortcuts: { ...s.shortcuts, [k]: e.key === ' ' ? 'Space' : e.key } })
                  }}
                  placeholder="Press key…"
                />
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="theme">
          <div className="rounded-lg border bg-card p-4 max-w-2xl space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {THEMES.map(t => (
                <button
                  key={t.id}
                  onClick={async () => { setTheme(t.id); await saveSettings({ theme: t.id }) }}
                  className={`rounded-xl border-2 p-3 text-left transition-colors ${theme === t.id ? 'border-primary' : 'border-transparent hover:border-border'}`}
                >
                  <div className="flex gap-1 mb-2">{t.colors.map(c => <span key={c} className="h-6 flex-1 rounded" style={{ background: c }} />)}</div>
                  <span className="text-sm font-medium">{t.name}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Theme is saved to your account and applied on every device you sign in from.</p>
          </div>
        </TabsContent>

        {/* Task 43 — Mail & backup: direct email settings for EVERY user (no role wall) */}
        <TabsContent value="mail">
          <div className="grid gap-4 max-w-3xl">

            {/* Email delivery (SMTP) — app password + one-click activation */}
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-sm flex items-center gap-1.5"><Mail className="h-4 w-4 text-primary" /> Email delivery (SMTP)</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Connect your own mailbox (Gmail, Outlook, Yahoo…) with an App Password — every backup and
                    report is emailed from it. One click turns delivery on or off for the whole shop.
                  </p>
                </div>
                <Badge variant="outline" className={`text-[10px] gap-1 ${smtpOn ? 'text-emerald-600 border-emerald-300' : 'text-amber-600 border-amber-300'}`} data-testid="smtp-badge">
                  <ShieldCheck className="h-3 w-3" />
                  {smtpOn
                    ? s.smtp?.configured ? 'SMTP active' : 'SMTP active (platform)'
                    : s.smtp?.configured ? 'SMTP paused' : platformSmtp ? 'SMTP off' : 'Not set up'}
                </Badge>
              </div>

              {/* one-click active switch */}
              <div className="flex items-center justify-between rounded-lg border p-3" data-testid="smtp-active-row">
                <div className="min-w-0">
                  <p className="text-xs font-semibold">SMTP active</p>
                  <p className="text-[11px] text-muted-foreground">
                    {smtpOn
                      ? s.smtp?.configured
                        ? <>ON — emails send from <b>{s.smtp?.user || 'your mailbox'}</b> via {s.smtp?.host || 'SMTP'}</>
                        : 'ON — emails send via the SmartMart platform mailbox until you connect your own below'
                      : s.smtp?.configured
                        ? 'Paused — flip this switch to resume email delivery'
                        : platformSmtp
                          ? 'OFF — flip this switch to turn email delivery on (it uses the SmartMart platform mailbox until you connect your own)'
                          : 'Save your email + App password below, then this switch works in one click'}
                  </p>
                </div>
                <Switch checked={smtpOn} onCheckedChange={v => void toggleSmtpActive(v)} data-testid="smtp-active" />
              </div>

              {/* quick setup — the two fields 99% of users need */}
              <div className="rounded-lg bg-secondary/40 border p-3 space-y-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground mr-1">Provider:</span>
                  {SMTP_PROVIDERS.map(p => (
                    <Button key={p.label} type="button" size="sm" variant="outline" className="h-7 px-2.5 text-[11px]"
                      onClick={() => setSmtpF(f => ({ ...f, host: p.host, port: p.port }))}>
                      {p.label}
                    </Button>
                  ))}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs flex items-center gap-1"><MailCheck className="h-3 w-3" /> Your email (SMTP login)</Label>
                    <Input value={smtpF.user} onChange={e => setSmtpF({ ...smtpF, user: e.target.value })} placeholder="you@gmail.com" inputMode="email" autoComplete="email" className="h-8 text-base md:text-xs" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">App password</Label>
                    <div className="flex gap-1.5">
                      <Input type={showPass ? 'text' : 'password'} value={smtpF.pass} onChange={e => setSmtpF({ ...smtpF, pass: e.target.value })}
                        placeholder={s.smtp?.configured ? '•••• saved — type to change' : '16-character app password'}
                        autoComplete="new-password" className="h-8 text-base md:text-xs" />
                      <Button type="button" size="sm" variant="ghost" className="h-8 px-2 shrink-0" onClick={() => setShowPass(v => !v)} title={showPass ? 'Hide password' : 'Show password'}>
                        {showPass ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </Button>
                    </div>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Spaces in the App Password are fine — they are removed automatically. The password is stored server-side only and is never sent back to the browser.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={() => void saveSmtp()} disabled={!!bkBusy} data-testid="smtp-save-on">
                    {busyBtn('smtp') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4 mr-1" />}
                    Save &amp; turn on
                  </Button>
                  <Button size="sm" variant="outline" onClick={sendTestEmail} disabled={!!bkBusy} data-testid="smtp-test">
                    {busyBtn('test') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
                    Send test email
                  </Button>
                  <span className="text-[11px] text-muted-foreground">The test email goes to the address in “Your email” — or your account email.</span>
                </div>
              </div>

              {/* Task 59 — the same Gmail quick-setup guide the Platform Owner Panel
                  shows, right where shop users connect their mailbox for data backup:
                  1. 2-Step Verification  2. App passwords (16-character code)  3. paste & test */}
              <div className="rounded-lg border bg-secondary/40 p-3 text-xs text-muted-foreground space-y-1.5" data-testid="smtp-gmail-guide">
                <p className="font-medium text-foreground">{t('adm.gmailTitle')}</p>
                <p className="leading-relaxed">
                  {t('adm.gmailStep1a')}{' '}<a className="underline text-emerald-700 dark:text-emerald-400" href="https://myaccount.google.com/security" target="_blank" rel="noreferrer">{t('adm.gmailSecurityLink')}</a>{' '}{t('adm.gmailStep1b')} <b>{t('adm.gmail2sv')}</b>.<br />
                  {t('adm.gmailStep2a')}{' '}<a className="underline text-emerald-700 dark:text-emerald-400" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">{t('adm.gmailAppPwLink')}</a>{' '}{t('adm.gmailStep2b')}<br />
                  {t('set.gmailStep3')}
                </p>
                <p>{t('adm.otherProviders')}</p>
              </div>

              {/* advanced — other providers */}
              <details className="rounded-lg border p-3">
                <summary className="text-xs font-medium cursor-pointer select-none">Advanced — host, port, from (other providers)</summary>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
                  <div className="space-y-1.5"><Label className="text-xs">SMTP host</Label><Input value={smtpF.host} onChange={e => setSmtpF({ ...smtpF, host: e.target.value })} placeholder="smtp.gmail.com" className="h-8 text-xs" /></div>
                  <div className="space-y-1.5"><Label className="text-xs">Port</Label><Input value={smtpF.port} onChange={e => setSmtpF({ ...smtpF, port: e.target.value })} placeholder="587" className="h-8 text-xs" /></div>
                  <div className="space-y-1.5"><Label className="text-xs">From address (optional)</Label><Input value={smtpF.from} onChange={e => setSmtpF({ ...smtpF, from: e.target.value })} placeholder="SmartMart <you@gmail.com>" className="h-8 text-xs" /></div>
                </div>
                <div className="mt-3">
                  <Button size="sm" variant="outline" onClick={() => void saveSmtp()} disabled={!!bkBusy}>
                    {busyBtn('smtp') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4 mr-1" />} Save
                  </Button>
                </div>
              </details>
            </div>

            {/* Cloud sync & backup (automatic) */}
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-sm flex items-center gap-1.5"><CloudUpload className="h-4 w-4 text-primary" /> Cloud sync &amp; backup</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    When anyone saves data (sales, purchases, khata payments, expenses, products), SmartMart
                    automatically emails a complete Excel snapshot of ALL data to the owner's Gmail
                    <b> and </b> a copy to the user's own email — your data always lives safely in the cloud.
                  </p>
                </div>
                <Badge variant="outline" className={`text-[10px] gap-1 ${smtpOn ? 'text-emerald-600 border-emerald-300' : 'text-amber-600 border-amber-300'}`}>
                  <ShieldCheck className="h-3 w-3" />
                  {smtpOn ? 'SMTP ready' : s.smtp?.configured || platformSmtp ? 'SMTP off' : 'SMTP needed'}
                </Badge>
              </div>

              <div className="rounded-lg bg-secondary/40 border p-3 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold">Automatic backup on data save</p>
                    <p className="text-[11px] text-muted-foreground">Excel snapshot emailed to the cloud after sales &amp; edits</p>
                  </div>
                  <Switch checked={cloud.auto !== false} onCheckedChange={v => void saveCloud({ auto: v })} />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs flex items-center gap-1"><Clock3 className="h-3 w-3" /> How often (max frequency)</Label>
                    <Select value={String(cloud.minIntervalMin || 30)} onValueChange={v => void saveCloud({ minIntervalMin: parseInt(v) })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="5" className="text-xs">Every 5 minutes ( busiest shops )</SelectItem>
                        <SelectItem value="10" className="text-xs">Every 10 minutes</SelectItem>
                        <SelectItem value="30" className="text-xs">Every 30 minutes (recommended)</SelectItem>
                        <SelectItem value="60" className="text-xs">Every hour</SelectItem>
                        <SelectItem value="180" className="text-xs">Every 3 hours</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs flex items-center gap-1"><Mail className="h-3 w-3" /> Your email (gets every backup)</Label>
                    <div className="flex gap-1.5">
                      <Input
                        value={emailDraft}
                        onChange={e => setEmailDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void connectEmail() } }}
                        placeholder="owner@gmail.com"
                        inputMode="email"
                        autoComplete="email"
                        className="h-8 text-base md:text-xs"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 px-3 text-xs shrink-0"
                        disabled={connecting}
                        onClick={() => void connectEmail()}
                      >
                        {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MailCheck className="h-3.5 w-3.5 mr-1" />}
                        Connect
                      </Button>
                    </div>
                    {cloud.ownerEmail ? (
                      <p className="text-[11px] flex items-center gap-1" data-testid="connect-status">
                        {cloud.auto !== false ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                            <CircleCheck className="h-3 w-3" /> {cloud.ownerEmail} connected — automatic backup is ON
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                            <CircleAlert className="h-3 w-3" /> {cloud.ownerEmail} connected — automatic backup is OFF
                          </span>
                        )}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold flex items-center gap-1"><UserRound className="h-3 w-3" /> Copy to the user's own email</p>
                    <p className="text-[11px] text-muted-foreground">The staff member who saved the data also receives the backup</p>
                  </div>
                  <Switch checked={cloud.ccUser !== false} onCheckedChange={v => void saveCloud({ ccUser: v })} />
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button size="sm" onClick={sendCloudNow} disabled={!!bkBusy}>
                    {busyBtn('cloud') ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4 mr-1" />}
                    Send cloud backup now
                  </Button>
                  <span className="text-[11px] text-muted-foreground">
                    {cloud.lastAutoAt
                      ? <>Last automatic backup: {new Date(cloud.lastAutoAt).toLocaleString()}</>
                      : 'No automatic backup sent yet — it will run on the next data save.'}
                  </span>
                </div>
                {!smtpOn ? (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    {s.smtp?.configured
                      ? 'Email delivery is paused — flip the “SMTP active” switch in the Email delivery card above to resume.'
                      : platformSmtp
                        ? 'Email delivery is OFF — flip the “SMTP active” switch above to turn it on (it uses the SmartMart platform mailbox until you connect your own).'
                        : 'One-time setup: add your email + App Password in the Email delivery card above and tap “Save & turn on” — until then backups are prepared but cannot be emailed.'}
                  </p>
                ) : null}
              </div>
            </div>

            {/* Task 41 — asked every time a mail address is connected */}
            <AlertDialog open={askOpen} onOpenChange={v => { if (!v) setAskOpen(false) }}>
              <AlertDialogContent data-testid="backup-ask">
                <AlertDialogHeader>
                  <AlertDialogTitle>Enable data backup?</AlertDialogTitle>
                  <AlertDialogDescription asChild>
                    <div>
                      <p>
                        Save data to the cloud automatically? Every time anyone saves data (sales, purchases,
                        khata payments, expenses, products), a complete Excel snapshot of ALL data will be emailed to
                        <b> {cloud.ownerEmail || 'your email'}</b>
                        {cloud.ccUser !== false && user?.email && user.email !== cloud.ownerEmail ? (
                          <>, with a copy to <b>{user.email}</b></>
                        ) : null}.
                      </p>
                      <p className="mt-2 text-xs">You can turn this on or off anytime in Settings → Backup.</p>
                    </div>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel onClick={() => answerBackup(false)} data-testid="ask-not-now">Not now</AlertDialogCancel>
                  <AlertDialogAction onClick={() => answerBackup(true)} data-testid="ask-enable">Enable data backup</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

          </div>
        </TabsContent>

        <TabsContent value="backup">
          <div className="grid gap-4 max-w-3xl">

            {/* Download backup */}
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-sm flex items-center gap-1.5"><DatabaseBackup className="h-4 w-4" /> Download backup</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Complete snapshot: products, stock, sales & items, purchases, customers & khata, suppliers, expenses, users & settings.
                    Passwords are never included. Every export is written to the audit log.
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-36 h-8 text-base md:text-xs" title="From (optional)" />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-36 h-8 text-base md:text-xs" title="To (optional)" />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => doBackup('xlsx')} disabled={!!bkBusy}>
                  {busyBtn('xlsx') ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4 mr-1" />}
                  Excel — all tables
                </Button>
                <div className="flex items-center gap-1.5">
                  <Select value={csvTable} onValueChange={setCsvTable}>
                    <SelectTrigger className="w-44 h-8 text-xs"><Table2 className="h-3.5 w-3.5 mr-1" /><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {BACKUP_SHEETS.map(sh => <SelectItem key={sh.key} value={String(sh.key)} className="text-xs">{sh.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" onClick={() => doBackup('csv')} disabled={!!bkBusy}>
                    {busyBtn('csv') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Table2 className="h-4 w-4 mr-1" />}
                    CSV
                  </Button>
                </div>
                <Button size="sm" variant="outline" onClick={() => doBackup('pdf')} disabled={!!bkBusy}>
                  {busyBtn('pdf') ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4 mr-1" />}
                  PDF (print)
                </Button>
                <Button size="sm" variant="outline" onClick={() => doBackup('json')} disabled={!!bkBusy}>
                  {busyBtn('json') ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileJson className="h-4 w-4 mr-1" />}
                  JSON (full)
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Excel = one sheet per table (recommended). CSV = the selected table only. PDF = printable report → “Save as PDF”.
                Leave dates empty for a full-history backup.
              </p>
            </div>

            {/* Email backup */}
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <h3 className="font-semibold text-sm flex items-center gap-1.5"><Mail className="h-4 w-4" /> Email backup to owner</h3>
              <p className="text-xs text-muted-foreground">
                Sends the complete Excel workbook (every table, based on the date range above) as an email attachment.
                Keep a copy in your inbox / cloud so your data is always safe even if a device is lost.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Send to email</Label>
                  <Input value={bkEmail} onChange={e => setBkEmail(e.target.value)} placeholder="owner@shop.com" className="w-64 h-8 text-base md:text-xs" />
                </div>
                <Button size="sm" onClick={sendBackupEmail} disabled={!!bkBusy}>
                  {busyBtn('email') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
                  Send backup now
                </Button>
                <Badge variant="outline" className={`text-[10px] gap-1 ${smtpOn ? 'text-emerald-600 border-emerald-300' : 'text-amber-600 border-amber-300'}`}>
                  <ShieldCheck className="h-3 w-3" />
                  {smtpOn ? 'SMTP ready' : s.smtp?.configured || platformSmtp ? 'SMTP off' : 'SMTP not configured'}
                </Badge>
              </div>

              <p className="text-[11px] text-muted-foreground">
                Who sends the email (SMTP login + App Password) is configured once in the <b>Mail &amp; backup</b> tab — the setup is shared by the whole shop.
              </p>
            </div>

          </div>
        </TabsContent>
      </Tabs>

      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
    </div>
  )
}
