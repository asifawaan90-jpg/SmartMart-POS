'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCartStore, type CartLine } from '@/stores/cart'
import { useAuthStore } from '@/stores/auth'
import { useT } from '@/stores/lang'
import { useOfflineStore, syncNow } from '@/stores/offline'
import { api, errMsg, isNetworkError, statusOf } from '@/lib/client'
import { fmtMoney, r2 } from '@/lib/format'
import { uuid } from '@/lib/uid'
import { jsbarcodeSvg } from '@/lib/barcode-client'
// Print engine imported STATICALLY (lightweight, xlsx-free): printHTML must run
// inside the tap gesture so it can open the mobile print window — a dynamic
// import would resolve after the gesture expired and mobile printing breaks.
import { printHTML, thermalReceiptHTML, invoiceHTML } from '@/lib/print'
import { useScannerWedge, findProductByCode, looksLikeBarcode, beepOk, beepErr, scanSoundOn, setScanSoundOn } from '@/lib/scanner'
import { startBarcodeScanner, applyScanTrackOptimizations, type BarcodeScannerHandle } from '@/lib/barcode-engine'
import { lookupInvoice, looksLikeInvoiceCode, type InvoiceLookupResult } from '@/lib/invoice-lookup'
import InvoiceViewDialog from '@/components/shared/invoice-view-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import {
  Search, Trash2, PauseCircle, PlayCircle, X, Check, Camera, Minus, Plus,
  CreditCard, Banknote, Landmark, Smartphone, BookUser, Printer, FileText, Share2, ShoppingCart, PackageX,
  Volume2, VolumeX, Flashlight, ScanLine, CheckCircle2,
} from 'lucide-react'

interface Product {
  id: string; name: string; sku: string; barcode: string; retailPrice: number
  costPrice: number; taxRate: number; stock: number; categoryId: string | null
  unit?: string | null
}
interface Category { id: string; name: string }
interface Customer { id: string; name: string; phone: string; balance?: number }

const METHODS = [
  { id: 'CASH', label: 'Cash', icon: Banknote },
  { id: 'CARD', label: 'Card', icon: CreditCard },
  { id: 'BANK', label: 'Bank Transfer', icon: Landmark },
  { id: 'DIGITAL', label: 'Digital Wallet', icon: Smartphone },
  { id: 'KHATA', label: 'Khata (Credit)', icon: BookUser },
]

interface SaleResult {
  id?: string
  invoiceNo: string
  total: number
  paid: number
  givenCash?: number
  dueAmount: number
  offline?: boolean
  duplicate?: boolean
}

/** Checkout-time snapshot so the receipt prints even without the sale-detail API (offline sales have no server id). */
interface ReceiptSnapshot {
  items: { name: string; quantity: number; price: number; total: number }[]
  customer: string
  paymentMethod: string
  subtotal: number
  discount: number
  tax: number
}

/** POS treats product.unit as a plain string everywhere (cart lines, labels, toasts).
 *  The API (and legacy offline caches) can carry the full Unit object
 *  {id, businessId, name, shortName} — rendering that object as a JSX child throws
 *  React minified error #31. Flatten on EVERY path that feeds `products`, including
 *  the offline-cache read which historically bypassed the flattening. */
function flattenProducts(v: unknown): Product[] {
  const arr = Array.isArray(v) ? v : []
  return arr.map(x => {
    const p = (x ?? {}) as Record<string, unknown>
    const u = p.unit
    let unit = ''
    if (typeof u === 'string') unit = u
    else if (u && typeof u === 'object') {
      const o = u as { shortName?: unknown; name?: unknown }
      unit = typeof o.shortName === 'string' ? o.shortName : typeof o.name === 'string' ? o.name : ''
    }
    return { ...(p as unknown as Product), unit: unit.trim() }
  })
}

