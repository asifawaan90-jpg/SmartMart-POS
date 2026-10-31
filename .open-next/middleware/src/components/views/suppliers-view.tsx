'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuthStore } from '@/stores/auth'
import { useT } from '@/stores/lang'
import { api, errMsg } from '@/lib/client'
import { fmtMoney, fmtDateTime } from '@/lib/format'
import { downloadCSV, downloadExcel } from '@/lib/export'
import { PageHeader, LoadingBlock, EmptyState, ErrorBanner, MobileCard, MobileCardList, MetaItem } from '@/components/shared/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Plus, Search, Pencil, Eye, Loader2 } from 'lucide-react'

interface Supplier { id: string; name: string; company: string; phone: string; address: string; openingBalance: number; payable: number; isActive: boolean }
interface Txn { id: string; type: string; amount: number; balanceAfter: number; refNo: string; note: string; createdAt: string }

const EMPTY = { name: '', company: '', phone: '', address: '', openingBalance: '' }

export default function SuppliersView() {
  const t = useT()
  const { business } = useAuthStore()
  const cur = business?.currency || 'PKR'
  const [items, setItems] = useState<Supplier[]>([])
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Supplier | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)

  const [stmt, setStmt] = useState<{ supplier: Supplier; txns: Txn[]; summary: { payable: number } } | null>(null)
  const [payOpen, setPayOpen] = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [payNote, setPayNote] = useState('')

  useEffect(() => {
    const h = setTimeout(() => setDebounced(search), 300)
    return () => clearTimeout(h)
  }, [search])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setItems(await api<Supplier[]>(`/api/suppliers?search=${encodeURIComponent(debounced)}`)) }
    catch (e) { setError(errMsg(e)) } finally { setLoading(false) }
  }, [debounced])

  useEffect(() => { load() }, [load])

  const save = async () => {
    setSaving(true)
    try {
      const body = { ...form, openingBalance: parseFloat(form.openingBalance) || 0 }
      if (editing) await api(`/api/suppliers?id=${editing.id}`, { method: 'PUT', body })
      else await api('/api/suppliers', { method: 'POST', body })
      setFormOpen(false); setEditing(null)
      load()
    } catch (e) { alert(errMsg(e)) } finally { setSaving(false) }
  }

  const openStatement = async (s: Supplier) => {
    try { setStmt(await api(`/api/suppliers/statement?supplierId=${s.id}`)) } catch (e) { alert(errMsg(e)) }
  }

  const pay = async () => {
    if (!stmt) return
    try {
      await api(`/api/suppliers/payment?supplierId=${stmt.supplier.id}`, {
        method: 'POST', body: { amount: parseFloat(payAmount) || 0, note: payNote || t('sup.defaultPaymentNote') },
      })
      setPayOpen(false); setPayAmount(''); setPayNote('')
      openStatement(stmt.supplier)
      load()
    } catch (e) { alert(errMsg(e)) }
  }

  const totalPayable = items.reduce((s, x) => s + Math.max(0, x.payable), 0)

  const cols = [
    { key: 'name', label: t('sup.supplier'), width: 20 }, { key: 'company', label: t('sup.company'), width: 16 },
    { key: 'phone', label: t('sup.phone'), width: 13 }, { key: 'payable', label: t('sup.payableCur', { cur }), width: 13 }, { key: 'status', label: t('common.status'), width: 10 },
  ]

  const exportRows = (rows: Supplier[]) => rows.map(s => ({
    name: s.name, company: s.company, phone: s.phone, payable: s.payable, status: s.isActive ? t('sup.active') : t('sup.inactive'),
  }))

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title={t('nav.suppliers')}
        subtitle={t('sup.totalPayable', { amount: fmtMoney(totalPayable, cur) })}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => downloadCSV('suppliers', cols, exportRows(items))}>CSV</Button>
            <Button variant="outline" size="sm" onClick={() => downloadExcel('suppliers', t('nav.suppliers'), cols, exportRows(items))}>Excel</Button>
            <Button size="sm" onClick={() => { setEditing(null); setForm(EMPTY); setFormOpen(true) }}><Plus className="h-4 w-4" /> {t('sup.addSupplier')}</Button>
          </>
        }
      />
      <div className="relative max-w-xs mb-3">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input placeholder={t('sup.search')} value={search} onChange={e => setSearch(e.target.value)} className="pl-8 h-9" />
      </div>
      {error ? <ErrorBanner message={error} onRetry={load} /> : null}
      {loading ? <LoadingBlock /> : items.length === 0 ? <EmptyState message={t('sup.empty')} action={<Button size="sm" onClick={() => setFormOpen(true)}><Plus className="h-4 w-4" /> {t('sup.addSupplier')}</Button>} /> : (
        <>
        <MobileCardList>
          {items.map(s => (
            <MobileCard
              key={s.id}
              title={s.name}
              subtitle={[s.company, s.phone].filter(Boolean).join(' · ') || t('sup.noContact')}
              badge={null}
              meta={(
                <>
                  <MetaItem label={t('sup.payable')} className="col-span-2"><span className={`font-bold ${s.payable > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{fmtMoney(s.payable, cur)}</span></MetaItem>
                </>
              )}
              actions={(
                <>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openStatement(s)}><Eye className="h-3.5 w-3.5" /> {t('sup.statementPay')}</Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { setEditing(s); setForm({ name: s.name, company: s.company, phone: s.phone, address: s.address || '', openingBalance: String(s.openingBalance) }); setFormOpen(true) }}>
                    <Pencil className="h-3.5 w-3.5" /> {t('common.edit')}
                  </Button>
                </>
              )}
            />
          ))}
        </MobileCardList>
        <div className="hidden md:block rounded-lg border overflow-x-auto bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-secondary/50 text-left text-xs text-muted-foreground">
                <th className="p-2.5 font-medium">{t('sup.supplier')}</th>
                <th className="p-2.5 font-medium hidden md:table-cell">{t('sup.company')}</th>
                <th className="p-2.5 font-medium">{t('sup.phone')}</th>
                <th className="p-2.5 font-medium text-right">{t('sup.payable')}</th>
                <th className="p-2.5 font-medium text-right">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map(s => (
                <tr key={s.id} className="border-b last:border-0 hover:bg-secondary/30">
                  <td className="p-2.5 font-medium">{s.name}</td>
                  <td className="p-2.5 hidden md:table-cell">{s.company || '—'}</td>
                  <td className="p-2.5">{s.phone || '—'}</td>
                  <td className={`p-2.5 text-right font-bold ${s.payable > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{fmtMoney(s.payable, cur)}</td>
                  <td className="p-2.5">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" title={t('sup.statementPay')} onClick={() => openStatement(s)}><Eye className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" title={t('common.edit')}
                        onClick={() => { setEditing(s); setForm({ name: s.name, company: s.company, phone: s.phone, address: s.address || '', openingBalance: String(s.openingBalance) }); setFormOpen(true) }}
                      ><Pencil className="h-3.5 w-3.5" /></Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}

      {/* add/edit dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{editing ? t('common.editTitle', { name: editing.name }) : t('sup.addSupplier')}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>{t('sup.name')}</Label><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>{t('sup.company')}</Label><Input value={form.company} onChange={e => setForm({ ...form, company: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>{t('sup.phone')}</Label><Input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></div>
            {!editing ? (
              <div className="space-y-1.5"><Label>{t('sup.openingPayable')}</Label><Input type="number" value={form.openingBalance} onChange={e => setForm({ ...form, openingBalance: e.target.value })} placeholder="0" /></div>
            ) : null}
            <div className="space-y-1.5 col-span-2"><Label>{t('sup.address')}</Label><Input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} /></div>
          </div>
          <Button className="w-full" onClick={save} disabled={saving || !form.name}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {t('common.save')}
          </Button>
        </DialogContent>
      </Dialog>

      {/* statement + pay */}
      <Dialog open={!!stmt} onOpenChange={v => !v && setStmt(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{t('sup.statementFor', { name: stmt?.supplier.name || '' })}</DialogTitle></DialogHeader>
          {stmt ? (
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">{t('sup.totalPayableLabel')} <b className="text-red-600 text-sm">{fmtMoney(stmt.summary.payable, cur)}</b></div>
                <Button size="sm" onClick={() => setPayOpen(true)}><Plus className="h-3.5 w-3.5" /> {t('sup.paySupplier')}</Button>
              </div>
              <table className="w-full text-xs">
                <thead><tr className="border-b text-left text-muted-foreground"><th className="py-1">{t('common.date')}</th><th className="py-1">{t('sup.type')}</th><th className="py-1">{t('sup.ref')}</th><th className="py-1 text-right">{t('sup.amount')}</th><th className="py-1 text-right">{t('sup.balance')}</th></tr></thead>
                <tbody>
                  {stmt.txns.map(txn => (
                    <tr key={txn.id} className="border-b last:border-0">
                      <td className="py-1.5 whitespace-nowrap">{fmtDateTime(txn.createdAt)}</td>
                      <td className="py-1.5">{txn.type.replace('_', ' ')}</td>
                      <td className="py-1.5">{txn.refNo || '—'}</td>
                      <td className={`py-1.5 text-right ${txn.amount > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{fmtMoney(txn.amount, cur)}</td>
                      <td className="py-1.5 text-right font-bold">{fmtMoney(txn.balanceAfter, cur)}</td>
                    </tr>
                  ))}
                  {stmt.txns.length === 0 ? <tr><td colSpan={5} className="p-3 text-center text-muted-foreground">{t('sup.noTxns')}</td></tr> : null}
                </tbody>
              </table>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>{t('sup.paySupplierFor', { name: stmt?.supplier.name || '' })}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t('sup.amountCur', { cur })}</Label>
              <Input type="number" min={0.01} value={payAmount} onChange={e => setPayAmount(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('sup.note')}</Label>
              <Input value={payNote} onChange={e => setPayNote(e.target.value)} placeholder={t('sup.optional')} />
            </div>
            <Button className="w-full" onClick={pay} disabled={!(parseFloat(payAmount) > 0)}>{t('sup.savePayment')}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
