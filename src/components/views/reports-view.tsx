'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuthStore } from '@/stores/auth'
import { useT, type TFn } from '@/stores/lang'
import { api, errMsg } from '@/lib/client'
import { fmtMoney, fmtNum, fmtDateTime, fmtDate, todayISO, daysAgoISO } from '@/lib/format'
import { downloadCSV, downloadExcel, printHTML } from '@/lib/export'
import { PageHeader, LoadingBlock, ErrorBanner } from '@/components/shared/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Printer, FileSpreadsheet, Download } from 'lucide-react'

interface Col { key: string; label: string; width?: number; num?: boolean }

const REPORTS: Record<string, { label: string; cols: Col[]; map: (r: Record<string, unknown>, t: TFn) => Record<string, unknown> }> = {
  sales: {
    label: 'nav.sales',
    cols: [
      { key: 'invoiceNo', label: 'common.invoice', width: 14 }, { key: 'date', label: 'common.date', width: 16 },
      { key: 'customer', label: 'common.customer', width: 16 }, { key: 'cashier', label: 'common.cashier', width: 12 },
      { key: 'method', label: 'common.payment', width: 10 }, { key: 'total', label: 'common.total', width: 10, num: true },
      { key: 'paid', label: 'common.paid', width: 10, num: true }, { key: 'due', label: 'common.due', width: 9, num: true },
      { key: 'profit', label: 'rep.colProfit', width: 10, num: true }, { key: 'status', label: 'common.status', width: 10 },
    ],
    map: (r, t) => ({ ...(r as object), date: fmtDateTime(r.createdAt as string), customer: (r.customer as { name?: string })?.name || t('common.walkIn'), method: r.paymentMethod }),
  },
  purchases: {
    label: 'nav.purchases',
    cols: [
      { key: 'invoiceNo', label: 'rep.colPurchaseNo', width: 14 }, { key: 'date', label: 'common.date', width: 16 },
      { key: 'supplier', label: 'rep.colSupplier', width: 16 }, { key: 'total', label: 'common.total', width: 11, num: true },
      { key: 'paid', label: 'common.paid', width: 11, num: true }, { key: 'due', label: 'common.due', width: 10, num: true },
    ],
    map: (r) => ({ ...(r as object), date: fmtDateTime(r.createdAt as string), supplier: (r.supplier as { name?: string })?.name || '' }),
  },
  profit: {
    label: 'rep.rProfit',
    cols: [
      { key: 'invoiceNo', label: 'common.invoice', width: 15 }, { key: 'date', label: 'common.date', width: 17 },
      { key: 'revenue', label: 'rep.colRevenue', width: 16, num: true }, { key: 'profit', label: 'rep.colGrossProfit', width: 13, num: true },
    ],
    map: (r) => ({ ...(r as object), date: fmtDateTime(r.date as string) }),
  },
  expense: {
    label: 'rep.rExpenses',
    cols: [
      { key: 'date', label: 'common.date', width: 14 }, { key: 'title', label: 'rep.colExpense', width: 22 },
      { key: 'category', label: 'rep.colCategory', width: 14 }, { key: 'paidTo', label: 'rep.colPaidTo', width: 14 },
      { key: 'amount', label: 'rep.colAmount', width: 12, num: true },
    ],
    map: (r) => ({ ...(r as object), date: fmtDate(r.expenseDate as string), category: (r.category as { name?: string })?.name || '' }),
  },
  inventory: {
    label: 'nav.inventory',
    cols: [
      { key: 'name', label: 'rep.colProduct', width: 24 }, { key: 'sku', label: 'rep.colSku', width: 13 },
      { key: 'category', label: 'rep.colCategory', width: 13 }, { key: 'stock', label: 'rep.colStock', width: 8, num: true },
      { key: 'costPrice', label: 'rep.colCost', width: 10, num: true }, { key: 'retailPrice', label: 'rep.colRetail', width: 10, num: true },
      { key: 'stockValue', label: 'rep.colStockValue', width: 12, num: true },
    ],
    map: (r) => ({ ...(r as object), category: (r.category as { name?: string })?.name || '', stockValue: (Number(r.stock) || 0) * (Number(r.costPrice) || 0) }),
  },
  'low-stock': {
    label: 'rep.rLowStock',
    cols: [
      { key: 'name', label: 'rep.colProduct', width: 24 }, { key: 'sku', label: 'rep.colSku', width: 14 },
      { key: 'stock', label: 'rep.colCurrentStock', width: 12, num: true }, { key: 'minStock', label: 'rep.colMinimum', width: 10, num: true },
    ],
    map: (r) => ({ ...r }),
  },
  customer: {
    label: 'nav.customers',
    cols: [
      { key: 'name', label: 'common.customer', width: 20 }, { key: 'phone', label: 'rep.colPhone', width: 13 },
      { key: 'invoiceCount', label: 'rep.colInvoices', width: 9, num: true }, { key: 'purchases', label: 'nav.purchases', width: 13, num: true },
      { key: 'due', label: 'common.due', width: 12, num: true },
    ],
    map: (r) => ({ ...r }),
  },
  khata: {
    label: 'rep.rKhata',
    cols: [
      { key: 'name', label: 'common.customer', width: 20 }, { key: 'phone', label: 'rep.colPhone', width: 13 },
      { key: 'due', label: 'rep.colOutstandingDue', width: 14, num: true }, { key: 'creditLimit', label: 'rep.colCreditLimit', width: 12, num: true },
    ],
    map: (r) => ({ ...r }),
  },
  supplier: {
    label: 'nav.suppliers',
    cols: [
      { key: 'name', label: 'rep.colSupplier', width: 20 }, { key: 'company', label: 'rep.colCompany', width: 16 },
      { key: 'phone', label: 'rep.colPhone', width: 13 }, { key: 'payable', label: 'rep.colPayable', width: 13, num: true },
    ],
    map: (r) => ({ ...r }),
  },
  payment: {
    label: 'rep.rPayments',
    cols: [
      { key: 'method', label: 'rep.colMethod', width: 16 }, { key: 'count', label: 'rep.colInvoices', width: 10, num: true },
      { key: 'amount', label: 'rep.colAmount', width: 13, num: true }, { key: 'paid', label: 'rep.colCollected', width: 13, num: true },
      { key: 'due', label: 'rep.colOutstanding', width: 13, num: true },
    ],
    map: (r) => ({ ...r }),
  },
  product: {
    label: 'rep.rProductSales',
    cols: [
      { key: 'name', label: 'rep.colProduct', width: 26 }, { key: 'qty', label: 'rep.colQtySold', width: 10, num: true },
      { key: 'revenue', label: 'rep.colRevenue', width: 13, num: true },
    ],
    map: (r) => ({ ...r }),
  },
  'sales-return': {
    label: 'rep.rSalesReturns',
    cols: [
      { key: 'returnNo', label: 'rep.colReturnNo', width: 14 }, { key: 'date', label: 'common.date', width: 17 },
      { key: 'total', label: 'rep.colRefund', width: 12, num: true }, { key: 'reason', label: 'common.reason', width: 24 },
    ],
    map: (r) => ({ ...(r as object), date: fmtDateTime(r.createdAt as string) }),
  },
  'purchase-return': {
    label: 'rep.rPurchaseReturns',
    cols: [
      { key: 'returnNo', label: 'rep.colReturnNo', width: 14 }, { key: 'date', label: 'common.date', width: 17 },
      { key: 'total', label: 'rep.colAmount', width: 12, num: true }, { key: 'reason', label: 'common.reason', width: 24 },
    ],
    map: (r) => ({ ...(r as object), date: fmtDateTime(r.createdAt as string) }),
  },
}

