'use client'

import { formatMoney, currencyInfo } from './currency'

// Print engine + document builders — kept SEPARATE from export.ts (which bundles
// the heavy SheetJS/xlsx library) so views can statically import printing without
// bloating their bundle. Statically importing matters: printHTML must run inside
// the tap/click gesture so it may open the mobile print window (a dynamic import
// would resolve after the gesture expired and the popup would be blocked).

/** Shared print document styles — used by printHTML AND the on-screen Print View,
 *  so what you preview is exactly what prints. */
export const PRINT_BASE_CSS = `
  body { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #111; margin: 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
  th { background: #f3f4f6; }
  .num { text-align: right; }
  h1 { font-size: 20px; } h2 { font-size: 16px; }
  .muted { color: #666; font-size: 11px; }
  .head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 12px; }
  .totals { margin-top: 10px; font-size: 13px; }
  .totals div { display: flex; justify-content: flex-end; gap: 24px; padding: 2px 0; }
  .totals .grand { font-weight: 700; font-size: 15px; border-top: 1px solid #333; padding-top: 4px; }
  .badge { display:inline-block; padding: 2px 8px; border: 1px solid #999; border-radius: 4px; font-size: 11px; }
  .bc { text-align: center; }
  .bc svg { height: 11mm; width: auto; max-width: 100%; }`

/** ─── Printing pipeline ──────────────────────────────────────────────────
 *
 *  Phones/tablets: hidden-frame printing is unreliable on mobile — iOS WebKit
 *  often silently no-ops print() from a hidden iframe and mobile Chrome can
 *  open a preview that renders empty. So on mobile we open a REAL window in
 *  the tap gesture, paint the receipt into it (visible on screen), and call
 *  print() on that top-level document — the native print preview then always
 *  has a fully rendered document to show. A toolbar stays at the top of the
 *  receipt tab so the operator can print again or use Share → Print where
 *  script printing is restricted (iOS standalone PWA, in-app WebViews).
 *
 *  Desktop: hidden 0×0 iframe → write → wait load + images → win.print().
 *  The frame is removed ONLY when the print dialog has really closed
 *  (afterprint, or print() returned after blocking). Removing it earlier —
 *  while Chromium's print preview is still open — yanks the document out from
 *  under the live preview and the preview renders blank ("receipt did not
 *  show on print preview").
 *
 *  printHTML NEVER rejects, so fire-and-forget callers stay safe; callers that
 *  await get a reliable "done" signal to reset busy states / close dialogs.
 */

