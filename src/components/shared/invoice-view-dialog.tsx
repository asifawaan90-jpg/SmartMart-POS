'use client'

import { useMemo } from 'react'
import { useAuthStore } from '@/stores/auth'
import { fmtMoney, fmtDateTime, fmtNum } from '@/lib/format'
import { printHTML, thermalReceiptHTML, invoiceHTML, purchaseInvoiceHTML } from '@/lib/export'
import { jsbarcodeSvg } from '@/lib/barcode-client'
import type { InvoiceLookupResult } from '@/lib/invoice-lookup'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Printer, FileText, ReceiptText, Truck, Undo2 } from 'lucide-react'

const STATUS_COLORS: Record<string, string> = {
  COMPLETED: 'text-emerald-600 border-emerald-300',
  RECEIVED: 'text-emerald-600 border-emerald-300',
  PARTIALLY_RETURNED: 'text-amber-600 border-amber-300',
  RETURNED: 'text-red-600 border-red-300',
}

function useBiz() {
  return useMemo(() => {
    const b = useAuthStore.getState().business
    const s = useAuthStore.getState().settings as { receipt?: { footer?: string; border?: boolean } } | null
    return {
      name: b?.name || 'SmartMart',
      address: b?.address || '',
      phone: b?.phone || '',
      logo: b?.logo || '',
      footer: String(s?.receipt?.footer || ''),
      border: s?.receipt?.border !== false,
    }
  }, [])
}

/**
 * The scanned-invoice viewer — opens INSTANTLY on top of any screen after a
 * successful invoice scan and gives one-tap print options for the customer:
 *   • Sale invoices / sale returns → 80mm & 58mm thermal receipt + A4 invoice
 *   • Purchase invoices / purchase returns → A4 purchase invoice
 * Every view includes a live scannable barcode of the document number.
 */
