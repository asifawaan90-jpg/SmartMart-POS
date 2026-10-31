'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuthStore } from '@/stores/auth'
import { useOfflineStore } from '@/stores/offline'
import { useT } from '@/stores/lang'
import { api, errMsg } from '@/lib/client'
import { fmtMoney, r2 } from '@/lib/format'
import { uuid } from '@/lib/uid'
import { PageHeader, LoadingBlock, ErrorBanner, StatCard } from '@/components/shared/kit'
import CustomerStatementPanel from '@/components/shared/customer-statement'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { BookUser, Clock, HandCoins, Wallet } from 'lucide-react'

interface Customer { id: string; name: string; phone: string; openingBalance: number; balance: number }

export default function KhataView() {
  const t = useT()
  const { business } = useAuthStore()
  const cur = business?.currency || 'PKR'
  const [customers, setCustomers] = useState<Customer[]>([])
  const [selected, setSelected] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [payOpen, setPayOpen] = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [payNote, setPayNote] = useState('')
  const [payMethod, setPayMethod] = useState('CASH')
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [offlineData, setOfflineData] = useState(false)
  const [notice, setNotice] = useState('')
  const bizId = business?.id
  const cacheKey = (k: string) => `pos_cache_${bizId || 'x'}_${k}`

  const flashNotice = useCallback((msg: string) => {
    setNotice(msg)
    window.setTimeout(() => setNotice(n => (n === msg ? '' : n)), 6000)
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const list = await api<Customer[]>('/api/customers')
      setCustomers(Array.isArray(list) ? list : [])
      setSelected(prev => prev || list.find(c => c.balance > 0.001 || c.openingBalance > 0)?.id || list[0]?.id || '')
      setOfflineData(false)
      // Same cache POS uses — keeps khata usable offline for free.
      try { localStorage.setItem(cacheKey('customers'), JSON.stringify(list)) } catch { /* quota */ }
    } catch {
      // Offline — work from the cached customer list.
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey('customers')) || '[]')
        if (Array.isArray(cached) && cached.length) {
          setCustomers(cached)
          setSelected(prev => prev || cached.find((c: Customer) => c.balance > 0.001 || c.openingBalance > 0)?.id || cached[0]?.id || '')
          setOfflineData(true); setError('')
        } else setError(t('khat.notCached'))
      } catch { setError(t('khat.notCached')) }
    } finally { setLoading(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bizId, t])

  useEffect(() => { load() }, [load])

  const addPayment = async () => {
    if (!selected) return
    setBusy(true)
    const amount = parseFloat(payAmount) || 0
    const body = { amount, note: payNote || t('khat.defaultNote', { method: payMethod }), method: payMethod }
    const cust = customers.find(c => c.id === selected)
    const finish = () => {
      setPayOpen(false); setPayAmount(''); setPayNote('')
      setRefreshKey(k => k + 1); setBusy(false)
    }

    /** Optimistic local ledger so the offline screen stays truthful. */
    const applyLocal = () => {
      setCustomers(cs => cs.map(c => c.id === selected ? { ...c, balance: Math.round((c.balance - amount) * 100) / 100 } : c))
    }

    const queueOffline = () => {
      const clientRef = uuid()
      useOfflineStore.getState().enqueue({
        clientRef, kind: 'KHATA_PAYMENT',
        payload: { ...body, customerId: selected, clientRef, deviceTs: new Date().toISOString() },
      })
      applyLocal()
      finish()
      flashNotice(t('khat.savedOffline', { n: useOfflineStore.getState().queue.length, name: cust?.name || 'customer' }))
    }

    if (!navigator.onLine) { queueOffline(); return }
    try {
      await api(`/api/customers/payment?customerId=${selected}`, { method: 'POST', body })
      finish()
      await load()
    } catch (e) {
      const msg = errMsg(e)
      if (/Internet connection unavailable/i.test(msg)) {
        queueOffline()
      } else {
        alert(msg)
        setBusy(false)
      }
    }
  }

  const totalDue = r2(customers.reduce((s, c) => s + Math.max(0, c.balance), 0))
  const sel = customers.find(c => c.id === selected)

  if (loading) return <div className="p-6"><LoadingBlock rows={8} /></div>

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title={t('khat.title')}
        subtitle={t('khat.subtitle')}
        actions={
          <Button size="sm" onClick={() => setPayOpen(true)} disabled={!selected}><HandCoins className="h-4 w-4" /> {t('khat.addPayment')}</Button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard title={t('khat.totalDueAll')} value={fmtMoney(totalDue, cur)} icon={<BookUser className="h-3.5 w-3.5" />} tone="bad" />
        <StatCard title={t('khat.inCredit')} value={fmtMoney(customers.reduce((s, c) => s + Math.max(0, -c.balance), 0), cur)} icon={<Wallet className="h-3.5 w-3.5" />} tone="good" />
        <StatCard title={t('khat.customersWithDue')} value={String(customers.filter(c => c.balance > 0.001).length)} icon={<BookUser className="h-3.5 w-3.5" />} />
        <StatCard title={t('khat.clearOrCredit')} value={String(customers.filter(c => c.balance <= 0.001).length)} icon={<Clock className="h-3.5 w-3.5" />} />
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}
      {offlineData ? (
        <div className="text-[11px] text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200 dark:border-amber-900 rounded px-2.5 py-1.5 mb-3">
          {t('khat.offlineBanner')}
        </div>
      ) : null}
      {notice ? (
        <div className="text-[11px] text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900 rounded px-2.5 py-1.5 mb-3">
          {notice}
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
        {/* customer list */}
        <div className="rounded-lg border bg-card max-h-[560px] overflow-y-auto">
          {customers.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t('khat.noCustomers')}</p>
          ) : customers.map(c => (
            <button
              key={c.id}
              onClick={() => setSelected(c.id)}
              className={`w-full text-left px-3 py-2.5 border-b last:border-0 flex items-center justify-between gap-2 hover:bg-secondary/40 transition-colors ${selected === c.id ? 'bg-accent' : ''}`}
            >
              <span className="text-sm">
                <span className="font-medium block">{c.name}</span>
                <span className="text-[11px] text-muted-foreground">{c.phone || ''}</span>
              </span>
              <span className={`text-sm font-bold ${c.balance > 0 ? 'text-red-600' : 'text-muted-foreground'}`}>
                {c.balance > 0 ? fmtMoney(c.balance, cur) : t('khat.clear')}
              </span>
            </button>
          ))}
        </div>

        {/* statement panel */}
        <div className="rounded-lg border bg-card overflow-hidden">
          {!selected ? (
            <div className="p-8 text-center text-sm text-muted-foreground">{t('khat.selectPrompt')}</div>
          ) : (
            <>
              <div className="p-3 border-b flex flex-wrap items-center justify-between gap-2 bg-secondary/40">
                <div>
                  <div className="font-bold text-sm">{sel?.name || t('common.customer')}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {sel?.phone ? `${sel.phone} · ` : ''}{t('common.due')}: <b className={sel && sel.balance > 0 ? 'text-red-600' : 'text-emerald-600'}>{fmtMoney(sel?.balance || 0, cur)}</b>
                  </div>
                </div>
                <span className="text-[11px] text-muted-foreground">{t('khat.statementPrints')}</span>
              </div>
              <CustomerStatementPanel customerId={selected} refreshKey={refreshKey} />
            </>
          )}
        </div>
      </div>

      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>{t('khat.addKhataPayment')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t('common.customer')}</Label>
              <Select value={selected} onValueChange={setSelected}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {customers.map(c => <SelectItem key={c.id} value={c.id}>{c.name} ({t('khat.dueAmount', { amount: fmtMoney(Math.max(0, c.balance), cur) })})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t('khat.amountLabel', { cur })}</Label>
                <Input type="number" min={0.01} value={payAmount} onChange={e => setPayAmount(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('khat.method')}</Label>
                <Select value={payMethod} onValueChange={setPayMethod}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CASH">{t('khat.cash')}</SelectItem>
                    <SelectItem value="BANK">{t('khat.bankTransfer')}</SelectItem>
                    <SelectItem value="DIGITAL">{t('khat.digitalWallet')}</SelectItem>
                    <SelectItem value="CARD">{t('khat.card')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t('khat.note')}</Label>
              <Input value={payNote} onChange={e => setPayNote(e.target.value)} placeholder={t('khat.optional')} />
            </div>
            <Button className="w-full" onClick={addPayment} disabled={busy || !(parseFloat(payAmount) > 0)}>{t('khat.savePayment')}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