function isMobileDevice(): boolean {
  try {
    const ua = navigator.userAgent || ''
    if (/Android|iPhone|iPad|iPod|IEMobile|BlackBerry|webOS|Opera Mini|Mobile/i.test(ua)) return true
    // iPadOS 13+ masquerades as desktop Mac — detect touch-capable "Macintosh"
    if (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1) return true
    const uad = (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData
    return !!uad?.mobile
  } catch { return false }
}

export function printHTML(title: string, html: string): Promise<void> {
  // window.open() must run synchronously inside the user gesture — this is the
  // first statement, so views that call printHTML() directly from a click/ tap
  // handler keep the transient activation needed to open the mobile window.
  if (isMobileDevice()) {
    const w = openPrintWindow()
    if (w) return printViaWindow(w, title, html)
    // Popup blocked / embedded webview refused → best-effort hidden frame below.
  }
  return printViaHiddenFrame(title, html)
}

function openPrintWindow(): Window | null {
  try {
    const w = window.open('', '_blank')
    if (!w) return null
    // The receipt document never needs to reach back into the app.
    try { (w as { opener: unknown }).opener = null } catch { /* ignore */ }
    return w
  } catch { return null }
}

/** On-screen toolbar shown on mobile: the receipt is visible before printing and
 *  re-printable even where script printing is restricted. Never printed itself. */
const MOBILE_PRINTBAR_CSS = `
  @media screen {
    body { padding-top: 62px; }
    .printbar { position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
      display: flex; align-items: center; gap: 10px; padding: 10px 14px;
      background: #0c59d8; color: #fff;
      font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      box-shadow: 0 2px 10px rgba(0,0,0,.28); }
    .printbar b { font-size: 14px; }
    .printbar button { margin-left: auto; flex: none; border: 0; background: #fff;
      color: #0c59d8; font-weight: 700; font-size: 14px; padding: 9px 20px;
      border-radius: 9px; cursor: pointer; }
    .printbar span { font-size: 11px; opacity: .9; }
  }
  @media print { .printbar { display: none !important; } }`

/** Screen-only fit-to-phone CSS for the mobile receipt tab. Documents are laid
 *  out for PAPER (80mm receipt = 302px, A4 invoice = 718px) — wider than any
 *  phone, which pushed the print preview half off the screen sideways. These
 *  rules shrink the preview to the phone width WITHOUT touching @media print,
 *  so what comes out of the printer is pixel-identical to before. */
const MOBILE_SCREEN_FIT_CSS = `
  @media screen {
    body { margin: 12px !important; }
    body > div:not(.printbar) { width: auto !important; max-width: 100% !important; overflow-wrap: anywhere; }
    table { table-layout: fixed !important; border-collapse: collapse !important; }
    th, td { box-sizing: border-box; overflow-wrap: anywhere; word-break: break-word; }
    .head { flex-wrap: wrap; gap: 6px; }
    img, svg { max-width: 100% !important; }
  }`

function printViaWindow(w: Window, title: string, html: string): Promise<void> {
  return new Promise<void>(resolve => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }

    let doc: Document
    try {
      doc = w.document
      doc.open()
      doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${PRINT_BASE_CSS}</style><style>${MOBILE_PRINTBAR_CSS}</style><style>${MOBILE_SCREEN_FIT_CSS}</style>
</head><body>
<div class="printbar"><b>${esc(title)}</b><button type="button">Print</button>
<span>Or use your browser menu: Print / Share → Print</span></div>
${html}</body></html>`)
      doc.close()
    } catch {
      // Could not write the window — don't leave an empty tab behind.
      try { w.close() } catch { /* ignore */ }
      finish()
      return
    }
    try {
      doc.querySelector('.printbar button')?.addEventListener('click', () => {
        try { w.print() } catch { /* ignore */ }
      })
    } catch { /* ignore */ }

    // When the print dialog has really closed (Chromium/Firefox fire afterprint)
    // the job is spooled — auto-close the receipt tab.
    try {
      w.addEventListener('afterprint', () => {
        finish()
        setTimeout(() => { try { w.close() } catch { /* ignore */ } }, 500)
      })
    } catch { /* ignore — fallback timer still resolves */ }

    const go = () => {
      const imgs = Array.from(doc.images || [])
      const decoded = Promise.all(imgs.map(im =>
        im.complete ? Promise.resolve() : (im.decode ? im.decode().catch(() => {}) : new Promise<void>(r => { im.onload = im.onerror = () => r() }))))
      const capped = new Promise<void>(res => setTimeout(res, 2500))
      void Promise.race([decoded, capped]).then(() => {
        // Let layout settle, then open the print sheet over the visible receipt.
        setTimeout(() => {
          try { w.focus(); w.print() } catch { /* silent no-op (iOS PWA/WebView) — the receipt stays on screen with its Print button */ }
        }, 150)
      })
    }
    if (doc.readyState === 'complete') go()
    else {
      let fired = false
      const onLoad = () => { if (!fired) { fired = true; go() } }
      w.addEventListener('load', onLoad)
      setTimeout(onLoad, 2500) // paranoia net if the load event never arrives
    }
    // Engines without afterprint (iOS): resolve anyway so callers release their
    // busy state — the receipt tab remains open and re-printable.
    setTimeout(finish, 15000)
  })
}

function printViaHiddenFrame(title: string, html: string): Promise<void> {
  return new Promise<void>(resolve => {
    const iframe = document.createElement('iframe')
    iframe.style.position = 'fixed'
    iframe.style.right = '0'
    iframe.style.bottom = '0'
    iframe.style.width = '0'
    iframe.style.height = '0'
    iframe.style.border = '0'
    iframe.setAttribute('aria-hidden', 'true')
    iframe.title = title

    let removed = false
    const removeIframe = () => {
      if (removed) return
      removed = true
      clearTimeout(leakGuard)
      try { iframe.remove() } catch { /* already gone */ }
      resolve() // every cleanup path ends the promise — awaiters can never hang
    }
    // True while win.print() has been called but the dialog may still be open.
    let printBlocked = false
    // Last-resort leak guard: a hidden print frame must never live longer than this —
    // but never yank the document out from under an OPEN print preview (printBlocked).
    const leakGuard = setTimeout(() => { if (!printBlocked) removeIframe() }, 120000)

    document.body.appendChild(iframe)
    const win = iframe.contentWindow
    const doc = win?.document
    if (!win || !doc) { removeIframe(); return }

    let printed = false
    const doPrint = () => {
      if (printed) return
      printed = true
      try {
        win.focus()
        printBlocked = true
        const t0 = Date.now()
        win.print()
        // Chromium's print() returns AT ONCE while the preview stays OPEN — the
        // frame must stay mounted (afterprint removes it when the dialog closes)
        // or the live preview re-renders blank. Firefox/Safari BLOCK until the
        // dialog is closed — if we waited >1.5s the dialog is gone, so clean up
        // now (Safari never fires afterprint).
        if (Date.now() - t0 > 1500) setTimeout(removeIframe, 300)
        // Release the guard for engines where print() was a silent no-op.
        setTimeout(() => { printBlocked = false }, 2000)
      } catch {
        printBlocked = false
        // Printing blocked/not allowed — don't leave a dead frame behind.
        removeIframe()
      }
    }

    try {
      doc.open()
      doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
      <style>${PRINT_BASE_CSS}</style></head><body>${html}</body></html>`)
      doc.close()
    } catch {
      // Document could not be written — no preview possible, clean up and bail.
      removeIframe()
      return
    }

    // Clean up only AFTER the print dialog is really gone (afterprint) — removing
    // the frame on a fixed timer while the preview is still open yanks the
    // document out from under the preview, and the preview then renders blank
    // ("receipt did not show on print preview").
    // ⚠ Register the listener only AFTER doc.write: document.open() replaces the
    // frame's document and Chrome drops Window listeners registered before it —
    // a pre-write listener would never fire and the frame would leak forever.
    win.addEventListener('afterprint', removeIframe)

    // Wait for the frame to FINISH loading before printing. Calling print() while a
    // heavy document (e.g. the full label sheet with many SVG barcodes) is still
    // parsing opens a preview that never finishes rendering and blocks the app.
    const ready = new Promise<void>(res => {
      iframe.addEventListener('load', () => res(), { once: true })
      if (doc.readyState === 'complete') res()
    })
    ready.then(() => {
      // Bounded wait for every image (logo data-URIs, barcode/label graphics) to
      // decode — opening the print dialog before images render can show a blank
      // or partial receipt in the print preview.
      const imgs = Array.from(doc.images || [])
      const decoded = Promise.all(imgs.map(im => (im.decode ? im.decode().catch(() => {}) : Promise.resolve())))
      const capped = new Promise<void>(res => setTimeout(res, 2500))
      void Promise.race([decoded, capped]).then(() => {
        // Let layout/fonts settle, then print.
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(doPrint, 50)))
      })
    })
    // Paranoia net: if the load event never arrives for any reason, still print.
    setTimeout(() => { if (!printed) doPrint() }, 3000)
  })
}

