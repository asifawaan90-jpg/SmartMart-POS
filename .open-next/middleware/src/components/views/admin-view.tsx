'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, errMsg } from '@/lib/client'
import { useAuthStore } from '@/stores/auth'
import { useT } from '@/stores/lang'
import { fmtMoney, fmtDate, fmtDateTime } from '@/lib/format'
import { PageHeader, LoadingBlock, ErrorBanner, StatCard, MobileCard, MobileCardList, MetaItem } from '@/components/shared/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PasswordInput } from '@/components/ui/password-input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { buildWorkbookBytes, buildMultiWorkbookBytes, backupFilename, type BackupData } from '@/lib/backup-shared'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
} from 'recharts'
import {
  Building2, Users, Crown, Clock, AlertTriangle, CheckCircle2, XCircle,
  TrendingUp, Loader2, Search, Save, Mail, KeyRound, DatabaseBackup, Download, CloudUpload, Trash2,
} from 'lucide-react'

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

interface Stats {
  cards: {
    totalBusinesses: number; activeSubs: number; trialSubs: number; expiredSubs: number
    suspended: number; lifetimeSubs: number; revenue: number; todayRevenue: number
    newThisMonth: number; pendingPayments: number
  }
  expiring: { business: { name: string; email: string }; status: string; endDate: string }[]
  trend: { date: string; count: number }[]
}
interface Biz {
  id: string; name: string; ownerName: string; email: string; phone: string; isActive: boolean; createdAt: string
  users: number; products: number; sales: number; lastLogin: string | null
  subscription: { id: string; status: string; planName: string; planCode: string; price: number; startDate: string; endDate: string | null; daysRemaining: number | null } | null
}
interface Payment { id: string; amount: number; method: string; reference: string; status: string; createdAt: string; business: { name: string; email: string }; plan: { name: string; code: string } }
interface Plan { id: string; code: string; name: string; price: number; durationDays: number; features: string; isActive: boolean; isPublic: boolean }
interface AUser {
  id: string; name: string; email: string; phone: string; role: string; isActive: boolean
  lastLoginAt: string | null; createdAt: string
  business: { id: string; name: string; email: string; isActive: boolean; subStatus: string; planName: string; planCode: string; endDate: string | null; daysRemaining: number | null } | null
  blocked: boolean; blockReason: string
}
interface UserSummary { total: number; active: number; deactivated: number; blockedBySub: number }

interface SmtpStatus {
  saved: { configured: boolean; host: string; port: number; user: string; from: string; passSet: boolean }
  envActive: boolean
  effectiveConfigured: boolean
  effectiveSource: string
}

interface PlatformBackupInfo {
  cfg: { auto: boolean; minIntervalMin: number; ccUserMail: boolean; lastAutoAt: string }
  ownerEmails: string[]
  businesses: { id: string; name: string; email: string; counts: Record<string, number> | null; error: string | null }[]
  smtpConfigured: boolean
  smtpUser: string
}

const SCOLORS: Record<string, string> = {
  TRIAL: 'text-sky-600 border-sky-300', ACTIVE: 'text-emerald-600 border-emerald-300',
  LIFETIME: 'text-amber-600 border-amber-300', EXPIRED: 'text-red-600 border-red-300',
  SUSPENDED: 'text-red-600 border-red-300', DEACTIVATED: 'text-red-600 border-red-300',
}

