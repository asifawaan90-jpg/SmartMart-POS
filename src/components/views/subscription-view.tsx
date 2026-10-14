'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuthStore, type SubInfo } from '@/stores/auth'
import { useT } from '@/stores/lang'
import { api, errMsg } from '@/lib/client'
import { fmtMoney, fmtDate } from '@/lib/format'
import { PageHeader, LoadingBlock, ErrorBanner } from '@/components/shared/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Crown, Loader2, Check, Bell } from 'lucide-react'

interface Plan { id: string; code: string; name: string; price: number; durationDays: number; features: string; limits: string }
interface Pay { id: string; amount: number; method: string; reference: string; status: string; createdAt: string; plan?: { name: string } }
interface Notif { id: string; type: string; title: string; body: string; createdAt: string }
interface SubData { subscription: SubInfo; plans: Plan[]; payments: Pay[]; notifications: Notif[] }

const STATUS_COLORS: Record<string, string> = {
  TRIAL: 'text-sky-600 border-sky-300',
  ACTIVE: 'text-emerald-600 border-emerald-300',
  LIFETIME: 'text-amber-600 border-amber-300',
  EXPIRED: 'text-red-600 border-red-300',
  SUSPENDED: 'text-red-600 border-red-300',
  DEACTIVATED: 'text-red-600 border-red-300',
  PENDING: 'text-amber-600 border-amber-300',
  APPROVED: 'text-emerald-600 border-emerald-300',
  REJECTED: 'text-red-600 border-red-300',
}

export default function SubscriptionView() {
  const t = useT()
  const { business } = useAuthStore()
  const cur = business?.currency || 'PKR'
  const [data, setData] = useState<SubData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [buyPlan, setBuyPlan] = useState<Plan | null>(null)
  const [method, setMethod] = useState('BANK_TRANSFER')
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setData(await api<SubData>('/api/subscription')) } catch (e) { setError(errMsg(e)) } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const submit = async () => {
    if (!buyPlan) return
    setBusy(true)
    try {
      await api('/api/subscription', { method: 'POST', body: { planId: buyPlan.id, method, reference } })
      setBuyPlan(null); setReference('')
      load()
    } catch (e) { alert(errMsg(e)) } finally { setBusy(false) }
  }

  if (loading) return <div className="p-6"><LoadingBlock /></div>
  if (error || !data) return <div className="p-6"><ErrorBanner message={error || t('subv.failedToLoad')} onRetry={load} /></div>

  const sub = data.subscription

  return (
    <div className="p-4 md:p-6">
      <PageHeader title={t('nav.subscription')} subtitle={t('subv.subtitle')} />

      {/* current status */}
      <div className="rounded-xl border bg-card p-5 mb-5">
        <div className="flex flex-wrap items-center gap-3">
          <Crown className="h-8 w-8 text-amber-500" />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-lg">{sub.planName}</h2>
              <Badge variant="outline" className={STATUS_COLORS[sub.status]}>{sub.status}</Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {sub.isLifetime ? t('subv.lifetime') :
                sub.status === 'TRIAL' ? `${t('subv.trialDays', { n: sub.daysRemaining ?? 0, s: sub.daysRemaining === 1 ? '' : 's' })}${sub.endDate ? ` ${t('sub.until', { date: fmtDate(sub.endDate) })}` : ''}` :
                  sub.endDate ? t('subv.validUntil', { date: fmtDate(sub.endDate), n: sub.daysRemaining ?? 0 }) : t('subv.active')}
            </p>
          </div>
          {sub.status === 'TRIAL' || sub.status === 'EXPIRED' ? (
            <div className="text-right">
              <div className="text-3xl font-black">{sub.daysRemaining ?? 0}</div>
              <div className="text-[11px] text-muted-foreground">{t('subv.daysLeft')}</div>
            </div>
          ) : null}
        </div>
        {sub.status === 'EXPIRED' ? (
          <p className="mt-3 text-sm text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg p-3">
            {t('subv.expiredNote')}
          </p>
        ) : null}
      </div>

      {/* plans */}
      <div className="grid md:grid-cols-2 gap-4 mb-6 max-w-3xl">
        {data.plans.map(p => (
          <div key={p.id} className="rounded-xl border bg-card p-5 flex flex-col">
            <h3 className="font-bold">{p.name}</h3>
            <div className="text-3xl font-black mt-1">{fmtMoney(p.price, cur)}<span className="text-sm font-normal text-muted-foreground">{p.durationDays === -1 ? t('subv.once') : t('subv.perMonth')}</span></div>
            <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground flex-1">
              {(JSON.parse(p.features || '[]') as string[]).map(f => (
                <li key={f} className="flex items-start gap-2"><Check className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />{f}</li>
              ))}
            </ul>
            <Button className="mt-4" onClick={() => setBuyPlan(p)}>
              {sub.status === 'EXPIRED' ? t('subv.renew') : p.code === 'LIFETIME' ? t('subv.goLifetime') : t('subv.subscribe')}
            </Button>
          </div>
        ))}
      </div>

      {/* notifications + payment history */}
      <div className="grid md:grid-cols-2 gap-4 max-w-4xl">
        <div className="rounded-lg border bg-card p-4">
          <h3 className="font-semibold text-sm mb-2 flex items-center gap-1.5"><Bell className="h-4 w-4" /> {t('subv.notifications')}</h3>
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {data.notifications.length === 0 ? <p className="text-xs text-muted-foreground">{t('subv.noNotifications')}</p> : data.notifications.map(n => (
              <div key={n.id} className="text-xs border-b last:border-0 pb-2">
                <div className="font-medium">{n.title}</div>
                <div className="text-muted-foreground">{n.body}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">{fmtDate(n.createdAt)}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <h3 className="font-semibold text-sm mb-2">{t('subv.paymentHistory')}</h3>
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {data.payments.length === 0 ? <p className="text-xs text-muted-foreground">{t('subv.noPayments')}</p> : data.payments.map(p => (
              <div key={p.id} className="text-xs border-b last:border-0 pb-2 flex items-center justify-between">
                <div>
                  <div className="font-medium">{fmtMoney(p.amount, cur)} · {p.method.replace('_', ' ')}</div>
                  <div className="text-[10px] text-muted-foreground">{fmtDate(p.createdAt)}{p.reference ? ` · ${t('subv.ref', { ref: p.reference })}` : ''}</div>
                </div>
                <Badge variant="outline" className={STATUS_COLORS[p.status]}>{p.status}</Badge>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* payment submit dialog */}
      <Dialog open={!!buyPlan} onOpenChange={v => !v && setBuyPlan(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>{t('subv.subscribeTitle', { name: buyPlan?.name || '' })}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('subv.transferLabel')} <b className="text-foreground">{fmtMoney(buyPlan?.price || 0, cur)}</b>{' '}{t('subv.transferNote')}</p>
            <div className="space-y-1.5">
              <Label>{t('subv.paymentMethod')}</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="BANK_TRANSFER">{t('subv.bankTransfer')}</SelectItem>
                  <SelectItem value="JAZZCASH">JazzCash</SelectItem>
                  <SelectItem value="EASYPAISA">Easypaisa</SelectItem>
                  <SelectItem value="GATEWAY">{t('subv.cardGateway')}</SelectItem>
                  <SelectItem value="MANUAL">{t('subv.cashManual')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('subv.referenceLabel')}</Label>
              <Input value={reference} onChange={e => setReference(e.target.value)} placeholder={t('subv.referencePlaceholder')} />
            </div>
            <Button className="w-full" onClick={submit} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {t('subv.submitForApproval')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
