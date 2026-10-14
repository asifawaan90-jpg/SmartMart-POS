'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuthStore } from '@/stores/auth'
import { useT } from '@/stores/lang'
import { api, errMsg } from '@/lib/client'
import { fmtDateTime, fmtMoney, fmtNum, r2 } from '@/lib/format'
import { printHTML, payslipHTML, PayslipItem } from '@/lib/export'
import { beepOk, beepErr } from '@/lib/scanner'
import { PageHeader, LoadingBlock, ErrorBanner, MobileCard, MobileCardList, MetaItem } from '@/components/shared/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Plus, Pencil, Trash2, KeyRound, Loader2, Fingerprint, Camera, LogIn, LogOut,
  CalendarDays, Banknote, Printer, ShieldCheck, RefreshCw, UserRound,
} from 'lucide-react'

const ROLES = ['MANAGER', 'CASHIER', 'INVENTORY_STAFF', 'ACCOUNTANT']
const PERMS = ['pos', 'products', 'inventory', 'sales', 'sales_return', 'purchases', 'customers', 'khata', 'khata_manage', 'suppliers', 'expenses', 'reports', 'users']

interface StaffUser {
  id: string; name: string; email: string; phone: string; role: string; perms: string
  isActive: boolean; lastLoginAt: string | null
  photo: string; cnic: string; salary: number; joinDate: string | null; bioCredentialId: string
}
interface AttRec {
  id: string; userId: string; date: string; checkInAt: string | null; checkOutAt: string | null
  checkInMethod: string; checkOutMethod: string; status: string; note: string
}
interface AttData { month: string; records: AttRec[]; summary: Record<string, { present: number; late: number; half: number; absent: number; minutes: number }> }
interface PayrollItemT {
  id: string; userId: string; name: string; role: string
  baseSalary: number; perDay: number; presentDays: number; absentDays: number; halfDays: number; lateCount: number
  bonus: number; deduction: number; advance: number; netPay: number; method: string; note: string; paidAt: string | null
}
interface PayrollRunT { id: string; month: string; status: string; totalNet: number; paidAt: string | null; items: PayrollItemT[] }
interface PayrollData {
  month: string; workDays: number
  run: PayrollRunT | null
  staff: { id: string; name: string; role: string; photo: string; cnic: string; salary: number; joinDate: string | null }[]
  stats: Record<string, { present: number; absent: number; half: number; late: number }>
}

const todayUTC = () => new Date().toISOString().slice(0, 10)
const thisMonth = () => new Date().toISOString().slice(0, 7)

function buf2hex(buf: Uint8Array): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('')
}

function formatCnicInput(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 13)
  if (d.length <= 5) return d
  if (d.length <= 12) return `${d.slice(0, 5)}-${d.slice(5)}`
  return `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`
}

async function resizeImage(file: File, max = 320): Promise<string> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result))
    fr.onerror = () => rej(new Error('read failed'))
    fr.readAsDataURL(file)
  })
  return new Promise<string>(res => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
      res(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => res(dataUrl)
    img.src = dataUrl
  })
}

async function bioPlatformAvailable(): Promise<boolean> {
  try {
    if (typeof window === 'undefined' || !('PublicKeyCredential' in window)) return false
    const fn = (window.PublicKeyCredential as unknown as { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> }).isUserVerifyingPlatformAuthenticatorAvailable
    return typeof fn === 'function' ? await fn.call(window.PublicKeyCredential) : false
  } catch { return false }
}

/** Create a device credential and return its hex id (WebAuthn platform authenticator). */
async function bioCreateCredential(userId: string, name: string): Promise<string> {
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const uid = new TextEncoder().encode(userId)
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'SmartMart POS' },
      user: { id: uid.buffer as ArrayBuffer, name, displayName: name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000,
    },
  }) as PublicKeyCredential | null
  if (!cred) throw new Error('no-credential')
  return buf2hex(new Uint8Array(cred.rawId))
}

/** Ask the device authenticator to verify (fingerprint/FaceID) — returns asserted hex id. */
async function bioAssert(storedHexId: string): Promise<string> {
  const bytes = new Uint8Array(storedHexId.match(/.{2}/g)!.map(h => parseInt(h, 16)))
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ id: bytes.buffer as ArrayBuffer, type: 'public-key' }],
      userVerification: 'required',
      timeout: 30000,
    },
  }) as PublicKeyCredential | null
  if (!cred) throw new Error('no-credential')
  return buf2hex(new Uint8Array(cred.rawId))
}

