'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuthStore } from '@/stores/auth'
import { useT } from '@/stores/lang'
import { api, errMsg } from '@/lib/client'
import { fmtMoney, fmtDate, todayISO, daysAgoISO } from '@/lib/format'
import { downloadCSV, downloadExcel } from '@/lib/export'
import { PageHeader, LoadingBlock, EmptyState, ErrorBanner, StatCard, MobileCard, MobileCardList } from '@/components/shared/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Plus, Pencil, Trash2, Loader2, TrendingUp, TrendingDown, Wallet, Zap } from 'lucide-react'
import { useExportAll, fetchAllPages } from '@/lib/use-export-all'

interface Ledger {
  id: string; title: string; amount: number; kind: string; isAuto: boolean
  paidTo: string; paymentMethod: string; note: string; expenseDate: string
  categoryId: string | null; category?: { name: string } | null
}
interface DayIncome { date: string; invoices: number; gross: number; returns: number; net: number }
interface Cat { id: string; name: string }

const EMPTY = { title: '', amount: '', categoryId: '', paidTo: '', paymentMethod: 'CASH', expenseDate: '', note: '' }

export default function ExpensesView() {
  const t = useT()
  const { business } = useAuthStore()
  const cur = business?.currency || 'PKR'
  const [items, setItems] = useState<Ledger[]>([])
  const [cats, setCats] = useState<Cat[]>([])
  const [totalAmount, setTotalAmount] = useState(0)
  const [incomeManual, setIncomeManual] = useState(0)
  const [incomeSales, setIncomeSales] = useState(0)
  const [netProfit, setNetProfit] = useState(0)
  const [byDay, setByDay] = useState<DayIncome[]>([])
  const [from, setFrom] = useState(daysAgoISO(30))
  const [to, setTo] = useState(todayISO())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [formKind, setFormKind] = useState<'EXPENSE' | 'INCOME'>('EXPENSE')
  const [editing, setEditing] = useState<Ledger | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [data, c] = await Promise.all([
        api<{ items: Ledger[]; totalAmount: number; incomeManual: number; incomeSales: number; netProfit: number; byDay: DayIncome[] }>(`/api/expenses?from=${from}&to=${to}&pageSize=100`),
        api<Cat[]>('/api/master/expense-categories'),
      ])
      setItems(data.items); setTotalAmount(data.totalAmount)
      setIncomeManual(data.incomeManual); setIncomeSales(data.incomeSales)
      setNetProfit(data.netProfit); setByDay(data.byDay); setCats(c)
    } catch (e) { setError(errMsg(e)) } finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const openForm = (kind: 'EXPENSE' | 'INCOME') => {
    setEditing(null); setFormKind(kind)
    setForm({ ...EMPTY, expenseDate: todayISO() })
    setFormOpen(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      const body = {
        ...form,
        kind: editing ? editing.kind : formKind,
        amount: parseFloat(form.amount) || 0,
        categoryId: formKind === 'INCOME' ? null : (form.categoryId || null),
        expenseDate: form.expenseDate ? new Date(form.expenseDate).toISOString() : new Date().toISOString(),
      }
      if (editing) await api(`/api/expenses?id=${editing.id}`, { method: 'PUT', body })
      else await api('/api/expenses', { method: 'POST', body })
      setFormOpen(false); setEditing(null); setForm(EMPTY)
      load()
    } catch (e) { alert(errMsg(e)) } finally { setSaving(false) }
  }

  const remove = async (x: Ledger) => {
    if (!confirm(t('exp.deleteConfirm', { title: x.title }))) return
    try { await api(`/api/expenses?id=${x.id}`, { method: 'DELETE' }); load() } catch (e) { alert(errMsg(e)) }
  }

  const cols = [
    { key: 'date', label: t('common.date'), width: 12 }, { key: 'kind', label: t('exp.type'), width: 10 },
    { key: 'title', label: t('exp.description'), width: 24 }, { key: 'category', label: t('exp.category'), width: 13 },
    { key: 'paidTo', label: t('exp.paidToFrom'), width: 14 }, { key: 'method', label: t('exp.method'), width: 9 },
    { key: 'signed', label: `${t('exp.amount')} (${cur})`, width: 12 },
  ]
  const exportRows = (rows: Ledger[]) => rows.map(x => ({
    date: fmtDate(x.expenseDate), kind: x.kind, title: x.title, category: x.category?.name || '',
    paidTo: x.paidTo, method: x.paymentMethod, signed: x.kind === 'INCOME' ? x.amount : -x.amount,
  }))

  // Task 73 — export the WHOLE from/to ledger (pages past the 100-row API cap).
  const { exporting, savedFlash, run: runExportAll } = useExportAll()
  const exportLedger = (kind: 'csv' | 'xlsx') => runExportAll(kind,
    () => fetchAllPages<Ledger>(`/api/expenses?from=${from}&to=${to}`) as unknown as Promise<Record<string, unknown>[]>,
    rows => {
      if (kind === 'csv') downloadCSV('income-expense', cols, exportRows(rows as unknown as Ledger[]))
      else downloadExcel('income-expense', 'Ledger', cols, exportRows(rows as unknown as Ledger[]))
    }, setError)

  const totalIncome = incomeManual + incomeSales

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title={t('nav.expenses')}
        subtitle={t('exp.subtitle')}
        actions={
          <>
            <Button variant="outline" size="sm" disabled={!!exporting} onClick={() => exportLedger('csv')}>
              {exporting === 'csv' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {exporting === 'csv' ? t('common.exportPreparing') : savedFlash === 'csv' ? t('common.exportSaved') : 'CSV'}
            </Button>
            <Button variant="outline" size="sm" disabled={!!exporting} onClick={() => exportLedger('xlsx')}>
              {exporting === 'xlsx' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {exporting === 'xlsx' ? t('common.exportPreparing') : savedFlash === 'xlsx' ? t('common.exportSaved') : 'Excel'}
            </Button>
            <Button size="sm" variant="outline" className="text-emerald-700 border-emerald-300 hover:bg-emerald-50" onClick={() => openForm('INCOME')}>
              <Plus className="h-4 w-4" /> {t('exp.addIncome')}
            </Button>
            <Button size="sm" onClick={() => openForm('EXPENSE')}><Plus className="h-4 w-4" /> {t('exp.addExpense')}</Button>
          </>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard title={t('exp.totalIncome')} value={fmtMoney(totalIncome, cur)} icon={<TrendingUp className="h-3.5 w-3.5" />} />
        <StatCard title={t('exp.salesIncomeAuto')} value={fmtMoney(incomeSales, cur)} icon={<Zap className="h-3.5 w-3.5" />} />
        <StatCard title={t('exp.expenses')} value={fmtMoney(totalAmount, cur)} icon={<TrendingDown className="h-3.5 w-3.5" />} tone="bad" />
        <StatCard title={t('exp.netProfit')} value={fmtMoney(netProfit, cur)} icon={<Wallet className="h-3.5 w-3.5" />} tone={netProfit >= 0 ? 'good' : 'bad'} />
      </div>

      <div className="flex flex-wrap items-end gap-2 mb-3">
        <div className="space-y-1"><Label className="text-xs">{t('exp.from')}</Label><Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="h-9 w-40" /></div>
        <div className="space-y-1"><Label className="text-xs">{t('exp.to')}</Label><Input type="date" value={to} onChange={e => setTo(e.target.value)} className="h-9 w-40" /></div>
        <span className="text-xs text-muted-foreground pb-2">
          {t('exp.incomeBreakdown', { sales: fmtMoney(incomeSales, cur), other: fmtMoney(incomeManual, cur) })}
        </span>
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      {loading ? <LoadingBlock /> : (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          {/* mixed ledger */}
          <div className="xl:col-span-2">
            {items.length === 0 ? (
              <EmptyState message={t('exp.empty')} action={<div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => openForm('INCOME')}><Plus className="h-4 w-4" /> {t('exp.income')}</Button><Button size="sm" onClick={() => openForm('EXPENSE')}><Plus className="h-4 w-4" /> {t('exp.expense')}</Button></div>} />
            ) : (
              <>
              <MobileCardList>
                {items.map(x => {
                  const income = x.kind === 'INCOME'
                  return (
                    <MobileCard
                      key={x.id}
                      title={x.title}
                      subtitle={`${fmtDate(x.expenseDate)}${x.category?.name ? ` · ${x.category.name}` : ''}${x.paidTo ? ` · ${x.paidTo}` : ''}`}
                      badge={(
                        <div className="flex flex-col items-end gap-0.5">
                          <span className={`text-[10px] font-semibold ${income ? 'text-emerald-600' : 'text-red-600'}`}>{income ? 'INCOME' : 'EXPENSE'}</span>
                          <span className={`font-bold text-sm ${income ? 'text-emerald-600' : 'text-red-600'}`}>{income ? '+' : '−'}{fmtMoney(x.amount, cur)}</span>
                        </div>
                      )}
                      actions={!x.isAuto ? (
                        <>
                          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => {
                            setEditing(x); setFormKind(x.kind as 'EXPENSE' | 'INCOME')
                            setForm({
                              title: x.title, amount: String(x.amount), categoryId: x.categoryId || '',
                              paidTo: x.paidTo, paymentMethod: x.paymentMethod, expenseDate: x.expenseDate.slice(0, 10), note: x.note,
                            })
                            setFormOpen(true)
                          }}><Pencil className="h-3.5 w-3.5" /> {t('common.edit')}</Button>
                          <Button variant="outline" size="sm" className="h-7 text-xs text-red-600 border-red-300" onClick={() => remove(x)}><Trash2 className="h-3.5 w-3.5" /> {t('common.delete')}</Button>
                        </>
                      ) : <span className="text-[10px] text-muted-foreground">{t('exp.autoManaged')}</span>}
                    />
                  )
                })}
              </MobileCardList>
              <div className="hidden md:block rounded-lg border overflow-x-auto bg-card">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-secondary/50 text-left text-xs text-muted-foreground">
                      <th className="p-2.5 font-medium">{t('common.date')}</th>
                      <th className="p-2.5 font-medium">{t('exp.description')}</th>
                      <th className="p-2.5 font-medium hidden md:table-cell">{t('exp.category')}</th>
                      <th className="p-2.5 font-medium hidden lg:table-cell">{t('exp.paidToFrom')}</th>
                      <th className="p-2.5 font-medium text-right">{t('exp.amount')}</th>
                      <th className="p-2.5 font-medium text-right">{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(x => {
                      const income = x.kind === 'INCOME'
                      return (
                        <tr key={x.id} className="border-b last:border-0 hover:bg-secondary/30">
                          <td className="p-2.5 text-xs whitespace-nowrap">{fmtDate(x.expenseDate)}</td>
                          <td className="p-2.5 font-medium">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {x.title}
                              <Badge variant="secondary" className={`text-[10px] ${income ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'}`}>
                                {income ? 'INCOME' : 'EXPENSE'}
                              </Badge>
                              {x.isAuto ? <Badge variant="outline" className="text-[10px]">AUTO</Badge> : null}
                            </div>
                          </td>
                          <td className="p-2.5 hidden md:table-cell">{x.category?.name || '—'}</td>
                          <td className="p-2.5 hidden lg:table-cell">{x.paidTo || '—'}</td>
                          <td className={`p-2.5 text-right font-bold ${income ? 'text-emerald-600' : 'text-red-600'}`}>
                            {income ? '+' : '−'}{fmtMoney(x.amount, cur)}
                          </td>
                          <td className="p-2.5">
                            <div className="flex justify-end gap-1">
                              {x.isAuto ? <span className="text-[10px] text-muted-foreground pr-1.5 self-center">{t('exp.auto')}</span> : (
                                <>
                                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => {
                                    setEditing(x); setFormKind(x.kind as 'EXPENSE' | 'INCOME')
                                    setForm({
                                      title: x.title, amount: String(x.amount), categoryId: x.categoryId || '',
                                      paidTo: x.paidTo, paymentMethod: x.paymentMethod, expenseDate: x.expenseDate.slice(0, 10), note: x.note,
                                    })
                                    setFormOpen(true)
                                  }}><Pencil className="h-3.5 w-3.5" /></Button>
                                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(x)}><Trash2 className="h-3.5 w-3.5" /></Button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </div>

          {/* automatic sales income breakdown */}
          <div className="rounded-lg border bg-card self-start overflow-hidden">
            <div className="p-2.5 border-b bg-secondary/50 text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5 text-amber-500" /> {t('exp.salesIncomePanel')} — {from} → {to}
            </div>
            <div className="max-h-[380px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-[11px] text-muted-foreground">
                    <th className="p-2 font-medium">{t('common.date')}</th>
                    <th className="p-2 font-medium text-right">{t('exp.invoices')}</th>
                    <th className="p-2 font-medium text-right">{t('exp.sales')}</th>
                    <th className="p-2 font-medium text-right">{t('exp.returns')}</th>
                    <th className="p-2 font-medium text-right">{t('exp.net')}</th>
                  </tr>
                </thead>
                <tbody>
                  {byDay.map(d => (
                    <tr key={d.date} className="border-b last:border-0">
                      <td className="p-2 text-xs whitespace-nowrap">{fmtDate(d.date)}</td>
                      <td className="p-2 text-right text-xs">{d.invoices}</td>
                      <td className="p-2 text-right text-xs">{fmtMoney(d.gross, cur)}</td>
                      <td className="p-2 text-right text-xs text-red-500">{d.returns ? `−${fmtMoney(d.returns, cur)}` : '—'}</td>
                      <td className="p-2 text-right font-bold text-emerald-600">{fmtMoney(d.net, cur)}</td>
                    </tr>
                  ))}
                  {byDay.length === 0 ? <tr><td colSpan={5} className="p-4 text-center text-sm text-muted-foreground">{t('exp.noSales')}</td></tr> : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{editing ? (formKind === 'INCOME' ? t('exp.editIncome') : t('exp.editExpense')) : (formKind === 'INCOME' ? t('exp.addIncome') : t('exp.addExpense'))}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5 col-span-2"><Label>{t('exp.titleLabel')}</Label><Input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder={formKind === 'INCOME' ? t('exp.titlePlaceholderIncome') : t('exp.titlePlaceholderExpense')} /></div>
            <div className="space-y-1.5"><Label>{t('exp.amountLabel', { cur })}</Label><Input type="number" min={0} value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></div>
            {formKind === 'EXPENSE' ? (
              <div className="space-y-1.5">
                <Label>{t('exp.category')}</Label>
                <Select value={form.categoryId || 'none'} onValueChange={v => setForm({ ...form, categoryId: v === 'none' ? '' : v })}>
                  <SelectTrigger><SelectValue placeholder={t('common.select')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">—</SelectItem>
                    {cats.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : <div />}
            <div className="space-y-1.5"><Label>{t('common.date')}</Label><Input type="date" value={form.expenseDate} onChange={e => setForm({ ...form, expenseDate: e.target.value })} /></div>
            <div className="space-y-1.5">
              <Label>{t('exp.method')}</Label>
              <Select value={form.paymentMethod} onValueChange={v => setForm({ ...form, paymentMethod: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CASH">{t('exp.cash')}</SelectItem>
                  <SelectItem value="BANK">{t('exp.bank')}</SelectItem>
                  <SelectItem value="DIGITAL">{t('exp.digital')}</SelectItem>
                  <SelectItem value="CARD">{t('exp.card')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 col-span-2"><Label>{formKind === 'INCOME' ? t('exp.receivedFrom') : t('exp.paidTo')}</Label><Input value={form.paidTo} onChange={e => setForm({ ...form, paidTo: e.target.value })} placeholder={formKind === 'INCOME' ? t('exp.payerPlaceholder') : t('exp.vendorPlaceholder')} /></div>
            <div className="space-y-1.5 col-span-2"><Label>{t('exp.note')}</Label><Input value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /></div>
          </div>
          <Button className="w-full" onClick={save} disabled={saving || !form.title || !(parseFloat(form.amount) > 0)}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {formKind === 'INCOME' ? t('exp.saveIncome') : t('exp.saveExpense')}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
