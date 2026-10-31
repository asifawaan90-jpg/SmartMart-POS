'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuthStore } from '@/stores/auth'
import { api, errMsg } from '@/lib/client'
import { fmtMoney, fmtDateTime } from '@/lib/format'
import { downloadCSV, printHTML, statementHTML, TXN_TYPE_LABEL, type StatementDoc, type StatementBiz } from '@/lib/export'
import { LoadingBlock, ErrorBanner } from '@/components/shared/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Printer, CalendarRange, Loader2 } from 'lucide-react'

interface Txn { id: string; type: string; amount: number; balanceAfter: number; refNo: string; note: string; createdAt: string }
interface Statement {
  customer: { name: string; phone: string; address: string; creditLimit: number }
  txns: Txn[]
  opening: number
  summary: { totalDue: number; overdue: number; paid: number; balance: number; periodDebit: number; periodCredit: number; hasRange: boolean; from: string; to: string }
}

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * Shared khata statement panel — used by the Khata view (inline) and the Customers
 * view (dialog). Provides date-range filtering with presets, brought-forward balance,
 * and SEPARATE print options: overall (all transactions) vs date-wise (selected range).
 */
export default function CustomerStatementPanel({ customerId, refreshKey = 0 }: { customerId: string; refreshKey?: number }) {
  const { business } = useAuthStore()
  const cur = business?.currency || 'PKR'
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [data, setData] = useState<Statement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [printing, setPrinting] = useState<'overall' | 'range' | null>(null)

  const hasRange = Boolean(from || to)

  const load = useCallback(async () => {
    if (!customerId) { setData(null); return }
    setLoading(true); setError('')
    try {
      const qs = new URLSearchParams({ customerId })
      if (from) qs.set('from', from)
      if (to) qs.set('to', to)
      setData(await api<Statement>(`/api/customers/statement?${qs.toString()}`))
    } catch (e) { setError(errMsg(e)) } finally { setLoading(false) }
  }, [customerId, from, to])

  useEffect(() => { load() }, [load, refreshKey])

  const biz = (): StatementBiz => ({
    name: business?.name || '', address: business?.address || '', phone: business?.phone || '',
    logo: business?.logo || '', currency: cur,
  })

  const doc = (s: Statement): StatementDoc => ({
    customer: s.customer, txns: s.txns, opening: s.opening,
    summary: {
      totalDue: s.summary.totalDue, periodDebit: s.summary.periodDebit, periodCredit: s.summary.periodCredit,
      hasRange: s.summary.hasRange, from: s.summary.from, to: s.summary.to,
    },
  })

  const fetchStatement = async (range: boolean) => {
    const qs = new URLSearchParams({ customerId })
    if (range) { if (from) qs.set('from', from); if (to) qs.set('to', to) }
    return api<Statement>(`/api/customers/statement?${qs.toString()}`)
  }

  /** Overall statement — every transaction of the customer. */
  const printOverall = async () => {
    setPrinting('overall')
    try {
      const s = await fetchStatement(false)
      printHTML(`Statement ${s.customer.name}`, statementHTML(biz(), doc(s)))
    } catch (e) { alert(errMsg(e)) } finally { setPrinting(null) }
  }

  /** Date-wise statement — only the selected period, with brought-forward balance. */
  const printDatewise = async () => {
    setPrinting('range')
    try {
      const s = await fetchStatement(true)
      printHTML(`Statement ${s.customer.name} (${s.summary.from || 'start'} → ${s.summary.to || 'now'})`, statementHTML(biz(), doc(s)))
    } catch (e) { alert(errMsg(e)) } finally { setPrinting(null) }
  }

  const exportCSV = () => {
    if (!data) return
    downloadCSV(
      `statement-${data.customer.name.replace(/\s+/g, '-').toLowerCase()}${hasRange ? `-${from || 'start'}_${to || 'now'}` : '-overall'}`,
      [
        { key: 'date', label: 'Date' }, { key: 'type', label: 'Type' }, { key: 'ref', label: 'Reference' },
        { key: 'note', label: 'Note' }, { key: 'debit', label: `Debit (${cur})` },
        { key: 'credit', label: `Credit (${cur})` }, { key: 'bal', label: `Balance (${cur})` },
      ],
      data.txns.map(t => ({
        date: fmtDateTime(t.createdAt), type: TXN_TYPE_LABEL[t.type] || t.type, ref: t.refNo || '', note: t.note || '',
        debit: t.amount > 0 ? t.amount : 0, credit: t.amount < 0 ? -t.amount : 0, bal: t.balanceAfter,
      })),
    )
  }

  const preset = (kind: 'month' | '30d' | 'all') => {
    if (kind === 'all') { setFrom(''); setTo(''); return }
    const now = new Date()
    if (kind === 'month') setFrom(isoDay(new Date(now.getFullYear(), now.getMonth(), 1)))
    else setFrom(isoDay(new Date(now.getTime() - 30 * 86400000)))
    setTo(isoDay(now))
  }

  const s = data
  const safeTxns = Array.isArray(s?.txns) ? s!.txns : []

  return (
    <div className="flex flex-col min-h-0">
      {/* toolbar: date range + presets + prints */}
      <div className="p-3 border-b bg-secondary/40 space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1"><Label className="text-xs">From</Label><Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="h-8 w-36 text-xs" /></div>
          <div className="space-y-1"><Label className="text-xs">To</Label><Input type="date" value={to} onChange={e => setTo(e.target.value)} className="h-8 w-36 text-xs" /></div>
          <div className="flex gap-1 pb-0.5">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => preset('month')}>This month</Button>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => preset('30d')}>Last 30 days</Button>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => preset('all')}>All</Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={printOverall} disabled={printing !== null}>
            {printing === 'overall' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />} Print Overall Statement
          </Button>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={printDatewise} disabled={printing !== null || !hasRange}
            title={hasRange ? 'Print only the selected date range' : 'Set From/To dates first'}>
            {printing === 'range' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarRange className="h-3.5 w-3.5" />} Print Date-wise
          </Button>
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={exportCSV} disabled={!s || safeTxns.length === 0}>CSV</Button>
          {hasRange ? <span className="text-[11px] text-muted-foreground ml-1">filtered: {from || 'start'} → {to || 'now'}</span> : null}
        </div>
      </div>

      {/* summary chips */}
      {s ? (
        <div className="px-3 py-2 border-b flex flex-wrap gap-2 text-xs">
          <span className="rounded-lg bg-secondary border px-2.5 py-1"><b>Brought fwd</b> {fmtMoney(s.opening, cur)}</span>
          <span className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-2.5 py-1"><b className="text-red-700 dark:text-red-300">Debit {fmtMoney(s.summary.periodDebit, cur)}</b></span>
          <span className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 px-2.5 py-1"><b className="text-emerald-700 dark:text-emerald-300">Credit {fmtMoney(s.summary.periodCredit, cur)}</b></span>
          <span className={`rounded-lg border px-2.5 py-1 ${s.summary.totalDue > 0 ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900' : 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900'}`}>
            <b className={s.summary.totalDue > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}>DUE NOW {fmtMoney(s.summary.totalDue, cur)}</b>
          </span>
        </div>
      ) : null}

      {error ? <div className="p-3"><ErrorBanner message={error} onRetry={load} /></div> : null}

      {loading && !s ? (
        <div className="p-4"><LoadingBlock rows={5} /></div>
      ) : s ? (
        <div className="min-h-0 overflow-auto" style={{ maxHeight: '46vh' }}>
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card z-10">
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-2 font-medium">Date</th><th className="p-2 font-medium">Type</th><th className="p-2 font-medium">Ref</th>
                <th className="p-2 font-medium text-right">Debit</th><th className="p-2 font-medium text-right">Credit</th>
                <th className="p-2 font-medium text-right">Balance</th><th className="p-2 font-medium hidden md:table-cell">Note</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b bg-secondary/20 italic text-muted-foreground">
                <td className="p-2" colSpan={3}>Opening balance (brought forward)</td>
                <td className="p-2" /><td className="p-2" />
                <td className="p-2 text-right font-bold">{fmtMoney(s.opening, cur)}</td>
                <td className="p-2 hidden md:table-cell" />
              </tr>
              {safeTxns.map(t => (
                <tr key={t.id} className="border-b last:border-0">
                  <td className="p-2 whitespace-nowrap">{fmtDateTime(t.createdAt)}</td>
                  <td className="p-2">{TXN_TYPE_LABEL[t.type] || t.type.replace('_', ' ')}</td>
                  <td className="p-2">{t.refNo || '—'}</td>
                  <td className="p-2 text-right text-red-600">{t.amount > 0 ? fmtMoney(t.amount, cur) : ''}</td>
                  <td className="p-2 text-right text-emerald-600">{t.amount < 0 ? fmtMoney(-t.amount, cur) : ''}</td>
                  <td className="p-2 text-right font-bold">{fmtMoney(t.balanceAfter, cur)}</td>
                  <td className="p-2 hidden md:table-cell text-muted-foreground max-w-[180px] truncate" title={t.note}>{t.note || '—'}</td>
                </tr>
              ))}
              {safeTxns.length === 0 ? (
                <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">No transactions in this period.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
