'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuthStore } from '@/stores/auth'
import { useT } from '@/stores/lang'
import { api, errMsg } from '@/lib/client'
import { fmtMoney, r2 } from '@/lib/format'
import { downloadCSV, downloadExcel } from '@/lib/export'
import { PageHeader, LoadingBlock, EmptyState, ErrorBanner, MobileCard, MobileCardList, MetaItem } from '@/components/shared/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import CustomerStatementPanel from '@/components/shared/customer-statement'
import { Plus, Search, Pencil, Loader2, MessageCircle, FileText } from 'lucide-react'

interface Customer {
  id: string; name: string; phone: string; address: string; openingBalance: number
  creditLimit: number; balance: number; isActive: boolean; notes?: string
  _count?: { sales: number }
}

const EMPTY = { name: '', phone: '', address: '', openingBalance: '', creditLimit: '', notes: '' }

export default function CustomersView() {
  const t = useT()
  const { business } = useAuthStore()
  const cur = business?.currency || 'PKR'
  const [items, setItems] = useState<Customer[]>([])
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [stmtFor, setStmtFor] = useState<Customer | null>(null)

  useEffect(() => {
    const h = setTimeout(() => setDebounced(search), 300)
    return () => clearTimeout(h)
  }, [search])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setItems(await api<Customer[]>(`/api/customers?search=${encodeURIComponent(debounced)}`)) }
    catch (e) { setError(errMsg(e)) } finally { setLoading(false) }
  }, [debounced])

  useEffect(() => { load() }, [load])

  const save = async () => {
    setSaving(true)
    try {
      const body = { ...form, openingBalance: parseFloat(form.openingBalance) || 0, creditLimit: parseFloat(form.creditLimit) || 0 }
      if (editing) await api(`/api/customers?id=${editing.id}`, { method: 'PUT', body })
      else await api('/api/customers', { method: 'POST', body })
      setFormOpen(false); setEditing(null)
      load()
    } catch (e) { alert(errMsg(e)) } finally { setSaving(false) }
  }

  const totalDue = r2(items.reduce((s, c) => s + Math.max(0, c.balance), 0))

  const cols = [
    { key: 'name', label: t('common.customer'), width: 20 }, { key: 'phone', label: t('cust.phone'), width: 14 },
    { key: 'balance', label: t('cust.balanceDueCur', { cur }), width: 14 }, { key: 'creditLimit', label: t('cust.creditLimit'), width: 12 },
    { key: 'totalPurchases', label: t('cust.purchasesCur', { cur }), width: 14 }, { key: 'status', label: t('common.status'), width: 10 },
  ]

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title={t('nav.customers')}
        subtitle={t('cust.subtitle', { n: items.length, total: fmtMoney(totalDue, cur) })}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => downloadCSV('customers', cols, items.map(c => ({ ...c, totalPurchases: (c as { salesTotal?: number }).salesTotal ?? '' })))}>CSV</Button>
            <Button variant="outline" size="sm" onClick={() => downloadExcel('customers', t('nav.customers'), cols, items.map(c => ({ ...c, totalPurchases: (c as { salesTotal?: number }).salesTotal ?? '' })))}>Excel</Button>
            <Button size="sm" onClick={() => { setEditing(null); setForm(EMPTY); setFormOpen(true) }}><Plus className="h-4 w-4" /> {t('cust.addCustomer')}</Button>
          </>
        }
      />
      <div className="relative max-w-xs mb-3">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input placeholder={t('cust.search')} value={search} onChange={e => setSearch(e.target.value)} className="pl-8 h-9" />
      </div>
      {error ? <ErrorBanner message={error} onRetry={load} /> : null}
      {loading ? <LoadingBlock /> : items.length === 0 ? <EmptyState message={t('cust.empty')} action={<Button size="sm" onClick={() => setFormOpen(true)}><Plus className="h-4 w-4" /> {t('cust.addCustomer')}</Button>} /> : (
        <>
        <MobileCardList>
          {items.map(c => (
            <MobileCard
              key={c.id}
              title={c.name}
              subtitle={c.phone || t('cust.noPhone')}
              badge={c.isActive ? <Badge variant="outline" className="text-emerald-600 border-emerald-300">{t('cust.active')}</Badge> : <Badge variant="secondary">{t('cust.inactive')}</Badge>}
              meta={(
                <>
                  <MetaItem label={t('cust.balanceDue')}><span className={`font-bold ${c.balance > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{fmtMoney(c.balance, cur)}</span></MetaItem>
                  <MetaItem label={t('cust.creditLimit')}>{c.creditLimit > 0 ? fmtMoney(c.creditLimit, cur) : '—'}</MetaItem>
                </>
              )}
              actions={(
                <>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setStmtFor(c)}><FileText className="h-3.5 w-3.5" /> {t('cust.statement')}</Button>
                  {c.phone && c.balance > 0 ? (
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => window.open(`https://wa.me/${c.phone.replace(/\D/g, '')}?text=${encodeURIComponent(t('cust.remindMsg', { name: c.name, shop: business?.name ?? '', amount: fmtMoney(c.balance, cur) }))}`, '_blank')}>
                      <MessageCircle className="h-3.5 w-3.5" /> {t('cust.remind')}
                    </Button>
                  ) : null}
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => {
                    setEditing(c)
                    setForm({ name: c.name, phone: c.phone, address: c.address || '', openingBalance: String(c.openingBalance), creditLimit: String(c.creditLimit), notes: c.notes || '' })
                    setFormOpen(true)
                  }}><Pencil className="h-3.5 w-3.5" /> {t('common.edit')}</Button>
                </>
              )}
            />
          ))}
        </MobileCardList>
        <div className="hidden md:block rounded-lg border overflow-x-auto bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-secondary/50 text-left text-xs text-muted-foreground">
                <th className="p-2.5 font-medium">{t('common.customer')}</th>
                <th className="p-2.5 font-medium">{t('cust.phone')}</th>
                <th className="p-2.5 font-medium text-right">{t('cust.balanceDue')}</th>
                <th className="p-2.5 font-medium text-right hidden md:table-cell">{t('cust.creditLimit')}</th>
                <th className="p-2.5 font-medium">{t('common.status')}</th>
                <th className="p-2.5 font-medium text-right">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map(c => (
                <tr key={c.id} className="border-b last:border-0 hover:bg-secondary/30">
                  <td className="p-2.5 font-medium">{c.name}</td>
                  <td className="p-2.5">{c.phone || '—'}</td>
                  <td className={`p-2.5 text-right font-bold ${c.balance > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{fmtMoney(c.balance, cur)}</td>
                  <td className="p-2.5 text-right hidden md:table-cell text-muted-foreground">{c.creditLimit > 0 ? fmtMoney(c.creditLimit, cur) : '—'}</td>
                  <td className="p-2.5">{c.isActive ? <Badge variant="outline" className="text-emerald-600 border-emerald-300">{t('cust.active')}</Badge> : <Badge variant="secondary">{t('cust.inactive')}</Badge>}</td>
                  <td className="p-2.5">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" title={t('cust.statementTitle')}
                        onClick={() => setStmtFor(c)}
                      ><FileText className="h-3.5 w-3.5" /></Button>
                      {c.phone && c.balance > 0 ? (
                        <Button variant="ghost" size="icon" className="h-7 w-7" title={t('cust.remindTitle')}
                          onClick={() => window.open(`https://wa.me/${c.phone.replace(/\D/g, '')}?text=${encodeURIComponent(t('cust.remindMsg', { name: c.name, shop: business?.name ?? '', amount: fmtMoney(c.balance, cur) }))}`, '_blank')}
                        ><MessageCircle className="h-3.5 w-3.5" /></Button>
                      ) : null}
                      <Button variant="ghost" size="icon" className="h-7 w-7" title={t('common.edit')}
                        onClick={() => {
                          setEditing(c)
                          setForm({ name: c.name, phone: c.phone, address: c.address || '', openingBalance: String(c.openingBalance), creditLimit: String(c.creditLimit), notes: c.notes || '' })
                          setFormOpen(true)
                        }}
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

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{editing ? t('common.editTitle', { name: editing.name }) : t('cust.addCustomer')}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5 col-span-2">
              <Label>{t('cust.name')}</Label>
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('cust.phone')}</Label>
              <Input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="0300-…" />
            </div>
            <div className="space-y-1.5">
              <Label>{editing ? t('cust.creditLimit') : t('cust.openingBalance')}</Label>
              {editing ? (
                <Input type="number" value={form.creditLimit} onChange={e => setForm({ ...form, creditLimit: e.target.value })} placeholder={t('cust.unlimitedHint')} />
              ) : (
                <Input type="number" value={form.openingBalance} onChange={e => setForm({ ...form, openingBalance: e.target.value })} placeholder="0" />
              )}
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>{t('cust.address')}</Label>
              <Input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
            </div>
          </div>
          <Button className="w-full" onClick={save} disabled={saving || !form.name}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {t('common.save')}
          </Button>
        </DialogContent>
      </Dialog>

      <Dialog open={stmtFor !== null} onOpenChange={o => { if (!o) setStmtFor(null) }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('cust.statementFor', { name: stmtFor?.name || '' })}</DialogTitle>
          </DialogHeader>
          {stmtFor ? (
            <div className="rounded-lg border overflow-hidden">
              <CustomerStatementPanel customerId={stmtFor.id} />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