/** ─── Document builders ───────────────────────────────────────────── */

/** thermal receipt + A4 invoice HTML builders */
export interface ReceiptBiz {
  name: string; address: string; phone: string; logo: string; footer: string
  /** Draw a frame border around the printed receipt/invoice (default: on) */
  border?: boolean
}

/** App brand logo — printed as the header mark when the shop has no custom logo */
export const APP_LOGO_SRC = '/brand/logo-512.png'
function logoImg(src: string, style: string): string {
  return `<img src="${src || APP_LOGO_SRC}" style="${style}" />`
}
export interface ReceiptSale {
  invoiceNo: string; date: string; cashier: string; customer: string
  items: { name: string; quantity: number; price: number; total: number }[]
  subtotal: number; discount: number; tax: number; total: number; paid: number; due: number
  /** Cash handed over at the till — when above the total, the difference is printed as CHANGE */
  givenCash?: number
  paymentMethod: string; currency: string
  /** Scannable CODE128/EAN-13 SVG of the invoice number (rendered on print) */
  barcodeSvg?: string
}

export function thermalReceiptHTML(biz: ReceiptBiz, sale: ReceiptSale, widthMm = 80): string {
  const w = widthMm - 6
  const useBorder = biz.border !== false
  // border-box keeps total width inside the paper even with padding + frame
  const frame = useBorder
    ? `box-sizing:border-box;border:1.4px solid #000;padding:2.5mm;`
    : ''
  const row = (l: string, r: string, bold = false) =>
    `<tr class="${bold ? 'b' : ''}"><td>${l}</td><td class="r">${r}</td></tr>`
  const items = sale.items.map(i => `
    <tr><td colspan="2">${i.name}</td></tr>
    <tr><td class="dim">${i.quantity} x ${fmt(i.price)}</td><td class="r">${fmt(i.total)}</td></tr>`).join('')
  const change = sale.givenCash && sale.givenCash > sale.total
    ? Math.round((sale.givenCash - sale.total) * 100) / 100 : 0
  return `
  <div style="width:${w}mm;margin:0 auto;font-family:'Courier New',monospace;font-size:11px;line-height:1.35;${frame}">
    <div style="text-align:center;">
      ${logoImg(biz.logo, 'max-width:38mm;max-height:16mm;object-fit:contain;margin-bottom:2mm;')}
      <div style="font-weight:bold;font-size:14px;">${esc(biz.name)}</div>
      ${biz.address ? `<div>${esc(biz.address)}</div>` : ''}
      ${biz.phone ? `<div>Ph: ${esc(biz.phone)}</div>` : ''}
    </div>
    <div style="border-top:1px dashed #000;border-bottom:1px dashed #000;margin:2mm 0;padding:1mm 0;">
      <div>Invoice: <b>${esc(sale.invoiceNo)}</b></div>
      <div>Date: ${esc(sale.date)}</div>
      <div>Cashier: ${esc(sale.cashier)}</div>
      ${sale.customer && sale.customer !== 'Walk-in Customer' ? `<div>Customer: ${esc(sale.customer)}</div>` : ''}
    </div>
    <table style="width:100%;border:none;font-size:11px;">${items}</table>
    <div style="border-top:1px dashed #000;margin-top:1mm;padding-top:1mm;">
      <table style="width:100%;border:none;font-size:11px;">
        ${row('Subtotal', fmt(sale.subtotal))}
        ${sale.discount ? row('Discount', '- ' + fmt(sale.discount)) : ''}
        ${sale.tax ? row('Tax', fmt(sale.tax)) : ''}
        ${row('TOTAL', fmt(sale.total), true)}
        ${row('Paid (' + sale.paymentMethod + ')', fmt(sale.paid))}
        ${sale.givenCash && sale.givenCash > 0 ? row('Cash given', fmt(sale.givenCash)) : ''}
        ${change ? row('CHANGE', fmt(change), true) : ''}
        ${sale.due ? row('DUE', fmt(sale.due), true) : ''}
      </table>
    </div>
    ${sale.barcodeSvg ? `<div class="bc" style="margin-top:2.5mm;padding-top:1.5mm;border-top:1px dashed #000;">${sale.barcodeSvg}</div>` : ''}
    <div style="text-align:center;margin-top:2.5mm;border-top:1px dashed #000;padding-top:2mm;">
      <div>${esc(biz.footer || 'Thank you for shopping with us!')}</div>
      <div style="font-size:9px;margin-top:1mm;">Powered by SmartMart POS</div>
    </div>
  </div>
  <style>
    table td { padding: 0.4mm 0; border: none !important; }
    td.r { text-align: right; white-space: nowrap; }
    tr.b td { font-weight: bold; }
    td.dim { color: #444; }
    @media print { @page { margin: 2mm; size: ${widthMm}mm auto; } body { margin: 0; } }
  </style>`
}

