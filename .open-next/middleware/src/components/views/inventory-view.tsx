'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuthStore } from '@/stores/auth'
import { useT } from '@/stores/lang'
import { useOfflineStore, applyLocalStockDelta } from '@/stores/offline'
import { api, errMsg, isNetworkError } from '@/lib/client'
import { fmtMoney, fmtNum, fmtDateTime, r2 } from '@/lib/format'
import { uuid } from '@/lib/uid'
import { downloadCSV, downloadExcel } from '@/lib/export'
import { PageHeader, LoadingBlock, ErrorBanner, StatCard } from '@/components/shared/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AlertTriangle, Boxes, PackageMinus, PackagePlus, Warehouse } from 'lucide-react'

interface Product { id: string; name: string; sku: string; stock: number; minStock: number; costPrice: number; retailPrice: number; category?: { name: string } | null }
interface Txn { id: string; type: string; quantity: number; stockBefore: number; stockAfter: number; note: string; createdAt: string; refNo: string; product: { name: string; sku: string } }

const TYPE_KEYS: Record<string, string> = {
  OPENING: 'inv.typeOpening', PURCHASE: 'inv.typePurchase', SALE: 'inv.typeSale', ADJUST_IN: 'inv.typeAdjustIn', ADJUST_OUT: 'inv.typeAdjustOut',
  DAMAGE: 'inv.typeDamage', RETURN_IN: 'inv.typeReturnIn', RETURN_OUT: 'inv.typeReturnOut',
}

