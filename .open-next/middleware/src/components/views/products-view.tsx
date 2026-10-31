'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuthStore } from '@/stores/auth'
import { useT } from '@/stores/lang'
import { api, errMsg, isNetworkError } from '@/lib/client'
import { uuid } from '@/lib/uid'
import { useOfflineStore } from '@/stores/offline'
import { fmtMoney, fmtNum, r2 } from '@/lib/format'
import { downloadCSV, downloadExcel, printHTML, barcodeLabelsHTML, LABEL_SIZES, type LabelSize } from '@/lib/export'
import { PageHeader, LoadingBlock, EmptyState, ErrorBanner, MobileCard, MobileCardList, MetaItem } from '@/components/shared/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { jsbarcodeSvg, generateEan13 } from '@/lib/barcode-client'
import { useExportAll } from '@/lib/use-export-all'
import {
  Plus, Search, Upload, Download, FileSpreadsheet, Printer, Pencil, Archive, QrCode, Loader2,
} from 'lucide-react'

interface Product {
  id: string; name: string; sku: string; barcode: string
  categoryId: string | null; category?: { id: string; name: string } | null
  brandId: string | null; unitId: string | null; supplierId: string | null
  costPrice: number; retailPrice: number; wholesalePrice: number; minPrice: number
  taxRate: number; stock: number; openingStock: number; minStock: number
  expiryDate: string | null; description: string; isActive: boolean; image: string
  unit?: { id: string; name: string; shortName: string } | null
}
interface Cat { id: string; name: string }
interface Unit { id: string; name: string; shortName: string }
interface Supplier { id: string; name: string }

const EMPTY = {
  name: '', sku: '', barcode: '', categoryId: '', unitId: '', supplierId: '',
  costPrice: '', retailPrice: '', wholesalePrice: '', minPrice: '',
  taxRate: '0', minStock: '0', openingStock: '0', expiryDate: '', description: '', isActive: true,
}

