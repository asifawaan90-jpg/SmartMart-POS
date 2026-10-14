'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuthStore } from '@/stores/auth'
import { useOfflineStore } from '@/stores/offline'
import { useT } from '@/stores/lang'
import { api, errMsg } from '@/lib/client'
import { fmtMoney, fmtNum, fmtDateTime, r2, todayISO, daysAgoISO } from '@/lib/format'
import { uuid } from '@/lib/uid'
import { downloadCSV, downloadExcel, printHTML, purchaseInvoiceHTML } from '@/lib/export'
import { jsbarcodeSvg } from '@/lib/barcode-client'
import { lookupInvoice, looksLikeInvoiceCode, type InvoiceLookupResult } from '@/lib/invoice-lookup'
import { useScannerWedge, beepOk, beepErr } from '@/lib/scanner'
import { useExportAll, fetchAllPages } from '@/lib/use-export-all'
import CameraScannerDialog from '@/components/shared/camera-scanner'
import InvoiceViewDialog from '@/components/shared/invoice-view-dialog'
import { cn } from '@/lib/utils'
import { PageHeader, LoadingBlock, EmptyState, ErrorBanner, MobileCard, MobileCardList, MetaItem } from '@/components/shared/kit'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Plus, Loader2, Search, Eye, Truck, Printer, ScanLine } from 'lucide-react'

interface Purchase { id: string; invoiceNo: string; createdAt: string; total: number; paid: number; dueAmount: number; status: string; supplier?: { name: string } | null; _count?: { items: number } }
interface PurchaseDetail extends Purchase {
  subtotal: number; discount: number; tax: number
  items: { id: string; productId: string; name: string; quantity: number; unitCost: number; total: number; returnedQty: number }[]
  supplier?: { id: string; name: string } | null
  returns?: { returnNo: string; total: number }[]
}
interface Product { id: string; name: string; costPrice: number; stock: number }
interface Supplier { id: string; name: string }

