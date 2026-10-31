'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuthStore } from '@/stores/auth'
import { useOfflineStore, syncNow, type QueueKind } from '@/stores/offline'
import { useT } from '@/stores/lang'
import { api, errMsg } from '@/lib/client'
import { fmtMoney, fmtNum, fmtDateTime } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader, StatCard, LoadingBlock, ErrorBanner } from '@/components/shared/kit'
import { Button } from '@/components/ui/button'
import type { ViewId } from '@/components/app-shell'
import { cn } from '@/lib/utils'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar, PieChart, Pie, Cell, Legend,
} from 'recharts'
import {
  TrendingUp, ShoppingCart, Package, Warehouse, Users, Wallet,
  BookUser, Building2, AlertTriangle, ReceiptText, Cloud, CloudOff, RefreshCw, CheckCircle2,
} from 'lucide-react'

interface DashData {
  cards: {
    todaySales: number; todayProfit: number; todayInvoices: number
    todayPurchases: number; todayExpenses: number
    products: number; lowStock: number; customers: number
    customerDue: number; supplierDue: number; stockValue: number
  }
  trend: { date: string; sales: number; profit: number }[]
  topProducts: { name: string; qty: number; revenue: number }[]
  payMethods: Record<string, number>
}

const PIE_COLORS = ['#10b981', '#f59e0b', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6']

const KIND_I18N: Record<QueueKind, string> = {
  SALE: 'sync.kindSale',
  STOCK_ADJUSTMENT: 'sync.kindStock',
  PURCHASE: 'sync.kindPurchase',
  KHATA_PAYMENT: 'sync.kindKhata',
  PRODUCT: 'sync.kindProduct',
}

/** Task 63 — the dashboard's honest window into device↔server data saving:
 *  live sync status, what is still queued on THIS device, when the last
 *  upload happened, and a manual Sync now button next to the automatic
 *  engine (boot + every 20s online + tab focus + connection-restore). */
function SyncCard() {
  const t = useT()
  const status = useOfflineStore(s => s.status)
  const queue = useOfflineStore(s => s.queue)
  const lastSyncedAt = useOfflineStore(s => s.lastSyncedAt)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const doSync = async () => {
    setBusy(true)
    try {
      const r = await syncNow(true) // Task 70 — real round-trip even when the queue is empty
      // Task 72 — honest notes: a skipped press (auto-sync was mid-flight, or
      // the session expired) must NOT show the fake "All synced" that made the
      // Last-synced date look frozen.
      if (r.skipped === 'BUSY') setNote(t('sync.busyWait'))
      else if (r.skipped === 'AUTH') setNote(t('sync.authNeeded'))
      else if (r.pushed > 0) setNote(t('sync.notePushed', { n: r.pushed }))
      else if (r.failed > 0) setNote(t('sync.noteFailed', { n: r.failed }))
    } finally { setBusy(false) }
  }

  const pending = queue.length
  const cfg: Record<string, { icon: typeof Cloud; cls: string; label: string }> = {
    ONLINE: { icon: Cloud, cls: 'text-emerald-600', label: t('common.online') },
    OFFLINE: { icon: CloudOff, cls: 'text-muted-foreground', label: t('common.offline') },
    SYNCING: { icon: RefreshCw, cls: 'text-amber-500 animate-spin', label: t('sync.statusSyncing') },
    SYNC_ERROR: { icon: AlertTriangle, cls: 'text-red-600', label: t('sync.statusError') },
  }
  const sc = cfg[status] || cfg.ONLINE

  return (
    <Card data-testid="dashboard-sync-card" className={pending > 0 ? 'border-amber-300' : ''}>
      <CardContent className="p-4 flex flex-wrap items-center gap-3">
        <div className={cn('flex items-center gap-1.5 shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide', sc.cls)}>
          <sc.icon className="h-3.5 w-3.5" /> {sc.label}
        </div>
        <div className="min-w-0 flex-1">
          {/* Line 1 — Premium sync status */}
          <div className="text-center">
            <div className="inline-flex items-center justify-center gap-1.5 text-sm font-semibold text-emerald-700">
              <Cloud className="h-4 w-4" />
              <span>Cloud Synced</span>
              <span className="text-muted-foreground font-medium"> · </span>
              <span>Local Backup Active</span>
            </div>
          </div>
          {/* Line 2 — Last sync + auto-save */}
          <div className="text-center mt-1">
            <div className="inline-flex items-center justify-center gap-1 text-xs text-muted-foreground">
              <span>Last sync: {lastSyncedAt ? fmtDateTime(new Date(lastSyncedAt)) : 'Never'}</span>
              <span className="font-medium text-emerald-600"> - Auto-save ON</span>
            </div>
          </div>
          {note && <p className="text-center text-xs text-foreground mt-1.5">{note}</p>}
        </div>
        <Button size="sm" variant="outline" className="shrink-0" onClick={doSync} disabled={busy}>
          <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} /> {t('sales.syncNow')}
        </Button>
      </CardContent>
    </Card>
  )
}