export default function InventoryView() {
  const t = useT()
  const { business } = useAuthStore()
  const cur = business?.currency || 'PKR'
  const [products, setProducts] = useState<Product[]>([])
  const [txns, setTxns] = useState<Txn[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lowOnly, setLowOnly] = useState(false)
  const [adjOpen, setAdjOpen] = useState(false)
  const [adj, setAdj] = useState({ productId: '', type: 'ADJUST_IN', quantity: '', note: '' })
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
      const [p, tx] = await Promise.all([
        api<{ items: Product[] }>('/api/products?all=1&status=active'),
        api<{ items: Txn[] }>('/api/inventory?pageSize=50'),
      ])
      // Same flat shape POS caches (unit: string) — both views share this key.
      const flatP = p.items.map(x => ({ ...x, unit: (x as unknown as { unit?: { shortName?: string } }).unit?.shortName || '' }))
      setProducts(Array.isArray(flatP) ? flatP : [])
      setTxns(Array.isArray(tx?.items) ? tx.items : [])
      setOfflineData(false)
      try {
        localStorage.setItem(cacheKey('products'), JSON.stringify(flatP))
        localStorage.setItem(cacheKey('invtxns'), JSON.stringify(tx.items))
      } catch { /* quota */ }
    } catch {
      // Offline — work from the last cached catalog/history.
      try {
        const p = JSON.parse(localStorage.getItem(cacheKey('products')) || '[]')
        const t = JSON.parse(localStorage.getItem(cacheKey('invtxns')) || '[]')
        setProducts(Array.isArray(p) ? p : [])
        setTxns(Array.isArray(t) ? t : [])
        setOfflineData(true)
        setError('')
      } catch { setError(t('inv.notCached')) }
    } finally { setLoading(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bizId, t])

  useEffect(() => { load() }, [load])

  // defensive: never let a non-array payload crash the render
  const safeTxns = Array.isArray(txns) ? txns : []
  const safeProducts = Array.isArray(products) ? products : []
  const shown = lowOnly ? safeProducts.filter(p => p.stock <= p.minStock) : safeProducts
  const stockValue = r2(safeProducts.reduce((s, p) => s + p.stock * p.costPrice, 0))
  const lowCount = safeProducts.filter(p => p.stock <= p.minStock).length
  const outCount = safeProducts.filter(p => p.stock <= 0).length

  const saveAdj = async () => {
    const qty = parseFloat(adj.quantity) || 0
    const body = { productId: adj.productId, type: adj.type, quantity: qty, note: adj.note }
    const prod = safeProducts.find(p => p.id === adj.productId)
    const delta = adj.type === 'ADJUST_OUT' || adj.type === 'DAMAGE' ? -qty : qty

    /** Optimistic local bookkeeping so offline screens stay truthful. */
    const applyLocal = () => {
      setProducts(ps => ps.map(p => p.id === adj.productId ? { ...p, stock: Math.max(0, Math.round((p.stock + delta) * 100) / 100) } : p))
      setTxns(ts => [{
        id: `local-${Date.now()}`, type: adj.type, quantity: delta,
        stockBefore: prod?.stock ?? 0, stockAfter: Math.max(0, (prod?.stock ?? 0) + delta),
        note: adj.note ? `${adj.note} ${t('inv.savedOnDevice')}` : t('inv.pendingSyncNote'),
        createdAt: new Date().toISOString(), refNo: '', product: { name: prod?.name || '', sku: prod?.sku || '' },
      }, ...ts])
      applyLocalStockDelta(bizId, adj.productId, delta)
    }

    // Offline → queue the adjustment on device; it syncs with the next connection.
    if (!navigator.onLine) {
      const clientRef = uuid()
      useOfflineStore.getState().enqueue({
        clientRef, kind: 'STOCK_ADJUSTMENT',
        payload: { ...body, clientRef, deviceTs: new Date().toISOString() },
      })
      applyLocal()
      setAdjOpen(false)
      setAdj({ productId: '', type: 'ADJUST_IN', quantity: '', note: '' })
      flashNotice(t('inv.queuedOffline', { n: useOfflineStore.getState().queue.length }))
      return
    }
    try {
      await api('/api/inventory', { method: 'POST', body })
      setAdjOpen(false)
      setAdj({ productId: '', type: 'ADJUST_IN', quantity: '', note: '' })
      load()
    } catch (e) {
      // Task 67-b — robust reachability check (was an English-string regex).
      if (isNetworkError(e)) {
        const clientRef = uuid()
        useOfflineStore.getState().enqueue({
          clientRef, kind: 'STOCK_ADJUSTMENT',
          payload: { ...body, clientRef, deviceTs: new Date().toISOString() },
        })
        applyLocal()
        setAdjOpen(false)
        setAdj({ productId: '', type: 'ADJUST_IN', quantity: '', note: '' })
        flashNotice(t('inv.queuedOffline', { n: useOfflineStore.getState().queue.length }))
      } else {
        alert(errMsg(e))
      }
    }
  }

  const cols = [
    { key: 'date', label: t('common.date'), width: 16 }, { key: 'type', label: t('inv.type'), width: 12 },
    { key: 'product', label: t('inv.product'), width: 24 }, { key: 'qty', label: t('common.qty'), width: 8 },
    { key: 'before', label: t('inv.before'), width: 9 }, { key: 'after', label: t('inv.after'), width: 9 },
    { key: 'refNo', label: t('inv.reference'), width: 14 },
  ]

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title={t('nav.inventory')}
        subtitle={t('inv.subtitle')}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => downloadCSV('inventory-stock', [
              { key: 'name', label: t('inv.product') }, { key: 'sku', label: 'SKU' }, { key: 'stock', label: t('inv.stock') },
              { key: 'minStock', label: t('inv.min') }, { key: 'costPrice', label: t('inv.costCur', { cur }) }, { key: 'value', label: t('inv.valueCur', { cur }) },
            ], shown.map(p => ({ ...p, value: r2(p.stock * p.costPrice) })))}>CSV</Button>
            <Button variant="outline" size="sm" onClick={() => downloadExcel('inventory-stock', t('inv.stock'), cols.filter(c => ['product', 'qty'].includes(c.key) === false), shown.map(p => ({ ...p, value: r2(p.stock * p.costPrice) })))}>Excel</Button>
            <Button size="sm" onClick={() => setAdjOpen(true)}><PackagePlus className="h-4 w-4" /> {t('inv.stockAdjustment')}</Button>
          </>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard title={t('inv.stockValue')} value={fmtMoney(stockValue, cur)} icon={<Warehouse className="h-3.5 w-3.5" />} />
        <StatCard title={t('nav.products')} value={String(safeProducts.length)} icon={<Boxes className="h-3.5 w-3.5" />} />
        <StatCard title={t('inv.lowStock')} value={String(lowCount)} icon={<AlertTriangle className="h-3.5 w-3.5" />} tone={lowCount ? 'warn' : undefined} />
        <StatCard title={t('inv.outOfStock')} value={String(outCount)} icon={<PackageMinus className="h-3.5 w-3.5" />} tone={outCount ? 'bad' : undefined} />
      </div>

      <div className="flex items-center gap-3 mb-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={lowOnly} onChange={e => setLowOnly(e.target.checked)} className="accent-[var(--primary)]" />
          {t('inv.showLowOnly')}
        </label>
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}
      {offlineData ? (
        <div className="text-[11px] text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200 dark:border-amber-900 rounded px-2.5 py-1.5 mb-3">
          {t('inv.offlineBanner')}
        </div>
      ) : null}
      {notice ? (
        <div className="text-[11px] text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900 rounded px-2.5 py-1.5 mb-3">
          {notice}
        </div>
      ) : null}
      {loading ? <LoadingBlock rows={8} /> : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {/* stock table */}
          <div className="rounded-lg border overflow-x-auto bg-card max-h-[420px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b bg-secondary/50 text-left text-xs text-muted-foreground">
                  <th className="p-2.5 font-medium">{t('inv.product')}</th>
                  <th className="p-2.5 font-medium text-right">{t('inv.stock')}</th>
                  <th className="p-2.5 font-medium text-right">{t('inv.min')}</th>
                  <th className="p-2.5 font-medium text-right">{t('inv.cost')}</th>
                  <th className="p-2.5 font-medium text-right">{t('inv.retail')}</th>
                  <th className="p-2.5 font-medium text-right">{t('inv.value')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(p => (
                  <tr key={p.id} className="border-b last:border-0 hover:bg-secondary/30">
                    <td className="p-2.5"><div className="font-medium">{p.name}</div><div className="text-[11px] text-muted-foreground">{p.sku}</div></td>
                    <td className={`p-2.5 text-right font-bold ${p.stock <= 0 ? 'text-red-600' : p.stock <= p.minStock ? 'text-amber-600' : ''}`}>{fmtNum(p.stock)}</td>
                    <td className="p-2.5 text-right text-muted-foreground">{fmtNum(p.minStock)}</td>
                    <td className="p-2.5 text-right">{fmtNum(p.costPrice)}</td>
                    <td className="p-2.5 text-right">{fmtNum(p.retailPrice)}</td>
                    <td className="p-2.5 text-right">{fmtNum(r2(p.stock * p.costPrice))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* transaction history */}
          <div className="rounded-lg border overflow-x-auto bg-card max-h-[420px] overflow-y-auto">
            <div className="p-2.5 border-b bg-secondary/50 text-xs font-medium text-muted-foreground sticky top-0">{t('inv.historyTitle')}</div>
            <table className="w-full text-sm">
              <tbody>
                {safeTxns.map(tx => (
                  <tr key={tx.id} className="border-b last:border-0">
                    <td className="p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{tx.product?.name || '—'}</span>
                        <span className={`text-xs font-bold ${tx.quantity >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                          {tx.quantity >= 0 ? '+' : ''}{fmtNum(tx.quantity)}
                        </span>
                      </div>
                      <div className="text-[11px] text-muted-foreground flex gap-2 mt-0.5">
                        <span className="font-medium">{TYPE_KEYS[tx.type] ? t(TYPE_KEYS[tx.type]) : tx.type}</span>
                        <span>{fmtDateTime(tx.createdAt)}</span>
                        {tx.refNo ? <span>· {tx.refNo}</span> : null}
                        <span>· {fmtNum(tx.stockBefore)} → {fmtNum(tx.stockAfter)}</span>
                      </div>
                      {tx.note ? <div className="text-[11px] text-muted-foreground italic">{tx.note}</div> : null}
                    </td>
                  </tr>
                ))}
                {safeTxns.length === 0 ? <tr><td className="p-4 text-sm text-muted-foreground text-center">{t('inv.noMovements')}</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* adjustment dialog */}
      <Dialog open={adjOpen} onOpenChange={setAdjOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>{t('inv.stockAdjustment')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t('inv.product')}</Label>
              <Select value={adj.productId} onValueChange={v => setAdj({ ...adj, productId: v })}>
                <SelectTrigger><SelectValue placeholder={t('inv.selectProduct')} /></SelectTrigger>
                <SelectContent>
                  {safeProducts.map(p => <SelectItem key={p.id} value={p.id}>{p.name} ({fmtNum(p.stock)})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t('inv.type')}</Label>
                <Select value={adj.type} onValueChange={v => setAdj({ ...adj, type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ADJUST_IN">{t('inv.stockIn')}</SelectItem>
                    <SelectItem value="ADJUST_OUT">{t('inv.stockOut')}</SelectItem>
                    <SelectItem value="DAMAGE">{t('inv.damaged')}</SelectItem>
                    <SelectItem value="RETURN_IN">{t('inv.customerReturn')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t('inv.quantity')}</Label>
                <Input type="number" min={0.01} value={adj.quantity} onChange={e => setAdj({ ...adj, quantity: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t('inv.note')}</Label>
              <Input value={adj.note} onChange={e => setAdj({ ...adj, note: e.target.value })} placeholder={t('inv.reasonPlaceholder')} />
            </div>
            <Button className="w-full" onClick={saveAdj} disabled={!adj.productId || !(parseFloat(adj.quantity) > 0)}>{t('inv.saveAdjustment')}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