export function invoiceHTML(biz: ReceiptBiz, sale: ReceiptSale & { customerId?: string }): string {
  const rows = sale.items.map((i, idx) => `
    <tr><td>${idx + 1}</td><td>${esc(i.name)}</td><td class="num">${i.quantity}</td>
    <td class="num">${fmt(i.price)}</td><td class="num">${fmt(i.total)}</td></tr>`).join('')
  const frame = biz.border !== false
    ? 'box-sizing:border-box;border:1.5px solid #333;border-radius:2mm;padding:7mm;'
    : ''
  const change = sale.givenCash && sale.givenCash > sale.total
    ? Math.round((sale.givenCash - sale.total) * 100) / 100 : 0
  return `
  <div style="max-width:190mm;margin:0 auto;${frame}">
    <div class="head">
      <div style="display:flex;gap:12px;align-items:center;">
        ${logoImg(biz.logo, 'max-width:26mm;max-height:20mm;object-fit:contain;')}
        <div>
          <h1 style="margin:0;">${esc(biz.name)}</h1>
          <div class="muted">${esc(biz.address)}${biz.phone ? ' · Ph: ' + esc(biz.phone) : ''}</div>
        </div>
      </div>
      <div style="text-align:right;">
        <h2 style="margin:0;">SALES INVOICE</h2>
        <div><b>${esc(sale.invoiceNo)}</b></div>
        <div class="muted">${esc(sale.date)}</div>
        ${sale.barcodeSvg ? `<div class="bc" style="margin-top:6px;">${sale.barcodeSvg}</div>` : ''}
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:8px;">
      <div><b>Customer:</b> ${esc(sale.customer || 'Walk-in Customer')}</div>
      <div><b>Cashier:</b> ${esc(sale.cashier)} · <b>Payment:</b> ${esc(sale.paymentMethod)}</div>
    </div>
    <table>
      <thead><tr><th style="width:28px;">#</th><th>Product</th><th class="num" style="width:70px;">Qty</th><th class="num" style="width:90px;">Price</th><th class="num" style="width:100px;">Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals">
      <div><span>Subtotal</span><span>${fmt(sale.subtotal)}</span></div>
      ${sale.discount ? `<div><span>Discount</span><span>- ${fmt(sale.discount)}</span></div>` : ''}
      ${sale.tax ? `<div><span>Tax</span><span>${fmt(sale.tax)}</span></div>` : ''}
      <div class="grand"><span>TOTAL (${esc(currencyInfo(sale.currency).symbol)})</span><span>${fmt(sale.total)}</span></div>
      <div><span>Paid</span><span>${fmt(sale.paid)}</span></div>
      ${sale.givenCash && sale.givenCash > 0 ? `<div><span>Cash given</span><span>${fmt(sale.givenCash)}</span></div>` : ''}
      ${change ? `<div class="grand"><span>CHANGE</span><span>${fmt(change)}</span></div>` : ''}
      ${sale.due ? `<div><span>Balance Due</span><span>${fmt(sale.due)}</span></div>` : ''}
    </div>
    <p class="muted" style="text-align:center;margin-top:18px;">${esc(biz.footer || 'Thank you for your business!')}</p>
  </div>`
}