export default function AdminView() {
  const t = useT()
  const [stats, setStats] = useState<Stats | null>(null)
  const [bizs, setBizs] = useState<Biz[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Biz | null>(null)
  // Task 57 — recent subscription changes for the Manage dialog (transparency:
  // every plan/date change is visible with its action + time)
  const [subHistory, setSubHistory] = useState<{ at: string; action: string; details: string }[] | null>(null)
  // Task 57 — the extend box MUST start empty: it used to open pre-filled
  // with "30", so one stray click on Extend silently granted 30 days (the
  // reported "I saved 7 days, after re-login it had gone to 30").
  const [extendDays, setExtendDays] = useState('')
  const [planEdit, setPlanEdit] = useState<Plan | null>(null)
  const [planForm, setPlanForm] = useState({ name: '', price: '', durationDays: '', features: '' })
  const [tab, setTab] = useState('businesses')
  const [users, setUsers] = useState<AUser[]>([])
  const [userSummary, setUserSummary] = useState<UserSummary>({ total: 0, active: 0, deactivated: 0, blockedBySub: 0 })
  const [userSearch, setUserSearch] = useState('')
  const [userDebounced, setUserDebounced] = useState('')
  const [userFilter, setUserFilter] = useState('all')
  const [userBusy, setUserBusy] = useState('')

  // Platform email delivery (Password-reset codes, notifications)
  const [smtpForm, setSmtpForm] = useState({ host: '', port: '587', user: '', pass: '', from: '' })
  const [smtpInfo, setSmtpInfo] = useState<SmtpStatus | null>(null)
  const [smtpBusy, setSmtpBusy] = useState('')
  const [smtpNote, setSmtpNote] = useState('')
  const [testTo, setTestTo] = useState('')

  // Platform data export & automatic cloud backup (Task 42)
  const [pbInfo, setPbInfo] = useState<PlatformBackupInfo | null>(null)
  const [pbBusy, setPbBusy] = useState('')
  const [exportTarget, setExportTarget] = useState('all')

  useEffect(() => {
    const timer = setTimeout(() => setUserDebounced(userSearch), 300)
    return () => clearTimeout(timer)
  }, [userSearch])

  const load = useCallback(async (silent = false) => {
    if (!silent) { setLoading(true); setError('') }
    try {
      const [s, b, p, pl] = await Promise.all([
        api<Stats>('/api/admin/stats'),
        api<Biz[]>(`/api/admin/businesses?search=${encodeURIComponent(debounced)}`),
        api<Payment[]>('/api/admin/payments'),
        api<Plan[]>('/api/admin/plans'),
      ])
      setStats(s); setBizs(b); setPayments(p); setPlans(pl)
      if (!silent) setError('')
    } catch (e) { if (!silent) setError(errMsg(e)) } finally { if (!silent) setLoading(false) }
  }, [debounced])

  useEffect(() => { load() }, [load])

  const loadUsers = useCallback(async () => {
    try {
      const d = await api<{ items: AUser[]; summary: UserSummary }>(`/api/admin/users?search=${encodeURIComponent(userDebounced)}&status=${userFilter}`)
      setUsers(d.items); setUserSummary(d.summary)
    } catch { /* main error banner covers auth issues */ }
  }, [userDebounced, userFilter])

  useEffect(() => { if (tab === 'users') loadUsers() }, [tab, loadUsers])

  // Task 50 — an OPEN panel must never show previous data: tenants save sales,
  // products and plan-relevant activity while the owner watches. Re-read
  // everything SILENTLY (no spinner flash) when the app refocuses and once a
  // minute while it stays open.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') { load(true); if (tab === 'users') loadUsers() } }
    document.addEventListener('visibilitychange', onVis)
    const iv = setInterval(() => { load(true); if (tab === 'users') loadUsers() }, 60_000)
    return () => { document.removeEventListener('visibilitychange', onVis); clearInterval(iv) }
  }, [load, loadUsers, tab])

  const loadSmtp = useCallback(async () => {
    try {
      const d = await api<SmtpStatus>('/api/admin/smtp')
      setSmtpInfo(d)
      if (d.saved.configured) {
        setSmtpForm(f => ({ ...f, host: d.saved.host, port: String(d.saved.port), user: d.saved.user, from: d.saved.from }))
      } else {
        // One-paste Gmail setup: prefill the form with the owner's own address so
        // the only thing left to type is the 16-character app password. The inner
        // guard never overwrites an address the owner already typed.
        const me = useAuthStore.getState().user?.email || ''
        setSmtpForm(f => (f.user ? f : { host: 'smtp.gmail.com', port: '587', user: me || f.user, pass: f.pass, from: f.from || (me ? `SmartMart POS <${me}>` : '') }))
      }
      setTestTo(prev => prev || useAuthStore.getState().user?.email || '')
    } catch { /* main error banner covers auth issues */ }
  }, [])

  useEffect(() => { if (tab === 'email') loadSmtp() }, [tab, loadSmtp])

  // Task 42 — platform data export & cloud-backup status/config
  const loadBackupInfo = useCallback(async () => {
    try { setPbInfo(await api<PlatformBackupInfo>('/api/admin/backup')) } catch { /* main error banner covers auth issues */ }
  }, [])

  useEffect(() => { if (tab === 'data') loadBackupInfo() }, [tab, loadBackupInfo])

  // Task 57 — fetch the subscription change history whenever the Manage dialog opens
  useEffect(() => {
    if (!selected?.id) { setSubHistory(null); return }
    let live = true
    api<{ at: string; action: string; details: string }[]>(`/api/admin/businesses/${selected.id}`)
      .then(h => { if (live) setSubHistory(Array.isArray(h) ? h : []) })
      .catch(() => { if (live) setSubHistory(null) })
    return () => { live = false }
  }, [selected?.id])

  // Task 57 — human-readable one-liner for an audit entry (details is JSON)
  const histLabel = (e: { action: string; details: string }): string => {
    let d: Record<string, unknown> = {}
    try { d = JSON.parse(e.details || '{}') } catch { /* raw details below */ }
    const s = (k: string) => (d[k] != null ? String(d[k]) : '')
    switch (e.action) {
      case 'ADMIN_SUBSCRIPTION_ACTION':
        return s('plan')
          ? t('adm.histPlan', { plan: s('plan'), status: s('status') || '—', until: s('endDate') ? new Date(s('endDate')).toISOString().slice(0, 10) : '—' })
          : t('adm.histStatus', { status: s('status') || s('action') || '—' })
      case 'TRIAL_STARTED':
        return t('adm.histTrial', { days: s('days') || '7', until: s('endDate') ? s('endDate').slice(0, 10) : '—' })
      case 'SUBSCRIPTION_PAYMENT_SUBMITTED':
        return t('adm.histPaySubmit', { plan: s('plan') || '—', amount: s('amount') || '—' })
      case 'ADMIN_PAYMENT_APPROVED':
        return t('adm.histPayOk', { plan: s('plan') || '—', amount: s('amount') || '—' })
      case 'ADMIN_PAYMENT_REJECTED':
        return t('adm.histPayNo', { plan: s('plan') || '—', amount: s('amount') || '—' })
      default:
        return e.details ? `${e.action} · ${e.details.slice(0, 80)}` : e.action
    }
  }

  const downloadExport = async () => {
    setPbBusy('export')
    try {
      const r = await api<{ businesses: { id: string; name: string; data: BackupData | null; error: string | null }[] }>(`/api/admin/export?businessId=${encodeURIComponent(exportTarget)}`)
      const items = r.businesses.filter((b): b is { id: string; name: string; data: BackupData; error: null } => !!b.data)
      if (!items.length) { alert(t('adm.exportEmpty')); return }
      if (items.length === 1) {
        downloadBlob(backupFilename(items[0].data.meta.businessName || items[0].name, 'xlsx'),
          buildWorkbookBytes(items[0].data) as BlobPart,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      } else {
        downloadBlob(`SmartMart-ALL-businesses-${new Date().toISOString().slice(0, 10)}.xlsx`,
          buildMultiWorkbookBytes(items) as BlobPart,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      }
    } catch (e) { alert(errMsg(e)) } finally { setPbBusy('') }
  }

  const savePbCfg = async (patch: Partial<PlatformBackupInfo['cfg']>) => {
    setPbInfo(p => p ? { ...p, cfg: { ...p.cfg, ...patch } } : p)
    try {
      const r = await api<{ cfg: PlatformBackupInfo['cfg'] }>('/api/admin/backup', { method: 'PUT', body: patch })
      setPbInfo(p => p ? { ...p, cfg: r.cfg } : p)
    } catch (e) { alert(errMsg(e)) }
  }

  const emailAllNow = async () => {
    setPbBusy('email')
    try {
      const r = await api<{ sent: boolean; to: string[]; files: string[]; businesses: number }>('/api/admin/backup', { method: 'POST', body: {} })
      alert(t('adm.backupEmailed', { to: r.to.join(', '), n: r.businesses }))
      loadBackupInfo()
    } catch (e) { alert(errMsg(e)) } finally { setPbBusy('') }
  }

  const saveSmtp = async () => {
    setSmtpBusy('save'); setSmtpNote('')
    try {
      const r = await api<{ message: string }>('/api/admin/smtp', {
        method: 'PUT',
        body: { host: smtpForm.host, port: Number(smtpForm.port) || 587, user: smtpForm.user, pass: smtpForm.pass, from: smtpForm.from },
      })
      setSmtpForm(f => ({ ...f, pass: '' }))
      setSmtpNote(r.message)
      loadSmtp()
    } catch (e) { alert(errMsg(e)) } finally { setSmtpBusy('') }
  }

  const sendTestEmail = async () => {
    setSmtpBusy('test'); setSmtpNote('')
    try {
      const r = await api<{ message: string }>('/api/admin/smtp', { method: 'POST', body: { to: testTo } })
      setSmtpNote(r.message)
    } catch (e) { alert(errMsg(e)) } finally { setSmtpBusy('') }
  }

  const removeSmtp = async () => {
    if (!confirm(t('adm.confirmRemoveSmtp'))) return
    setSmtpBusy('del'); setSmtpNote('')
    try {
      await api('/api/admin/smtp', { method: 'DELETE' })
      setSmtpForm({ host: '', port: '587', user: '', pass: '', from: '' })
      setSmtpNote(t('adm.smtpRemoved'))
      loadSmtp()
    } catch (e) { alert(errMsg(e)) } finally { setSmtpBusy('') }
  }

  const setUserActive = async (u: AUser, next: boolean) => {
    if (!next && !confirm(t('adm.confirmDeactivateUser', { name: u.name, email: u.email }))) return
    setUserBusy(u.id)
    try {
      await api('/api/admin/users', { method: 'PATCH', body: { action: 'set_user_active', userId: u.id, isActive: next } })
      loadUsers()
    } catch (e) { alert(errMsg(e)) } finally { setUserBusy('') }
  }

  // Platform owner sets a brand-new password for a user (forgot-password support).
  const [pwUser, setPwUser] = useState<AUser | null>(null)
  const [pwForm, setPwForm] = useState({ a: '', b: '' })
  const [pwBusy, setPwBusy] = useState(false)

  const setUserPassword = async () => {
    if (!pwUser) return
    if (pwForm.a.length < 6) { alert(t('adm.pwTooShort')) ; return }
    if (pwForm.a !== pwForm.b) { alert(t('adm.pwMismatch')) ; return }
    setPwBusy(true)
    try {
      const r = await api<{ message: string }>('/api/admin/users', {
        method: 'PATCH', body: { action: 'set_password', userId: pwUser.id, password: pwForm.a },
      })
      alert(r.message)
      setPwUser(null)
      setPwForm({ a: '', b: '' })
      loadUsers()
    } catch (e) { alert(errMsg(e)) } finally { setPwBusy(false) }
  }

  // Platform owner permanently deletes a staff account. Irreversible — the
  // dialog demands the typed word DELETE before the button wakes up.
  const [delUser, setDelUser] = useState<AUser | null>(null)
  const [delConfirm, setDelConfirm] = useState('')
  const [delBusy, setDelBusy] = useState(false)

  const deleteUser = async () => {
    if (!delUser) return
    setDelBusy(true)
    try {
      const r = await api<{ message: string }>('/api/admin/users', {
        method: 'PATCH', body: { action: 'delete_user', userId: delUser.id },
      })
      alert(r.message)
      setDelUser(null)
      setDelConfirm('')
      loadUsers()
    } catch (e) { alert(errMsg(e)) } finally { setDelBusy(false) }
  }

  const bulkStaff = async (bizId: string, bizName: string, next: boolean) => {
    if (!confirm(next
      ? t('adm.confirmBulkActivate', { name: bizName })
      : t('adm.confirmBulkDeactivate', { name: bizName }))) return
    try {
      await api('/api/admin/users', { method: 'PATCH', body: { action: 'bulk_business', businessId: bizId, isActive: next } })
      loadUsers()
    } catch (e) { alert(errMsg(e)) }
  }

  const act = async (biz: Biz, action: string, days?: number, planId?: string) => {
    try {
      const r = await api<{ changed?: boolean; subscription?: { status: string; planCode?: string; endDate: string | null } }>(`/api/admin/businesses/${biz.id}`, { method: 'PATCH', body: { action, days, planId } })
      setSelected(null)
      load()
      // Task 47 — every plan change answers back unambiguously: the owner must
      // never have to guess whether the change actually saved (the old silent
      // close looked like "not saved", and re-login showed the SAME data
      // because the change had in fact been saved).
      // Task 55 — a re-applied running package is a server-side NO-OP: the
      // answer now says so honestly ("dates kept exactly as applied") instead
      // of pretending to save and leaving the owner unsure what happened.
      if (action === 'change_plan' && r?.subscription) {
        const p = plans.find(x => x.id === planId)
        const planName = p?.name || r.subscription.planCode || t('adm.theNewPlan')
        const end = r.subscription.endDate ? new Date(r.subscription.endDate).toLocaleDateString() : ''
        const until = end ? t('adm.validUntil', { date: end }) : ''
        if (r.changed === false) {
          alert(t('adm.planAlready', { name: biz.name, plan: planName, until }))
        } else {
          alert(t('adm.planSaved', { name: biz.name, plan: planName, status: r.subscription.status, until }))
        }
      }
      // Task 57 — an extension also confirms with the exact new end date, so
      // the owner always sees what was saved (never a silent dialog close).
      if (action === 'extend' && r?.subscription) {
        const end = r.subscription.endDate ? new Date(r.subscription.endDate).toLocaleDateString() : ''
        alert(t('adm.extended', { name: biz.name, date: end }))
      }
    } catch (e) { alert(errMsg(e)) }
  }

  const reviewPayment = async (p: Payment, status: 'APPROVED' | 'REJECTED') => {
    try {
      await api(`/api/admin/payments/${p.id}`, { method: 'PATCH', body: { status } })
      load()
    } catch (e) { alert(errMsg(e)) }
  }

  const savePlan = async () => {
    if (!planEdit) return
    // Task 57 — the plan duration must be EXPLICIT: an emptied field used to
    // save 0 (a broken plan that could no longer grant a period), and the
    // extend box silently sent 30 when left empty. No more silent values —
    // invalid input is refused with an honest message and nothing is sent.
    const days = parseInt(planForm.durationDays, 10)
    if (!Number.isFinite(days) || (days !== -1 && days < 1)) {
      alert(t('adm.planDaysInvalid'))
      return
    }
    try {
      await api(`/api/admin/plans?id=${planEdit.id}`, {
        method: 'PUT',
        body: {
          name: planForm.name,
          price: parseFloat(planForm.price) || 0,
          durationDays: days,
          features: planForm.features.split('\n').map(x => x.trim()).filter(Boolean),
        },
      })
      setPlanEdit(null)
      load()
    } catch (e) { alert(errMsg(e)) }
  }

  if (loading) return <div className="p-6"><LoadingBlock rows={8} /></div>
  if (error || !stats) return <div className="p-6"><ErrorBanner message={error} onRetry={() => load()} /></div>

  const c = stats.cards

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title={t('adm.title')}
        subtitle={t('adm.subtitle')}
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <StatCard title={t('adm.statBiz')} value={String(c.totalBusinesses)} sub={t('adm.statBizSub', { n: c.newThisMonth })} icon={<Building2 className="h-3.5 w-3.5" />} />
        <StatCard title={t('adm.statRevenue')} value={fmtMoney(c.revenue)} sub={t('adm.statRevenueSub', { v: fmtMoney(c.todayRevenue) })} icon={<TrendingUp className="h-3.5 w-3.5" />} tone="good" />
        <StatCard title={t('adm.statActive')} value={String(c.activeSubs)} icon={<CheckCircle2 className="h-3.5 w-3.5" />} />
        <StatCard title={t('adm.statTrial')} value={String(c.trialSubs)} icon={<Clock className="h-3.5 w-3.5" />} />
        <StatCard title={t('adm.statExpired')} value={`${c.expiredSubs} / ${c.suspended}`} icon={<AlertTriangle className="h-3.5 w-3.5" />} tone={c.expiredSubs ? 'warn' : undefined} />
        <StatCard title={t('adm.statLifetime')} value={String(c.lifetimeSubs)} icon={<Crown className="h-3.5 w-3.5" />} />
        <StatCard title={t('adm.statPending')} value={String(c.pendingPayments)} icon={<Clock className="h-3.5 w-3.5" />} tone={c.pendingPayments ? 'warn' : undefined} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap h-auto gap-1">
          <TabsTrigger value="businesses" className="text-xs">{t('adm.tabBusinesses')}</TabsTrigger>
          <TabsTrigger value="users" className="text-xs">{t('adm.tabUsers')} {userSummary.total ? `(${userSummary.total})` : ''}</TabsTrigger>
          <TabsTrigger value="payments" className="text-xs">{t('adm.tabPayments')} {c.pendingPayments ? `(${c.pendingPayments})` : ''}</TabsTrigger>
          <TabsTrigger value="plans" className="text-xs">{t('adm.tabPlans')}</TabsTrigger>
          <TabsTrigger value="growth" className="text-xs">{t('adm.tabGrowth')}</TabsTrigger>
          <TabsTrigger value="data" className="text-xs">{t('adm.tabData')}</TabsTrigger>
          <TabsTrigger value="email" className="text-xs">{t('adm.tabEmail')}</TabsTrigger>
        </TabsList>

        <TabsContent value="businesses">
          <div className="relative max-w-xs mb-3">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder={t('adm.searchBiz')} value={search} onChange={e => setSearch(e.target.value)} className="pl-8 h-9" />
          </div>
          <MobileCardList>
            {bizs.map(b => (
              <MobileCard
                key={b.id}
                title={b.name}
                subtitle={b.email}
                badge={b.subscription ? <Badge variant="outline" className={SCOLORS[b.subscription.status]}>{b.subscription.status}</Badge> : null}
                meta={(
                  <>
                    <MetaItem label={t('adm.colPlan')}>{b.subscription?.planName || '—'}{b.subscription?.status === 'EXPIRED' && b.subscription?.endDate ? <span className="block text-[10px] text-muted-foreground">{t('adm.wasDue', { date: fmtDate(b.subscription.endDate) })}</span> : b.subscription?.daysRemaining != null && b.subscription.status !== 'LIFETIME' ? <span className="block text-[10px] text-muted-foreground">{t('adm.daysLeft', { n: b.subscription.daysRemaining })}</span> : null}</MetaItem>
                    <MetaItem label={t('adm.colUsersProducts')}>{b.users} / {b.products}</MetaItem>
                    <MetaItem label={t('adm.colRegistered')} className="col-span-2">{fmtDate(b.createdAt)}</MetaItem>
                  </>
                )}
                actions={
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setSelected(b)}>{t('adm.manage')}</Button>
                }
              />
            ))}
          </MobileCardList>
          <div className="hidden md:block rounded-lg border overflow-x-auto bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-secondary/50 text-left text-xs text-muted-foreground">
                  <th className="p-2.5 font-medium">{t('adm.colBusiness')}</th>
                  <th className="p-2.5 font-medium">{t('adm.colPlan')}</th>
                  <th className="p-2.5 font-medium">{t('common.status')}</th>
                  <th className="p-2.5 font-medium text-right">{t('adm.colUsersProducts')}</th>
                  <th className="p-2.5 font-medium hidden lg:table-cell">{t('adm.colRegistered')}</th>
                  <th className="p-2.5 font-medium text-right">{t('adm.manage')}</th>
                </tr>
              </thead>
              <tbody>
                {bizs.map(b => (
                  <tr key={b.id} className="border-b last:border-0 hover:bg-secondary/30">
                    <td className="p-2.5">
                      <div className="font-medium">{b.name} {!b.isActive ? <Badge variant="secondary" className="ml-1">{t('adm.disabled')}</Badge> : null}</div>
                      <div className="text-[11px] text-muted-foreground">{b.email}</div>
                    </td>
                    <td className="p-2.5 text-xs">{b.subscription?.planName || '—'}</td>
                    <td className="p-2.5">
                      {b.subscription ? <Badge variant="outline" className={SCOLORS[b.subscription.status]}>{b.subscription.status}</Badge> : '—'}
                      {b.subscription?.status === 'EXPIRED' && b.subscription?.endDate ? (
                        <div className="text-[10px] text-muted-foreground mt-0.5">{t('adm.wasDue', { date: fmtDate(b.subscription.endDate) })}</div>
                      ) : b.subscription?.daysRemaining != null && b.subscription.status !== 'LIFETIME' ? (
                        <div className="text-[10px] text-muted-foreground mt-0.5">{t('adm.daysLeft', { n: b.subscription.daysRemaining })}</div>
                      ) : null}
                    </td>
                    <td className="p-2.5 text-right text-xs">{b.users} / {b.products}</td>
                    <td className="p-2.5 hidden lg:table-cell text-xs">{fmtDate(b.createdAt)}</td>
                    <td className="p-2.5 text-right">
                      <Button size="sm" variant="outline" onClick={() => setSelected(b)}>{t('adm.manage')}</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="users">
          <p className="text-xs text-muted-foreground mb-3">
            {t('adm.usersIntro')}
          </p>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="relative max-w-xs">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input placeholder={t('adm.searchUsers')} value={userSearch} onChange={e => setUserSearch(e.target.value)} className="pl-8 h-9" />
            </div>
            <Select value={userFilter} onValueChange={setUserFilter}>
              <SelectTrigger className="w-44 h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('adm.filterAll')}</SelectItem>
                <SelectItem value="active">{t('adm.filterActive')}</SelectItem>
                <SelectItem value="deactivated">{t('adm.filterDeactivated', { n: userSummary.deactivated })}</SelectItem>
                <SelectItem value="blocked">{t('adm.filterBlocked', { n: userSummary.blockedBySub })}</SelectItem>
              </SelectContent>
            </Select>
            <div className="text-xs text-muted-foreground ml-auto">{t('adm.userSummary', { active: userSummary.active, deactivated: userSummary.deactivated, blocked: userSummary.blockedBySub })}</div>
          </div>
          <MobileCardList>
            {users.length === 0 ? <p className="text-sm text-muted-foreground p-4 border rounded-lg">{t('adm.noUsers')}</p> : users.map(u => {
              const isSuper = u.role === 'SUPER_ADMIN'
              const isOwner = u.role === 'OWNER'
              const subOff = u.blockReason.startsWith('SUBSCRIPTION_') || u.blockReason === 'BUSINESS_DEACTIVATED'
              return (
                <MobileCard
                  key={u.id}
                  title={u.name}
                  subtitle={`${u.email}${u.phone ? ` · ${u.phone}` : ''}`}
                  badge={<Badge variant="outline" className="text-[10px]">{u.role.replace('_', ' ')}</Badge>}
                  meta={(
                    <>
                      <MetaItem label={t('adm.colBizService')} className="col-span-2">
                        {u.business ? (
                          <>
                            {u.business.name}
                            <span className="inline-flex items-center gap-1.5 ml-1.5">
                              <Badge variant="outline" className={`text-[10px] ${SCOLORS[u.business.subStatus] || ''}`}>{u.business.subStatus}</Badge>
                              {u.business.daysRemaining != null && u.business.subStatus !== 'LIFETIME' ? (
                                <span className="text-[10px] text-muted-foreground">{u.business.subStatus === 'EXPIRED' ? t('adm.wasDue', { date: fmtDate(u.business.endDate) }) : t('adm.daysLeft', { n: u.business.daysRemaining })}</span>
                              ) : null}
                            </span>
                          </>
                        ) : <span className="text-muted-foreground">{t('adm.platformTag')}</span>}
                      </MetaItem>
                      <MetaItem label={t('adm.colLastLogin')} className="col-span-2">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : t('adm.never')}</MetaItem>
                      <MetaItem label={t('common.status')} className="col-span-2">
                        {isSuper ? <Badge variant="outline">{t('adm.platformAdmin')}</Badge>
                          : !u.isActive ? <Badge variant="outline" className="text-red-600 border-red-300">{t('adm.deactivated')}</Badge>
                          : u.blocked ? <Badge variant="outline" className="text-amber-600 border-amber-300">{t('adm.serviceBlocked')}</Badge>
                          : <Badge variant="outline" className="text-emerald-600 border-emerald-300">{t('adm.active')}</Badge>}
                      </MetaItem>
                    </>
                  )}
                  actions={isSuper ? <span className="text-[11px] text-muted-foreground">{t('adm.platformAdminProtected')}</span> : (
                    <>
                      <Button size="sm" variant="outline" className="h-7 text-xs" title={t('adm.titleSetPw')}
                        onClick={() => { setPwUser(u); setPwForm({ a: '', b: '' }) }}>
                        <KeyRound className="h-3.5 w-3.5" /> {t('adm.password')}
                      </Button>
                      {u.isActive ? (
                        <Button size="sm" variant="outline" className="text-red-600 border-red-300 h-7 text-xs" disabled={userBusy === u.id || isOwner}
                          title={isOwner ? t('adm.titleOwnerNoDeactivate') : t('adm.titleBlockSignin')}
                          onClick={() => setUserActive(u, false)}>
                          {userBusy === u.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />} {t('adm.deactivate')}
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" className="text-emerald-600 border-emerald-300 h-7 text-xs" disabled={userBusy === u.id}
                          title={subOff ? t('adm.titleServiceOff') : t('adm.titleRestoreSignin')}
                          onClick={() => setUserActive(u, true)}>
                          {userBusy === u.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} {t('adm.activate')}
                        </Button>
                      )}
                      <Button size="sm" variant="outline" className="text-red-600 border-red-300 h-7 text-xs" disabled={isOwner}
                        title={isOwner ? t('adm.titleOwnerNoDelete') : t('adm.titleDelete')}
                        onClick={() => { setDelUser(u); setDelConfirm('') }}>
                        <Trash2 className="h-3.5 w-3.5" /> {t('adm.delete')}
                      </Button>
                    </>
                  )}
                />
              )
            })}
          </MobileCardList>
          <div className="hidden md:block rounded-lg border overflow-x-auto bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-secondary/50 text-left text-xs text-muted-foreground">
                  <th className="p-2.5 font-medium">{t('adm.colUser')}</th>
                  <th className="p-2.5 font-medium">{t('adm.colRole')}</th>
                  <th className="p-2.5 font-medium">{t('adm.colBizService')}</th>
                  <th className="p-2.5 font-medium hidden lg:table-cell">{t('adm.colLastLogin')}</th>
                  <th className="p-2.5 font-medium">{t('common.status')}</th>
                  <th className="p-2.5 font-medium text-right">{t('adm.colAccess')}</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? <tr><td colSpan={6} className="p-6 text-center text-muted-foreground text-sm">{t('adm.noUsers')}</td></tr> : users.map(u => {
                  const isSuper = u.role === 'SUPER_ADMIN'
                  const isOwner = u.role === 'OWNER'
                  const subOff = u.blockReason.startsWith('SUBSCRIPTION_') || u.blockReason === 'BUSINESS_DEACTIVATED'
                  return (
                    <tr key={u.id} className="border-b last:border-0 hover:bg-secondary/30">
                      <td className="p-2.5">
                        <div className="font-medium">{u.name}</div>
                        <div className="text-[11px] text-muted-foreground">{u.email}{u.phone ? ` · ${u.phone}` : ''}</div>
                      </td>
                      <td className="p-2.5"><Badge variant="outline" className="text-[10px]">{u.role.replace('_', ' ')}</Badge></td>
                      <td className="p-2.5 text-xs">
                        {u.business ? (
                          <>
                            <div className="font-medium">{u.business.name}</div>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <Badge variant="outline" className={`text-[10px] ${SCOLORS[u.business.subStatus] || ''}`}>{u.business.subStatus}</Badge>
                              {u.business.daysRemaining != null && u.business.subStatus !== 'LIFETIME' ? (
                                <span className="text-[10px] text-muted-foreground">{u.business.subStatus === 'EXPIRED' ? t('adm.wasDue', { date: fmtDate(u.business.endDate) }) : t('adm.daysLeft', { n: u.business.daysRemaining })}</span>
                              ) : null}
                            </div>
                          </>
                        ) : <span className="text-muted-foreground">{t('adm.platformTag')}</span>}
                      </td>
                      <td className="p-2.5 hidden lg:table-cell text-xs">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : t('adm.never')}</td>
                      <td className="p-2.5">
                        {isSuper ? <Badge variant="outline">{t('adm.platformAdmin')}</Badge>
                          : !u.isActive ? <Badge variant="outline" className="text-red-600 border-red-300">{t('adm.deactivated')}</Badge>
                          : u.blocked ? <Badge variant="outline" className="text-amber-600 border-amber-300">{t('adm.serviceBlocked')}</Badge>
                          : <Badge variant="outline" className="text-emerald-600 border-emerald-300">{t('adm.active')}</Badge>}
                      </td>
                      <td className="p-2.5 text-right">
                        {isSuper ? <span className="text-[11px] text-muted-foreground">—</span>
                          : (
                            <div className="flex justify-end items-center gap-1.5">
                              <Button size="sm" variant="outline" className="h-7" title={t('adm.titleSetPw')}
                                onClick={() => { setPwUser(u); setPwForm({ a: '', b: '' }) }}>
                                <KeyRound className="h-3.5 w-3.5" /> {t('adm.password')}
                              </Button>
                              {u.isActive ? (
                                <Button size="sm" variant="outline" className="text-red-600 border-red-300 h-7" disabled={userBusy === u.id || isOwner}
                                  title={isOwner ? t('adm.titleOwnerNoDeactivate') : t('adm.titleBlockSignin')}
                                  onClick={() => setUserActive(u, false)}>
                                  {userBusy === u.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />} {t('adm.deactivate')}
                                </Button>
                              ) : (
                                <Button size="sm" variant="outline" className="text-emerald-600 border-emerald-300 h-7" disabled={userBusy === u.id}
                                  title={subOff ? t('adm.titleServiceOff') : t('adm.titleRestoreSignin')}
                                  onClick={() => setUserActive(u, true)}>
                                  {userBusy === u.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} {t('adm.activate')}
                                </Button>
                              )}
                              <Button size="sm" variant="outline" className="text-red-600 border-red-300 h-7" disabled={isOwner}
                                title={isOwner ? t('adm.titleOwnerNoDelete') : t('adm.titleDelete')}
                                onClick={() => { setDelUser(u); setDelConfirm('') }}>
                                <Trash2 className="h-3.5 w-3.5" /> {t('adm.delete')}
                              </Button>
                            </div>
                          )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="payments">
          <MobileCardList>
            {payments.length === 0 ? <p className="text-sm text-muted-foreground p-4 border rounded-lg">{t('adm.noPayments')}</p> : payments.map(p => (
              <MobileCard
                key={p.id}
                title={p.business?.name}
                subtitle={p.business?.email}
                badge={<Badge variant="outline" className={SCOLORS[p.status]}>{p.status}</Badge>}
                meta={(
                  <>
                    <MetaItem label={t('adm.colAmount')}><span className="font-bold">{fmtMoney(p.amount)}</span></MetaItem>
                    <MetaItem label={t('adm.colPlan')}>{p.plan?.name}</MetaItem>
                    <MetaItem label={t('adm.colMethodRef')} className="col-span-2">{p.method.replace('_', ' ')}{p.reference ? ` · ${p.reference}` : ''}<span className="block text-[10px] text-muted-foreground">{fmtDateTime(p.createdAt)}</span></MetaItem>
                  </>
                )}
                actions={p.status === 'PENDING' ? (
                  <>
                    <Button size="sm" variant="outline" className="text-emerald-600 border-emerald-300 h-7 text-xs" onClick={() => reviewPayment(p, 'APPROVED')}><CheckCircle2 className="h-3.5 w-3.5" /> {t('adm.approve')}</Button>
                    <Button size="sm" variant="outline" className="text-red-600 border-red-300 h-7 text-xs" onClick={() => reviewPayment(p, 'REJECTED')}><XCircle className="h-3.5 w-3.5" /> {t('adm.reject')}</Button>
                  </>
                ) : <span className="text-xs text-muted-foreground">{t('adm.reviewed')}</span>}
              />
            ))}
          </MobileCardList>
          <div className="hidden md:block rounded-lg border overflow-x-auto bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-secondary/50 text-left text-xs text-muted-foreground">
                  <th className="p-2.5 font-medium">{t('adm.colBusiness')}</th>
                  <th className="p-2.5 font-medium">{t('adm.colPlan')}</th>
                  <th className="p-2.5 font-medium text-right">{t('adm.colAmount')}</th>
                  <th className="p-2.5 font-medium">{t('adm.colMethodRef')}</th>
                  <th className="p-2.5 font-medium">{t('common.status')}</th>
                  <th className="p-2.5 font-medium text-right">{t('adm.colReview')}</th>
                </tr>
              </thead>
              <tbody>
                {payments.length === 0 ? <tr><td colSpan={6} className="p-6 text-center text-muted-foreground text-sm">{t('adm.noPayments')}</td></tr> : payments.map(p => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="p-2.5"><div className="font-medium">{p.business?.name}</div><div className="text-[11px] text-muted-foreground">{p.business?.email}</div></td>
                    <td className="p-2.5 text-xs">{p.plan?.name}</td>
                    <td className="p-2.5 text-right font-bold">{fmtMoney(p.amount)}</td>
                    <td className="p-2.5 text-xs">{p.method.replace('_', ' ')}{p.reference ? ` · ${p.reference}` : ''}<div className="text-[10px] text-muted-foreground">{fmtDateTime(p.createdAt)}</div></td>
                    <td className="p-2.5"><Badge variant="outline" className={SCOLORS[p.status]}>{p.status}</Badge></td>
                    <td className="p-2.5">
                      {p.status === 'PENDING' ? (
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="outline" className="text-emerald-600 border-emerald-300" onClick={() => reviewPayment(p, 'APPROVED')}><CheckCircle2 className="h-3.5 w-3.5" /> {t('adm.approve')}</Button>
                          <Button size="sm" variant="outline" className="text-red-600 border-red-300" onClick={() => reviewPayment(p, 'REJECTED')}><XCircle className="h-3.5 w-3.5" /> {t('adm.reject')}</Button>
                        </div>
                      ) : <span className="text-xs text-muted-foreground">{t('adm.reviewed')}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="plans">
          <p className="text-sm text-muted-foreground mb-3">{t('adm.plansIntro')}</p>
          <div className="grid md:grid-cols-3 gap-3">
            {plans.map(p => (
              <div key={p.id} className="rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-sm">{p.name}</h3>
                  <Badge variant="outline">{p.code}</Badge>
                </div>
                <div className="text-2xl font-black mt-1">{fmtMoney(p.price)}<span className="text-xs font-normal text-muted-foreground">{p.durationDays === -1 ? t('adm.once') : p.durationDays > 0 ? t('adm.perDays', { n: p.durationDays }) : ''}</span></div>
                <Button size="sm" variant="outline" className="mt-3 w-full" onClick={() => {
                  setPlanEdit(p)
                  setPlanForm({ name: p.name, price: String(p.price), durationDays: String(p.durationDays), features: (JSON.parse(p.features || '[]') as string[]).join('\n') })
                }}>{t('adm.editPlan')}</Button>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="growth">
          <div className="rounded-lg border bg-card p-4">
            <h3 className="text-sm font-semibold mb-3">{t('adm.growthTitle')}</h3>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={stats.trend} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} fontSize={10} tickLine={false} />
                  <YAxis fontSize={10} tickLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Area type="monotone" dataKey="count" name={t('adm.signups')} stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.25} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            {stats.expiring.length > 0 ? (
              <div className="mt-4">
                <h3 className="text-sm font-semibold mb-2">{t('adm.expiringTitle')}</h3>
                <div className="space-y-1.5">
                  {stats.expiring.map((x, i) => (
                    <div key={i} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                      <span>{x.business.name} <span className="text-xs text-muted-foreground">({x.business.email})</span></span>
                      <span className="text-xs">{x.status} · {t('adm.ends', { date: fmtDate(x.endDate) })}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </TabsContent>

        <TabsContent value="data">
          <div className="max-w-2xl space-y-3">
            {/* Data export — one business or ALL businesses */}
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <div>
                <h3 className="font-semibold text-sm flex items-center gap-1.5"><DatabaseBackup className="h-4 w-4 text-primary" /> {t('adm.dataExport')}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('adm.dataExportDesc')}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={exportTarget} onValueChange={setExportTarget}>
                  <SelectTrigger className="w-60 h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="text-xs">{t('adm.exportAllBiz')}</SelectItem>
                    {(pbInfo?.businesses || []).map(b => (
                      <SelectItem key={b.id} value={b.id} className="text-xs">{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={downloadExport} disabled={pbBusy === 'export'}>
                  {pbBusy === 'export' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4 mr-1" />} {t('adm.exportExcel')}
                </Button>
              </div>
              {pbInfo ? (
                <p className="text-[11px] text-muted-foreground">
                  {t('adm.exportCoverage', {
                    n: pbInfo.businesses.length,
                    rows: pbInfo.businesses.reduce((a, b) => a + (b.counts ? Object.values(b.counts).reduce((x, y) => x + Number(y || 0), 0) : 0), 0).toLocaleString(),
                  })}
                  {pbInfo.businesses.some(b => b.error) ? ' ' + t('adm.exportErrors') : ''}
                </p>
              ) : null}
            </div>

            {/* Automatic platform cloud backup — all users' data → owner mail */}
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-sm flex items-center gap-1.5"><CloudUpload className="h-4 w-4 text-primary" /> {t('adm.autoBackup')}</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('adm.autoBackupDesc1')} <b>{t('adm.and')}</b> {t('adm.autoBackupDesc2')}
                  </p>
                </div>
                {!pbInfo?.smtpConfigured ? (
                  <Badge variant="outline" className="text-amber-600 border-amber-300 text-[10px]">{t('adm.emailNotSet')}</Badge>
                ) : null}
              </div>

              <div className="rounded-lg bg-secondary/40 border p-3 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold">{t('adm.saveAuto')}</p>
                    <p className="text-[11px] text-muted-foreground">{t('adm.saveAutoDesc')}</p>
                  </div>
                  <Switch checked={pbInfo?.cfg.auto !== false} onCheckedChange={v => void savePbCfg({ auto: v })} />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t('adm.howOften')}</Label>
                    <Select value={String(pbInfo?.cfg.minIntervalMin || 60)} onValueChange={v => void savePbCfg({ minIntervalMin: parseInt(v) })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="15" className="text-xs">{t('adm.every15Min')}</SelectItem>
                        <SelectItem value="30" className="text-xs">{t('adm.every30Min')}</SelectItem>
                        <SelectItem value="60" className="text-xs">{t('adm.everyHour')}</SelectItem>
                        <SelectItem value="180" className="text-xs">{t('adm.every3h')}</SelectItem>
                        <SelectItem value="360" className="text-xs">{t('adm.every6h')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs flex items-center gap-1"><Mail className="h-3 w-3" /> {t('adm.ownerMail')}</Label>
                    <div className="h-8 flex items-center gap-1.5 text-xs text-muted-foreground rounded-md border px-2 bg-background/50 min-w-0">
                      <span className="truncate" data-testid="owner-mails">{pbInfo?.ownerEmails.join(', ') || '—'}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold">{t('adm.ccUserMail')}</p>
                    <p className="text-[11px] text-muted-foreground">{t('adm.ccUserMailDesc')}</p>
                  </div>
                  <Switch checked={pbInfo?.cfg.ccUserMail !== false} onCheckedChange={v => void savePbCfg({ ccUserMail: v })} />
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button size="sm" onClick={emailAllNow} disabled={pbBusy === 'email'}>
                    {pbBusy === 'email' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4 mr-1" />} {t('adm.emailAllNow')}
                  </Button>
                  <span className="text-[11px] text-muted-foreground" data-testid="last-auto">
                    {pbInfo?.cfg.lastAutoAt
                      ? t('adm.lastAuto', { time: new Date(pbInfo.cfg.lastAutoAt).toLocaleString() })
                      : t('adm.noAutoYet')}
                  </span>
                </div>
                {!pbInfo?.smtpConfigured ? (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    {t('adm.smtpSetupHint')}
                  </p>
                ) : null}
              </div>
            </div>

          </div>
        </TabsContent>

        <TabsContent value="email">
          <div className="max-w-xl space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">{t('adm.deliveryStatus')}</span>
              {smtpInfo?.effectiveConfigured ? (
                <Badge variant="outline" className="text-emerald-600 border-emerald-300">
                  {t('adm.smtpWorking', { via: smtpInfo.effectiveSource === 'environment' ? t('adm.viaEnv') : t('adm.viaPanel') })}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-amber-600 border-amber-300">{t('adm.smtpNotConfigured')}</Badge>
              )}
            </div>
            {smtpInfo?.envActive ? (
              <p className="text-xs text-muted-foreground">{t('adm.envNote')}</p>
            ) : null}
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{t('adm.smtpHost')}</Label>
                  <Input value={smtpForm.host} onChange={e => setSmtpForm({ ...smtpForm, host: e.target.value })} placeholder="smtp.gmail.com" />
                </div>
                <div className="space-y-1.5">
                  <Label>{t('adm.port')}</Label>
                  <Input value={smtpForm.port} onChange={e => setSmtpForm({ ...smtpForm, port: e.target.value })} placeholder="587" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>{t('adm.smtpUser')}</Label>
                <Input value={smtpForm.user} onChange={e => setSmtpForm({ ...smtpForm, user: e.target.value })} placeholder="you@gmail.com" />
              </div>
              <div className="space-y-1.5">
                <Label>{t('adm.smtpPass')}</Label>
                <Input type="password" value={smtpForm.pass} onChange={e => setSmtpForm({ ...smtpForm, pass: e.target.value })} placeholder={smtpInfo?.saved.passSet ? t('adm.pwSavedPlaceholder') : t('adm.pwPlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('adm.smtpFrom')}</Label>
                <Input value={smtpForm.from} onChange={e => setSmtpForm({ ...smtpForm, from: e.target.value })} placeholder="SmartMart POS <you@gmail.com>" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={saveSmtp} disabled={smtpBusy === 'save' || !smtpForm.host || !smtpForm.user}>
                  {smtpBusy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {t('adm.saveSettings')}
                </Button>
                <Input value={testTo} onChange={e => setTestTo(e.target.value)} placeholder={t('adm.sendTestTo')} className="h-8 w-52 text-xs" />
                <Button size="sm" variant="outline" onClick={sendTestEmail} disabled={smtpBusy === 'test' || !testTo}>
                  {smtpBusy === 'test' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />} {t('adm.sendTest')}
                </Button>
                {smtpInfo?.saved.configured ? (
                  <Button size="sm" variant="outline" className="text-red-600 border-red-300" onClick={removeSmtp} disabled={smtpBusy === 'del'}>
                    {t('adm.remove')}
                  </Button>
                ) : null}
              </div>
              {smtpNote ? <p className="text-xs text-emerald-600">{smtpNote}</p> : null}
            </div>
            <div className="rounded-lg border bg-secondary/40 p-3 text-xs text-muted-foreground space-y-1.5">
              <p className="font-medium text-foreground">{t('adm.gmailTitle')}</p>
              <p>
                {t('adm.gmailStep1a')}{' '}<a className="underline text-emerald-700 dark:text-emerald-400" href="https://myaccount.google.com/security" target="_blank" rel="noreferrer">{t('adm.gmailSecurityLink')}</a>{' '}{t('adm.gmailStep1b')} <b>{t('adm.gmail2sv')}</b>.<br />
                {t('adm.gmailStep2a')}{' '}<a className="underline text-emerald-700 dark:text-emerald-400" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">{t('adm.gmailAppPwLink')}</a>{' '}{t('adm.gmailStep2b')}<br />
                {t('adm.gmailStep3a')} <b>{t('adm.saveSettings')}</b>{t('adm.gmailStep3b')} <b>{t('adm.sendTest')}</b>{t('adm.gmailStep3c')}
              </p>
              <p>{t('adm.otherProviders')}</p>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {/* manage business dialog */}
      <Dialog open={!!selected} onOpenChange={v => !v && setSelected(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t('adm.manageTitle', { name: selected?.name || '' })}</DialogTitle></DialogHeader>
          {selected ? (
            <div className="space-y-3 text-sm">
              <div className="text-xs text-muted-foreground">
                {t('adm.ownerLine', { name: selected.ownerName, email: selected.email, phone: selected.phone || t('adm.noPhone') })}<br />
                {t('adm.currentPlan')} <b className="text-foreground">{selected.subscription?.planName || '—'}</b> · {t('common.status')}: <b className="text-foreground">{selected.subscription?.status}</b>
                {selected.subscription?.endDate ? ` · ${selected.subscription.status === 'EXPIRED' ? t('adm.wasDue', { date: fmtDate(selected.subscription.endDate) }) : t('adm.ends', { date: fmtDate(selected.subscription.endDate) })}` : ''}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {selected.subscription?.status === 'SUSPENDED' || selected.subscription?.status === 'EXPIRED' || selected.subscription?.status === 'DEACTIVATED' ? (
                  <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => act(selected, 'activate')}><Loader2 className="hidden" /> {t('adm.activate')}</Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => act(selected, 'suspend')}>{t('adm.suspend')}</Button>
                )}
                <Button size="sm" variant="outline" onClick={() => act(selected, 'deactivate')}>{t('adm.deactivate')}</Button>
              </div>
              <div className="space-y-1.5">
                <Label>{t('adm.extendSub')}</Label>
                <div className="flex gap-2">
                  <Input type="number" min={1} value={extendDays} onChange={e => setExtendDays(e.target.value)} />
                  <Button size="sm" onClick={() => {
                    // Task 57 — an empty/0 box used to silently extend by 30
                    // days (the reported "I saved 7 days, it became 30"). Now
                    // nothing is sent unless the owner typed a real number.
                    const d = parseInt(extendDays, 10)
                    if (!Number.isFinite(d) || d < 1) { alert(t('adm.extendDaysInvalid')); return }
                    act(selected, 'extend', d)
                  }}>{t('adm.extend')}</Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>{t('adm.changePlan')}</Label>
                <div className="flex flex-wrap gap-1.5">
                  {plans.map(p => (
                    <Button
                      key={p.id}
                      size="sm"
                      variant={selected.subscription?.planCode === p.code ? 'default' : 'outline'}
                      className={selected.subscription?.planCode === p.code ? 'ring-2 ring-primary/40' : ''}
                      onClick={() => act(selected, 'change_plan', undefined, p.id)}
                    >
                      {p.code}{selected.subscription?.planCode === p.code ? ' ✓' : ''}
                    </Button>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground">{t('adm.planHint')}</p>
              </div>
              {/* Task 57 — recent subscription changes: total transparency about
                  WHO changed WHAT and WHEN, so a changed date is a visible fact,
                  never a mystery */}
              <div className="space-y-1.5 border-t pt-3">
                <Label className="text-xs">{t('adm.histTitle')}</Label>
                {subHistory === null ? (
                  <p className="text-[11px] text-muted-foreground">…</p>
                ) : subHistory.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">{t('adm.histEmpty')}</p>
                ) : (
                  <ul className="space-y-1 max-h-40 overflow-y-auto" data-testid="sub-history">
                    {subHistory.map((e, i) => (
                      <li key={i} className="text-[11px] flex gap-2 items-baseline">
                        <span className="text-muted-foreground shrink-0 tabular-nums">{fmtDateTime(e.at)}</span>
                        <span>{histLabel(e)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="space-y-1.5 border-t pt-3">
                <Label>{t('adm.allAccounts')}</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Button size="sm" variant="outline" className="text-red-600 border-red-300" onClick={() => bulkStaff(selected.id, selected.name, false)}>{t('adm.deactivateAllStaff')}</Button>
                  <Button size="sm" variant="outline" className="text-emerald-600 border-emerald-300" onClick={() => bulkStaff(selected.id, selected.name, true)}>{t('adm.activateAllStaff')}</Button>
                </div>
                <p className="text-[10px] text-muted-foreground">{t('adm.ownerKeepsAccess')}</p>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* set user password dialog */}
      <Dialog open={!!pwUser} onOpenChange={v => !v && setPwUser(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t('adm.setPasswordTitle', { name: pwUser?.name || '' })}</DialogTitle></DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="text-xs text-muted-foreground">
              {pwUser?.email}{pwUser?.business ? ` · ${pwUser.business.name}` : ` · ${t('adm.platformUser')}`} · {t('adm.roleLabel', { role: pwUser?.role.replace('_', ' ') || '' })}
            </div>
            <div className="space-y-1.5">
              <Label>{t('adm.newPassword')}</Label>
              <PasswordInput value={pwForm.a} onChange={e => setPwForm({ ...pwForm, a: e.target.value })} autoComplete="new-password" placeholder={t('adm.pwAtLeast6')} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('adm.confirmNewPassword')}</Label>
              <PasswordInput value={pwForm.b} onChange={e => setPwForm({ ...pwForm, b: e.target.value })} autoComplete="new-password" placeholder={t('adm.pwAgain')} />
            </div>
            <p className="text-[10px] text-muted-foreground">
              {t('adm.pwShareNote')}
            </p>
            <Button className="w-full" onClick={setUserPassword} disabled={pwBusy || pwForm.a.length < 6 || pwForm.a !== pwForm.b}>
              {pwBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} {t('adm.saveNewPassword')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* delete user confirmation dialog — irreversible, typed confirmation */}
      <Dialog open={!!delUser} onOpenChange={v => !v && setDelUser(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t('adm.deleteTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="text-xs text-muted-foreground">
              {delUser?.email}{delUser?.business ? ` · ${delUser.business.name}` : ''} · {t('adm.roleLabel', { role: delUser?.role.replace('_', ' ') || '' })}
            </div>
            <p className="text-xs leading-relaxed text-red-600 border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 rounded-md p-2.5">
              {t('adm.deleteWarn', { name: delUser?.name || '', email: delUser?.email || '' })}
            </p>
            <p className="text-[10px] text-muted-foreground">{t('adm.deleteKeepAudit')}</p>
            <div className="space-y-1.5">
              <Label>{t('adm.deleteTypePrompt')}</Label>
              <Input value={delConfirm} onChange={e => setDelConfirm(e.target.value)} placeholder="DELETE" autoComplete="off" />
            </div>
            <Button variant="destructive" className="w-full" onClick={deleteUser} disabled={delBusy || delConfirm !== 'DELETE'}>
              {delBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} {t('adm.deleteBtn')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* edit plan dialog */}
      <Dialog open={!!planEdit} onOpenChange={v => !v && setPlanEdit(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t('adm.editPlanTitle', { code: planEdit?.code || '' })}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5"><Label>{t('adm.planName')}</Label><Input value={planForm.name} onChange={e => setPlanForm({ ...planForm, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>{t('adm.planPrice')}</Label><Input type="number" value={planForm.price} onChange={e => setPlanForm({ ...planForm, price: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>{t('adm.planDuration')}</Label><Input type="number" value={planForm.durationDays} onChange={e => setPlanForm({ ...planForm, durationDays: e.target.value })} /></div>
            </div>
            <div className="space-y-1.5"><Label>{t('adm.planFeatures')}</Label><textarea className="w-full min-h-24 rounded-md border bg-background px-3 py-2 text-sm" value={planForm.features} onChange={e => setPlanForm({ ...planForm, features: e.target.value })} /></div>
            <Button className="w-full" onClick={savePlan}>{t('adm.savePlan')}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