export default function PurchasesView() {
  const t = useT()
  const { business } = useAuthStore()
  const cur = business?.currency || 'PKR'
  const [items, setItems] = useState<Purchase[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [total, setTotal] = useState(0)

  // new purchase
  const [formOpen, setFormOpen] = useState(false)
  const [products, setProducts] = useState<Product[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [lines, setLines] = useState<{ productId: string; quantity: string; unitCost: string }[]>([])
  const [paid, setPaid] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  // detail / return
  const [detail, setDetail] = useState<PurchaseDetail | null>(null)
  const [returnQty, setReturnQty] = useState<Record<string, string>>({})
  const [payAmount, setPayAmount] = useState('')
  // scan-invoice-to-open
  const [scanOpen, setScanOpen] = useState(false)
  const [scanMsg, setScanMsg] = useState('')
  const [scanMsgKind, setScanMsgKind] = useState<'ok' | 'err'>('ok')
  const [found, setFound] = useState<InvoiceLookupResult | null>(null)
  const lastScanRef = useRef<{ code: string; at: number }>({ code: '', at: 0 })
  const [offlineData, setOfflineData] = useState(false)
  const [notice, setNotice] = useState('')
  const bizId = business?.id
  const cacheKey = (k: string) => `pos_cache_${bizId || 'x'}_${k}`

  const flashNotice = useCallback((msg: string) => {
    setNotice(msg)
    window.setTimeout(() => setNotice(n => (n === msg ? '' : n)), 6000)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setPage(1) }, 300)
    return () => clearTimeout(t)
  }, [search])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const data = await api<{ items: Purchase[]; total: number }>(`/api/purchases?search=${encodeURIComponent(debounced)}&page=${page}&pageSize=${pageSize}`)
      setItems(data.items); setTotal(data.total)
      setOfflineData(false)
      try { localStorage.setItem(cacheKey('purlist'), JSON.stringify(data.items)) } catch { /* quota */ }
    } catch {
      // Offline — fall back to the last cached list (search/paging frozen).
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey('purlist')) || '[]')
        if (Array.isArray(cached) && cached.length) {
          setItems(cached); setTotal(cached.length); setOfflineData(true); setError('')
        } else setError(t('pur.notCached'))
      } catch { setError(t('pur.notCached')) }
    } finally { setLoading(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, page, bizId, t])

  useEffect(() => { load() }, [load])

  const openForm = async () => {
    try {
      const [p, s] = await Promise.all([
        api<{ items: Product[] }>('/api/products?all=1&status=active'),
        api<Supplier[]>('/api/suppliers'),
      ])
      setProducts(p.items); setSuppliers(s)
      try {
        localStorage.setItem(cacheKey('products'), JSON.stringify(p.items))
        localStorage.setItem(cacheKey('suppliers'), JSON.stringify(s))
      } catch { /* quota */ }
    } catch {
      // Offline — reuse the POS catalog cache + last cached suppliers so a
      // stock-in can still be recorded on the device.
      try {
        const p = JSON.parse(localStorage.getItem(cacheKey('products')) || '[]')
        const s = JSON.parse(localStorage.getItem(cacheKey('suppliers')) || '[]')
        setProducts(Array.isArray(p) ? p : [])
        setSuppliers(Array.isArray(s) ? s : [])
        setOfflineData(true)
      } catch { /* nothing cached */ }
    }
    setLines([{ productId: '', quantity: '1', unitCost: '' }])
    setSupplierId(''); setPaid(''); setNote('')
    setFormOpen(true)
  }

  const grandTotal = r2(lines.reduce((s, l) => s + (parseFloat(l.quantity) || 0) * (parseFloat(l.unitCost) || 0), 0))

  const savePurchase = async () => {
    const valid = lines.filter(l => l.productId && parseFloat(l.quantity) > 0 && parseFloat(l.unitCost) >= 0)
    if (valid.length === 0) { alert(t('pur.addAtLeastOne')); return }
    setSaving(true)
    const finish = () => { setFormOpen(false); setSaving(false) }
    const body = {
      supplierId: supplierId || null,
      items: valid.map(l => ({ productId: l.productId, quantity: parseFloat(l.quantity), unitCost: parseFloat(l.unitCost) })),
      paid: parseFloat(paid) || 0,
      note,
    }
    const queueOffline = () => {
      const clientRef = uuid()
      useOfflineStore.getState().enqueue({
        clientRef, kind: 'PURCHASE',
        payload: { ...body, clientRef, deviceTs: new Date().toISOString() },
      })
      finish()
      flashNotice(t('pur.savedOffline', { n: useOfflineStore.getState().queue.length }))
    }
    if (!navigator.onLine) { queueOffline(); return }
    try {
      await api('/api/purchases', { method: 'POST', body })
      finish()
      load()
    } catch (e) {
      const msg = errMsg(e)
      if (/Internet connection unavailable/i.test(msg)) {
        queueOffline()
      } else {
        alert(msg); setSaving(false)
      }
    }
  }

  const openDetail = async (p: Purchase) => {
    try { setDetail(await api<PurchaseDetail>(`/api/purchases/detail?id=${p.id}`)) } catch (e) { alert(errMsg(e)) }
  }

  /** A4 print of a purchase invoice (with scannable barcode). */
  const printPurchase = (p: PurchaseDetail) => {
    const b = useAuthStore.getState().business
    const s = useAuthStore.getState().settings as { receipt?: { footer?: string; border?: boolean } } | null
    printHTML(t('pur.printTitle', { no: p.invoiceNo }), purchaseInvoiceHTML({
      name: b?.name || '', address: b?.address || '', phone: b?.phone || '', logo: b?.logo || '',
      footer: String(s?.receipt?.footer || ''), border: s?.receipt?.border !== false,
    }, {
      invoiceNo: p.invoiceNo, date: fmtDateTime(p.createdAt), supplier: p.supplier?.name || '—', status: p.status,
      items: p.items.map(i => ({ name: i.name, quantity: i.quantity, unitCost: i.unitCost, total: i.total, returnedQty: i.returnedQty })),
      subtotal: p.subtotal, discount: p.discount, tax: p.tax,
      total: p.total, paid: p.paid, due: p.dueAmount, currency: cur,
      barcodeSvg: jsbarcodeSvg(p.invoiceNo, { height: 44 }),
    }))
  }

  /** Universal scan pipeline: dedup → lookup → instant on-screen invoice. */
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
        say(t('pur.scanFound', { no }), 'ok')
      } else {
        beepErr()
        say(t('pur.scanNoMatch', { no: code }), 'err')
      }
    } catch (e) {
      beepErr()
      say(errMsg(e), 'err')
    }
  }, [t])

  // hardware scanner capture anywhere on the page
  useScannerWedge(handleScan, !scanOpen && !detail && !formOpen)

  const submitReturn = async () => {
    if (!detail) return
    const rows = Object.entries(returnQty).map(([purchaseItemId, q]) => ({ purchaseItemId, quantity: parseFloat(q) || 0 })).filter(r => r.quantity > 0)
    if (rows.length === 0) { alert(t('pur.enterReturnQty')); return }
    try {
      await api(`/api/purchases/detail?id=${detail.id}`, { method: 'POST', body: { items: rows, reason: 'Purchase return' } })
      setDetail(null); setReturnQty({})
      load()
    } catch (e) { alert(errMsg(e)) }
  }

  const paySupplier = async () => {
    if (!detail) return
    try {
      await api('/api/purchases', { method: 'PUT', body: { purchaseId: detail.id, amount: parseFloat(payAmount) || 0 } })
      setDetail(null); setPayAmount('')
      load()
    } catch (e) { alert(errMsg(e)) }
  }

  const cols = [
    { key: 'invoiceNo', label: t('pur.invoiceNo'), width: 15 }, { key: 'date', label: t('common.date'), width: 16 },
    { key: 'supplier', label: t('pur.supplier'), width: 18 }, { key: 'total', label: `${t('common.total')} (${cur})`, width: 11 },
    { key: 'paid', label: `${t('common.paid')} (${cur})`, width: 11 }, { key: 'due', label: `${t('common.due')} (${cur})`, width: 11 }, { key: 'status', label: t('common.status'), width: 14 },
  ]
  const exportRows = (rows: Purchase[]) => rows.map(p => ({
    invoiceNo: p.invoiceNo, date: fmtDateTime(p.createdAt), supplier: p.supplier?.name || '', total: p.total, paid: p.paid, due: p.dueAmount, status: p.status,
  }))

  // Task 73 — export the WHOLE filtered purchase history (pages through the
  // API past the 100-row cap), not just the 20 rows on this page.
  const { exporting, savedFlash, run: runExportAll } = useExportAll()
  const exportPurchases = (kind: 'csv' | 'xlsx') => runExportAll(kind,
    () => fetchAllPages<Purchase>(`/api/purchases?search=${encodeURIComponent(debounced)}`) as unknown as Promise<Record<string, unknown>[]>,
    rows => {
      if (kind === 'csv') downloadCSV('purchases', cols, exportRows(rows as unknown as Purchase[]))
      else downloadExcel('purchases', 'Purchases', cols, exportRows(rows as unknown as Purchase[]))
    }, setError)

  const pages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title={t('nav.purchases')}
        subtitle={t('pur.subtitle')}
        actions={
          <>
            <Button variant="outline" size="sm" disabled={!!exporting} onClick={() => exportPurchases('csv')}>
              {exporting === 'csv' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {exporting === 'csv' ? t('common.exportPreparing') : savedFlash === 'csv' ? t('common.exportSaved') : 'CSV'}
            </Button>
            <Button variant="outline" size="sm" disabled={!!exporting} onClick={() => exportPurchases('xlsx')}>
              {exporting === 'xlsx' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {exporting === 'xlsx' ? t('common.exportPreparing') : savedFlash === 'xlsx' ? t('common.exportSaved') : 'Excel'}
            </Button>
            <Button size="sm" onClick={openForm}><Plus className="h-4 w-4" /> {t('pur.newPurchase')}</Button>
          </>
        }
      />
      <div className="flex flex-wrap items-end gap-2 mb-3">
        <div className="relative max-w-xs flex-1 min-w-40">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('pur.searchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && looksLikeInvoiceCode(search)) { e.preventDefault(); void handleScan(search) } }}
            className="pl-8 h-9"
          />
        </div>
        <Button variant="outline" size="sm" className="h-9" onClick={() => setScanOpen(true)} title={t('pur.scanTip')}>
          <ScanLine className="h-4 w-4" /> {t('pur.scanInvoice')}
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
      {offlineData ? (
        <div className="text-[11px] text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200 dark:border-amber-900 rounded px-2.5 py-1.5 mb-3">
          {t('pur.offlineBanner')}
        </div>
      ) : null}
      {notice ? (
        <div className="text-[11px] text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900 rounded px-2.5 py-1.5 mb-3">
          {notice}
        </div>
      ) : null}
      {loading ? <LoadingBlock /> : items.length === 0 ? <EmptyState message={t('pur.empty')} action={<Button size="sm" onClick={openForm}><Plus className="h-4 w-4" /> {t('pur.newPurchase')}</Button>} /> : (
        <>
        <MobileCardList>
          {items.map(p => (
            <MobileCard
              key={p.id}
              title={p.invoiceNo}
              subtitle={`${fmtDateTime(p.createdAt)} · ${p.supplier?.name || '—'}`}
              badge={<Badge variant="outline" className={p.status === 'PAID' ? 'text-emerald-600 border-emerald-300' : p.dueAmount > 0 ? 'text-amber-600 border-amber-300' : ''}>{p.status.replace('_', ' ')}</Badge>}
              meta={(
                <>
                  <MetaItem label={t('common.total')}>{fmtNum(p.total)}</MetaItem>
                  <MetaItem label={t('common.paid')}>{fmtNum(p.paid)}</MetaItem>
                  <MetaItem label={t('common.due')}><span className={p.dueAmount > 0 ? 'text-red-600 font-medium' : 'text-muted-foreground'}>{fmtNum(p.dueAmount)}</span></MetaItem>
                </>
              )}
              actions={(
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openDetail(p)}><Eye className="h-3.5 w-3.5" /> {t('pur.viewDetails')}</Button>
              )}
            />
          ))}
        </MobileCardList>
        <div className="hidden md:block rounded-lg border overflow-x-auto bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-secondary/50 text-left text-xs text-muted-foreground">
                <th className="p-2.5 font-medium">{t('pur.invoiceNo')}</th>
                <th className="p-2.5 font-medium">{t('common.date')}</th>
                <th className="p-2.5 font-medium">{t('pur.supplier')}</th>
                <th className="p-2.5 font-medium text-right">{t('common.total')}</th>
                <th className="p-2.5 font-medium text-right">{t('common.paid')}</th>
                <th className="p-2.5 font-medium text-right">{t('common.due')}</th>
                <th className="p-2.5 font-medium">{t('common.status')}</th>
                <th className="p-2.5 font-medium text-right">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map(p => (
                <tr key={p.id} className="border-b last:border-0 hover:bg-secondary/30">
                  <td className="p-2.5 font-medium">{p.invoiceNo}</td>
                  <td className="p-2.5 text-xs">{fmtDateTime(p.createdAt)}</td>
                  <td className="p-2.5">{p.supplier?.name || '—'}</td>
                  <td className="p-2.5 text-right font-medium">{fmtNum(p.total)}</td>
                  <td className="p-2.5 text-right">{fmtNum(p.paid)}</td>
                  <td className={`p-2.5 text-right ${p.dueAmount > 0 ? 'text-red-600 font-medium' : 'text-muted-foreground'}`}>{fmtNum(p.dueAmount)}</td>
                  <td className="p-2.5 text-xs">{p.status.replace('_', ' ')}</td>
                  <td className="p-2.5 text-right"><Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openDetail(p)}><Eye className="h-3.5 w-3.5" /></Button></td>
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
          <span className="text-muted-foreground">{t('common.pageOf', { a: page, b: pages })}</span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>{t('common.next')}</Button>
        </div>
      ) : null}

      {/* New purchase dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Truck className="h-4 w-4" /> {t('pur.newPurchase')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t('pur.supplier')}</Label>
              <Select value={supplierId || 'none'} onValueChange={v => setSupplierId(v === 'none' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder={t('pur.walkInPurchase')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('pur.noSupplier')}</SelectItem>
                  {suppliers.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              {lines.map((l, idx) => (
                <div key={idx} className="grid grid-cols-[1fr_70px_90px_32px] gap-2 items-center">
                  <Select value={l.productId} onValueChange={v => {
                    const p = products.find(x => x.id === v)
                    const next = [...lines]
                    next[idx] = { ...l, productId: v, unitCost: l.unitCost || String(p?.costPrice ?? '') }
                    setLines(next)
                  }}>
                    <SelectTrigger className="h-9"><SelectValue placeholder={t('pur.selectProduct')} /></SelectTrigger>
                    <SelectContent>
                      {products.map(p => <SelectItem key={p.id} value={p.id}>{p.name} ({t('pur.stockLabel', { n: p.stock })})</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input type="number" min={0.01} className="h-9" placeholder={t('common.qty')} value={l.quantity}
                    onChange={e => { const n = [...lines]; n[idx] = { ...l, quantity: e.target.value }; setLines(n) }} />
                  <Input type="number" min={0} className="h-9" placeholder={t('pur.cost')} value={l.unitCost}
                    onChange={e => { const n = [...lines]; n[idx] = { ...l, unitCost: e.target.value }; setLines(n) }} />
                  <Button variant="ghost" size="icon" className="h-9" onClick={() => setLines(lines.filter((_, i) => i !== idx))}>×</Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setLines([...lines, { productId: '', quantity: '1', unitCost: '' }])}><Plus className="h-3.5 w-3.5" /> {t('pur.addLine')}</Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t('pur.paidNow', { cur })}</Label>
                <Input type="number" min={0} value={paid} onChange={e => setPaid(e.target.value)} placeholder={t('pur.creditHint')} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('pur.note')}</Label>
                <Input value={note} onChange={e => setNote(e.target.value)} placeholder={t('pur.optional')} />
              </div>
            </div>
            <div className="flex items-center justify-between border-t pt-2 text-sm">
              <span className="text-muted-foreground">{t('pur.grandTotalNote')}</span>
              <b className="text-lg">{fmtMoney(grandTotal, cur)}</b>
            </div>
            <Button className="w-full" onClick={savePurchase} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {t('pur.saveAndReceive')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Detail dialog */}
      <Dialog open={!!detail} onOpenChange={v => !v && setDetail(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{detail?.invoiceNo}</DialogTitle></DialogHeader>
          {detail ? (
            <div className="space-y-3 text-sm">
              <div className="text-xs text-muted-foreground">
                {fmtDateTime(detail.createdAt)} · {t('pur.supplier')}: <b className="text-foreground">{detail.supplier?.name || '—'}</b> · {t('common.total')} {fmtMoney(detail.total, cur)} · {t('common.paid')} {fmtMoney(detail.paid, cur)} · {t('common.due')} <b className="text-red-600">{fmtMoney(detail.dueAmount, cur)}</b>
              </div>
              <table className="w-full text-xs">
                <thead><tr className="border-b text-left text-muted-foreground"><th className="py-1">{t('common.item')}</th><th className="py-1 text-right">{t('common.qty')}</th><th className="py-1 text-right">{t('pur.cost')}</th><th className="py-1 text-right">{t('pur.returned')}</th><th className="py-1 text-right">{t('common.return')}</th></tr></thead>
                <tbody>
                  {detail.items.map(i => {
                    const returnable = r2(i.quantity - (i.returnedQty || 0))
                    return (
                      <tr key={i.id} className="border-b last:border-0">
                        <td className="py-1.5">{i.name}</td>
                        <td className="py-1.5 text-right">{i.quantity}</td>
                        <td className="py-1.5 text-right">{fmtNum(i.unitCost)}</td>
                        <td className="py-1.5 text-right text-red-600">{i.returnedQty || 0}</td>
                        <td className="py-1.5 text-right">
                          {returnable > 0 ? (
                            <Input type="number" min={0} max={returnable} className="w-16 h-8 text-base md:text-xs" value={returnQty[i.id] || ''} onChange={e => setReturnQty({ ...returnQty, [i.id]: e.target.value })} />
                          ) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => printPurchase(detail)}><Printer className="h-4 w-4 mr-1" /> {t('pur.printA4')}</Button>
                <Button size="sm" variant="destructive" onClick={submitReturn} disabled={Object.keys(returnQty).length === 0}>{t('pur.returnItems')}</Button>
                {detail.dueAmount > 0 ? (
                  <div className="flex gap-1.5 ml-auto">
                    <Input type="number" min={0} max={detail.dueAmount} className="h-8 w-28 text-base md:text-xs" placeholder={t('pur.payUpTo', { n: detail.dueAmount })} value={payAmount} onChange={e => setPayAmount(e.target.value)} />
                    <Button size="sm" onClick={paySupplier} disabled={!(parseFloat(payAmount) > 0)}>{t('pur.paySupplier')}</Button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* scan-invoice camera + instant on-screen invoice (rendered last → stacks on top) */}
      <CameraScannerDialog
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onScan={code => void handleScan(code)}
        title={t('pur.scanDialogTitle')}
        hint={t('pur.scanDialogHint')}
      />
      <InvoiceViewDialog result={found} onClose={() => setFound(null)} />
    </div>
  )
}