export default function InvoiceViewDialog({ result, onClose }: {
  result: InvoiceLookupResult | null
  onClose: () => void
}) {
  const biz = useBiz()
  const cur = useAuthStore.getState().business?.currency || 'PKR'
  if (!result) return null

  /* ── Sale invoice / sale return ─────────────────────────────── */
  if (result.sale) {
    const s = result.sale
    const isReturn = result.kind === 'SALE_RETURN'

    const printThermal = (width: 58 | 80) => {
      printHTML(`Receipt ${s.invoiceNo}`, thermalReceiptHTML(biz, {
        invoiceNo: s.invoiceNo,
        date: fmtDateTime(s.createdAt),
        cashier: s.cashierName,
        customer: s.customer?.name || 'Walk-in Customer',
        items: s.items.map(i => ({ name: i.name, quantity: i.quantity, price: i.price, total: i.total })),
        subtotal: s.subtotal, discount: s.discount, tax: s.tax,
        total: s.total, paid: s.paid, due: s.dueAmount, givenCash: s.givenCash,
        paymentMethod: s.paymentMethod, currency: cur,
        barcodeSvg: jsbarcodeSvg(s.invoiceNo, { height: 38 }),
      }, width))
    }
    const printA4 = () => {
      printHTML(`Invoice ${s.invoiceNo}`, invoiceHTML(biz, {
        invoiceNo: s.invoiceNo,
        date: fmtDateTime(s.createdAt),
        cashier: s.cashierName,
        customer: s.customer?.name || 'Walk-in Customer',
        items: s.items.map(i => ({ name: i.name, quantity: i.quantity, price: i.price, total: i.total })),
        subtotal: s.subtotal, discount: s.discount, tax: s.tax,
        total: s.total, paid: s.paid, due: s.dueAmount, givenCash: s.givenCash,
        paymentMethod: s.paymentMethod, currency: cur,
        barcodeSvg: jsbarcodeSvg(s.invoiceNo, { height: 44 }),
      }))
    }

    return (
      <Dialog open onOpenChange={v => !v && onClose()}>
        {/* flex-col + pinned footer: the print options used to sit at the end
            of one long scrolling column (416px below the fold on a 360×640
            phone — the whole reason "print option not fit in screen"). Now
            the details scroll in the middle and the print row is ALWAYS on
            screen, centered with the rest of the dialog. */}
        <DialogContent className="flex flex-col gap-3 p-4 sm:gap-4 sm:p-6 sm:max-w-lg">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex flex-wrap items-center gap-2 min-w-0 pr-7">
              <ReceiptText className="h-4 w-4 shrink-0" /> <span className="min-w-0 break-words">{s.invoiceNo}</span>
              <Badge variant="outline" className={`shrink-0 ${STATUS_COLORS[s.status] || ''}`}>{s.status.replace('_', ' ')}</Badge>
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto text-sm">
            {isReturn && result.return ? (
              <div className="text-xs font-medium text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200 dark:border-amber-900 rounded px-2 py-1.5 flex items-center gap-1.5">
                <Undo2 className="h-3.5 w-3.5 shrink-0" />
                Return slip {result.return.returnNo} · {fmtMoney(result.return.total, cur)}{result.return.reason ? ` · ${result.return.reason}` : ''} — showing the original invoice below.
              </div>
            ) : null}
            <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-1 text-xs text-muted-foreground [&>span]:min-w-0 [&_b]:break-words">
              <span>Date: <b className="text-foreground">{fmtDateTime(s.createdAt)}</b></span>
              <span>Cashier: <b className="text-foreground">{s.cashierName}</b></span>
              <span>Customer: <b className="text-foreground">{s.customer?.name || 'Walk-in'}</b></span>
              <span>Payment: <b className="text-foreground">{s.paymentMethod}</b></span>
            </div>
            <table className="w-full text-xs [&_td]:[overflow-wrap:anywhere] [&_th]:whitespace-nowrap [&_th]:px-1 [&_td]:px-1">
              <thead><tr className="border-b text-left text-muted-foreground"><th className="py-1">Item</th><th className="py-1 text-right">Qty</th><th className="py-1 text-right">Price</th><th className="py-1 text-right">Total</th><th className="py-1 text-right">Returned</th></tr></thead>
              <tbody>
                {s.items.map(i => (
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
              <div>Subtotal: {fmtMoney(s.subtotal, cur)}</div>
              {s.discount ? <div>Discount: −{fmtMoney(s.discount, cur)}</div> : null}
              {s.tax ? <div>Tax: {fmtMoney(s.tax, cur)}</div> : null}
              <div className="font-bold text-sm">Total: {fmtMoney(s.total, cur)}</div>
              <div>Paid: {fmtMoney(s.paid, cur)}{s.givenCash && s.givenCash > s.total ? ` · Cash given: ${fmtMoney(s.givenCash, cur)} · Change: ${fmtMoney(s.givenCash - s.total, cur)}` : s.dueAmount ? ` · Due: ${fmtMoney(s.dueAmount, cur)}` : ''}</div>
            </div>
            {/* live scannable barcode — the screen itself can be re-scanned */}
            <div className="flex justify-center border-t pt-2 [&_svg]:h-12 [&_svg]:w-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: jsbarcodeSvg(s.invoiceNo, { height: 44 }) }} aria-label={`Barcode ${s.invoiceNo}`} />
            {s.returns.length ? (
              <div className="text-[11px] text-muted-foreground">Returns: {s.returns.map(r => `${r.returnNo} (${fmtMoney(r.total, cur)})`).join(', ')}</div>
            ) : null}
          </div>
          {/* pinned action footer — always visible, zero scrolling needed */}
          <div className="shrink-0 border-t pt-2.5">
            {/* flex-wrap (not grid-cols-3): the 3 fixed columns needed 251px
                min-content — more than a 320dp phone's 238px — so the row (and
                the whole centered dialog) ran past the screen edge. Now the
                buttons shrink to fit one row on normal phones and wrap to a
                second row on narrow/zoomed screens instead of overflowing. */}
            <div className="flex flex-wrap gap-1.5 [&>button]:flex-1 [&>button]:min-w-[84px] [&>button]:px-1.5 [&>button]:text-xs">
              <Button variant="outline" size="sm" onClick={() => printThermal(80)}><Printer className="h-4 w-4 mr-1" /> 80mm</Button>
              <Button variant="outline" size="sm" onClick={() => printThermal(58)}><Printer className="h-4 w-4 mr-1" /> 58mm</Button>
              <Button variant="outline" size="sm" onClick={printA4}><FileText className="h-4 w-4 mr-1" /> A4 Invoice</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  /* ── Purchase invoice / purchase return ─────────────────────── */
  if (result.purchase) {
    const p = result.purchase
    const isReturn = result.kind === 'PURCHASE_RETURN'
    const printA4 = () => {
      printHTML(`Purchase ${p.invoiceNo}`, purchaseInvoiceHTML(biz, {
        invoiceNo: p.invoiceNo,
        date: fmtDateTime(p.createdAt),
        supplier: p.supplier?.name || '—',
        status: p.status,
        items: p.items.map(i => ({ name: i.name, quantity: i.quantity, unitCost: i.unitCost, total: i.total, returnedQty: i.returnedQty })),
        subtotal: p.subtotal, discount: p.discount, tax: p.tax,
        total: p.total, paid: p.paid, due: p.dueAmount,
        currency: cur,
        barcodeSvg: jsbarcodeSvg(p.invoiceNo, { height: 44 }),
      }))
    }

    return (
      <Dialog open onOpenChange={v => !v && onClose()}>
        {/* same pinned-footer pattern as the sale variant: details scroll in
            the middle, the print action stays on screen on phones */}
        <DialogContent className="flex flex-col gap-3 p-4 sm:gap-4 sm:p-6 sm:max-w-lg">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex flex-wrap items-center gap-2 min-w-0 pr-7">
              <Truck className="h-4 w-4 shrink-0" /> <span className="min-w-0 break-words">{p.invoiceNo}</span>
              <Badge variant="outline" className={`shrink-0 ${STATUS_COLORS[p.status] || ''}`}>{p.status.replace('_', ' ')}</Badge>
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto text-sm">
            {isReturn && result.return ? (
              <div className="text-xs font-medium text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200 dark:border-amber-900 rounded px-2 py-1.5 flex items-center gap-1.5">
                <Undo2 className="h-3.5 w-3.5 shrink-0" />
                Return slip {result.return.returnNo} · {fmtMoney(result.return.total, cur)} — showing the original purchase below.
              </div>
            ) : null}
            <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-1 text-xs text-muted-foreground [&>span]:min-w-0 [&_b]:break-words">
              <span>Date: <b className="text-foreground">{fmtDateTime(p.createdAt)}</b></span>
              <span>Supplier: <b className="text-foreground">{p.supplier?.name || '—'}</b></span>
            </div>
            <table className="w-full text-xs [&_td]:[overflow-wrap:anywhere] [&_th]:whitespace-nowrap [&_th]:px-1 [&_td]:px-1">
              <thead><tr className="border-b text-left text-muted-foreground"><th className="py-1">Item</th><th className="py-1 text-right">Qty</th><th className="py-1 text-right">Cost</th><th className="py-1 text-right">Total</th><th className="py-1 text-right">Returned</th></tr></thead>
              <tbody>
                {p.items.map(i => (
                  <tr key={i.id} className="border-b last:border-0">
                    <td className="py-1.5">{i.name}</td>
                    <td className="py-1.5 text-right">{i.quantity}</td>
                    <td className="py-1.5 text-right">{fmtNum(i.unitCost)}</td>
                    <td className="py-1.5 text-right">{fmtNum(i.total)}</td>
                    <td className="py-1.5 text-right text-red-600">{i.returnedQty || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-xs space-y-0.5 text-right">
              <div>Subtotal: {fmtMoney(p.subtotal, cur)}</div>
              {p.discount ? <div>Discount: −{fmtMoney(p.discount, cur)}</div> : null}
              {p.tax ? <div>Tax: {fmtMoney(p.tax, cur)}</div> : null}
              <div className="font-bold text-sm">Total: {fmtMoney(p.total, cur)}</div>
              <div>Paid: {fmtMoney(p.paid, cur)}{p.dueAmount ? ` · Due: ${fmtMoney(p.dueAmount, cur)}` : ''}</div>
            </div>
            <div className="flex justify-center border-t pt-2 [&_svg]:h-12 [&_svg]:w-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: jsbarcodeSvg(p.invoiceNo, { height: 44 }) }} aria-label={`Barcode ${p.invoiceNo}`} />
          </div>
          {/* pinned action footer — always visible, zero scrolling needed */}
          <div className="shrink-0 border-t pt-2.5">
            <Button variant="outline" size="sm" className="w-full" onClick={printA4}><Printer className="h-4 w-4 mr-1" /> Print Purchase Invoice (A4)</Button>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return null
}