export default function DashboardView({ onNavigate }: { onNavigate: (v: ViewId) => void }) {
  const { business } = useAuthStore()
  const t = useT()
  const [data, setData] = useState<DashData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const cur = business?.currency || 'PKR'

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setData(await api<DashData>('/api/dashboard')) }
    catch (e) { setError(errMsg(e)) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) return <LoadingBlock rows={8} />
  if (error) return <ErrorBanner message={error} onRetry={load} />
  if (!data) return null

  const c = data.cards
  const payData = Object.entries(data.payMethods || {}).map(([name, value]) => ({ name, value }))

  return (
    <div className="p-4 md:p-6 space-y-5">
      <PageHeader
        title={t('dash.title')}
        subtitle={t('dash.subtitle', { shop: business?.name || 'your shop' })}
        actions={<button onClick={load} className="text-xs underline text-muted-foreground">{t('common.refresh')}</button>}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard title={t('dash.todaysSales')} value={fmtMoney(c.todaySales, cur)} sub={`${c.todayInvoices} ${t('dash.invoices')}`} icon={<ShoppingCart className="h-3.5 w-3.5" />} tone="good" />
        <StatCard title={t('dash.todaysProfit')} value={fmtMoney(c.todayProfit, cur)} sub={t('dash.costBasis')} icon={<TrendingUp className="h-3.5 w-3.5" />} tone="good" />
        <StatCard title={t('dash.todaysPurchases')} value={fmtMoney(c.todayPurchases, cur)} icon={<Building2 className="h-3.5 w-3.5" />} />
        <StatCard title={t('dash.todaysExpenses')} value={fmtMoney(c.todayExpenses, cur)} icon={<Wallet className="h-3.5 w-3.5" />} tone="warn" />
        <StatCard title={t('dash.products')} value={fmtNum(c.products)} sub={c.lowStock ? `${c.lowStock} ${t('dash.lowStockUnit')}` : t('dash.stockHealthy')} icon={<Package className="h-3.5 w-3.5" />} />
        <StatCard title={t('dash.lowStock')} value={fmtNum(c.lowStock)} sub={t('dash.atOrBelowMin')} icon={<AlertTriangle className="h-3.5 w-3.5" />} tone={c.lowStock > 0 ? 'warn' : undefined} />
        <StatCard title={t('dash.customerDue')} value={fmtMoney(c.customerDue, cur)} sub={`${c.customers} ${t('dash.customersUnit')}`} icon={<BookUser className="h-3.5 w-3.5" />} tone="bad" />
        <StatCard title={t('dash.supplierDue')} value={fmtMoney(c.supplierDue, cur)} icon={<Building2 className="h-3.5 w-3.5" />} tone="bad" />
      </div>

      <SyncCard />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="xl:col-span-2">
          <CardHeader className="pb-0">
            <CardTitle className="text-sm font-semibold">{t('dash.salesTrend')}</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.trend} margin={{ top: 10, right: 8, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="gs" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="gp" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} fontSize={10} tickLine={false} />
                <YAxis fontSize={10} tickLine={false} width={56} tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)} />
                <Tooltip formatter={(v: number) => fmtMoney(v, cur)} labelStyle={{ fontSize: 12 }} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Area type="monotone" dataKey="sales" name="Sales" stroke="var(--chart-1)" fill="url(#gs)" strokeWidth={2} />
                <Area type="monotone" dataKey="profit" name="Profit" stroke="var(--chart-2)" fill="url(#gp)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-0">
            <CardTitle className="text-sm font-semibold">{t('dash.payMethods')}</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            {payData.length === 0 ? (
              <div className="h-full grid place-items-center text-sm text-muted-foreground">{t('dash.noPayments')}</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={payData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} paddingAngle={3}>
                    {payData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => fmtMoney(v, cur)} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="xl:col-span-2">
          <CardHeader className="pb-0">
            <CardTitle className="text-sm font-semibold">{t('dash.topProducts')}</CardTitle>
          </CardHeader>
          <CardContent className="h-60">
            {data.topProducts.length === 0 ? (
              <div className="h-full grid place-items-center text-sm text-muted-foreground">{t('dash.noSales')}</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.topProducts} layout="vertical" margin={{ top: 4, right: 16, left: 30, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis type="number" fontSize={10} tickLine={false} tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)} />
                  <YAxis type="category" dataKey="name" fontSize={10} width={110} tickLine={false} />
                  <Tooltip formatter={(v: number) => fmtMoney(v, cur)} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Bar dataKey="revenue" name="Revenue" fill="var(--chart-1)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-0">
            <CardTitle className="text-sm font-semibold">{t('dash.stockValue')}</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            <div className="text-3xl font-bold">{fmtMoney(c.stockValue, cur)}</div>
            <div className="space-y-2 text-sm">
              <button className="w-full flex items-center justify-between rounded-lg border p-3 hover:bg-secondary transition-colors" onClick={() => onNavigate('pos')}>
                <span className="flex items-center gap-2"><ReceiptText className="h-4 w-4" /> {t('dash.openPos')}</span>
                <span className="text-xs text-muted-foreground">F2</span>
              </button>
              <button className="w-full flex items-center justify-between rounded-lg border p-3 hover:bg-secondary transition-colors" onClick={() => onNavigate('inventory')} disabled>
                <span className="flex items-center gap-2"><Warehouse className="h-4 w-4" /> {t('nav.inventory')}</span>
                <span className="text-xs text-muted-foreground">{c.lowStock} {t('dash.alerts')}</span>
              </button>
              <button className="w-full flex items-center justify-between rounded-lg border p-3 hover:bg-secondary transition-colors" onClick={() => onNavigate('reports')}>
                <span className="flex items-center gap-2"><TrendingUp className="h-4 w-4" /> {t('dash.plReport')}</span>
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