/** Press-and-hold fingerprint pad (device-simulated biometric scan). */
function FingerprintPad({ onComplete, busy }: { onComplete: () => void; busy: boolean }) {
  const t = useT()
  const [progress, setProgress] = useState(0)
  const holding = useRef(false)
  const raf = useRef(0)
  const HOLD_MS = 900

  const stop = useCallback(() => {
    holding.current = false
    cancelAnimationFrame(raf.current)
    setProgress(0)
  }, [])

  const start = useCallback(() => {
    if (busy || holding.current) return
    holding.current = true
    const t0 = Date.now()
    const tick = () => {
      if (!holding.current) return
      const p = Math.min(1, (Date.now() - t0) / HOLD_MS)
      setProgress(p)
      if (p >= 1) { holding.current = false; onComplete(); return }
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }, [busy, onComplete])

  useEffect(() => () => stop(), [stop])

  const C = 2 * Math.PI * 34
  return (
    <div className="flex flex-col items-center gap-2 select-none">
      <button
        type="button"
        aria-label={t('staff.holdAria')}
        disabled={busy}
        onPointerDown={start}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        className="relative h-24 w-24 rounded-full border-2 border-dashed border-[var(--primary)]/50 flex items-center justify-center hover:bg-secondary/40 active:scale-95 transition-all disabled:opacity-50"
      >
        <svg className="absolute inset-0 -rotate-90" viewBox="0 0 80 80">
          <circle cx="40" cy="40" r="34" fill="none" stroke="var(--primary)" strokeWidth="3"
            strokeDasharray={C} strokeDashoffset={C * (1 - progress)} strokeLinecap="round" />
        </svg>
        <Fingerprint className={`h-10 w-10 ${progress > 0 ? 'text-[var(--primary)]' : 'text-muted-foreground'}`} />
      </button>
      <p className="text-xs text-muted-foreground">{progress > 0 ? t('staff.scanning') : t('staff.holdPad')}</p>
    </div>
  )
}

function Avatar({ user, size = 36 }: { user: { name: string; photo?: string }; size?: number }) {
  const initials = user.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()
  if (user.photo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={user.photo} alt={user.name} style={{ width: size, height: size }}
      className="rounded-full object-cover border" />
  }
  return (
    <div style={{ width: size, height: size }}
      className="rounded-full bg-secondary border flex items-center justify-center text-xs font-bold text-secondary-foreground">
      {initials || <UserRound className="h-4 w-4" />}
    </div>
  )
}

const EMPTY = { name: '', email: '', phone: '', password: '', role: 'CASHIER', perms: [] as string[], photo: '', cnic: '', salary: '', joinDate: '' }

const STATUS_BADGE: Record<string, string> = {
  PRESENT: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  LATE: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  HALF_DAY: 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300',
  ABSENT: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
}

interface EditRow { deduction: string; bonus: string; advance: string; method: string; note: string }

export default function UsersView() {
  const t = useT()
  const me = useAuthStore(s => s.user)
  const { business } = useAuthStore()
  const cur = business?.currency || 'PKR'
  const biz = {
    name: business?.name || '', address: business?.address || '',
    phone: business?.phone || '', logo: business?.logo || '', currency: cur,
  }

  const [tab, setTab] = useState('staff')
  const [users, setUsers] = useState<StaffUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<StaffUser | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)

  // attendance
  const [attMonth, setAttMonth] = useState(thisMonth())
  const [att, setAtt] = useState<AttData | null>(null)
  const [attLoading, setAttLoading] = useState(false)
  const [punchFor, setPunchFor] = useState<StaffUser | null>(null)
  const [punchBusy, setPunchBusy] = useState(false)
  const [padReady, setPadReady] = useState(false)
  const [punchMsg, setPunchMsg] = useState('')

  // payroll
  const [payMonth, setPayMonth] = useState(thisMonth())
  const [pay, setPay] = useState<PayrollData | null>(null)
  const [payLoading, setPayLoading] = useState(false)
  const [edits, setEdits] = useState<Record<string, EditRow>>({})
  const [editsMonth, setEditsMonth] = useState('')
  const [payBusy, setPayBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setUsers(await api<StaffUser[]>('/api/users')) }
    catch (e) { setError(errMsg(e)) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const loadAtt = useCallback(async () => {
    setAttLoading(true)
    try { setAtt(await api<AttData>(`/api/attendance?month=${attMonth}`)) }
    catch (e) { setError(errMsg(e)) } finally { setAttLoading(false) }
  }, [attMonth])
  useEffect(() => { if (tab === 'attendance') loadAtt() }, [tab, loadAtt])

  const loadPay = useCallback(async () => {
    setPayLoading(true)
    try { setPay(await api<PayrollData>(`/api/payroll?month=${payMonth}`)) }
    catch (e) { setError(errMsg(e)) } finally { setPayLoading(false) }
  }, [payMonth])
  useEffect(() => { if (tab === 'payroll') loadPay() }, [tab, loadPay])

  // init payroll edit rows when data arrives
  useEffect(() => {
    if (!pay || editsMonth === pay.month) return
    setEditsMonth(pay.month)
    const e: Record<string, EditRow> = {}
    if (pay.run) {
      for (const it of pay.run.items) e[it.userId] = { deduction: String(it.deduction), bonus: String(it.bonus), advance: String(it.advance), method: it.method, note: it.note }
    } else {
      for (const s of pay.staff) {
        const st = pay.stats[s.id] || { present: 0, absent: 0, half: 0, late: 0 }
        const perDay = s.salary / (pay.workDays || 26)
        const auto = r2(st.absent * perDay + st.half * perDay * 0.5)
        e[s.id] = { deduction: String(auto), bonus: '', advance: '', method: 'CASH', note: '' }
      }
    }
    setEdits(e)
  }, [pay, editsMonth])

  // ── staff form ──
  const save = async () => {
    setSaving(true)
    try {
      const extra = { cnic: form.cnic, salary: parseFloat(form.salary) || 0, photo: form.photo, joinDate: form.joinDate || null }
      if (editing) {
        await api(`/api/users?id=${editing.id}`, {
          method: 'PUT',
          body: { name: form.name, phone: form.phone, role: form.role, perms: form.perms, ...extra, ...(form.password ? { password: form.password } : {}) },
        })
      } else {
        await api('/api/users', { method: 'POST', body: { ...form, ...extra } })
      }
      setFormOpen(false); setEditing(null)
      load()
    } catch (e) { alert(errMsg(e)) } finally { setSaving(false) }
  }

  const toggleActive = async (u: StaffUser, v: boolean) => {
    try { await api(`/api/users?id=${u.id}`, { method: 'PUT', body: { isActive: v } }); load() }
    catch (e) { alert(errMsg(e)) }
  }

  const remove = async (u: StaffUser) => {
    if (!confirm(t('staff.deleteConfirm', { name: u.name }))) return
    try { await api(`/api/users?id=${u.id}`, { method: 'DELETE' }); load() } catch (e) { alert(errMsg(e)) }
  }

  // ── attendance punch ──
  const doPunch = async (u: StaffUser, method: 'BIOMETRIC' | 'MANUAL', credentialId?: string) => {
    setPunchBusy(true); setPunchMsg('')
    try {
      const res = await api<{ punch: string }>('/api/attendance', {
        method: 'POST',
        body: { action: 'punch', userId: u.id, method, credentialId, date: todayUTC() },
      })
      beepOk()
      setPunchMsg(res.punch === 'IN' ? t('staff.checkedIn', { name: u.name }) : t('staff.checkedOut', { name: u.name }))
      setTimeout(() => { setPunchFor(null); setPunchMsg('') }, 700)
      loadAtt()
    } catch (e) {
      beepErr(); setPunchMsg(''); alert(errMsg(e))
    } finally { setPunchBusy(false) }
  }

  // when punch dialog opens: try real WebAuthn first, else reveal the hold-pad
  useEffect(() => {
    if (!punchFor) { setPadReady(false); setPunchMsg(''); return }
    let cancelled = false
    ;(async () => {
      if (punchFor.bioCredentialId && await bioPlatformAvailable()) {
        try {
          const asserted = await bioAssert(punchFor.bioCredentialId)
          if (!cancelled) doPunch(punchFor, 'BIOMETRIC', asserted)
          return
        } catch { /* device refused / unsupported → fall back to pad */ }
      }
      if (!cancelled) setPadReady(true)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [punchFor])

  const enrollFor = async (u: StaffUser) => {
    try {
      if (!(await bioPlatformAvailable())) {
        alert(t('staff.noSensor'))
        return
      }
      const hex = await bioCreateCredential(u.id, u.name)
      await api('/api/attendance', { method: 'POST', body: { action: 'enroll', credentialId: hex } })
      // enroll stores on the signed-in account by design; for other staff re-login on their device
      if (u.id !== me?.id) await api(`/api/users?id=${u.id}`, { method: 'PUT', body: { bioCredentialId: hex } })
      beepOk(); alert(t('staff.enrolledFor', { name: u.name }))
      load()
    } catch (e) { beepErr(); alert(errMsg(e)) }
  }

  const markDay = async (u: StaffUser, status: string) => {
    try {
      await api('/api/attendance', { method: 'POST', body: { action: 'mark', userId: u.id, date: todayUTC(), status, note: t('staff.markedByManager') } })
      beepOk(); loadAtt()
    } catch (e) { beepErr(); alert(errMsg(e)) }
  }

  // ── payroll ──
  const payRun = pay?.run || null
  const paid = payRun?.status === 'PAID'

  const netFor = (s: PayrollData['staff'][number], e?: EditRow): number => {
    if (!e) return 0
    return Math.max(0, r2(s.salary - (parseFloat(e.deduction) || 0) + (parseFloat(e.bonus) || 0) - (parseFloat(e.advance) || 0)))
  }

  const generate = async () => {
    if (!pay) return
    setPayBusy(true)
    try {
      const items = pay.staff.map(s => ({
        userId: s.id,
        deduction: parseFloat(edits[s.id]?.deduction || '0') || 0,
        bonus: parseFloat(edits[s.id]?.bonus || '0') || 0,
        advance: parseFloat(edits[s.id]?.advance || '0') || 0,
        method: edits[s.id]?.method || 'CASH',
        note: edits[s.id]?.note || '',
      }))
      await api('/api/payroll', { method: 'POST', body: { action: 'generate', month: payMonth, items } })
      beepOk(); loadPay()
    } catch (e) { beepErr(); alert(errMsg(e)) } finally { setPayBusy(false) }
  }

  const payAll = async () => {
    if (!payRun) return
    if (!confirm(t('staff.payConfirm', { month: payMonth, amount: fmtMoney(payRun.totalNet, cur) }))) return
    setPayBusy(true)
    try {
      await api('/api/payroll', { method: 'POST', body: { action: 'pay', runId: payRun.id } })
      beepOk(); loadPay()
    } catch (e) { beepErr(); alert(errMsg(e)) } finally { setPayBusy(false) }
  }

  const printPayslips = (items: PayrollItemT[]) => {
    if (!items.length) return
    const cnicOf = new Map((pay?.staff || []).map(s => [s.id, s.cnic]))
    const rows: PayslipItem[] = items.map(it => ({ ...it, cnic: cnicOf.get(it.userId) || '', month: payMonth }))
    printHTML(t('staff.payslipsTitle', { month: payMonth }), payslipHTML(biz, rows))
  }

  const timeStr = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'
  const durStr = (a: string | null, b: string | null) => {
    if (!a || !b) return '—'
    const m = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000))
    return `${Math.floor(m / 60)}h ${m % 60}m`
  }

  const today = todayUTC()
  const activeUsers = users.filter(u => u.isActive)
  const todayRecs = useMemo(() => new Map((att?.records || []).filter(r => r.date === today).map(r => [r.userId, r])), [att, today])
  const hoursOf = (uid: string) => {
    const s = att?.summary?.[uid]
    return s ? `${Math.floor(s.minutes / 60)}h ${s.minutes % 60}m` : '0h'
  }

  if (loading) return <div className="p-6"><LoadingBlock /></div>

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title={t('staff.title')}
        subtitle={t('staff.subtitle')}
        actions={<Button size="sm" onClick={() => { setEditing(null); setForm(EMPTY); setFormOpen(true) }}><Plus className="h-4 w-4" /> {t('staff.addStaff')}</Button>}
      />
      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      <Tabs value={tab} onValueChange={setTab} className="mt-1">
        <TabsList className="mb-3">
          <TabsTrigger value="staff">{t('staff.tabStaff')}</TabsTrigger>
          <TabsTrigger value="attendance" className="gap-1.5"><Fingerprint className="h-3.5 w-3.5" /> {t('staff.tabAttendance')}</TabsTrigger>
          <TabsTrigger value="payroll" className="gap-1.5"><Banknote className="h-3.5 w-3.5" /> {t('staff.tabPayroll')}</TabsTrigger>
        </TabsList>

        {/* ───────── STAFF ───────── */}
        <TabsContent value="staff" className="space-y-3">
          <MobileCardList>
            {users.map(u => (
              <MobileCard
                key={u.id}
                leading={<Avatar user={u} />}
                title={<span className="flex items-center gap-1.5 flex-wrap">{u.name} {u.id === me?.id ? <span className="text-[10px] text-muted-foreground">{t('staff.you')}</span> : null}{u.bioCredentialId ? <Fingerprint className="h-3.5 w-3.5 text-emerald-600" aria-label={t('staff.bioEnrolledAria')} /> : null}</span>}
                subtitle={u.email}
                badge={<Badge variant="outline" className="font-semibold">{u.role.replace('_', ' ')}</Badge>}
                meta={(
                  <>
                    <MetaItem label={t('staff.salary')}>{u.salary > 0 ? fmtMoney(u.salary, cur) : '—'}</MetaItem>
                    <MetaItem label={t('staff.active')}>
                      <Switch checked={u.isActive} onCheckedChange={v => toggleActive(u, v)} disabled={u.role === 'OWNER' || u.id === me?.id} />
                    </MetaItem>
                    <MetaItem label={t('staff.cnic')}>{u.cnic || '—'}</MetaItem>
                    <MetaItem label={t('staff.joined')}>{u.joinDate ? new Date(u.joinDate).toLocaleDateString('en-GB') : '—'}</MetaItem>
                    <MetaItem label={t('staff.lastLogin')} className="col-span-2">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : t('staff.never')}</MetaItem>
                  </>
                )}
                actions={(
                  <>
                    <Button variant="outline" size="sm" className="h-7 text-xs" title={t('common.edit')} onClick={() => {
                      setEditing(u)
                      setForm({
                        name: u.name, email: u.email, phone: u.phone, password: '', role: u.role,
                        perms: JSON.parse(u.perms || '[]'), photo: u.photo || '',
                        cnic: u.cnic || '', salary: u.salary > 0 ? String(u.salary) : '',
                        joinDate: u.joinDate ? u.joinDate.slice(0, 10) : '',
                      })
                      setFormOpen(true)
                    }}><Pencil className="h-3.5 w-3.5" /> {t('common.edit')}</Button>
                    {u.role !== 'OWNER' && u.id !== me?.id ? (
                      <Button variant="outline" size="sm" className="h-7 text-xs text-red-600 border-red-300" onClick={() => remove(u)}><Trash2 className="h-3.5 w-3.5" /> {t('staff.remove')}</Button>
                    ) : null}
                  </>
                )}
              />
            ))}
          </MobileCardList>
          <div className="hidden md:block rounded-lg border overflow-x-auto bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-secondary/50 text-left text-xs text-muted-foreground">
                  <th className="p-2.5 font-medium">{t('staff.staff')}</th>
                  <th className="p-2.5 font-medium">{t('staff.role')}</th>
                  <th className="p-2.5 font-medium hidden md:table-cell">{t('staff.cnic')}</th>
                  <th className="p-2.5 font-medium text-right">{t('staff.salary')}</th>
                  <th className="p-2.5 font-medium hidden lg:table-cell">{t('staff.joined')}</th>
                  <th className="p-2.5 font-medium hidden lg:table-cell">{t('staff.lastLogin')}</th>
                  <th className="p-2.5 font-medium">{t('staff.active')}</th>
                  <th className="p-2.5 font-medium text-right">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className="border-b last:border-0 hover:bg-secondary/30">
                    <td className="p-2.5">
                      <div className="flex items-center gap-2.5">
                        <Avatar user={u} />
                        <div>
                          <div className="font-medium flex items-center gap-1.5">{u.name} {u.id === me?.id ? <span className="text-[10px] text-muted-foreground">{t('staff.you')}</span> : null}
                            {u.bioCredentialId ? <Fingerprint className="h-3.5 w-3.5 text-emerald-600" aria-label={t('staff.bioEnrolledAria')} /> : null}
                          </div>
                          <div className="text-[11px] text-muted-foreground">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="p-2.5"><Badge variant="outline" className="font-semibold">{u.role.replace('_', ' ')}</Badge></td>
                    <td className="p-2.5 hidden md:table-cell font-mono text-xs">{u.cnic || '—'}</td>
                    <td className="p-2.5 text-right font-bold">{u.salary > 0 ? fmtMoney(u.salary, cur) : '—'}</td>
                    <td className="p-2.5 hidden lg:table-cell text-xs">{u.joinDate ? new Date(u.joinDate).toLocaleDateString('en-GB') : '—'}</td>
                    <td className="p-2.5 hidden lg:table-cell text-xs">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'Never'}</td>
                    <td className="p-2.5">
                      <Switch checked={u.isActive} onCheckedChange={v => toggleActive(u, v)} disabled={u.role === 'OWNER' || u.id === me?.id} />
                    </td>
                    <td className="p-2.5">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7" title={t('common.edit')}
                          onClick={() => {
                            setEditing(u)
                            setForm({
                              name: u.name, email: u.email, phone: u.phone, password: '', role: u.role,
                              perms: JSON.parse(u.perms || '[]'), photo: u.photo || '',
                              cnic: u.cnic || '', salary: u.salary > 0 ? String(u.salary) : '',
                              joinDate: u.joinDate ? u.joinDate.slice(0, 10) : '',
                            })
                            setFormOpen(true)
                          }}><Pencil className="h-3.5 w-3.5" /></Button>
                        {u.role !== 'OWNER' && u.id !== me?.id ? (
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(u)}><Trash2 className="h-3.5 w-3.5" /></Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <Fingerprint className="h-3.5 w-3.5 text-emerald-600" /> {t('staff.fingerprintNote')}
          </p>
        </TabsContent>

        {/* ───────── ATTENDANCE ───────── */}
        <TabsContent value="attendance" className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">{t('staff.month')}</Label>
              <Input type="month" value={attMonth} onChange={e => setAttMonth(e.target.value)} className="h-9 w-44" />
            </div>
            <Button variant="outline" size="sm" onClick={loadAtt} disabled={attLoading}>
              {attLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} {t('common.refresh')}
            </Button>
            <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> {t('staff.biometricNote')}
            </span>
          </div>

          {/* today punch board */}
          <div>
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5"><CalendarDays className="h-4 w-4" /> {t('staff.today', { date: new Date().toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short' }) })}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
              {activeUsers.map(u => {
                const rec = todayRecs.get(u.id)
                const status = !rec ? { label: t('staff.notCheckedIn'), cls: 'bg-secondary text-secondary-foreground' }
                  : rec.checkOutAt ? { label: t('staff.outAt', { time: timeStr(rec.checkOutAt), dur: durStr(rec.checkInAt, rec.checkOutAt) }), cls: STATUS_BADGE.HALF_DAY }
                  : { label: t('staff.workingSince', { time: timeStr(rec.checkInAt) }), cls: STATUS_BADGE.PRESENT }
                return (
                  <div key={u.id} className="rounded-lg border bg-card p-3 flex items-center gap-3">
                    <Avatar user={u} size={40} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm truncate">{u.name}</div>
                      <div className="text-[11px] text-muted-foreground">{u.role.replace('_', ' ')}</div>
                      <Badge className={`mt-1 text-[10px] ${status.cls}`} variant="secondary">{status.label}</Badge>
                    </div>
                    <div className="flex flex-col gap-1">
                      <Button size="sm" className="h-7 text-xs" disabled={punchBusy} onClick={() => { setPunchFor(u); setPadReady(false); setPunchMsg('') }}>
                        <Fingerprint className="h-3.5 w-3.5" /> {t('staff.punch')}
                      </Button>
                      <Select value="" onValueChange={v => v && markDay(u, v)}>
                        <SelectTrigger className="h-7 text-[11px] w-full" aria-label={t('staff.markAria', { name: u.name })}><SelectValue placeholder={t('staff.markPlaceholder')} /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="PRESENT">{t('staff.present')}</SelectItem>
                          <SelectItem value="LATE">{t('staff.late')}</SelectItem>
                          <SelectItem value="HALF_DAY">{t('staff.halfDay')}</SelectItem>
                          <SelectItem value="ABSENT">{t('staff.absent')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* month summary */}
          <MobileCardList>
            {activeUsers.map(u => {
              const s = att?.summary?.[u.id]
              return (
                <MobileCard
                  key={u.id}
                  leading={<Avatar user={u} size={32} />}
                  title={u.name}
                  badge={<span className="text-xs font-semibold">{hoursOf(u.id)}h</span>}
                  meta={(
                    <>
                      <MetaItem label={t('staff.present')}><span className="font-bold text-emerald-600">{s?.present || 0}</span></MetaItem>
                      <MetaItem label={t('staff.late')}><span className="text-amber-600">{s?.late || 0}</span></MetaItem>
                      <MetaItem label={t('staff.half')}><span className="text-orange-600">{s?.half || 0}</span></MetaItem>
                      <MetaItem label={t('staff.absent')}><span className="text-red-600">{s?.absent || 0}</span></MetaItem>
                    </>
                  )}
                />
              )
            })}
          </MobileCardList>
          <div className="hidden md:block rounded-lg border overflow-x-auto bg-card">
            <div className="p-2.5 border-b bg-secondary/50 text-xs font-medium text-muted-foreground">{t('staff.monthlySummary', { month: attMonth })}</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-secondary/40 text-left text-xs text-muted-foreground">
                  <th className="p-2.5 font-medium">{t('staff.staff')}</th>
                  <th className="p-2.5 font-medium text-right">{t('staff.present')}</th>
                  <th className="p-2.5 font-medium text-right">{t('staff.late')}</th>
                  <th className="p-2.5 font-medium text-right">{t('staff.half')}</th>
                  <th className="p-2.5 font-medium text-right">{t('staff.absent')}</th>
                  <th className="p-2.5 font-medium text-right">{t('staff.hours')}</th>
                </tr>
              </thead>
              <tbody>
                {activeUsers.map(u => {
                  const s = att?.summary?.[u.id]
                  return (
                    <tr key={u.id} className="border-b last:border-0">
                      <td className="p-2.5"><div className="flex items-center gap-2"><Avatar user={u} size={28} /><span className="font-medium">{u.name}</span></div></td>
                      <td className="p-2.5 text-right font-bold text-emerald-600">{s?.present || 0}</td>
                      <td className="p-2.5 text-right text-amber-600">{s?.late || 0}</td>
                      <td className="p-2.5 text-right text-orange-600">{s?.half || 0}</td>
                      <td className="p-2.5 text-right text-red-600">{s?.absent || 0}</td>
                      <td className="p-2.5 text-right">{hoursOf(u.id)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* records */}
          <div className="rounded-lg border overflow-x-auto bg-card max-h-80 overflow-y-auto">
            <div className="p-2.5 border-b bg-secondary/50 text-xs font-medium text-muted-foreground sticky top-0">{t('staff.records')}</div>
            <table className="w-full text-sm">
              <tbody>
                {(att?.records || []).slice(0, 60).map(r => {
                  const u = users.find(x => x.id === r.userId)
                  return (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="p-2.5">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="font-medium">{u?.name || r.userId}</span>
                          <span className="text-xs flex items-center gap-2">
                            <Badge className={`text-[10px] ${STATUS_BADGE[r.status] || ''}`} variant="secondary">{r.status.replace('_', ' ')}</Badge>
                            <span className="text-muted-foreground">{r.date}</span>
                          </span>
                        </div>
                        <div className="text-[11px] text-muted-foreground flex gap-2 mt-0.5 flex-wrap">
                          <span>{t('staff.inTime', { time: timeStr(r.checkInAt), method: r.checkInMethod ? ` (${r.checkInMethod.toLowerCase()})` : '' })}</span>
                          <span>{t('staff.outTime', { time: timeStr(r.checkOutAt), method: r.checkOutMethod ? ` (${r.checkOutMethod.toLowerCase()})` : '' })}</span>
                          <span>· {durStr(r.checkInAt, r.checkOutAt)}</span>
                          {r.note ? <span className="italic">· {r.note}</span> : null}
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {(att?.records || []).length === 0 ? <tr><td className="p-4 text-sm text-muted-foreground text-center">{t('staff.noRecords')}</td></tr> : null}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* ───────── PAYROLL ───────── */}
        <TabsContent value="payroll" className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">{t('staff.salaryMonth')}</Label>
              <Input type="month" value={payMonth} onChange={e => setPayMonth(e.target.value)} className="h-9 w-44" />
            </div>
            <Button variant="outline" size="sm" onClick={loadPay} disabled={payLoading}>
              {payLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} {t('staff.reload')}
            </Button>
            {paid ? <Badge className="bg-emerald-600">PAID · {fmtMoney(payRun!.totalNet, cur)}</Badge> : null}
            <div className="ml-auto flex gap-2">
              {!paid ? (
                <Button size="sm" onClick={generate} disabled={payBusy || !pay?.staff.length}>
                  {payBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
                  {payRun ? t('staff.recalcSave') : t('staff.generatePayroll')}
                </Button>
              ) : null}
              {payRun && !paid ? (
                <Button size="sm" onClick={payAll} disabled={payBusy}><LogOut className="h-4 w-4" /> {t('staff.payAll')}</Button>
              ) : null}
              {payRun ? (
                <Button variant="outline" size="sm" onClick={() => printPayslips(payRun.items)}><Printer className="h-4 w-4" /> {t('staff.printPayslips')}</Button>
              ) : null}
            </div>
          </div>
          {payRun && !paid ? <p className="text-xs text-muted-foreground">{t('staff.draftNote')}</p> : null}

          {payLoading || !pay ? <LoadingBlock rows={6} /> : pay.staff.length === 0 ? (
            <p className="text-sm text-muted-foreground p-4 border rounded-lg">{t('staff.noSalaryStaff')}</p>
          ) : (
            <>
            <MobileCardList>
              {(payRun ? payRun.items : pay.staff.map(s => ({
                userId: s.id, name: s.name, role: s.role, baseSalary: s.salary,
                perDay: r2(s.salary / (pay.workDays || 26)),
                presentDays: pay.stats[s.id]?.present || 0, absentDays: pay.stats[s.id]?.absent || 0,
                halfDays: pay.stats[s.id]?.half || 0, lateCount: pay.stats[s.id]?.late || 0,
                bonus: 0, advance: 0, netPay: 0, method: 'CASH', note: '', paidAt: null,
                id: s.id, deduction: 0,
              } as PayrollItemT))).map(it => {
                const s = pay.staff.find(x => x.id === it.userId)
                const e = edits[it.userId]
                const net = paid || payRun ? it.netPay : netFor(s || { ...it, salary: it.baseSalary, cnic: '', photo: '', joinDate: null }, e)
                return (
                  <MobileCard
                    key={it.userId}
                    leading={<Avatar user={{ name: it.name, photo: s?.photo }} size={30} />}
                    title={it.name}
                    subtitle={it.role.replace('_', ' ')}
                    badge={<span className="text-sm font-bold">{fmtMoney(net, cur)}</span>}
                    meta={(
                      <>
                        <MetaItem label={t('staff.base')}>{fmtNum(it.baseSalary)}</MetaItem>
                        <MetaItem label={t('staff.perDay')}>{fmtNum(it.perDay)}</MetaItem>
                        <MetaItem label={t('staff.plha')} className="col-span-2">
                          <span className="text-emerald-600 font-bold">{it.presentDays}</span> / <span className="text-amber-600">{it.lateCount}</span> / <span className="text-orange-600">{it.halfDays}</span> / <span className="text-red-600">{it.absentDays}</span>
                        </MetaItem>
                        {paid || payRun ? (
                          <>
                            <MetaItem label={t('staff.deduction')}><span className="text-red-600">{fmtNum(it.deduction)}</span></MetaItem>
                            <MetaItem label={t('staff.bonus')}><span className="text-emerald-600">{fmtNum(it.bonus)}</span></MetaItem>
                            <MetaItem label={t('staff.advance')}><span className="text-red-600">{fmtNum(it.advance)}</span></MetaItem>
                            <MetaItem label={t('staff.method')}>{it.method}</MetaItem>
                          </>
                        ) : (
                          <>
                            <MetaItem label={t('staff.deduction')}><Input type="number" min={0} className="h-8 w-full text-right" value={e?.deduction ?? ''} onChange={ev => setEdits(p => ({ ...p, [it.userId]: { ...p[it.userId], deduction: ev.target.value } }))} /></MetaItem>
                            <MetaItem label={t('staff.bonus')}><Input type="number" min={0} className="h-8 w-full text-right" value={e?.bonus ?? ''} onChange={ev => setEdits(p => ({ ...p, [it.userId]: { ...p[it.userId], bonus: ev.target.value } }))} /></MetaItem>
                            <MetaItem label={t('staff.advance')}><Input type="number" min={0} className="h-8 w-full text-right" value={e?.advance ?? ''} onChange={ev => setEdits(p => ({ ...p, [it.userId]: { ...p[it.userId], advance: ev.target.value } }))} /></MetaItem>
                            <MetaItem label={t('staff.method')}>
                              <Select value={e?.method || 'CASH'} onValueChange={v => setEdits(p => ({ ...p, [it.userId]: { ...p[it.userId], method: v } }))}>
                                <SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="CASH">{t('staff.cash')}</SelectItem>
                                  <SelectItem value="BANK">{t('staff.bank')}</SelectItem>
                                  <SelectItem value="DIGITAL">{t('staff.digital')}</SelectItem>
                                </SelectContent>
                              </Select>
                            </MetaItem>
                          </>
                        )}
                      </>
                    )}
                    actions={payRun ? <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => printPayslips([it])}><Printer className="h-3.5 w-3.5" /> {t('staff.payslip')}</Button> : null}
                  />
                )
              })}
            </MobileCardList>
            <div className="hidden md:block rounded-lg border overflow-x-auto bg-card">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="border-b bg-secondary/50 text-left text-xs text-muted-foreground">
                    <th className="p-2.5 font-medium">{t('staff.staff')}</th>
                    <th className="p-2.5 font-medium text-right">{t('staff.base')}</th>
                    <th className="p-2.5 font-medium text-right">{t('staff.perDay')}</th>
                    <th className="p-2.5 font-medium text-right">{t('staff.plha')}</th>
                    <th className="p-2.5 font-medium text-right">{t('staff.deduction')}</th>
                    <th className="p-2.5 font-medium text-right">{t('staff.bonus')}</th>
                    <th className="p-2.5 font-medium text-right">{t('staff.advance')}</th>
                    <th className="p-2.5 font-medium">{t('staff.method')}</th>
                    <th className="p-2.5 font-medium text-right">{t('staff.netPay')}</th>
                    <th className="p-2.5 font-medium text-right">{t('staff.payslip')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(payRun ? payRun.items : pay.staff.map(s => ({
                    userId: s.id, name: s.name, role: s.role, baseSalary: s.salary,
                    perDay: r2(s.salary / (pay.workDays || 26)),
                    presentDays: pay.stats[s.id]?.present || 0, absentDays: pay.stats[s.id]?.absent || 0,
                    halfDays: pay.stats[s.id]?.half || 0, lateCount: pay.stats[s.id]?.late || 0,
                    bonus: 0, advance: 0, netPay: 0, method: 'CASH', note: '', paidAt: null,
                    id: s.id, deduction: 0,
                  } as PayrollItemT))).map(it => {
                    const s = pay.staff.find(x => x.id === it.userId)
                    const e = edits[it.userId]
                    const net = paid || payRun ? it.netPay : netFor(s || { ...it, salary: it.baseSalary, cnic: '', photo: '', joinDate: null }, e)
                    return (
                      <tr key={it.userId} className="border-b last:border-0">
                        <td className="p-2.5">
                          <div className="flex items-center gap-2">
                            <Avatar user={{ name: it.name, photo: s?.photo }} size={30} />
                            <div><div className="font-medium">{it.name}</div><div className="text-[10px] text-muted-foreground">{it.role.replace('_', ' ')}</div></div>
                          </div>
                        </td>
                        <td className="p-2.5 text-right">{fmtNum(it.baseSalary)}</td>
                        <td className="p-2.5 text-right text-muted-foreground">{fmtNum(it.perDay)}</td>
                        <td className="p-2.5 text-right whitespace-nowrap">
                          <span className="text-emerald-600 font-bold">{it.presentDays}</span> / <span className="text-amber-600">{it.lateCount}</span> / <span className="text-orange-600">{it.halfDays}</span> / <span className="text-red-600">{it.absentDays}</span>
                        </td>
                        {paid || payRun ? (
                          <>
                            <td className="p-2.5 text-right text-red-600">{fmtNum(it.deduction)}</td>
                            <td className="p-2.5 text-right text-emerald-600">{fmtNum(it.bonus)}</td>
                            <td className="p-2.5 text-right text-red-600">{fmtNum(it.advance)}</td>
                            <td className="p-2.5">{it.method}</td>
                          </>
                        ) : (
                          <>
                            <td className="p-2.5"><Input type="number" min={0} className="h-8 w-24 text-right" value={e?.deduction ?? ''} onChange={ev => setEdits(p => ({ ...p, [it.userId]: { ...p[it.userId], deduction: ev.target.value } }))} /></td>
                            <td className="p-2.5"><Input type="number" min={0} className="h-8 w-24 text-right" value={e?.bonus ?? ''} onChange={ev => setEdits(p => ({ ...p, [it.userId]: { ...p[it.userId], bonus: ev.target.value } }))} /></td>
                            <td className="p-2.5"><Input type="number" min={0} className="h-8 w-24 text-right" value={e?.advance ?? ''} onChange={ev => setEdits(p => ({ ...p, [it.userId]: { ...p[it.userId], advance: ev.target.value } }))} /></td>
                            <td className="p-2.5">
                              <Select value={e?.method || 'CASH'} onValueChange={v => setEdits(p => ({ ...p, [it.userId]: { ...p[it.userId], method: v } }))}>
                                <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="CASH">{t('staff.cash')}</SelectItem>
                                  <SelectItem value="BANK">{t('staff.bank')}</SelectItem>
                                  <SelectItem value="DIGITAL">{t('staff.digital')}</SelectItem>
                                </SelectContent>
                              </Select>
                            </td>
                          </>
                        )}
                        <td className="p-2.5 text-right font-bold">{fmtMoney(net, cur)}</td>
                        <td className="p-2.5 text-right">
                          {payRun ? <Button variant="ghost" size="icon" className="h-7 w-7" title={t('staff.printPayslip')} onClick={() => printPayslips([it])}><Printer className="h-3.5 w-3.5" /></Button> : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
          {!paid && pay?.staff.length ? (
            <p className="text-[11px] text-muted-foreground">{t('staff.deductionNote')}</p>
          ) : null}
        </TabsContent>
      </Tabs>

      {/* ── staff form dialog ── */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{editing ? t('common.editTitle', { name: editing.name }) : t('staff.addStaffUser')}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 flex items-center gap-3">
              <Avatar user={{ name: form.name || '?', photo: form.photo }} size={56} />
              <div className="space-y-1">
                <label className="text-xs flex items-center gap-1.5 cursor-pointer border rounded px-2 py-1.5 hover:bg-secondary w-fit">
                  <Camera className="h-3.5 w-3.5" /> {form.photo ? t('staff.changePhoto') : t('staff.uploadPhoto')}
                  <input type="file" accept="image/*" className="hidden" onChange={async e => {
                    const f = e.target.files?.[0]
                    if (f) {
                      const photo = await resizeImage(f)
                      setForm(f2 => ({ ...f2, photo }))
                    }
                    e.target.value = ''
                  }} />
                </label>
                {form.photo ? <button type="button" className="text-[10px] text-red-600" onClick={() => setForm(f => ({ ...f, photo: '' }))}>{t('staff.removePhoto')}</button> : null}
              </div>
            </div>
            <div className="space-y-1.5 col-span-2"><Label>{t('staff.name')}</Label><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
            {!editing ? <div className="space-y-1.5 col-span-2"><Label>{t('staff.email')}</Label><Input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></div> : null}
            <div className="space-y-1.5"><Label>{t('staff.phone')}</Label><Input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>{t('staff.cnic')}</Label><Input inputMode="numeric" placeholder="35202-1234567-1" value={form.cnic} onChange={e => setForm({ ...form, cnic: formatCnicInput(e.target.value) })} /></div>
            <div className="space-y-1.5"><Label>{t('staff.monthlySalary', { cur })}</Label><Input type="number" min={0} value={form.salary} onChange={e => setForm({ ...form, salary: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>{t('staff.joinDate')}</Label><Input type="date" value={form.joinDate} onChange={e => setForm({ ...form, joinDate: e.target.value })} /></div>
            <div className="space-y-1.5">
              <Label>{editing ? t('staff.resetPassword') : t('staff.password')}</Label>
              <Input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder={editing ? t('staff.pwKeep') : t('staff.pwMin')} />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>{t('staff.role')}</Label>
              <Select value={form.role} onValueChange={v => setForm({ ...form, role: v })} disabled={editing?.role === 'OWNER'}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLES.map(r => <SelectItem key={r} value={r}>{r.replace('_', ' ')}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">
                {form.role === 'CASHIER' ? t('staff.roleCashier') :
                 form.role === 'INVENTORY_STAFF' ? t('staff.roleInventory') :
                 form.role === 'ACCOUNTANT' ? t('staff.roleAccountant') :
                 t('staff.roleManager')}
              </p>
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label className="flex items-center gap-1"><KeyRound className="h-3.5 w-3.5" /> {t('staff.extraPerms')}</Label>
              <div className="grid grid-cols-3 gap-1.5">
                {PERMS.map(p => (
                  <label key={p} className="flex items-center gap-1.5 text-xs border rounded px-2 py-1.5 cursor-pointer hover:bg-secondary">
                    <input
                      type="checkbox"
                      className="accent-[var(--primary)]"
                      checked={form.perms.includes(p)}
                      onChange={e => setForm({ ...form, perms: e.target.checked ? [...form.perms, p] : form.perms.filter(x => x !== p) })}
                    />
                    {p.replace('_', ' ')}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <Button className="w-full" onClick={save} disabled={saving || !form.name || (!editing && (!form.email || form.password.length < 6))}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {t('common.save')}
          </Button>
        </DialogContent>
      </Dialog>

      {/* ── punch dialog ── */}
      <Dialog open={!!punchFor} onOpenChange={v => !v && setPunchFor(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Fingerprint className="h-4 w-4" /> {t('staff.bioPunch')}</DialogTitle></DialogHeader>
          {punchFor ? (
            <div className="flex flex-col items-center gap-3 py-1">
              <Avatar user={punchFor} size={56} />
              <div className="text-center">
                <div className="font-semibold">{punchFor.name}</div>
                <div className="text-[11px] text-muted-foreground">{punchFor.role.replace('_', ' ')} · {punchFor.bioCredentialId ? t('staff.bioEnrolled') : t('staff.noEnrollment')}</div>
              </div>
              {punchMsg ? (
                <div className="rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 px-4 py-2 text-sm font-medium">{punchMsg}</div>
              ) : padReady ? (
                <>
                  <FingerprintPad busy={punchBusy} onComplete={() => doPunch(punchFor, 'BIOMETRIC', punchFor.bioCredentialId || `sim:${punchFor.id}`)} />
                  <Button variant="outline" size="sm" className="w-full" disabled={punchBusy} onClick={() => doPunch(punchFor, 'MANUAL')}>
                    <LogIn className="h-4 w-4" /> {t('staff.manualPunch')}
                  </Button>
                </>
              ) : (
                <div className="flex flex-col items-center gap-2 py-4">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">{t('staff.waitingFingerprint')}</p>
                  <Button variant="outline" size="sm" onClick={() => setPadReady(true)}>{t('staff.usePad')}</Button>
                </div>
              )}
              {punchFor.id !== me?.id && !punchFor.bioCredentialId ? (
                <Button variant="ghost" size="sm" className="text-xs" disabled={punchBusy} onClick={() => enrollFor(punchFor)}>
                  <ShieldCheck className="h-3.5 w-3.5" /> {t('staff.enrollBio')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