export default function ReportsView() {
  const t = useT()
  const { business } = useAuthStore()
  const cur = business?.currency || 'PKR'
  const [type, setType] = useState('sales')
  const [from, setFrom] = useState(daysAgoISO(30))
  const [to, setTo] = useState(todayISO())
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [summary, setSummary] = useState<Record<string, number> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const spec = REPORTS[type]

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const data = await api<{ items?: Record<string, unknown>[]; rows?: Record<string, unknown>[]; summary?: Record<string, number> }>(
        `/api/reports/${type}?from=${from}&to=${to}&pageSize=5000` // Task 73 — 5000 = API max; print/export/CSV must never drop rows
      )
      setRows(data.items || data.rows || [])
      setSummary(data.summary || null)
    } catch (e) { setError(errMsg(e)) } finally { setLoading(false) }
  }, [type, from, to])

  useEffect(() => { load() }, [load])

  const mapped = rows.map(r => spec.map(r, t))
  const colsT = spec.cols.map(c => ({ ...c, label: t(c.label) }))
  const title = t('rep.titleOf', { name: t(spec.label), from, to })

  const printReport = () => {
    const head = colsT.map(c => `<th class="${c.num ? 'num' : ''}">${c.label}</th>`).join('')
    const body = mapped.map(r => `<tr>${spec.cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.num ? fmtNum(Number(r[c.key]) || 0) : String(r[c.key] ?? '')}</td>`).join('')}</tr>`).join('')
    const sums = summary ? Object.entries(summary).map(([k, v]) => `<div><span>${k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}</span><span>${fmtMoney(v, cur)}</span></div>`).join('') : ''
    printHTML(title, `
      <div class="head"><div><h1>${business?.name || ''}</h1><div class="muted">${title}</div></div>
      <div style="text-align:right"><h2>${t(spec.label)}</h2><div class="muted">${t('rep.generated', { date: new Date().toLocaleString() })}</div></div></div>
      <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
      ${sums ? `<div class="totals">${sums}</div>` : ''}
    `)
  }

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title={t('nav.reports')}
        subtitle={t('rep.subtitle')}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={printReport}><Printer className="h-4 w-4" /> {t('rep.printPdf')}</Button>
            <Button variant="outline" size="sm" onClick={() => downloadCSV(`${type}-report`, colsT, mapped)}><Download className="h-4 w-4" /> CSV</Button>
            <Button variant="outline" size="sm" onClick={() => downloadExcel(`${type}-report`, t(spec.label), colsT, mapped)}><FileSpreadsheet className="h-4 w-4" /> Excel</Button>
          </>
        }
      />

      <div className="mb-3 space-y-3">
        <Tabs value={type} onValueChange={setType}>
          <TabsList className="flex flex-wrap h-auto gap-1">
            {Object.entries(REPORTS).map(([k, v]) => (
              <TabsTrigger key={k} value={k} className="text-xs px-2.5 py-1">{t(v.label)}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1"><Label className="text-xs">{t('rep.from')}</Label><Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="h-9 w-40" /></div>
          <div className="space-y-1"><Label className="text-xs">{t('rep.to')}</Label><Input type="date" value={to} onChange={e => setTo(e.target.value)} className="h-9 w-40" /></div>
          <Button variant="secondary" size="sm" className="h-9" onClick={load}>{t('rep.runReport')}</Button>
          {summary ? (
            <div className="flex flex-wrap gap-2 ml-auto text-xs">
              {Object.entries(summary).map(([k, v]) => (
                <span key={k} className="rounded-full border bg-secondary/50 px-2.5 py-1">
                  {k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}: <b>{fmtMoney(v, cur)}</b>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}
      {loading ? <LoadingBlock rows={10} /> : (
        <div className="rounded-lg border overflow-x-auto bg-card max-h-[60vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b bg-secondary/50 text-left text-xs text-muted-foreground">
                {colsT.map(c => <th key={c.key} className={`p-2.5 font-medium ${c.num ? 'text-right' : ''}`}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {mapped.length === 0 ? (
                <tr><td colSpan={spec.cols.length} className="p-6 text-center text-muted-foreground text-sm">{t('rep.noData')}</td></tr>
              ) : mapped.map((r, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-secondary/30">
                  {spec.cols.map(c => (
                    <td key={c.key} className={`p-2.5 ${c.num ? 'text-right' : ''}`}>{c.num ? fmtNum(Number(r[c.key]) || 0) : String(r[c.key] ?? '—')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