function fmt(n: number): string {
  return (typeof n === 'number' ? n : 0).toLocaleString('en-PK', { maximumFractionDigits: 2 })
}
function esc(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** A4 purchase invoice (stock-in from supplier) */
export interface PurchaseDoc {
  invoiceNo: string; date: string; supplier: string; status: string
  items: { name: string; quantity: number; unitCost: number; total: number; returnedQty?: number }[]
  subtotal: number; discount: number; tax: number; total: number; paid: number; due: number
  currency: string
  barcodeSvg?: string
}

export function purchaseInvoiceHTML(biz: ReceiptBiz, p: PurchaseDoc): string {
  const rows = p.items.map((i, idx) => `
    <tr><td>${idx + 1}</td><td>${esc(i.name)}</td><td class="num">${i.quantity}</td>
    <td class="num">${fmt(i.unitCost)}</td><td class="num">${fmt(i.total)}</td>
    <td class="num">${i.returnedQty || 0}</td></tr>`).join('')
  const frame = biz.border !== false
    ? 'box-sizing:border-box;border:1.5px solid #333;border-radius:2mm;padding:7mm;'
    : ''
  return `
  <div style="max-width:190mm;margin:0 auto;${frame}">
    <div class="head">
      <div style="display:flex;gap:12px;align-items:center;">
        ${logoImg(biz.logo, 'max-width:26mm;max-height:20mm;object-fit:contain;')}
        <div>
          <h1 style="margin:0;">${esc(biz.name)}</h1>
          <div class="muted">${esc(biz.address)}${biz.phone ? ' · Ph: ' + esc(biz.phone) : ''}</div>
        </div>
      </div>
      <div style="text-align:right;">
        <h2 style="margin:0;">PURCHASE INVOICE</h2>
        <div><b>${esc(p.invoiceNo)}</b></div>
        <div class="muted">${esc(p.date)}</div>
        ${p.barcodeSvg ? `<div class="bc" style="margin-top:6px;">${p.barcodeSvg}</div>` : ''}
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:8px;">
      <div><b>Supplier:</b> ${esc(p.supplier || '—')}</div>
      <div><b>Status:</b> ${esc(p.status)}</div>
    </div>
    <table>
      <thead><tr><th style="width:28px;">#</th><th>Item</th><th class="num" style="width:70px;">Qty</th><th class="num" style="width:90px;">Cost</th><th class="num" style="width:100px;">Total</th><th class="num" style="width:70px;">Returned</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals">
      <div><span>Subtotal</span><span>${fmt(p.subtotal)}</span></div>
      ${p.discount ? `<div><span>Discount</span><span>- ${fmt(p.discount)}</span></div>` : ''}
      ${p.tax ? `<div><span>Tax</span><span>${fmt(p.tax)}</span></div>` : ''}
      <div class="grand"><span>TOTAL (${esc(currencyInfo(p.currency).symbol)})</span><span>${fmt(p.total)}</span></div>
      <div><span>Paid</span><span>${fmt(p.paid)}</span></div>
      ${p.due ? `<div><span>Balance Due</span><span>${fmt(p.due)}</span></div>` : ''}
    </div>
    <p class="muted" style="text-align:center;margin-top:18px;">${esc(biz.footer || 'Thank you for your business!')}</p>
  </div>`
}

/** ─── Barcode label sheets ─────────────────────────────────────── */
export type LabelSize = 'small' | 'standard' | 'large' | 'jumbo'
/** Label stock sizes offered in the print dialogs (mm). */
export const LABEL_SIZES: { key: LabelSize; name: string; dims: string }[] = [
  { key: 'small', name: 'Small', dims: '38 × 25 mm' },
  { key: 'standard', name: 'Standard', dims: '48 × 28 mm' },
  { key: 'large', name: 'Large', dims: '60 × 40 mm' },
  { key: 'jumbo', name: 'Jumbo', dims: '80 × 50 mm' },
]
const LABEL_DIMS: Record<LabelSize, {
  w: number; h: number; bw: number; bh: number; store: number; name: number; meta: number; price: number
}> = {
  small: { w: 38, h: 25, bw: 32, bh: 10, store: 7, name: 8, meta: 6, price: 9 },
  standard: { w: 48, h: 28, bw: 42, bh: 12, store: 8, name: 9, meta: 7, price: 11 },
  large: { w: 60, h: 40, bw: 54, bh: 16, store: 9, name: 11, meta: 8, price: 13 },
  jumbo: { w: 80, h: 50, bw: 72, bh: 20, store: 11, name: 13, meta: 9, price: 15 },
}

/** barcode label sheet: grid of labels; `size` picks the label stock dimensions */
export function barcodeLabelsHTML(
  biz: ReceiptBiz,
  items: { name: string; price: number; barcode: string; sku: string }[],
  svgProvider: (code: string) => string,
  copies = 1,
  currency = 'PKR',
  size: LabelSize = 'standard'
): string {
  const d = LABEL_DIMS[size] || LABEL_DIMS.standard
  let cells = ''
  for (const it of items) {
    for (let c = 0; c < copies; c++) {
      cells += `
      <div class="label">
        <div class="store">${esc(biz.name)}</div>
        <div class="pname">${esc(it.name)}</div>
        <div class="bcode">${svgProvider(it.barcode)}</div>
        <div class="meta">${esc(it.sku)}</div>
        <div class="price">${formatMoney(it.price, currency)}</div>
      </div>`
    }
  }
  return `<div class="sheet">${cells}</div>
  <style>
    body { margin: 8px; }
    .sheet { display: flex; flex-wrap: wrap; gap: 4mm; }
    .label { width: ${d.w}mm; height: ${d.h}mm; border: 1px dashed #bbb; padding: 1.5mm; box-sizing: border-box;
             display: flex; flex-direction: column; align-items: center; justify-content: center; page-break-inside: avoid; }
    .store { font-size: ${d.store}px; font-weight: bold; }
    .pname { font-size: ${d.name}px; max-width: ${d.w - 2}mm; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bcode svg { width: ${d.bw}mm; height: ${d.bh}mm; }
    .meta { font-size: ${d.meta}px; color: #555; }
    .price { font-size: ${d.price}px; font-weight: bold; }
    @media print { @page { margin: 4mm; } .label { border: 1px dashed #ddd; } }
  </style>`
}

/** ─── Payslip (A4, half-page friendly) ─────────────────────────── */
export interface PayslipBiz { name: string; address: string; phone: string; logo: string; currency: string }
export interface PayslipItem {
  name: string; role: string; cnic: string; month: string
  baseSalary: number; perDay: number
  presentDays: number; absentDays: number; halfDays: number; lateCount: number
  bonus: number; deduction: number; advance: number; netPay: number
  method: string; paidAt: string | null; note: string
}

export function payslipHTML(biz: PayslipBiz, items: PayslipItem[]): string {
  const cur = biz.currency || 'PKR'
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c))
  const money = (n: number) => formatMoney(n, cur)
  const monthLabel = (m: string) => {
    const [y, mm] = m.split('-').map(Number)
    return new Date(Date.UTC(y, (mm || 1) - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  }
  const rows = items.map((it, i) => `
    <div class="slip ${i > 0 ? 'break' : ''}">
      <div class="head">
        <div class="hl">${biz.logo ? `<img src="${biz.logo}" class="lg" />` : ''}
          <div><h1>${esc(biz.name)}</h1><div class="muted">${esc(biz.address)}${biz.address && biz.phone ? ' · ' : ''}${esc(biz.phone)}</div></div>
        </div>
        <div style="text-align:right"><div class="badge">SALARY SLIP</div><div class="muted" style="margin-top:4px">${esc(monthLabel(it.month))}</div>
        <div class="muted">Paid: ${it.paidAt ? esc(new Date(it.paidAt).toLocaleDateString('en-GB')) : '—'} · ${esc(it.method)}</div></div>
      </div>
      <table class="emp">
        <tr><td><span class="muted">Employee</span><br/><b>${esc(it.name)}</b></td>
            <td><span class="muted">Designation</span><br/><b>${esc(it.role.replace('_', ' '))}</b></td>
            <td><span class="muted">CNIC</span><br/><b>${esc(it.cnic || '—')}</b></td></tr>
      </table>
      <table>
        <tr><th>Attendance</th><th class="num">Days</th><th>Earnings / Deductions</th><th class="num">Amount</th></tr>
        <tr><td>Present (incl. late: ${it.lateCount})</td><td class="num">${it.presentDays}</td>
            <td>Basic salary</td><td class="num">${money(it.baseSalary)}</td></tr>
        <tr><td>Absent</td><td class="num">${it.absentDays}</td>
            <td>Bonus ${it.note ? `<span class="muted">(${esc(it.note)})</span>` : ''}</td><td class="num">${money(it.bonus)}</td></tr>
        <tr><td>Half days</td><td class="num">${it.halfDays}</td>
            <td>Deductions (absence/other)</td><td class="num">− ${money(it.deduction)}</td></tr>
        <tr><td>Per-day rate</td><td class="num">${money(it.perDay)}</td>
            <td>Advance recovered</td><td class="num">− ${money(it.advance)}</td></tr>
      </table>
      <div class="totals"><div class="grand"><span>NET PAYABLE</span><span>${money(it.netPay)}</span></div></div>
      <div class="sign"><span>Employee signature</span><span>Authorized signature</span></div>
    </div>`).join('')
  return `${rows}
  <style>
    body { margin: 16px; font-size: 12px; }
    .slip { border: 1.5px solid #111; border-radius: 6px; padding: 14px 16px; margin-bottom: 14px; }
    .slip.break { page-break-before: always; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 10px; }
    .hl { display: flex; gap: 10px; align-items: center; }
    .lg { width: 42px; height: 42px; object-fit: contain; }
    h1 { font-size: 18px; margin: 0; }
    .muted { color: #666; font-size: 11px; }
    .badge { display: inline-block; border: 1px solid #555; border-radius: 4px; padding: 2px 10px; font-weight: 700; font-size: 11px; letter-spacing: 1px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #ccc; padding: 5px 8px; text-align: left; }
    th { background: #f3f4f6; font-size: 11px; }
    .num { text-align: right; }
    .emp td { border: none; padding: 4px 8px 4px 0; }
    .totals { margin-top: 10px; display: flex; justify-content: flex-end; }
    .grand { display: flex; gap: 40px; font-weight: 800; font-size: 15px; border-top: 2px solid #111; padding-top: 6px; }
    .sign { display: flex; justify-content: space-between; margin-top: 42px; color: #444; font-size: 11px; }
    .sign span { border-top: 1px dotted #888; padding-top: 4px; min-width: 180px; text-align: center; }
  </style>`
}

/** ─── Customer khata statement (A4) — overall or date-wise ─────── */
export interface StatementBiz { name: string; address: string; phone: string; logo: string; currency: string }
export interface StatementTxn {
  type: string; amount: number; balanceAfter: number; refNo: string; note: string; createdAt: string
}
export interface StatementDoc {
  customer: { name: string; phone: string; address: string; creditLimit: number }
  txns: StatementTxn[]
  /** running balance carried into the printed period (openingBalance for full statements) */
  opening: number
  summary: {
    totalDue: number; periodDebit: number; periodCredit: number
    hasRange: boolean; from: string; to: string
  }
}

export const TXN_TYPE_LABEL: Record<string, string> = {
  SALE_CREDIT: 'Credit sale', PAYMENT: 'Payment received', RETURN: 'Return refund',
  ADJUST: 'Adjustment', OPENING: 'Opening balance',
}

export function statementHTML(biz: StatementBiz, doc: StatementDoc): string {
  const cur = biz.currency || 'PKR'
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c))
  const money = (n: number) => formatMoney(n, cur)
  const d = (s: string) => new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const period = doc.summary.hasRange
    ? `${doc.summary.from || 'beginning'} → ${doc.summary.to || 'today'}`
    : 'All transactions (overall)'

  const rows = doc.txns.map(t => {
    const debit = t.amount > 0 ? money(t.amount) : ''
    const credit = t.amount < 0 ? money(-t.amount) : ''
    return `<tr>
      <td class="nw">${d(t.createdAt)}</td>
      <td>${esc(TXN_TYPE_LABEL[t.type] || t.type.replace('_', ' '))}</td>
      <td>${esc(t.refNo || '—')}</td>
      <td>${esc(t.note || '')}</td>
      <td class="num debit">${debit}</td>
      <td class="num credit">${credit}</td>
      <td class="num"><b>${money(t.balanceAfter)}</b></td>
    </tr>`
  }).join('')

  const emptyRow = doc.txns.length === 0
    ? `<tr><td colspan="7" class="empty">No transactions in this period.</td></tr>`
    : ''

  return `
  <div class="head">
    <div class="hl">${biz.logo ? `<img src="${biz.logo}" class="lg" />` : ''}
      <div><h1>${esc(biz.name)}</h1>
        <div class="muted">${esc(biz.address)}${biz.address && biz.phone ? ' · ' : ''}${esc(biz.phone)}</div></div>
    </div>
    <div style="text-align:right">
      <div class="badge">KHATA STATEMENT</div>
      <div class="muted" style="margin-top:5px">Period: <b>${esc(period)}</b></div>
      <div class="muted">Printed: ${new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
    </div>
  </div>
  <table class="cust">
    <tr>
      <td><span class="muted">Customer</span><br/><b style="font-size:14px">${esc(doc.customer.name)}</b></td>
      <td><span class="muted">Phone</span><br/><b>${esc(doc.customer.phone || '—')}</b></td>
      <td><span class="muted">Address</span><br/><b>${esc(doc.customer.address || '—')}</b></td>
      <td><span class="muted">Credit limit</span><br/><b>${doc.customer.creditLimit > 0 ? money(doc.customer.creditLimit) : '—'}</b></td>
    </tr>
  </table>
  <table>
    <thead><tr>
      <th>Date</th><th>Type</th><th>Reference</th><th>Note</th>
      <th class="num">Debit (owed)</th><th class="num">Credit (paid)</th><th class="num">Balance</th>
    </tr></thead>
    <tbody>
      <tr class="bf"><td colspan="4"><i>Opening balance (brought forward)</i></td>
        <td class="num" colspan="3"><b>${money(doc.opening)}</b></td></tr>
      ${rows}${emptyRow}
    </tbody>
  </table>
  <div class="totals">
    <div><span>Period debit (new dues)</span><span>${money(doc.summary.periodDebit)}</span></div>
    <div><span>Period credit (payments)</span><span>${money(doc.summary.periodCredit)}</span></div>
    <div class="grand"><span>TOTAL DUE NOW (${esc(cur)})</span><span>${money(doc.summary.totalDue)}</span></div>
  </div>
  <div class="sign"><span>Customer signature</span><span>For ${esc(biz.name)}</span></div>
  <style>
    body { margin: 16px; font-size: 12px; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 10px; }
    .hl { display: flex; gap: 10px; align-items: center; }
    .lg { width: 42px; height: 42px; object-fit: contain; }
    h1 { font-size: 18px; margin: 0; }
    .muted { color: #666; font-size: 11px; }
    .badge { display: inline-block; border: 1px solid #555; border-radius: 4px; padding: 2px 10px; font-weight: 700; font-size: 11px; letter-spacing: 1px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #ccc; padding: 5px 8px; text-align: left; }
    th { background: #f3f4f6; font-size: 11px; }
    .num { text-align: right; white-space: nowrap; }
    .nw { white-space: nowrap; }
    .cust td { border: none; padding: 3px 10px 3px 0; vertical-align: top; }
    .bf td { background: #fafafa; font-size: 11px; }
    .debit { color: #b91c1c; }
    .credit { color: #047857; }
    .empty { text-align: center; color: #888; padding: 16px; }
    .totals { margin-top: 10px; font-size: 12px; }
    .totals div { display: flex; justify-content: flex-end; gap: 28px; padding: 2px 0; }
    .grand { font-weight: 800; font-size: 15px; border-top: 2px solid #111; padding-top: 6px; }
    .sign { display: flex; justify-content: space-between; margin-top: 42px; color: #444; font-size: 11px; }
    .sign span { border-top: 1px dotted #888; padding-top: 4px; min-width: 180px; text-align: center; }
    @media print { @page { margin: 14mm 12mm; } }
  </style>`
}
