'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuthStore } from '@/stores/auth'
import { useT } from '@/stores/lang'
import { api, errMsg } from '@/lib/client'
import { fmtMoney, fmtDateTime, fmtNum, r2, todayISO, daysAgoISO } from '@/lib/format'
import { downloadCSV, downloadExcel, printHTML, invoiceHTML, thermalReceiptHTML } from '@/lib/export'
import { jsbarcodeSvg } from '@/lib/barcode-client'
import { lookupInvoice, looksLikeInvoiceCode, type InvoiceLookupResult } from '@/lib/invoice-lookup'
import { useOfflineStore, syncNow } from '@/stores/offline'
import { useScannerWedge, beepOk, beepErr } from '@/lib/scanner'
import CameraScannerDialog from '@/components/shared/camera-scanner'
import InvoiceViewDialog from '@/components/shared/invoice-view-dialog'
import PrintPreviewDialog, { type PreviewDoc } from '@/components/shared/print-preview-dialog'
import { cn } from '@/lib/utils'
import { PageHeader, LoadingBlock, EmptyState, ErrorBanner, MobileCard, MobileCardList, MetaItem } from '@/components/shared/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Search, Printer, FileSpreadsheet, RotateCcw, Loader2, Eye, ReceiptText, ScanLine, CloudOff, RefreshCw,
} from 'lucide-react'

interface Sale {
  id: string; invoiceNo: string; createdAt: string; total: number; paid: number; dueAmount: number
  givenCash?: number
  paymentMethod: string; status: string; profit: number; cashierName: string; discount: number; tax: number; subtotal: number
  customer?: { name: string; phone?: string } | null
  _count?: { items: number }
}
interface SaleDetail extends Sale {
  items: { id: string; name: string; quantity: number; price: number; discount: number; total: number; returnedQty: number }[]
  returns: { returnNo: string; total: number }[]
}

const STATUS_COLORS: Record<string, string> = {
  COMPLETED: 'text-emerald-600 border-emerald-300',
  PARTIALLY_RETURNED: 'text-amber-600 border-amber-300',
  RETURNED: 'text-red-600 border-red-300',
}

