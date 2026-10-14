'use client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { r2 } from '@/lib/format'

export interface CartLine {
  productId: string
  name: string
  sku: string
  barcode: string
  price: number
  cost: number
  qty: number
  discount: number
  taxRate: number
  stock: number
  unit?: string
}

/** Coerce any persisted/legacy `unit` value to a plain string (or undefined).
 *  Older builds once stored the WHOLE Unit object {id, businessId, name, shortName}
 *  here — rendering that object as a JSX child throws React minified error #31
 *  ("Objects are not valid as a React child"). Normalized at every boundary:
 *  store hydration, add(), and offline-cache reads. */
function normUnit(u: unknown): string | undefined {
  if (typeof u === 'string') { const s = u.trim(); return s || undefined }
  if (u && typeof u === 'object') {
    const o = u as { shortName?: unknown; name?: unknown }
    const s = (typeof o.shortName === 'string' && o.shortName.trim()) || (typeof o.name === 'string' && o.name.trim()) || ''
    return s || undefined
  }
  return undefined
}

const toNum = (v: unknown, d = 0): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(parseFloat(v))) return parseFloat(v)
  return d
}
const toStr = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

/** Rebuild a cart line from any persisted/legacy shape so poisoned storage can
 *  never crash the UI: numbers coerced, strings enforced, unit normalized.
 *  Lines without a productId are unusable (can't edit/remove) — dropped. */
function sanitizeLine(l: unknown): CartLine | null {
  if (!l || typeof l !== 'object') return null
  const o = l as Record<string, unknown>
  const productId = toStr(o.productId)
  if (!productId) return null
  const qty = Math.max(0, toNum(o.qty))
  if (qty <= 0) return null // store invariant: every line has qty > 0 (matches setQty)
  return {
    productId,
    name: toStr(o.name, 'Item'),
    sku: toStr(o.sku),
    barcode: toStr(o.barcode),
    price: Math.max(0, toNum(o.price)),
    cost: Math.max(0, toNum(o.cost)),
    qty: Math.max(0, toNum(o.qty)),
    discount: Math.max(0, toNum(o.discount)),
    taxRate: Math.max(0, toNum(o.taxRate)),
    stock: Math.max(0, toNum(o.stock)),
    unit: normUnit(o.unit),
  }
}

/** Sanitize the whole persisted cart blob (runs on EVERY rehydration, any shape). */
function sanitizeState(p: unknown): Partial<CartState> {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
  const lines = Array.isArray(o.lines) ? o.lines.map(sanitizeLine).filter((l): l is CartLine => l !== null) : []
  return {
    lines,
    customerId: typeof o.customerId === 'string' && o.customerId ? o.customerId : null,
    customerName: toStr(o.customerName),
    discount: Math.max(0, toNum(o.discount)),
    discountType: o.discountType === 'PERCENT' ? 'PERCENT' : 'AMOUNT',
    bizId: toStr(o.bizId),
  }
}

interface CartState {
  lines: CartLine[]
  customerId: string | null
  customerName: string
  discount: number
  discountType: 'AMOUNT' | 'PERCENT'
  bizId: string
  setBiz: (bizId: string) => void
  add: (line: CartLine) => void
  setQty: (productId: string, qty: number) => void
  setPrice: (productId: string, price: number) => void
  setLineDiscount: (productId: string, discount: number) => void
  remove: (productId: string) => void
  clear: () => void
  setCustomer: (id: string | null, name: string) => void
  setDiscount: (d: number, type?: 'AMOUNT' | 'PERCENT') => void
  totals: () => { subtotal: number; lineDiscounts: number; discount: number; tax: number; total: number; count: number }
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      lines: [],
      customerId: null,
      customerName: '',
      discount: 0,
      discountType: 'AMOUNT',
      bizId: '',
      setBiz: (bizId) => set((st) => (st.bizId === bizId ? st : { bizId, lines: [], customerId: null, customerName: '', discount: 0 })),
      add: (rawLine) => {
        // Sanitize the incoming line so a poisoned products cache can never put a
        // raw Unit object (React error #31) or NaN into the persisted cart.
        const line = sanitizeLine(rawLine)
        if (!line) return
        return set((st) => {
        const existing = st.lines.find(l => l.productId === line.productId)
        if (existing) {
          return {
            lines: st.lines.map(l => l.productId === line.productId
              ? { ...l, qty: Math.min(r2(l.qty + line.qty), Math.max(l.stock, l.qty)) }
              : l),
          }
        }
        return { lines: [...st.lines, line] }
        })
      },
      setQty: (productId, qty) => set((st) => ({
        lines: st.lines.map(l => l.productId === productId ? { ...l, qty: Math.max(0, r2(qty)) } : l).filter(l => l.qty > 0),
      })),
      setPrice: (productId, price) => set((st) => ({
        lines: st.lines.map(l => l.productId === productId ? { ...l, price: Math.max(0, r2(price)) } : l),
      })),
      setLineDiscount: (productId, discount) => set((st) => ({
        lines: st.lines.map(l => l.productId === productId ? { ...l, discount: Math.max(0, r2(discount)) } : l),
      })),
      remove: (productId) => set((st) => ({ lines: st.lines.filter(l => l.productId !== productId) })),
      clear: () => set({ lines: [], customerId: null, customerName: '', discount: 0, discountType: 'AMOUNT' }),
      setCustomer: (customerId, customerName) => set({ customerId, customerName }),
      setDiscount: (discount, type) => set((st) => ({ discount: Math.max(0, r2(discount)), discountType: type || st.discountType })),
      totals: () => {
        const { lines, discount, discountType } = get()
        let subtotal = 0, lineDiscounts = 0, tax = 0
        for (const l of lines) {
          subtotal = r2(subtotal + l.qty * l.price)
          lineDiscounts = r2(lineDiscounts + l.discount)
          tax = r2(tax + (l.qty * l.price - l.discount) * (l.taxRate / 100))
        }
        let d = discount
        if (discountType === 'PERCENT') d = r2((subtotal - lineDiscounts) * (discount / 100))
        d = Math.min(d, r2(subtotal - lineDiscounts + tax))
        const total = r2(subtotal - lineDiscounts - d + tax)
        return { subtotal, lineDiscounts, discount: r2(d), tax, total, count: lines.length }
      },
    }),
    {
      name: 'smartmart-cart',
      version: 1,
      // Legacy carts (version 0) may carry raw Unit objects / wrong types → sanitize.
      migrate: (persisted) => sanitizeState(persisted) as CartState,
      // And EVERY rehydration passes through the sanitizer, so a poisoned
      // localStorage blob can never reach the renderer again.
      merge: (persisted, current) => ({ ...current, ...sanitizeState(persisted) }),
    }
  )
)