export default function ProductsView() {
  const t = useT()
  const { business } = useAuthStore()
  const cur = business?.currency || 'PKR'
  const [items, setItems] = useState<Product[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Task 67-b — "saved on this device, will sync" notice after an offline product save.
  const [notice, setNotice] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState<typeof EMPTY>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [cats, setCats] = useState<Cat[]>([])
  const [units, setUnits] = useState<Unit[]>([])
  const [sups, setSups] = useState<Supplier[]>([])
  const [labelProduct, setLabelProduct] = useState<Product | null>(null)
  const [labelCopies, setLabelCopies] = useState(3)
  const [labelPrinting, setLabelPrinting] = useState(false)
  const [allLabelsOpen, setAllLabelsOpen] = useState(false)
  const [allList, setAllList] = useState<Product[]>([])
  const [allLoading, setAllLoading] = useState(false)
  const [allCopies, setAllCopies] = useState(1)
  const [allPrinting, setAllPrinting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const pageSize = 20

  // Label stock choice persists across sessions — a shop usually keeps one roll size.
  const [labelSize, setLabelSize] = useState<LabelSize>(() => {
    try {
      const v = localStorage.getItem('labelSize') as LabelSize | null
      return v && LABEL_SIZES.some(s => s.key === v) ? v : 'standard'
    } catch { return 'standard' }
  })
  useEffect(() => { try { localStorage.setItem('labelSize', labelSize) } catch { /* private mode */ } }, [labelSize])

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setPage(1) }, 300)
    return () => clearTimeout(t)
  }, [search])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [data, c, u, s] = await Promise.all([
        api<{ items: Product[]; total: number }>(`/api/products?search=${encodeURIComponent(debounced)}&status=all&page=${page}&pageSize=${pageSize}`),
        api<Cat[]>('/api/master/categories'),
        api<Unit[]>('/api/master/units'),
        api<Supplier[]>('/api/suppliers'),
      ])
      setItems(data.items); setTotal(data.total); setCats(c); setUnits(u); setSups(s)
    } catch (e) { setError(errMsg(e)) } finally { setLoading(false) }
  }, [debounced, page])

  useEffect(() => { load() }, [load])

  const openNew = () => { setEditing(null); setForm(EMPTY); setFormOpen(true) }
  const openEdit = (p: Product) => {
    setEditing(p)
    setForm({
      name: p.name, sku: p.sku, barcode: p.barcode,
      categoryId: p.categoryId || '', unitId: p.unitId || '', supplierId: p.supplierId || '',
      costPrice: String(p.costPrice), retailPrice: String(p.retailPrice),
      wholesalePrice: String(p.wholesalePrice), minPrice: String(p.minPrice),
      taxRate: String(p.taxRate), minStock: String(p.minStock), openingStock: String(p.stock),
      expiryDate: p.expiryDate ? p.expiryDate.slice(0, 10) : '',
      description: p.description, isActive: p.isActive,
    })
    setFormOpen(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      // Task 67-b — the device supplies the product id for creates so a queued
      // offline save syncs idempotently (upsert by id — a retried push can
      // never duplicate the product).
      const body: Record<string, unknown> & { id?: string } = {
        ...form,
        costPrice: parseFloat(form.costPrice) || 0,
        retailPrice: parseFloat(form.retailPrice) || 0,
        wholesalePrice: parseFloat(form.wholesalePrice) || 0,
        minPrice: parseFloat(form.minPrice) || 0,
        taxRate: parseFloat(form.taxRate) || 0,
        minStock: parseFloat(form.minStock) || 0,
        openingStock: parseFloat(form.openingStock) || 0,
        categoryId: form.categoryId || null,
        unitId: form.unitId || null,
        supplierId: form.supplierId || null,
        expiryDate: form.expiryDate || null,
      }

      /** Offline / unreachable-server path: queue the PRODUCT op on the device.
       *  Before this, a product save made while the server was unreachable was
       *  lost forever (the error message even claimed it was "saved on this
       *  device" — the exact "product data not saving" report of Oct 7). */
      const queueOffline = (mode: 'create' | 'edit') => {
        const productId = mode === 'edit' ? String(editing!.id) : uuid()
        if (mode === 'create') body.id = productId
        const payload = { ...body, mode, id: productId, deviceTs: new Date().toISOString() }
        useOfflineStore.getState().enqueue({
          clientRef: `product-${mode}-${productId}`,
          kind: 'PRODUCT',
          payload,
          createdAt: Date.now(),
          attempts: 0,
        })
        // Optimistic local update so the screen stays truthful until the next
        // server refresh (POS sells the new product from its cache as well).
        if (mode === 'create') {
          const p: Product = {
            id: productId, name: String(body.name || ''), sku: String(body.sku || ''),
            barcode: String(body.barcode || ''), categoryId: (body.categoryId as string) || null,
            brandId: (body.brandId as string) || null, unitId: (body.unitId as string) || null,
            supplierId: (body.supplierId as string) || null,
            costPrice: Number(body.costPrice), retailPrice: Number(body.retailPrice),
            wholesalePrice: Number(body.wholesalePrice), minPrice: Number(body.minPrice),
            taxRate: Number(body.taxRate), stock: Number(body.openingStock),
            openingStock: Number(body.openingStock), minStock: Number(body.minStock),
            expiryDate: (body.expiryDate as string) || null, description: String(body.description || ''),
            isActive: body.isActive !== false, image: '',
          }
          setItems(prev => [p, ...prev])
          setTotal(n => n + 1)
          try {
            const key = `pos_cache_${business?.id || 'x'}_products`
            const raw = localStorage.getItem(key)
            if (raw) localStorage.setItem(key, JSON.stringify([p, ...JSON.parse(raw)]))
          } catch { /* quota */ }
        } else if (editing) {
          setItems(prev => prev.map(p => p.id === editing.id ? {
            ...p,
            name: String(body.name ?? p.name), sku: String(body.sku ?? p.sku),
            barcode: String(body.barcode ?? p.barcode),
            costPrice: Number(body.costPrice), retailPrice: Number(body.retailPrice),
            wholesalePrice: Number(body.wholesalePrice), minPrice: Number(body.minPrice),
            taxRate: Number(body.taxRate), minStock: Number(body.minStock),
            categoryId: (body.categoryId as string) || null,
            unitId: (body.unitId as string) || null,
            supplierId: (body.supplierId as string) || null,
            expiryDate: (body.expiryDate as string) || null,
            description: String(body.description ?? p.description),
            isActive: body.isActive !== false,
          } : p))
        }
        setFormOpen(false)
        setNotice(t('prod.queuedOffline', { n: useOfflineStore.getState().queue.length }))
      }

      if (editing) {
        if (!navigator.onLine) { queueOffline('edit'); return }
        try {
          await api(`/api/products?id=${editing.id}`, { method: 'PUT', body })
        } catch (e) {
          if (isNetworkError(e)) { queueOffline('edit'); return }
          throw e
        }
      } else {
        if (!navigator.onLine) { queueOffline('create'); return }
        try {
          await api('/api/products', { method: 'POST', body })
        } catch (e) {
          if (isNetworkError(e)) { queueOffline('create'); return }
          throw e
        }
      }
      setFormOpen(false)
      load()
    } catch (e) { alert(errMsg(e)) } finally { setSaving(false) }
  }

  const archive = async (p: Product) => {
    if (!confirm(t('prod.archiveConfirm', { name: p.name }))) return
    try { await api(`/api/products?id=${p.id}`, { method: 'DELETE' }); load() } catch (e) { alert(errMsg(e)) }
  }

  const printLabels = async (p: Product, copies: number, size: LabelSize) => {
    const svg = jsbarcodeSvg(p.barcode)
    // printHTML resolves when the print frame is cleaned up (native dialog closed on
    // blocking engines) — the dialog awaits this and always closes itself afterwards.
    await printHTML(`Labels ${p.sku}`, barcodeLabelsHTML(
      { name: business?.name || '', address: business?.address || '', phone: business?.phone || '', logo: business?.logo || '', footer: '' },
      [{ name: p.name, price: p.retailPrice, barcode: p.barcode, sku: p.sku }],
      () => svg, copies, cur, size,
    ))
  }

  const openAllLabels = async () => {
    setAllLabelsOpen(true)
    setAllLoading(true)
    try {
      // "All" means the WHOLE catalog, not just the visible page — fetch every active
      // product; fall back to the loaded page when the fetch fails (offline).
      let list: Product[] = []
      try {
        const data = await api<{ items: Product[] }>('/api/products?all=1&status=active')
        list = Array.isArray(data?.items) ? data.items : []
      } catch { list = [] }
      if (list.length === 0) list = items.filter(p => p.isActive)
      setAllList(list)
    } finally { setAllLoading(false) }
  }

  const printAllLabels = async () => {
    if (allPrinting) return
    setAllPrinting(true)
    try {
      const list = allList.length ? allList : items.filter(p => p.isActive)
      if (list.length === 0) { alert(t('prod.noActiveLabels')); return }
      const biz = { name: business?.name || '', address: '', phone: '', logo: business?.logo || '', footer: '' }
      await printHTML('All labels', barcodeLabelsHTML(
        biz,
        list.map(p => ({ name: p.name, price: p.retailPrice, barcode: p.barcode, sku: p.sku })),
        (code) => jsbarcodeSvg(code), allCopies, cur, labelSize,
      ))
      setAllLabelsOpen(false)
    } catch (e) { alert(errMsg(e)) } finally { setAllPrinting(false) }
  }

  const exportRows = (rows: Product[]) => rows.map(p => ({
    name: p.name, sku: p.sku, barcode: p.barcode, category: p.category?.name || '',
    costPrice: p.costPrice, retailPrice: p.retailPrice, wholesalePrice: p.wholesalePrice,
    stock: p.stock, minStock: p.minStock, taxRate: p.taxRate, active: p.isActive,
  }))

  // Task 73 — export the WHOLE catalog under the current search (all=1 lifts
  // the 100-row API cap to 5000), not just the 20 rows on this page.
  const { exporting, savedFlash, run: runExportAll } = useExportAll()
  const exportProducts = (kind: 'csv' | 'xlsx') => runExportAll(kind, async () => {
    const d = await api<{ items: Product[] }>(`/api/products?all=1&status=all&search=${encodeURIComponent(debounced)}`)
    return (d.items || []) as unknown as Record<string, unknown>[]
  }, rows => {
    if (kind === 'csv') downloadCSV('products', cols, exportRows(rows as unknown as Product[]))
    else downloadExcel('products', 'Products', cols, exportRows(rows as unknown as Product[]))
  }, setError)
  const cols = [
    { key: 'name', label: t('prod.col.name'), width: 26 }, { key: 'sku', label: t('prod.col.sku'), width: 14 },
    { key: 'barcode', label: t('prod.col.barcode'), width: 16 }, { key: 'category', label: t('prod.col.category'), width: 14 },
    { key: 'costPrice', label: `${t('prod.cost')} (${cur})`, width: 12 }, { key: 'retailPrice', label: `${t('prod.retail')} (${cur})`, width: 12 },
    { key: 'wholesalePrice', label: `${t('prod.wholesale')} (${cur})`, width: 12 }, { key: 'stock', label: t('prod.stock'), width: 9 },
    { key: 'minStock', label: t('prod.minStockLevel'), width: 10 }, { key: 'taxRate', label: t('prod.taxRate'), width: 8 },
    { key: 'active', label: t('prod.active'), width: 8 },
  ]

  // CSV import: name,costPrice,retailPrice,stock[,barcode,sku,category]
  const importCSV = async (file: File) => {
    const text = await file.text()
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
    if (lines.length < 2) { alert(t('prod.csvNeedRows')); return }
    const header = lines[0].split(',').map(h => h.trim().toLowerCase())
    const idx = (k: string) => header.indexOf(k)
    let okCount = 0
    for (const line of lines.slice(1)) {
      const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map(s => s.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')) || []
      if (!cells[idx('name')]) continue
      try {
        await api('/api/products', {
          method: 'POST',
          body: {
            name: cells[idx('name')],
            barcode: cells[idx('barcode')] || '',
            sku: cells[idx('sku')] || '',
            costPrice: parseFloat(cells[idx('costprice')] || '0') || 0,
            retailPrice: parseFloat(cells[idx('retailprice')] || '0') || 0,
            openingStock: parseFloat(cells[idx('stock')] || '0') || 0,
          },
        })
        okCount++
      } catch { /* skip bad rows */ }
    }
    alert(t('prod.imported', { n: okCount }))
    load()
  }

  const pages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title={t('nav.products')}
        subtitle={t('prod.subtitle', { n: total })}
        actions={
          <>
            <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) importCSV(f); e.target.value = '' }} />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" /> {t('prod.importCsv')}</Button>
            <Button variant="outline" size="sm" disabled={!!exporting} onClick={() => exportProducts('csv')}>
              {exporting === 'csv' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {exporting === 'csv' ? t('common.exportPreparing') : savedFlash === 'csv' ? t('common.exportSaved') : 'CSV'}
            </Button>
            <Button variant="outline" size="sm" disabled={!!exporting} onClick={() => exportProducts('xlsx')}>
              {exporting === 'xlsx' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
              {exporting === 'xlsx' ? t('common.exportPreparing') : savedFlash === 'xlsx' ? t('common.exportSaved') : 'Excel'}
            </Button>
            <Button variant="outline" size="sm" onClick={openAllLabels}><QrCode className="h-4 w-4" /> {t('prod.allLabels')}</Button>
            <Button size="sm" onClick={openNew}><Plus className="h-4 w-4" /> {t('prod.add')}</Button>
          </>
        }
      />
      <div className="flex items-center gap-2 mb-3 max-w-md">
        <Search className="h-4 w-4 text-muted-foreground" />
        <Input placeholder={t('prod.search')} value={search} onChange={e => setSearch(e.target.value)} className="h-9" />
      </div>
      {error ? <ErrorBanner message={error} onRetry={load} /> : null}
      {notice ? (
        <div data-testid="product-queued-notice" className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <span>{notice}</span>
          <button className="text-amber-700 hover:text-amber-900 font-medium" onClick={() => setNotice('')}>×</button>
        </div>
      ) : null}
      {loading ? <LoadingBlock /> : items.length === 0 ? (
        <EmptyState message={t('prod.empty')} action={<Button size="sm" onClick={openNew}><Plus className="h-4 w-4" /> {t('prod.add')}</Button>} />
      ) : (
        <>
        <MobileCardList>
          {items.map(p => (
            <MobileCard
              key={p.id}
              title={p.name}
              subtitle={p.barcode ? `${p.sku} · ${p.barcode}` : p.sku}
              badge={p.isActive ? <Badge variant="outline" className="text-emerald-600 border-emerald-300">{t('prod.active')}</Badge> : <Badge variant="secondary">{t('prod.archived')}</Badge>}
              meta={(
                <>
                  <MetaItem label={t('prod.cost')}>{fmtNum(p.costPrice)}</MetaItem>
                  <MetaItem label={t('prod.retail')}>{fmtNum(p.retailPrice)}</MetaItem>
                  <MetaItem label={t('prod.stock')}><span className={p.stock <= p.minStock ? 'text-amber-600' : ''}>{fmtNum(p.stock)}</span></MetaItem>
                  <MetaItem label={t('prod.value')}>{fmtMoney(r2(p.stock * p.costPrice), cur)}</MetaItem>
                </>
              )}
              actions={(
                <>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { setLabelProduct(p); setLabelCopies(3) }}><QrCode className="h-3.5 w-3.5" /> {t('prod.labels')}</Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openEdit(p)}><Pencil className="h-3.5 w-3.5" /> {t('common.edit')}</Button>
                  {p.isActive ? <Button variant="outline" size="sm" className="h-7 text-xs text-red-600 border-red-300" onClick={() => archive(p)}><Archive className="h-3.5 w-3.5" /> {t('prod.archive')}</Button> : null}
                </>
              )}
            />
          ))}
        </MobileCardList>
        <div className="hidden md:block rounded-lg border overflow-x-auto bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-secondary/50 text-left text-xs text-muted-foreground">
                <th className="p-2.5 font-medium">{t('prod.col.product')}</th>
                <th className="p-2.5 font-medium hidden md:table-cell">{t('prod.col.barcode')}</th>
                <th className="p-2.5 font-medium hidden lg:table-cell">{t('prod.col.category')}</th>
                <th className="p-2.5 font-medium text-right">{t('prod.cost')}</th>
                <th className="p-2.5 font-medium text-right">{t('prod.retail')}</th>
                <th className="p-2.5 font-medium text-right">{t('prod.stock')}</th>
                <th className="p-2.5 font-medium text-right">{t('prod.value')}</th>
                <th className="p-2.5 font-medium">{t('prod.status')}</th>
                <th className="p-2.5 font-medium text-right">{t('prod.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map(p => (
                <tr key={p.id} className="border-b last:border-0 hover:bg-secondary/30">
                  <td className="p-2.5">
                    <div className="font-medium">{p.name}</div>
                    <div className="text-[11px] text-muted-foreground">{p.sku}</div>
                  </td>
                  <td className="p-2.5 hidden md:table-cell font-mono text-xs">{p.barcode}</td>
                  <td className="p-2.5 hidden lg:table-cell">{p.category?.name || '—'}</td>
                  <td className="p-2.5 text-right">{fmtNum(p.costPrice)}</td>
                  <td className="p-2.5 text-right font-medium">{fmtNum(p.retailPrice)}</td>
                  <td className={`p-2.5 text-right font-medium ${p.stock <= p.minStock ? 'text-amber-600' : ''}`}>{fmtNum(p.stock)}</td>
                  <td className="p-2.5 text-right text-muted-foreground">{fmtMoney(r2(p.stock * p.costPrice), cur)}</td>
                  <td className="p-2.5">
                    {p.isActive ? <Badge variant="outline" className="text-emerald-600 border-emerald-300">{t('prod.active')}</Badge> : <Badge variant="secondary">{t('prod.archived')}</Badge>}
                  </td>
                  <td className="p-2.5">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" title={t('prod.printLabels')} onClick={() => { setLabelProduct(p); setLabelCopies(3) }}><QrCode className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" title={t('common.edit')} onClick={() => openEdit(p)}><Pencil className="h-3.5 w-3.5" /></Button>
                      {p.isActive ? <Button variant="ghost" size="icon" className="h-7 w-7" title={t('prod.archive')} onClick={() => archive(p)}><Archive className="h-3.5 w-3.5" /></Button> : null}
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
          <span className="text-muted-foreground">{t('common.pageOf', { a: page, b: pages })}</span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>{t('common.next')}</Button>
        </div>
      ) : null}

      {/* Product form */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? t('common.editTitle', { name: editing.name }) : t('prod.add')}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t('prod.name')}</Label>
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder={t('prod.namePh')} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('prod.col.barcode')}</Label>
              <div className="flex gap-1.5">
                <Input value={form.barcode} onChange={e => setForm({ ...form, barcode: e.target.value })} placeholder={t('prod.autoIfEmpty')} className="font-mono" />
                <Button type="button" variant="outline" size="sm" className="shrink-0" title={t('prod.autoTitle')}
                  onClick={() => setForm({ ...form, barcode: generateEan13() })}
                >{t('prod.auto')}</Button>
              </div>
              <p className="text-[10px] text-muted-foreground">{t('prod.autoHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t('prod.col.sku')}</Label>
              <Input value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} placeholder={t('prod.autoIfEmpty')} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('prod.col.category')}</Label>
              <Select value={form.categoryId || 'none'} onValueChange={v => setForm({ ...form, categoryId: v === 'none' ? '' : v })}>
                <SelectTrigger><SelectValue placeholder={t('common.select')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">—</SelectItem>
                  {cats.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('prod.unit')}</Label>
              <Select value={form.unitId || 'none'} onValueChange={v => setForm({ ...form, unitId: v === 'none' ? '' : v })}>
                <SelectTrigger><SelectValue placeholder={t('common.select')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">—</SelectItem>
                  {units.map(u => <SelectItem key={u.id} value={u.id}>{u.name} ({u.shortName})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('prod.defaultSupplier')}</Label>
              <Select value={form.supplierId || 'none'} onValueChange={v => setForm({ ...form, supplierId: v === 'none' ? '' : v })}>
                <SelectTrigger><SelectValue placeholder={t('common.select')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">—</SelectItem>
                  {sups.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('prod.expiry')}</Label>
              <Input type="date" value={form.expiryDate} onChange={e => setForm({ ...form, expiryDate: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t('prod.purchasePrice')}</Label>
                <Input type="number" min={0} value={form.costPrice} onChange={e => setForm({ ...form, costPrice: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('prod.retailPrice')}</Label>
                <Input type="number" min={0} value={form.retailPrice} onChange={e => setForm({ ...form, retailPrice: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('prod.wholesalePrice')}</Label>
                <Input type="number" min={0} value={form.wholesalePrice} onChange={e => setForm({ ...form, wholesalePrice: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('prod.minPrice')}</Label>
                <Input type="number" min={0} value={form.minPrice} onChange={e => setForm({ ...form, minPrice: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>{editing ? t('prod.currentStock') : t('prod.openingStock')}</Label>
                <Input type="number" value={form.openingStock} onChange={e => setForm({ ...form, openingStock: e.target.value })} disabled={!!editing} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('prod.minStockLevel')}</Label>
                <Input type="number" min={0} value={form.minStock} onChange={e => setForm({ ...form, minStock: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('prod.taxRate')}</Label>
                <Input type="number" min={0} value={form.taxRate} onChange={e => setForm({ ...form, taxRate: e.target.value })} />
              </div>
              <div className="space-y-1.5 flex flex-col justify-end">
                <Label className="flex items-center justify-between">{t('prod.active')} <Switch checked={form.isActive} onCheckedChange={v => setForm({ ...form, isActive: v })} /></Label>
              </div>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t('prod.description')}</Label>
              <Input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder={t('prod.notesPh')} />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setFormOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={save} disabled={saving || !form.name}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {editing ? t('common.saveChanges') : t('prod.add')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Label print dialog */}
      <Dialog open={!!labelProduct} onOpenChange={v => !v && setLabelProduct(null)}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader><DialogTitle>{t('prod.printBarcodeLabels')}</DialogTitle></DialogHeader>
          {labelProduct ? (
            <div className="space-y-3">
              <div className="border rounded-lg p-2 text-center" dangerouslySetInnerHTML={{ __html: jsbarcodeSvg(labelProduct.barcode) }} />
              <div className="text-xs text-muted-foreground text-center">{labelProduct.name} · {labelProduct.barcode}</div>
              <div className="space-y-1.5">
                <Label>{t('prod.labelSize')}</Label>
                <Select value={labelSize} onValueChange={v => setLabelSize(v as LabelSize)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LABEL_SIZES.map(s => <SelectItem key={s.key} value={s.key}>{s.name} · {s.dims}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t('prod.copies')}</Label>
                <Input type="number" min={1} max={100} value={labelCopies} onChange={e => setLabelCopies(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))} />
              </div>
              <Button className="w-full" disabled={labelPrinting} onClick={async () => {
                if (!labelProduct) return
                setLabelPrinting(true)
                try {
                  await printLabels(labelProduct, labelCopies, labelSize)
                } catch (e) { alert(errMsg(e)) } finally {
                  // Resolves when the print dialog has closed (or hand-off failed) —
                  // the app dialog can NEVER get stuck open or leave a dangling job.
                  setLabelPrinting(false)
                  setLabelProduct(null)
                }
              }}>
                {labelPrinting
                  ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> {t('prod.printing')}</>
                  : <><Printer className="h-4 w-4 mr-1" /> {labelCopies > 1 ? t('prod.printNMany', { n: labelCopies }) : t('prod.printNOne', { n: labelCopies })}</>}
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* All labels dialog — whole active catalog, chosen size & copies */}
      <Dialog open={allLabelsOpen} onOpenChange={v => { if (!allPrinting) setAllLabelsOpen(v) }}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader><DialogTitle>{t('prod.printAll')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              {allLoading ? t('prod.counting') : (allList.length === 1 ? t('prod.selectedOne', { n: allList.length }) : t('prod.selectedMany', { n: allList.length }))}
            </div>
            <div className="space-y-1.5">
              <Label>{t('prod.labelSize')}</Label>
              <Select value={labelSize} onValueChange={v => setLabelSize(v as LabelSize)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LABEL_SIZES.map(s => <SelectItem key={s.key} value={s.key}>{s.name} · {s.dims}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('prod.copiesPer')}</Label>
              <Input type="number" min={1} max={50} value={allCopies} onChange={e => setAllCopies(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))} />
            </div>
            <Button className="w-full" disabled={allPrinting || allLoading || allList.length === 0} onClick={printAllLabels}>
              {allPrinting
                ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> {t('prod.printing')}</>
                : <><Printer className="h-4 w-4 mr-1" /> {allList.length * allCopies === 1 ? t('prod.printNOne', { n: allList.length * allCopies }) : t('prod.printNMany', { n: allList.length * allCopies })}</>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