export default function SalesView() {
  const t = useT()
  const { business } = useAuthStore()
  const cur = business?.currency || 'PKR'
  const [items, setItems] = useState<Sale[]>([])
  const [summary, setSummary] = useState<{ count: number; total: number; paid: number; due: number; profit: number } | null>(null)
  const [from, setFrom] = useState(daysAgoISO(30))
  const [to, setTo] = useState(todayISO())
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<SaleDetail | null>(null)
  const [returnOpen, setReturnOpen] = useState(false)
  const [returnQty, setReturnQty] = useState<Record<string, string>>({})
  const [returnReason, setReturnReason] = useState('')
  const [busy, setBusy] = useState(false)
  // scan-invoice-to-open (camera dialog + status + instant result)
  const [scanOpen, setScanOpen] = useState(false)
  const [scanMsg, setScanMsg] = useState('')
  const [scanMsgKind, setScanMsgKind] = useState<'ok' | 'err'>('ok')
  const [found, setFound] = useState<InvoiceLookupResult | null>(null)
  const [preview, setPreview] = useState<PreviewDoc | null>(null)
  // Task 72 — export state: which format is preparing + transient "Saved ✓"
  // flash (on phones the file silently lands in the Downloads folder — without
  // feedback the user assumes nothing happened / data is missing)
  const [exporting, setExporting] = useState<'' | 'csv' | 'xlsx'>('')
  const [savedFlash, setSavedFlash] = useState<'' | 'csv' | 'xlsx'>('')
  const lastScanRef = useRef<{ code: string; at: number }>({ code: '', at: 0 })
  const pageSize = 20
  // Task 61-d — make device-pending sales VISIBLE: sales queued offline on this
  // device (phone) are real business data the server has not received yet. The
  // sales list reads the server, so without this banner the user sees them on
  // the phone but "missing" on any other device — the exact "data not saving"
  // confusion. The panel shows the truthful on-device state + a manual flush.
  const queue = useOfflineStore(s => s.queue)
  // Task 67-b — show EVERY pending op (sales, product edits, stock adjustments,
  // purchases, khata payments), not only sales: the user must see the complete
  // truth about what this device holds that the server has not received yet.
  const pendingCount = queue.length

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const data = await api<{ items: Sale[]; total: number; summary: typeof summary }>(
        `/api/reports/sales?from=${from}&to=${to}&search=${encodeURIComponent(search)}&page=${page}&pageSize=${pageSize}`
      )
      setItems(data.items); setSummary(data.summary)
    } catch (e) { setError(errMsg(e)) } finally { setLoading(false) }
  }, [from, to, search, page])

  useEffect(() => { load() }, [load])

  const openDetail = async (s: Sale): Promise<SaleDetail | null> => {
    try {
      const d = await api<SaleDetail>(`/api/sales/detail?id=${s.id}`)
      setDetail(d)
      return d
    } catch (e) { alert(errMsg(e)); return null }
  }

  const biz = () => (
    { name: business?.name || '', address: business?.address || '', phone: business?.phone || '', logo: business?.logo || '', footer: String((useAuthStore.getState().settings as { receipt?: { footer?: string } })?.receipt?.footer || ''), border: (useAuthStore.getState().settings as { receipt?: { border?: boolean } })?.receipt?.border !== false }
  )

  const printInvoice = (s: SaleDetail) => {
    printHTML(`Invoice ${s.invoiceNo}`, invoiceHTML(biz(),
      {
        invoiceNo: s.invoiceNo, date: fmtDateTime(s.createdAt), cashier: s.cashierName,
        customer: s.customer?.name || t('pos.walkIn'),
        items: s.items.map(i => ({ name: i.name, quantity: i.quantity, price: i.price, total: i.total })),
        subtotal: s.subtotal, discount: s.discount, tax: s.tax,
        total: s.total, paid: s.paid, due: s.dueAmount, givenCash: s.givenCash, paymentMethod: s.paymentMethod, currency: cur,
        barcodeSvg: jsbarcodeSvg(s.invoiceNo, { height: 44 }),
      }
    ))
  }

  /** Customer-facing 80mm thermal reprint of any invoice. */
  const printThermal80 = (s: SaleDetail) => {
    printHTML(`Receipt ${s.invoiceNo}`, thermalReceiptHTML(biz(),
      {
        invoiceNo: s.invoiceNo, date: fmtDateTime(s.createdAt), cashier: s.cashierName,
        customer: s.customer?.name || t('pos.walkIn'),
        items: s.items.map(i => ({ name: i.name, quantity: i.quantity, price: i.price, total: i.total })),
        subtotal: s.subtotal, discount: s.discount, tax: s.tax,
        total: s.total, paid: s.paid, due: s.dueAmount, givenCash: s.givenCash, paymentMethod: s.paymentMethod, currency: cur,
        barcodeSvg: jsbarcodeSvg(s.invoiceNo, { height: 38 }),
      }, 80))
  }

  /** On-screen PRINT VIEW of the receipt / invoice — see it before printing. */
  const viewThermal80 = (s: SaleDetail) => {
    import('@/lib/export').then(({ thermalReceiptHTML }) => {
      setPreview({
        title: t('sale.receiptTitle', { no: s.invoiceNo }),
        html: thermalReceiptHTML(biz(), {
          invoiceNo: s.invoiceNo, date: fmtDateTime(s.createdAt), cashier: s.cashierName,
          customer: s.customer?.name || t('pos.walkIn'),
          items: s.items.map(i => ({ name: i.name, quantity: i.quantity, price: i.price, total: i.total })),
          subtotal: s.subtotal, discount: s.discount, tax: s.tax,
          total: s.total, paid: s.paid, due: s.dueAmount, givenCash: s.givenCash, paymentMethod: s.paymentMethod, currency: cur,
          barcodeSvg: jsbarcodeSvg(s.invoiceNo, { height: 38 }),
        }, 80),
        widthMm: 80,
      })
    })
  }
  const viewInvoice = (s: SaleDetail) => {
    import('@/lib/export').then(({ invoiceHTML }) => {
      setPreview({
        title: t('sale.invoiceTitle', { no: s.invoiceNo }),
        html: invoiceHTML(biz(), {
          invoiceNo: s.invoiceNo, date: fmtDateTime(s.createdAt), cashier: s.cashierName,
          customer: s.customer?.name || t('pos.walkIn'),
          items: s.items.map(i => ({ name: i.name, quantity: i.quantity, price: i.price, total: i.total })),
          subtotal: s.subtotal, discount: s.discount, tax: s.tax,
          total: s.total, paid: s.paid, due: s.dueAmount, givenCash: s.givenCash, paymentMethod: s.paymentMethod, currency: cur,
          barcodeSvg: jsbarcodeSvg(s.invoiceNo, { height: 44 }),
        }),
        widthMm: 190,
      })
    })
  }

  /** Universal scan pipeline: dedup → lookup (sale/return/purchase) → instant on-screen invoice. */
  const handleScan = useCallback(async (raw: string) => {
    const code = raw.trim()
    if (!code) return
    const now = Date.now()
    if (lastScanRef.current.code === code && now - lastScanRef.current.at < 800) return
    lastScanRef.current = { code, at: now }
    const say = (msg: string, kind: 'ok' | 'err') => {
      setScanMsgKind(kind)
      setScanMsg(msg)
      window.setTimeout(() => setScanMsg(c => (c === msg ? '' : c)), 2800)
    }
    try {
      const res = await lookupInvoice(code)
      if (res) {
        beepOk()
        setFound(res)
        const no = res.purchase?.invoiceNo || res.sale?.invoiceNo || code
        say(t('sale.scanFound', { no }), 'ok')
      } else {
        beepErr()
        say(t('sale.scanNone', { code }), 'err')
      }
    } catch (e) {
      beepErr()
      say(errMsg(e), 'err')
    }
  }, [t])

  // hardware scanner capture anywhere on the page — the invoice desk never
  // needs to touch the mouse: scan → invoice on screen → print for customer
  useScannerWedge(handleScan, !scanOpen && !detail && !returnOpen)

  const submitReturn = async () => {
    if (!detail) return
    const rows = Object.entries(returnQty)
      .map(([saleItemId, q]) => ({ saleItemId, quantity: parseFloat(q) || 0 }))
      .filter(r => r.quantity > 0)
    if (rows.length === 0) { alert(t('sale.returnQtyNeeded')); return }
    setBusy(true)
    try {
      await api(`/api/sales/return?id=${detail.id}`, { method: 'POST', body: { items: rows, reason: returnReason } })
      setReturnOpen(false); setReturnQty({}); setReturnReason('')
      setDetail(null)
      load()
    } catch (e) { alert(errMsg(e)) } finally { setBusy(false) }
  }

  const cols = [
    { key: 'invoiceNo', label: t('common.invoice'), width: 15 }, { key: 'date', label: t('common.date'), width: 17 },
    { key: 'customer', label: t('common.customer'), width: 18 }, { key: 'cashier', label: t('common.cashier'), width: 13 },
    { key: 'method', label: t('common.payment'), width: 11 }, { key: 'total', label: `${t('common.total')} (${cur})`, width: 11 },
    { key: 'paid', label: `${t('common.paid')} (${cur})`, width: 11 }, { key: 'due', label: `${t('common.due')} (${cur})`, width: 10 },
    { key: 'status', label: t('common.status'), width: 12 },
  ]
  const exportRows = (rows: Sale[]) => rows.map(s => ({
    invoiceNo: s.invoiceNo, date: fmtDateTime(s.createdAt), customer: s.customer?.name || t('common.walkIn'),
    cashier: s.cashierName, method: s.paymentMethod, total: s.total, paid: s.paid, due: s.dueAmount, status: s.status,
  }))

  // Task 72 — CSV/Excel must contain the WHOLE filtered dataset, not just the
  // 20 rows of the current page (that was why exports looked like "data not
  // showing"). Pages through the same filtered query the list uses: 500 per
  // call, hard-capped at 20 pages = 10,000 rows.
  const fetchAllForExport = useCallback(async (): Promise<Sale[]> => {
    const pageSize = 500
    const q = `from=${from}&to=${to}&search=${encodeURIComponent(search)}`
    const first = await api<{ items: Sale[]; total: number }>(`/api/reports/sales?${q}&page=1&pageSize=${pageSize}`)
    const all: Sale[] = [...first.items]
    const pages = Math.min(20, Math.ceil(first.total / pageSize))
    for (let p = 2; p <= pages; p++) {
      const d = await api<{ items: Sale[] }>(`/api/reports/sales?${q}&page=${p}&pageSize=${pageSize}`)
      all.push(...d.items)
    }
    return all
  }, [from, to, search])

  const runExport = async (kind: 'csv' | 'xlsx') => {
    if (exporting) return
    setExporting(kind); setSavedFlash('')
    try {
      const rows = await fetchAllForExport()
      if (kind === 'csv') downloadCSV('sales', cols, exportRows(rows))
      else downloadExcel('sales', 'Sales', cols, exportRows(rows))
      setSavedFlash(kind)
      setTimeout(() => setSavedFlash(f => (f === kind ? '' : f)), 2500)
    } catch (e) { setError(errMsg(e)) } finally { setExporting('') }
  }

  const pages = Math.ceil((summary?.count || 0) / pageSize)

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title={t('nav.sales')}
        subtitle={summary ? t('sale.subtitleCount', { n: summary.count, total: fmtMoney(summary.total, cur), paid: fmtMoney(summary.paid, cur), profit: fmtMoney(summary.profit, cur) }) : t('sale.allRecords')}
        actions={
          <>
            <Button variant="outline" size="sm" disabled={!!exporting} onClick={() => runExport('csv')}>
              {exporting === 'csv' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {exporting === 'csv' ? t('sale.exportPreparing') : savedFlash === 'csv' ? t('sale.exportSaved') : 'CSV'}
            </Button>
            <Button variant="outline" size="sm" disabled={!!exporting} onClick={() => runExport('xlsx')}>
              {exporting === 'xlsx' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
              {exporting === 'xlsx' ? t('sale.exportPreparing') : savedFlash === 'xlsx' ? t('sale.exportSaved') : 'Excel'}
            </Button>
          </>
        }
      />
      {pendingCount > 0 && (
        <div data-testid="pending-sync-panel" className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <CloudOff className="h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{t('sales.pendingSync', { n: pendingCount })}</div>
            <div className="text-xs opacity-80">{t('sales.pendingSyncHint')}</div>
          </div>
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => syncNow(true)}>
            <RefreshCw className="h-4 w-4" /> {t('sales.syncNow')}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2 mb-3">
        <div className="space-y-1"><Label className="text-xs">{t('sale.from')}</Label><Input type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1) }} className="h-9 w-40" /></div>
        <div className="space-y-1"><Label className="text-xs">{t('sale.to')}</Label><Input type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1) }} className="h-9 w-40" /></div>
        <div className="relative flex-1 min-w-40 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('sale.searchPh')}
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            onKeyDown={e => { if (e.key === 'Enter' && looksLikeInvoiceCode(search)) { e.preventDefault(); void handleScan(search) } }}
            className="pl-8 h-9"
          />
        </div>
        <Button variant="outline" size="sm" className="h-9" onClick={() => setScanOpen(true)} title={t('sale.scanTitle')}>
          <ScanLine className="h-4 w-4" /> {t('sale.scan')}
        </Button>
      </div>
      {scanMsg ? (
        <div
          role="status"
          className={cn(
            'text-xs font-medium border rounded px-2 py-1 mb-3',
            scanMsgKind === 'err'
              ? 'text-red-700 bg-red-50 dark:bg-red-950/40 dark:text-red-300 border-red-200 dark:border-red-900'
              : 'text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900'
          )}
        >
          {scanMsg}
        </div>
      ) : null}
      {error ? <ErrorBanner message={error} onRetry={load} /> : null}
      {loading ? <LoadingBlock /> : items.length === 0 ? <EmptyState message={t('sale.empty')} /> : (
        <>
        <MobileCardList>
          {items.map(s => (
            <MobileCard
              key={s.id}
              title={s.invoiceNo}
              subtitle={`${fmtDateTime(s.createdAt)} · ${s.cashierName}`}
              badge={<Badge variant="outline" className={STATUS_COLORS[s.status] || ''}>{s.status.replace('_', ' ')}</Badge>}
              meta={(
                <>
                  <MetaItem label={t('common.customer')}>{s.customer?.name || t('common.walkIn')}</MetaItem>
                  <MetaItem label={t('common.payment')}>{s.paymentMethod}</MetaItem>
                  <MetaItem label={t('common.total')}>{fmtNum(s.total)}</MetaItem>
                  <MetaItem label={t('common.due')}><span className={s.dueAmount > 0 ? 'text-red-600 font-medium' : 'text-muted-foreground'}>{fmtNum(s.dueAmount)}</span></MetaItem>
                </>
              )}
              actions={(
                <>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openDetail(s)}><Eye className="h-3.5 w-3.5" /> {t('common.view')}</Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openDetail(s).then(d => d && viewInvoice(d))}><Printer className="h-3.5 w-3.5" /> {t('common.print')}</Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { setDetail(null); openDetail(s).then(() => setReturnOpen(true)) }}><RotateCcw className="h-3.5 w-3.5" /> {t('common.return')}</Button>
                </>
              )}
            />
          ))}
        </MobileCardList>
        <div className="hidden md:block rounded-lg border overflow-x-auto bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-secondary/50 text-left text-xs text-muted-foreground">
                <th className="p-2.5 font-medium">{t('common.invoice')}</th>
                <th className="p-2.5 font-medium">{t('common.date')}</th>
                <th className="p-2.5 font-medium hidden md:table-cell">{t('common.customer')}</th>
                <th className="p-2.5 font-medium hidden lg:table-cell">{t('common.cashier')}</th>
                <th className="p-2.5 font-medium">{t('common.payment')}</th>
                <th className="p-2.5 font-medium text-right">{t('common.total')}</th>
                <th className="p-2.5 font-medium text-right">{t('common.due')}</th>
                <th className="p-2.5 font-medium">{t('common.status')}</th>
                <th className="p-2.5 font-medium text-right">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map(s => (
                <tr key={s.id} className="border-b last:border-0 hover:bg-secondary/30">
                  <td className="p-2.5 font-medium">{s.invoiceNo}</td>
                  <td className="p-2.5 text-xs">{fmtDateTime(s.createdAt)}</td>
                  <td className="p-2.5 hidden md:table-cell">{s.customer?.name || t('common.walkIn')}</td>
                  <td className="p-2.5 hidden lg:table-cell">{s.cashierName}</td>
                  <td className="p-2.5 text-xs">{s.paymentMethod}</td>
                  <td className="p-2.5 text-right font-medium">{fmtNum(s.total)}</td>
                  <td className={`p-2.5 text-right ${s.dueAmount > 0 ? 'text-red-600 font-medium' : 'text-muted-foreground'}`}>{fmtNum(s.dueAmount)}</td>
                  <td className="p-2.5"><Badge variant="outline" className={STATUS_COLORS[s.status] || ''}>{s.status.replace('_', ' ')}</Badge></td>
                  <td className="p-2.5">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" title={t('common.view')} onClick={() => openDetail(s)}><Eye className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" title={t('sale.printPdf')} onClick={() => openDetail(s).then(d => d && printInvoice(d))}><Printer className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" title={t('sale.returnRefund')} onClick={() => { setDetail(null); openDetail(s).then(() => setReturnOpen(true)) }}><RotateCcw className="h-3.5 w-3.5" /></Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
      {pages > 1 ? (
        <div className="flex items-center justify-center gap-2 mt-3 text-sm">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('common.prev')}</Button>
          <span className="text-muted-foreground">{t('common.pageOf', { a: page, b: Math.max(1, pages) })}</span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>{t('common.next')}</Button>
        </div>
      ) : null}

      {/* detail + return dialog */}
      <Dialog open={!!detail} onOpenChange={v => !v && setDetail(null)}>
        {/* pinned-footer pattern: details scroll in the middle, the print/
            return actions are ALWAYS on screen on phones (they used to sit
            400px+ below the fold — "print option not fit in screen") */}
        <DialogContent className="flex flex-col gap-3 p-4 sm:gap-4 sm:p-6 sm:max-w-lg">
          <DialogHeader className="shrink-0"><DialogTitle className="flex items-center gap-2 min-w-0 pr-7"><ReceiptText className="h-4 w-4 shrink-0" /> <span className="min-w-0 break-words">{detail?.invoiceNo}</span></DialogTitle></DialogHeader>
          {detail ? (
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto text-sm">
              <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-1 text-xs text-muted-foreground [&>span]:min-w-0 [&_b]:break-words">
                <span>{t('common.date')}: <b className="text-foreground">{fmtDateTime(detail.createdAt)}</b></span>
                <span>{t('common.cashier')}: <b className="text-foreground">{detail.cashierName}</b></span>
                <span>{t('common.customer')}: <b className="text-foreground">{detail.customer?.name || t('common.walkIn')}</b></span>
                <span>{t('common.payment')}: <b className="text-foreground">{detail.paymentMethod}</b></span>
              </div>
              <table className="w-full text-xs [&_td]:[overflow-wrap:anywhere] [&_th]:whitespace-nowrap [&_th]:px-1 [&_td]:px-1">
                <thead><tr className="border-b text-left text-muted-foreground"><th className="py-1">{t('common.item')}</th><th className="py-1 text-right">{t('common.qty')}</th><th className="py-1 text-right">{t('common.price')}</th><th className="py-1 text-right">{t('common.total')}</th><th className="py-1 text-right">{t('sale.returned')}</th></tr></thead>
                <tbody>
                  {detail.items.map(i => (
                    <tr key={i.id} className="border-b last:border-0">
                      <td className="py-1.5">{i.name}</td>
                      <td className="py-1.5 text-right">{i.quantity}</td>
                      <td className="py-1.5 text-right">{fmtNum(i.price)}</td>
                      <td className="py-1.5 text-right">{fmtNum(i.total)}</td>
                      <td className="py-1.5 text-right text-red-600">{i.returnedQty || 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-xs space-y-0.5 text-right">
                <div>{t('common.subtotal')}: {fmtMoney(detail.subtotal, cur)}</div>
                {detail.discount ? <div>{t('common.discount')}: −{fmtMoney(detail.discount, cur)}</div> : null}
                {detail.tax ? <div>{t('common.tax')}: {fmtMoney(detail.tax, cur)}</div> : null}
                <div className="font-bold text-sm">{t('common.total')}: {fmtMoney(detail.total, cur)}</div>
                <div>{t('common.paid')}: {fmtMoney(detail.paid, cur)}{detail.givenCash && detail.givenCash > detail.total ? ` · ${t('sale.cashGiven')}: ${fmtMoney(detail.givenCash, cur)} · ${t('common.change')}: ${fmtMoney(r2(detail.givenCash - detail.total), cur)}` : ` · ${t('common.due')}: ${fmtMoney(detail.dueAmount, cur)}`}</div>
              </div>
              <div className="flex justify-center border-t pt-2 [&_svg]:h-12 [&_svg]:w-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: jsbarcodeSvg(detail.invoiceNo, { height: 44 }) }} aria-label={`Barcode ${detail.invoiceNo}`} />
              {detail.returns.length ? (
                <div className="text-[11px] text-muted-foreground">{t('sale.returnsList', { list: detail.returns.map(r => `${r.returnNo} (${fmtMoney(r.total, cur)})`).join(', ') })}</div>
              ) : null}
            </div>
          ) : null}
          {/* pinned action footer — always visible, zero scrolling needed */}
          {detail ? (
            <div className="shrink-0 border-t pt-2.5">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => viewThermal80(detail)}><Eye className="h-4 w-4 mr-1" /> {t('sale.view80')}</Button>
                <Button variant="outline" size="sm" onClick={() => printThermal80(detail)}><Printer className="h-4 w-4 mr-1" /> {t('sale.receipt80')}</Button>
                <Button variant="outline" size="sm" onClick={() => viewInvoice(detail)}><Eye className="h-4 w-4 mr-1" /> {t('sale.viewA4')}</Button>
                <Button variant="outline" size="sm" onClick={() => printInvoice(detail)}><Printer className="h-4 w-4 mr-1" /> {t('sale.printPdf')}</Button>
                <Button
                  variant="destructive" size="sm"
                  onClick={() => { setReturnQty({}); setReturnOpen(true) }}
                  disabled={detail.status === 'RETURNED'}
                ><RotateCcw className="h-4 w-4 mr-1" /> {t('sale.returnRefund')}</Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={returnOpen} onOpenChange={setReturnOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t('sale.returnTitle', { no: detail?.invoiceNo || '' })}</DialogTitle></DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="text-xs text-muted-foreground">{t('sale.returnHint')}</p>
            {detail?.items.map(i => {
              const returnable = r2(i.quantity - (i.returnedQty || 0))
              if (returnable <= 0) return null
              return (
                <div key={i.id} className="flex items-center justify-between gap-2">
                  <span className="flex-1">{i.name} <span className="text-xs text-muted-foreground">({t('sale.max', { n: returnable })})</span></span>
                  <Input
                    type="number" min={0} max={returnable} className="w-20 h-8"
                    value={returnQty[i.id] || ''}
                    onChange={e => setReturnQty({ ...returnQty, [i.id]: e.target.value })}
                  />
                </div>
              )
            })}
            <Label className="text-xs">{t('common.reason')}</Label>
            <Input value={returnReason} onChange={e => setReturnReason(e.target.value)} placeholder={t('sale.reasonPh')} />
            <Button className="w-full" onClick={submitReturn} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {t('sale.confirmReturn')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* scan-invoice camera + instant on-screen invoice (rendered last → stacks on top) */}
      <CameraScannerDialog
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onScan={code => void handleScan(code)}
        title={t('sale.scanBarcode')}
        hint={t('sale.scanHint')}
      />
      <InvoiceViewDialog result={found} onClose={() => setFound(null)} />
      <PrintPreviewDialog doc={preview} onClose={() => setPreview(null)} />
    </div>
  )
}