export default function PosView() {
  const { business } = useAuthStore()
  const t = useT()
  const cart = useCartStore()
  const deviceId = useOfflineStore(s => s.deviceId)
  const enqueue = useOfflineStore(s => s.enqueue)
  const cur = business?.currency || 'PKR'
  // Payment-method labels in the UI language (Task 50)
  const methodLabel: Record<string, string> = {
    CASH: t('pos.cash'), CARD: t('pos.card'), BANK: t('pos.bank'),
    DIGITAL: t('pos.wallet'), KHATA: t('pos.khataCredit'),
  }
  const cacheKey = useCallback((k: string) => `pos_cache_${business?.id || 'x'}_${k}`, [business?.id])

  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [offlineData, setOfflineData] = useState(false)
  const [payOpen, setPayOpen] = useState(false)
  const [holdsOpen, setHoldsOpen] = useState(false)
  const [receipt, setReceipt] = useState<(SaleResult & { snapshot?: ReceiptSnapshot }) | null>(null)
  const [busy, setBusy] = useState(false)
  const [scanMsg, setScanMsg] = useState('')
  const [scanMsgKind, setScanMsgKind] = useState<'ok' | 'err'>('ok')
  const [scanFlash, setScanFlash] = useState<'ok' | 'err' | null>(null)
  const [soundOn, setSoundOn] = useState(true)
  // invoice document opened by scanning its barcode (INV / RET / PUR / PRET)
  const [invoiceFound, setInvoiceFound] = useState<InvoiceLookupResult | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const productsRef = useRef<Product[]>([])
  const lastScanRef = useRef<{ code: string; at: number }>({ code: '', at: 0 })

  // camera scanner state
  const [camOpen, setCamOpen] = useState(false)
  const [camLog, setCamLog] = useState<string[]>([])
  const [camError, setCamError] = useState('')
  const [camStarting, setCamStarting] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const scanEngineRef = useRef<BarcodeScannerHandle | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const camOpenRef = useRef(false)

  /** Toast-style scan message with success/error styling. */
  const say = useCallback((msg: string, kind: 'ok' | 'err' = 'ok', ms = 2000) => {
    setScanMsgKind(kind)
    setScanMsg(msg)
    window.setTimeout(() => setScanMsg(cur => (cur === msg ? '' : cur)), ms)
  }, [])

  /** Brief green/red flash on the scan box — professional scan feedback. */
  const flash = useCallback((kind: 'ok' | 'err') => {
    setScanFlash(kind)
    window.setTimeout(() => setScanFlash(null), 350)
  }, [])

  const totals = cart.totals()

  // load catalog (with offline cache fallback)
  const loadProducts = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [p, c, cust] = await Promise.all([
        api<{ items: Product[] }>('/api/products?all=1&status=active'),
        api<Category[]>('/api/master/categories'),
        api<Customer[]>('/api/customers'),
      ])
      const flat = flattenProducts(p.items)
      setProducts(flat)
      setCategories(c)
      setCustomers(cust)
      setOfflineData(false)
      try {
        localStorage.setItem(cacheKey('products'), JSON.stringify(flat))
        localStorage.setItem(cacheKey('categories'), JSON.stringify(c))
        localStorage.setItem(cacheKey('customers'), JSON.stringify(cust))
      } catch { /* quota */ }
    } catch {
      try {
        const p = flattenProducts(JSON.parse(localStorage.getItem(cacheKey('products')) || '[]'))
        const c = JSON.parse(localStorage.getItem(cacheKey('categories')) || '[]')
        const cust = JSON.parse(localStorage.getItem(cacheKey('customers')) || '[]')
        setProducts(p)
        setCategories(Array.isArray(c) ? c : [])
        setCustomers(Array.isArray(cust) ? cust : [])
        setOfflineData(true)
      } catch { /* nothing cached */ }
    } finally { setLoading(false) }
  }, [cacheKey])

  useEffect(() => { loadProducts() }, [loadProducts])

  useEffect(() => { productsRef.current = products }, [products])
  useEffect(() => { setSoundOn(scanSoundOn()) }, [])

  // reset cart when business changes (tenant safety)
  const setCartBiz = useCartStore(s => s.setBiz)
  useEffect(() => {
    if (business?.id) setCartBiz(business.id)
  }, [business?.id, setCartBiz])

  // disable heavy animations in POS
  useEffect(() => {
    document.documentElement.setAttribute('data-pos', '1')
    return () => { document.documentElement.removeAttribute('data-pos') }
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return products.filter(p => {
      if (catFilter && p.categoryId !== catFilter) return false
      if (!q) return true
      return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.barcode.includes(q)
    })
  }, [products, search, catFilter])

  /** Adds one unit; returns the line quantity now in cart (0 when blocked). */
  const addToCart = useCallback((p: Product): number => {
    const inCart = useCartStore.getState().lines.find(l => l.productId === p.id)?.qty ?? 0
    if (p.stock <= 0) {
      beepErr(); flash('err')
      say(`"${p.name}" is out of stock`, 'err', 2500)
      return 0
    }
    if (inCart + 1 > p.stock) {
      beepErr(); flash('err')
      say(`Max stock reached — only ${r2(p.stock)} ${p.unit || ''} of "${p.name}" available`, 'err', 2500)
      return inCart
    }
    const line: CartLine = {
      productId: p.id, name: p.name, sku: p.sku, barcode: p.barcode,
      price: p.retailPrice, cost: p.costPrice, qty: 1,
      discount: 0, taxRate: p.taxRate || 0, stock: p.stock, unit: p.unit || undefined,
    }
    cart.add(line)
    const qty = useCartStore.getState().lines.find(l => l.productId === p.id)?.qty ?? inCart + 1
    beepOk(); flash('ok')
    say(`+ ${p.name}${qty > 1 ? `  ·  qty ${r2(qty)}` : ''}`, 'ok', 1400)
    return qty
  }, [cart, say, flash])

  /** Central scan pipeline: dedup → strict lookup → add to cart → feedback.
   *  Product miss + invoice-shaped code → universal invoice lookup → the
   *  document opens on screen instantly with print options for the customer. */
  const processScan = useCallback((raw: string, opts?: { fromCamera?: boolean }) => {
    const code = raw.trim()
    if (!code) return
    const now = Date.now()
    if (lastScanRef.current.code === code && now - lastScanRef.current.at < 350) return
    lastScanRef.current = { code, at: now }
    const hit = findProductByCode(productsRef.current, code)
    if (hit) {
      const qty = addToCart(hit.product)
      if (opts?.fromCamera && qty > 0) setCamLog(l => [`✓ ${hit.product.name}${qty > 1 ? ` ×${r2(qty)}` : ''}`, ...l].slice(0, 6))
    } else if (looksLikeInvoiceCode(code)) {
      say(`Looking up ${code}…`, 'ok', 1600)
      lookupInvoice(code).then(res => {
        if (res) {
          beepOk(); flash('ok')
          const no = res.purchase?.invoiceNo || res.sale?.invoiceNo || code
          setInvoiceFound(res)
          if (opts?.fromCamera) setCamLog(l => [`✓ Invoice ${no} opened`, ...l].slice(0, 6))
          say(`Invoice ${no} opened on screen — print from the dialog`, 'ok', 2400)
        } else {
          beepErr(); flash('err')
          say(`Unknown barcode: ${code}`, 'err', 3000)
        }
      }).catch(() => {
        beepErr(); flash('err')
        say(`Could not look up ${code}`, 'err', 3000)
      })
    } else {
      beepErr(); flash('err')
      say(`Unknown barcode: ${code}`, 'err', 3000)
    }
  }, [addToCart, say, flash])

  const handleSearchEnter = () => {
    const q = search.trim()
    if (!q) return
    // strict barcode/SKU lookup first — a scan must never add the wrong item
    const exact = findProductByCode(products, q)
    if (exact) {
      addToCart(exact.product)
      setSearch('')
      searchRef.current?.focus()
      return
    }
    // numeric input that looks like a barcode → never guess from the list
    if (looksLikeBarcode(q)) {
      beepErr(); flash('err')
      say(`Unknown barcode: ${q}`, 'err', 3000)
      setSearch('')
      searchRef.current?.focus()
      return
    }
    // invoice / return number → open the document on screen instantly
    if (looksLikeInvoiceCode(q)) {
      say(`Looking up ${q}…`, 'ok', 1600)
      lookupInvoice(q).then(res => {
        if (res) {
          beepOk(); flash('ok')
          setInvoiceFound(res)
          say(`Invoice ${res.purchase?.invoiceNo || res.sale?.invoiceNo} opened on screen`, 'ok', 2400)
        } else {
          beepErr(); flash('err')
          say(`No invoice matches "${q}"`, 'err', 3000)
        }
      }).catch(() => { beepErr(); flash('err'); say(`Could not look up ${q}`, 'err', 3000) })
      setSearch('')
      searchRef.current?.focus()
      return
    }
    const hit = filtered[0]
    if (hit) {
      addToCart(hit)
      setSearch('')
    } else {
      say(`No product found for "${q}"`, 'err', 2200)
    }
  }

  /* ---------------- camera scanner (professional) ----------------
   * - back camera preferred (facingMode: environment)
   * - owns its MediaStream → clean stop on close/unmount (no leaks)
   * - stays open for rapid multi-item scanning with per-scan feedback
   * - same-code cooldown + frame-echo guard → one scan never adds twice
   * - torch toggle when the camera supports it
   */
  const stopCamera = useCallback(() => {
    camOpenRef.current = false
    scanEngineRef.current?.stop()
    scanEngineRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setTorchOn(false)
  }, [])

  const openCamera = useCallback(async () => {
    if (camOpenRef.current) return
    setCamError(''); setCamLog([]); setCamStarting(true)
    setCamOpen(true)
    camOpenRef.current = true
    // wait for the <video> element (dialog mount/animation) — no getElementById race
    let video = videoRef.current
    for (let i = 0; i < 30 && !video; i++) {
      await new Promise(r => setTimeout(r, 100))
      video = videoRef.current
    }
    if (!camOpenRef.current) return // closed while starting
    if (!video) { setCamStarting(false); setCamError('Video element not ready — close and reopen the scanner.'); return }
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw Object.assign(new Error('Camera unsupported'), { name: 'NotSupportedError' })
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      if (!camOpenRef.current) { stream.getTracks().forEach(t => t.stop()); return }
      streamRef.current = stream
      video.srcObject = stream
      await video.play().catch(() => { /* autoplay policy */ })
      // video is LIVE — clear the starting overlay NOW. The scan engine keeps
      // running until stopCamera(), so nothing after this needs to resolve.
      setCamStarting(false)
      applyScanTrackOptimizations(stream) // continuous autofocus where supported (Android)
      // fast scan engine: native BarcodeDetector on Android, ZXing center-ROI
      // adaptive decoder elsewhere — 10-20 probes/sec at a fraction of the old cost
      let lastCode = ''
      let lastAt = 0
      const engine = await startBarcodeScanner({
        video,
        onResult: (code) => {
          if (!code || !camOpenRef.current) return
          const t = Date.now()
          if (code === lastCode && t - lastAt < 1500) return // same-code cooldown (re-scan needs lift-away ≥1s, engine re-arm 1s)
          if (t - lastAt < 300) return                       // frame-echo guard
          lastCode = code
          lastAt = t
          processScan(code, { fromCamera: true })
        },
      })
      if (!camOpenRef.current) { engine?.stop(); return } // closed while the engine was spinning up
      scanEngineRef.current = engine
    } catch (e) {
      setCamStarting(false)
      const name = (e as { name?: string })?.name || ''
      setCamError(
        name === 'NotAllowedError' ? 'Camera permission denied. Allow camera access in your browser and try again.'
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No usable camera found on this device.'
        : name === 'NotReadableError' ? 'Camera is busy — close other apps using it and try again.'
        : 'Camera not available. Use a USB/Bluetooth scanner or type the barcode.'
      )
    }
  }, [processScan])

  const closeCamera = useCallback(() => {
    stopCamera()
    setCamOpen(false)
    searchRef.current?.focus()
  }, [stopCamera])

  // never leak the camera stream on unmount
  useEffect(() => () => stopCamera(), [stopCamera])

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    try {
      const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>
      if (!('torch' in caps)) { say('Torch not supported on this camera', 'err', 2000); return }
      await track.applyConstraints({ advanced: [{ torch: !torchOn } as unknown as MediaTrackConstraints] })
      setTorchOn(v => !v)
    } catch {
      say('Torch not supported on this camera', 'err', 2000)
    }
  }, [torchOn, say])

  const toggleSound = useCallback(() => {
    setSoundOn(v => {
      setScanSoundOn(!v)
      return !v
    })
  }, [])

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA'
      if (e.key === 'F1') { e.preventDefault(); searchRef.current?.focus() }
      else if (e.key === 'F2') { e.preventDefault(); cart.clear(); setSearch(''); setReceipt(null); searchRef.current?.focus() }
      else if (e.key === 'F4') { e.preventDefault(); if (cart.lines.length > 0) holdSale() }
      else if (e.key === 'F8') { e.preventDefault(); if (cart.lines.length > 0) setPayOpen(true) }
      else if (e.key === 'F9') { e.preventDefault(); void openCamera() }
      else if (e.key === 'Escape') { setPayOpen(false); setHoldsOpen(false) }
      else if (inInput && e.key === 'Enter' && e.target === searchRef.current) handleSearchEnter()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // global hardware-scanner capture — scans work no matter where focus is
  useScannerWedge(processScan, !payOpen && !camOpen && !holdsOpen && !receipt && !invoiceFound)

  // keep the scan box always ready: refocus whenever dialogs close
  useEffect(() => {
    if (!payOpen && !holdsOpen && !camOpen && !receipt && !invoiceFound) searchRef.current?.focus()
  }, [payOpen, holdsOpen, camOpen, receipt, invoiceFound])

  const holdSale = async () => {
    try {
      await api('/api/sales/hold', {
        method: 'POST',
        body: { label: `${cart.lines.length} items · ${fmtMoney(totals.total, cur)}`, customerId: cart.customerId, cart: cart.lines },
      })
      cart.clear()
      say('Sale held — resume from Held Sales', 'ok', 2000)
    } catch (e) { say(errMsg(e), 'err', 2500) }
  }

  const resumeHold = async (id: string) => {
    try {
      // GET /api/sales/hold returns the held sale with `cart` stored as a JSON
      // string (see POST /api/sales/hold) — parse it back before restoring.
      const held = await api<{ id: string; customerId: string | null; cart: string }>(`/api/sales/hold`)
      const h = (Array.isArray(held) ? held : []).find(x => x.id === id)
      if (!h) return
      const lines: CartLine[] = h.cart
        ? (() => { try { return JSON.parse(h.cart) } catch { return [] } })()
        : []
      cart.clear()
      for (const l of lines) cart.add(l)
      if (h.customerId) {
        const c = customers.find(x => x.id === h.customerId)
        cart.setCustomer(h.customerId, c?.name || '')
      }
      await api(`/api/sales/hold?id=${id}`, { method: 'DELETE' })
      setHoldsOpen(false)
    } catch { /* ignore */ }
  }

  const [holdsList, setHoldsList] = useState<{ id: string; label: string }[]>([])
  const openHolds = async () => {
    try {
      const list = await api<{ id: string; label: string }[]>('/api/sales/hold')
      setHoldsList(Array.isArray(list) ? list : [])
    } catch { setHoldsList([]) }
    setHoldsOpen(true)
  }

  // checkout
  const [payMethod, setPayMethod] = useState('CASH')
  const [partialPay, setPartialPay] = useState('')

  const checkout = async () => {
    if (cart.lines.length === 0) return
    if (payMethod === 'KHATA' && !cart.customerId) {
      say('Khata sale requires a customer. Select one first.', 'err', 2500)
      return
    }
    setBusy(true)
    // Snapshot for the receipt dialog — printing must work even if /sales/detail
    // never loads (offline sales have no server id to fetch it with).
    const snap: ReceiptSnapshot = {
      items: cart.lines.map(l => ({ name: l.name, quantity: l.qty, price: l.price, total: r2(l.price * l.qty - (l.discount || 0)) })),
      customer: cart.customerName || 'Walk-in Customer',
      paymentMethod: payMethod,
      subtotal: totals.subtotal, discount: totals.discount, tax: totals.tax,
    }
    // CASH: what the customer physically hands over (may exceed total → change).
    // KHATA: partial payment toward the bill. Other methods: full by default.
    const givenAmt = r2(parseFloat(partialPay) || 0)
    const paidAmt = payMethod === 'KHATA'
      ? givenAmt
      : partialPay === '' ? totals.total : givenAmt
    const payload = {
      clientRef: uuid(),
      customerId: cart.customerId,
      items: cart.lines.map(l => ({ productId: l.productId, quantity: l.qty, price: l.price, discount: l.discount, taxRate: l.taxRate })),
      discount: cart.discount, discountType: cart.discountType,
      paid: Math.min(paidAmt, totals.total),
      ...(payMethod === 'CASH' && givenAmt > 0 ? { givenCash: givenAmt } : {}),
      paymentMethod: payMethod,
    }
    if (!navigator.onLine) {
      enqueue({
        clientRef: payload.clientRef,
        kind: 'SALE',
        payload: { ...payload, deviceTs: new Date().toISOString() },
        createdAt: Date.now(), attempts: 0,
      })
      setReceipt({ invoiceNo: `OFF-${payload.clientRef.slice(0, 8).toUpperCase()}`, total: totals.total, paid: Math.min(paidAmt, totals.total), givenCash: payMethod === 'CASH' ? Math.max(givenAmt, Math.min(paidAmt, totals.total)) : 0, dueAmount: r2(totals.total - Math.min(paidAmt, totals.total)), offline: true, snapshot: snap })
      cart.clear(); setPayOpen(false); setPartialPay(''); setBusy(false)
      return
    }
    try {
      const sale = await api<SaleResult>('/api/sales', { method: 'POST', body: payload })
      setReceipt({ ...sale, offline: false, snapshot: snap })
      cart.clear(); setPayOpen(false); setPartialPay('')
      syncNow() // also drain any offline backlog
    } catch (e) {
      const msg = errMsg(e)
      const status = (e as { status?: number }).status
      // Task 45 — a sale must NEVER be lost to a transient failure: network
      // drops AND server 5xx both queue the sale locally. This is safe because
      // the sync engine is idempotent by clientRef — if the server actually
      // saved the sale, the queued push comes back DUPLICATE and is dropped
      // (never double-sold); if it did not save, the push completes it.
      // Task 67-b — robust reachability check (was a regex on the message text).
      const networkish = isNetworkError(e) || statusOf(e) === 0
      const serverish = typeof status === 'number' && status >= 500
      // Task 61 — a subscription wall (402) must never EAT a sale: queue it on
      // the device like an offline sale so it syncs the moment the plan is
      // renewed. Before this, a 402 only toasted and the cart items were lost.
      const subWall = status === 402
      // Task 67 — same guarantee for a dead session (401): the sale is queued
      // and syncs automatically right after the user logs in again (the sync
      // engine re-reads the fresh token on every attempt).
      const authWall = status === 401
      if (networkish || serverish || subWall || authWall) {
        enqueue({ clientRef: payload.clientRef, kind: 'SALE', payload: { ...payload, deviceTs: new Date().toISOString() }, createdAt: Date.now(), attempts: 0 })
        setReceipt({ invoiceNo: `OFF-${payload.clientRef.slice(0, 8).toUpperCase()}`, total: totals.total, paid: Math.min(paidAmt, totals.total), givenCash: payMethod === 'CASH' ? Math.max(givenAmt, Math.min(paidAmt, totals.total)) : 0, dueAmount: r2(totals.total - Math.min(paidAmt, totals.total)), offline: true, snapshot: snap })
        cart.clear(); setPayOpen(false); setPartialPay('')
        say(authWall
          ? 'Session expired — please log in again. Sale kept safe on this device and will sync after login.'
          : `${msg} — sale saved on this device and will sync automatically.`, 'err', 4200)
        if (!subWall && !authWall) syncNow() // try to drain it right away (a 402/401 wall won't drain yet)
      } else if (/INSUFFICIENT_STOCK|PRODUCT_NOT_FOUND/.test(msg)) {
        say(msg, 'err', 3500)
        loadProducts(true)
      } else {
        say(msg, 'err', 3500)
      }
    } finally { setBusy(false) }
  }

  return (
    // Mobile (<lg): natural page flow — the page scrolls, so the cart, totals and
    // PAY are always reachable by touch even with the on-screen keyboard open (a
    // fixed-height frame here crushed the products pane to 0px once the cart had
    // items and froze everything below the fold). Desktop (lg+): fixed app frame.
    <div className="flex flex-col lg:h-[calc(100dvh-3.5rem)] lg:flex-row">
      {/* Products side */}
      <div className="flex flex-col min-w-0 border-b lg:border-b-0 lg:border-r lg:flex-1 lg:min-h-0">
        {/* search + scan */}
        <div className="p-3 border-b space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('pos.scan')}
                className={cn(
                  // text-base on phones: 16px is the iOS no-auto-zoom floor —
                  // a smaller font makes Safari zoom the whole POS on focus.
                  'pl-8 h-9 text-base md:text-sm transition-shadow duration-150',
                  scanFlash === 'ok' && 'ring-2 ring-emerald-500 border-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.45)]',
                  scanFlash === 'err' && 'ring-2 ring-red-500 border-red-500 shadow-[0_0_12px_rgba(239,68,68,0.45)]'
                )}
                autoFocus
                autoComplete="off"
              />
            </div>
            <Button variant="outline" size="sm" className="h-9 px-2.5" onClick={toggleSound} title={soundOn ? 'Scan beep: on' : 'Scan beep: off'}>
              {soundOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4 text-muted-foreground" />}
            </Button>
            <Button variant="outline" size="sm" className="h-9 px-2.5" onClick={() => void openCamera()} title="Camera scan (F9)"><Camera className="h-4 w-4" /></Button>
            <Button variant="outline" size="sm" className="h-9 px-2.5" onClick={openHolds} title="Held sales"><PlayCircle className="h-4 w-4" /></Button>
            <Button variant="outline" size="sm" className="h-9 px-2.5" onClick={() => { cart.clear(); setReceipt(null); searchRef.current?.focus() }} title="New sale (F2)"><X className="h-4 w-4" /></Button>
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-1 -mb-1">
            <button
              onClick={() => setCatFilter('')}
              className={cn('px-3 py-1 rounded-full text-xs font-medium border whitespace-nowrap', !catFilter ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-secondary')}
            >{t('pos.all')}</button>
            {categories.map(c => (
              <button
                key={c.id}
                onClick={() => setCatFilter(c.id)}
                className={cn('px-3 py-1 rounded-full text-xs font-medium border whitespace-nowrap', catFilter === c.id ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-secondary')}
              >{c.name}</button>
            ))}
          </div>
          {scanMsg ? (
            <div
              role="status"
              className={cn(
                'text-xs font-medium border rounded px-2 py-1',
                scanMsgKind === 'err'
                  ? 'text-red-700 bg-red-50 dark:bg-red-950/40 dark:text-red-300 border-red-200 dark:border-red-900'
                  : 'text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900'
              )}
            >
              {scanMsg}
            </div>
          ) : null}
          {offlineData ? (
            <div className="text-[11px] text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200 dark:border-amber-900 rounded px-2 py-1">
              {t('pos.offlineCatalog')}
            </div>
          ) : null}
        </div>

        {/* grid — MOBILE: natural height (NO inner scroller). The previous fixed
            45svh inner-scroll pane consumed every swipe (a real catalog never
            reaches its end and overscroll-contain blocks scroll chaining), so
            the page could not be scrolled from the products area and the cart
            below felt FROZEN. Now the whole POS scrolls as one page: items on
            top, cart directly below. DESKTOP (lg+): internal scroll inside the
            fixed app frame, as before. */}
        <div ref={gridRef} className="p-3 lg:h-auto lg:flex-1 lg:overflow-y-auto lg:overscroll-contain">
          {loading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
              {Array.from({ length: 12 }).map((_, i) => <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="h-full grid place-items-center text-center text-sm text-muted-foreground gap-2">
              <PackageX className="h-8 w-8 opacity-40 mx-auto" />
              No products match. Add products or adjust the filter.
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
              {filtered.map(p => (
                <button
                  key={p.id}
                  onClick={() => addToCart(p)}
                  disabled={p.stock <= 0}
                  className={cn(
                    'text-left rounded-lg border bg-card p-2.5 flex flex-col gap-1 transition-colors',
                    p.stock > 0 ? 'hover:border-primary hover:bg-accent active:scale-[0.99]' : 'opacity-50 cursor-not-allowed'
                  )}
                >
                  <span className="text-xs font-medium leading-tight line-clamp-2 min-h-[2em]">{p.name}</span>
                  <span className="text-sm font-bold">{fmtMoney(p.retailPrice, cur)}</span>
                  <span className={cn('text-[10px] font-semibold', p.stock <= 0 ? 'text-red-600' : p.stock <= 5 ? 'text-amber-600' : 'text-muted-foreground')}>
                    {p.stock <= 0 ? 'Out of stock' : `${r2(p.stock)} ${p.unit || ''} in stock`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Cart side */}
      <div id="pos-cart" className={cn('w-full lg:w-[380px] lg:shrink-0 flex flex-col bg-card scroll-mt-14', cart.lines.length > 0 && 'pb-16 lg:pb-0')}>
        <div className="p-3 border-b flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-bold"><ShoppingCart className="h-4 w-4" /> Cart ({totals.count})</div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs" onClick={holdSale} disabled={cart.lines.length === 0}>
              <PauseCircle className="h-3.5 w-3.5" /> Hold <span className="text-[10px] opacity-60">(F4)</span>
            </Button>
          </div>
        </div>
        {/* customer */}
        <div className="p-3 border-b">
          <Select
            value={cart.customerId || 'walkin'}
            onValueChange={v => {
              if (v === 'walkin') cart.setCustomer(null, '')
              else { const c = customers.find(x => x.id === v); cart.setCustomer(v, c?.name || '') }
            }}
          >
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={t('pos.walkIn')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="walkin">Walk-in Customer</SelectItem>
              {customers.filter(c => c.name !== 'Walk-in Customer').map(c => (
                <SelectItem key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ''}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* lines — grows naturally on phones (the page scrolls); desktop keeps
            the internal scroller inside the fixed frame */}
        <div className="min-h-[120px] lg:flex-1 lg:overflow-y-auto">
          {cart.lines.length === 0 ? (
            <div className="h-full grid place-items-center text-sm text-muted-foreground p-4 text-center">
              Scan a barcode or tap a product to start selling.
            </div>
          ) : cart.lines.map(l => (
            <div key={l.productId} className="px-3 py-2 border-b text-sm">
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium leading-tight line-clamp-2 flex-1">{l.name}</span>
                <button onClick={() => cart.remove(l.productId)} className="p-1.5 -m-1 text-muted-foreground hover:text-red-600" aria-label={`Remove ${l.name}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex items-center justify-between mt-1.5 gap-2">
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => cart.setQty(l.productId, l.qty - 1)} aria-label="Decrease quantity"><Minus className="h-3 w-3" /></Button>
                  <input
                    type="number"
                    className="w-14 h-8 text-center text-base md:text-xs border rounded bg-background"
                    value={l.qty}
                    min={0.01}
                    onChange={e => cart.setQty(l.productId, parseFloat(e.target.value) || 0)}
                    aria-label={`Quantity of ${l.name}`}
                  />
                  <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => cart.setQty(l.productId, l.qty + 1)} aria-label="Increase quantity"><Plus className="h-3 w-3" /></Button>
                  <span className="text-[10px] text-muted-foreground">{typeof l.unit === 'string' ? l.unit : ''}</span>
                </div>
                <div className="text-right">
                  <input
                    type="number"
                    className="w-20 md:w-16 h-8 text-center text-base md:text-xs border rounded bg-background"
                    value={l.price}
                    onChange={e => cart.setPrice(l.productId, parseFloat(e.target.value) || 0)}
                    title="Unit price"
                    aria-label={`Unit price of ${l.name}`}
                  />
                  <span className="block text-xs font-bold mt-0.5">{fmtMoney(r2(l.qty * l.price - l.discount), cur)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
        {/* totals + actions */}
        <div className="border-t p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center gap-1">
              <Input type="number" min={0} className="h-8 text-base md:text-xs" placeholder={t('pos.discount')} value={cart.discount || ''} onChange={e => cart.setDiscount(parseFloat(e.target.value) || 0)} />
              <Select value={cart.discountType} onValueChange={v => cart.setDiscount(cart.discount, v as 'AMOUNT' | 'PERCENT')}>
                <SelectTrigger className="h-8 w-16 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="AMOUNT">{cur}</SelectItem>
                  <SelectItem value="PERCENT">%</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="text-right text-sm space-y-0.5 self-center">
              <div className="text-xs text-muted-foreground">
                Sub {fmtMoney(totals.subtotal, cur)}{totals.discount ? ` · ${t('pos.disc')} -${fmtMoney(totals.discount, cur)}` : ''}{totals.tax ? ` · ${t('pos.tax')} ${fmtMoney(totals.tax, cur)}` : ''}
              </div>
            </div>
          </div>
          <div className="flex items-baseline justify-between border-t pt-2">
            <span className="text-sm font-semibold">{t('pos.total')}</span>
            <span className="text-2xl font-black">{fmtMoney(totals.total, cur)}</span>
          </div>
          <Button className="w-full h-11 text-base font-bold" onClick={() => setPayOpen(true)} disabled={cart.lines.length === 0}>
            <Check className="h-5 w-5 mr-1" /> {t('pos.pay')}  <span className="text-xs opacity-70 ml-1">(F8)</span>
          </Button>
        </div>
      </div>

      {/* Mobile quick-bar: cart total + PAY pinned to the bottom of the screen.
          Fixed (not sticky) — an ancestor overflow clip would break sticky.
          The cart stays visible and touchable from anywhere on the POS — never
          frozen below the fold or behind the keyboard. Desktop hides it (the
          cart panel is permanently on screen there). */}
      {cart.lines.length > 0 ? (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 z-30 border-t bg-card px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex items-center gap-3 shadow-[0_-6px_16px_rgba(0,0,0,0.12)]">
          <button
            className="min-w-0 flex-1 text-left"
            onClick={() => document.getElementById('pos-cart')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            aria-label="Scroll to cart"
          >
            <div className="text-[11px] text-muted-foreground">{t('pos.cartTap', { n: totals.count })}</div>
            <div className="text-sm font-bold truncate">{fmtMoney(totals.total, cur)}</div>
          </button>
          <Button className="h-10 px-5 text-base font-bold shrink-0" onClick={() => setPayOpen(true)}>
            <Check className="h-4 w-4 mr-1" /> {t('pos.pay')}
          </Button>
        </div>
      ) : null}

      {/* Payment dialog */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="sm:max-w-md gap-3">
          <DialogHeader>
            <DialogTitle>{t('pos.takePayment')} — {fmtMoney(totals.total, cur)}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              {METHODS.map(m => (
                <button
                  key={m.id}
                  onClick={() => setPayMethod(m.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border p-2.5 text-xs font-medium transition-colors',
                    payMethod === m.id ? 'border-primary bg-accent text-accent-foreground' : 'hover:bg-secondary'
                  )}
                >
                  <m.icon className="h-4 w-4" /> {methodLabel[m.id] || m.label}
                </button>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pp">{
                payMethod === 'KHATA' ? t('pos.advanceKhata')
                : payMethod === 'CASH' ? t('pos.cashGiven')
                : t('pos.amountReceived')
              }</Label>
              <Input id="pp" type="number" min={0} inputMode="decimal" placeholder={String(totals.total)} value={partialPay} onChange={e => setPartialPay(e.target.value)} className="h-11 text-lg font-semibold" />
              {payMethod === 'CASH' ? (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {[
                    { label: t('pos.exact'), v: '' },
                    { label: '100', v: '100' },
                    { label: '500', v: '500' },
                    { label: '1000', v: '1000' },
                    { label: '5000', v: '5000' },
                  ].map(q => (
                    <button key={q.label} type="button" onClick={() => setPartialPay(q.v)}
                      className={cn('px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors',
                        partialPay === q.v ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-secondary')}
                    >{q.label}</button>
                  ))}
                </div>
              ) : null}
            </div>
            {payMethod === 'KHATA' && !cart.customerId ? (
              <p className="text-xs text-red-600">{t('pos.selectCustomerKhata')}</p>
            ) : null}
            <div className="rounded-lg bg-secondary p-2.5 text-xs space-y-0.5">
              <div className="flex justify-between"><span>{t('common.total')}</span><b>{fmtMoney(totals.total, cur)}</b></div>
              <div className="flex justify-between">
                <span>{payMethod === 'CASH' ? t('pos.cash') : t('pos.payingNow')}</span>
                <b>{fmtMoney(payMethod === 'KHATA' ? r2(parseFloat(partialPay) || 0) : partialPay === '' ? totals.total : r2(parseFloat(partialPay) || 0), cur)}</b>
              </div>
              {payMethod === 'CASH' && partialPay !== '' && r2(parseFloat(partialPay) || 0) > totals.total ? (
                <div className="flex justify-between items-center pt-1 mt-1 border-t">
                  <span className="font-semibold">{t('pos.changeReturn')}</span>
                  <b className="text-base text-emerald-600">{fmtMoney(r2((parseFloat(partialPay) || 0) - totals.total), cur)}</b>
                </div>
              ) : (
                <div className="flex justify-between">
                  <span>{payMethod === 'KHATA' ? t('pos.toKhata') : t('pos.remaining')}</span>
                  <b>{fmtMoney(r2(totals.total - (payMethod === 'KHATA' ? r2(parseFloat(partialPay) || 0) : partialPay === '' ? totals.total : r2(parseFloat(partialPay) || 0))), cur)}</b>
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" className="flex-1 min-w-0" onClick={() => setPayOpen(false)}>{t('common.cancel')} <span className="hidden sm:inline">(Esc)</span></Button>
              <Button className="flex-1 min-w-0 font-bold" onClick={checkout} disabled={busy || (payMethod === 'KHATA' && !cart.customerId)}>
                {busy ? t('common.saving') : t('pos.completeSale')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Camera scan dialog — stays open for rapid multi-item scanning.
          Compact on phones: capped video height + tighter gaps + short hint so
          the Torch / Done buttons always stay ON screen (the dialog used to
          grow past small viewports once the scan log filled up). */}
      <Dialog open={camOpen} onOpenChange={v => (v ? setCamOpen(true) : closeCamera())}>
        <DialogContent className="sm:max-w-md gap-3">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 min-w-0"><ScanLine className="h-5 w-5 shrink-0 text-primary" /> Scan Barcode</DialogTitle>
          </DialogHeader>
          <div className="relative">
            <video ref={videoRef} className="w-full max-h-[36svh] rounded-lg bg-black aspect-[4/3] object-cover" muted autoPlay playsInline />
            {camStarting && !camError ? (
              <div className="absolute inset-0 grid place-items-center text-xs text-white/80 bg-black/60 rounded-lg">Starting camera…</div>
            ) : null}
            {/* pro aiming reticle: brackets + animated scan line, flashes green on hit */}
            {!camStarting && !camError ? (
              <div className="absolute inset-0 pointer-events-none grid place-items-center" aria-hidden>
                <div className={cn(
                  'relative w-[80%] h-[46%] rounded-lg transition-shadow duration-150',
                  scanFlash === 'ok' ? 'shadow-[0_0_0_3px_rgba(16,185,129,0.95)]' : 'shadow-[0_0_0_2px_rgba(255,255,255,0.6)]'
                )}>
                  <span className="absolute -top-px -left-px w-6 h-6 border-t-[3px] border-l-[3px] border-white/90 rounded-tl-lg" />
                  <span className="absolute -top-px -right-px w-6 h-6 border-t-[3px] border-r-[3px] border-white/90 rounded-tr-lg" />
                  <span className="absolute -bottom-px -left-px w-6 h-6 border-b-[3px] border-l-[3px] border-white/90 rounded-bl-lg" />
                  <span className="absolute -bottom-px -right-px w-6 h-6 border-b-[3px] border-r-[3px] border-white/90 rounded-br-lg" />
                  <span className="absolute left-2 right-2 h-[2px] bg-red-500/85 shadow-[0_0_8px_rgba(239,68,68,0.8)] animate-scanline" />
                </div>
              </div>
            ) : null}
            {torchOn ? <div className="absolute top-2 right-2 text-[10px] font-bold text-amber-300 bg-black/50 rounded px-1.5 py-0.5">TORCH ON</div> : null}
          </div>
          {!camStarting && !camError ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm bg-card min-w-0">
              <span className="font-medium flex items-center gap-1.5 shrink-0"><ShoppingCart className="h-4 w-4" /> Cart</span>
              <span className="font-bold min-w-0 text-right">{totals.count} item{totals.count === 1 ? '' : 's'} · {fmtMoney(totals.total, cur)}</span>
            </div>
          ) : null}
          {camError ? (
            <div className="text-xs font-medium text-red-700 bg-red-50 dark:bg-red-950/40 dark:text-red-300 border border-red-200 dark:border-red-900 rounded px-2 py-1.5">{camError}</div>
          ) : null}
          {camLog.length > 0 ? (
            <div className="max-h-24 overflow-y-auto rounded-lg border bg-secondary/50 px-2.5 py-2 space-y-1">
              {camLog.map((l, i) => (
                <div key={i} className="text-xs font-medium text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5 min-w-0">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> <span className="min-w-0 break-all">{l}</span>
                </div>
              ))}
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground text-center sm:hidden">
            Hold a barcode inside the frame — each hit adds to the cart.
          </p>
          <p className="hidden sm:block text-xs text-muted-foreground text-center">
            {camStarting || camError ? 'Keep scanning — each hit adds to the cart with a beep. USB & Bluetooth scanners work anywhere on this screen.' : 'Scanner active — hold a barcode steady inside the frame. Each hit beeps and adds to the cart.'}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => void toggleTorch()}><Flashlight className="h-4 w-4 mr-1" /> Torch</Button>
            <Button className="flex-1 font-bold" onClick={closeCamera}>Done (Esc)</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Held sales sheet */}
      <Sheet open={holdsOpen} onOpenChange={setHoldsOpen}>
        <SheetContent side="left" className="w-80">
          <SheetHeader><SheetTitle className="text-base">{t('pos.heldSales')}</SheetTitle></SheetHeader>
          <div className="p-4 space-y-2">
            {holdsList.length === 0 ? (
              <p className="text-sm text-muted-foreground">No held sales.</p>
            ) : holdsList.map(h => (
              <button key={h.id} onClick={() => resumeHold(h.id)} className="w-full text-left rounded-lg border p-3 text-sm hover:bg-secondary flex items-center gap-2">
                <PlayCircle className="h-4 w-4 text-primary" /> {h.label}
              </button>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      {/* Receipt dialog */}
      <ReceiptDialog
        receipt={receipt}
        onClose={() => setReceipt(null)}
        biz={{
          name: business?.name || 'SmartMart',
          address: business?.address || '',
          phone: business?.phone || '',
          logo: business?.logo || '',
          footer: String((useAuthStore.getState().settings as { receipt?: { footer?: string } })?.receipt?.footer || 'Thank you for shopping with us!'),
          border: (useAuthStore.getState().settings as { receipt?: { border?: boolean } })?.receipt?.border !== false,
        }}
        cur={cur}
        snapshot={receipt?.snapshot}
      />

      {/* Scanned-invoice viewer — instant on-screen document with print options.
          Rendered last → stacks on top of receipt & camera dialogs. */}
      <InvoiceViewDialog result={invoiceFound} onClose={() => setInvoiceFound(null)} />
      
    </div>
  )
}

function ReceiptDialog({ receipt, onClose, biz, cur, snapshot }: {
  receipt: (SaleResult & { snapshot?: ReceiptSnapshot }) | null
  onClose: () => void
  biz: { name: string; address: string; phone: string; logo: string; footer: string; border?: boolean }
  cur: string
  snapshot?: ReceiptSnapshot
}) {
  const [detail, setDetail] = useState<{ items: { name: string; quantity: number; price: number; total: number }[]; subtotal: number; discount: number; tax: number; paymentMethod: string; cashierName: string; customer?: { name: string } | null; dueAmount: number; paid: number; givenCash?: number } | null>(null)
  // Auto-print preference persists across sales, reloads and sign-ins.
  const [autoPrint, setAutoPrint] = useState<boolean>(() =>
    typeof window !== 'undefined' && localStorage.getItem('smartmart.autoprint') === '1'
  )
  const toggleAutoPrint = (v: boolean) => {
    setAutoPrint(v)
    try { localStorage.setItem('smartmart.autoprint', v ? '1' : '0') } catch { /* storage unavailable */ }
  }
  // Auto-print fires once per completed sale — it never flips the toggle back off.
  const printedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (receipt?.id) {
      api<NonNullable<typeof detail>>(`/api/sales/detail?id=${receipt.id}`).then(setDetail).catch(() => null)
    } else setDetail(null)
  }, [receipt])

  useEffect(() => {
    if (!receipt || !autoPrint) return
    if (printedForRef.current === receipt.invoiceNo) return
    printedForRef.current = receipt.invoiceNo
    const t = setTimeout(() => printThermal(80), 400) // let the dialog paint first
    return () => clearTimeout(t)
  }, [receipt, autoPrint])

  if (!receipt) return null

  // Items/customer/subtotal come from the sale-detail API when available, but fall
  // back to the checkout snapshot so printing works even for OFFLINE sales (no id).
  const items = detail?.items?.length ? detail.items : (snapshot?.items || [])
  const givenCash = receipt.givenCash ?? detail?.givenCash ?? 0
  const buildSale = (barcodeH: number) => ({
    invoiceNo: receipt.invoiceNo,
    date: new Date().toLocaleString(),
    cashier: detail?.cashierName || useAuthStore.getState().user?.name || '',
    customer: detail?.customer?.name || snapshot?.customer || 'Walk-in Customer',
    items: items.map(i => ({ name: i.name, quantity: i.quantity, price: i.price, total: i.total })),
    subtotal: detail?.subtotal || snapshot?.subtotal || items.reduce((a, i) => a + i.total, 0) || receipt.total,
    discount: detail?.discount || snapshot?.discount || 0,
    tax: detail?.tax || snapshot?.tax || 0,
    total: receipt.total, paid: receipt.paid, due: receipt.dueAmount,
    givenCash,
    paymentMethod: detail?.paymentMethod || snapshot?.paymentMethod || 'CASH', currency: cur,
    barcodeSvg: jsbarcodeSvg(receipt.invoiceNo, { height: barcodeH }),
  })
  // Synchronous calls — see the import note above (mobile tap gesture).
  const printThermal = (width: 58 | 80) => {
    printHTML(`Receipt ${receipt.invoiceNo}`, thermalReceiptHTML(biz, buildSale(38), width))
  }
  const printInvoice = () => {
    printHTML(`Invoice ${receipt.invoiceNo}`, invoiceHTML(biz, buildSale(44)))
  }
  const share = () => {
    const lines = items.map(i => `${i.name} x${i.quantity} = ${fmtMoney(i.total, cur)}`).join('\n')
    const text = `*${biz.name}*\nInvoice: ${receipt.invoiceNo}\n${lines}\n*Total: ${fmtMoney(receipt.total, cur)}*\nPaid: ${fmtMoney(receipt.paid, cur)}${receipt.dueAmount ? `\nDue: ${fmtMoney(receipt.dueAmount, cur)}` : ''}\n\n${biz.footer}`
    const phone = detail?.customer ? '' : ''
    void phone
    const url = `https://wa.me/?text=${encodeURIComponent(text)}`
    window.open(url, '_blank')
  }

  return (
    <Dialog open={!!receipt} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-sm p-4 sm:p-6 gap-3 sm:gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Check className="h-5 w-5 text-emerald-600" />
            {receipt.offline ? 'Sale saved on device (offline)' : receipt.duplicate ? 'Already processed' : 'Sale completed'}
          </DialogTitle>
        </DialogHeader>
        <div className="text-center border rounded-lg p-3 sm:p-4 bg-card">
          <div className="text-xs text-muted-foreground">Invoice</div>
          <div className="text-xl font-black tracking-tight">{receipt.invoiceNo}</div>
          <div className="text-2xl font-bold mt-1">{fmtMoney(receipt.total, cur)}</div>
          <div className="mt-2 flex justify-center [&_svg]:h-10 [&_svg]:w-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: jsbarcodeSvg(receipt.invoiceNo, { height: 40 }) }} aria-label={`Barcode ${receipt.invoiceNo}`} />
          <div className="text-xs text-muted-foreground mt-1">
            Paid {fmtMoney(receipt.paid, cur)}
            {givenCash > receipt.total ? ` · Cash given ${fmtMoney(givenCash, cur)} · Change ${fmtMoney(r2(givenCash - receipt.total), cur)}` : receipt.dueAmount ? ` · Due ${fmtMoney(receipt.dueAmount, cur)}` : ''}
          </div>
          {receipt.offline ? (
            <div className="text-[11px] text-amber-700 mt-2">Will sync automatically when internet is available.</div>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" size="sm" onClick={() => printThermal(80)} className="max-sm:px-2 max-sm:text-xs"><Printer className="h-4 w-4 mr-1" /> 80mm</Button>
          <Button variant="outline" size="sm" onClick={() => printThermal(58)} className="max-sm:px-2 max-sm:text-xs"><Printer className="h-4 w-4 mr-1" /> 58mm</Button>
          <Button variant="outline" size="sm" onClick={printInvoice} className="max-sm:px-2 max-sm:text-xs"><FileText className="h-4 w-4 mr-1" /> A4 Invoice</Button>
          <Button variant="outline" size="sm" onClick={share} className="max-sm:px-2 max-sm:text-xs"><Share2 className="h-4 w-4 mr-1" /> Share</Button>
        </div>
        <label className="flex cursor-pointer select-none items-center justify-between gap-2 py-1 text-xs text-muted-foreground px-1">
          Auto-print thermal receipt after each sale
          <Switch checked={autoPrint} onCheckedChange={toggleAutoPrint} />
        </label>
        <Button className="w-full" onClick={onClose}>New Sale (F2)</Button>
      </DialogContent>
    </Dialog>
  )
}