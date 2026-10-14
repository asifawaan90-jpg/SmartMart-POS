'use client'

import { api } from '@/lib/client'

/* ------------------------------------------------------------------ */
/* Invoice barcode lookup — shared by Sales / Purchases / POS          */
/* ------------------------------------------------------------------ */

export interface LookupSaleItem {
  id: string; name: string; sku: string; barcode: string
  quantity: number; price: number; discount: number; total: number; returnedQty: number
}
export interface LookupSale {
  id: string; invoiceNo: string; createdAt: string
  subtotal: number; discount: number; tax: number; total: number
  paid: number; givenCash?: number; dueAmount: number; paymentMethod: string; status: string
  cashierName: string
  customer?: { name: string; phone?: string } | null
  items: LookupSaleItem[]
  returns: { returnNo: string; total: number; reason?: string }[]
}
export interface LookupPurchaseItem {
  id: string; name: string; quantity: number; unitCost: number
  total: number; returnedQty: number
}
export interface LookupPurchase {
  id: string; invoiceNo: string; createdAt: string
  subtotal: number; discount: number; tax: number; total: number
  paid: number; dueAmount: number; status: string
  supplier?: { id: string; name: string } | null
  items: LookupPurchaseItem[]
  returns: { returnNo: string; total: number; reason?: string }[]
}
export interface InvoiceLookupResult {
  kind: 'SALE' | 'SALE_RETURN' | 'PURCHASE' | 'PURCHASE_RETURN'
  sale?: LookupSale
  purchase?: LookupPurchase
  return?: { returnNo: string; total: number; reason?: string; createdAt?: string }
}

/**
 * Resolves any scanned invoice barcode (sale invoice, sale return, purchase
 * invoice, purchase return) to its full document. Returns null when the code
 * does not match any invoice (404) — throws on network/permission errors.
 */
export async function lookupInvoice(code: string): Promise<InvoiceLookupResult | null> {
  try {
    return await api<InvoiceLookupResult>(
      `/api/lookup/invoice?code=${encodeURIComponent(code.trim())}`
    )
  } catch (e) {
    const status = (e as { status?: number })?.status
    if (status === 404) return null
    throw e
  }
}

/**
 * True when a scanned code looks like an invoice/return number
 * (e.g. INV-20260920-00016, RET-000004, PUR-20260919-00003):
 * letters + digits, ≥6 chars, only alphanumeric / dash / space.
 * Pure-numeric codes (product EAN/UPC barcodes) never match — the POS
 * product pipeline keeps priority.
 */
export function looksLikeInvoiceCode(code: string): boolean {
  const s = code.trim()
  return s.length >= 6 && s.length <= 64
    && /[A-Za-z]/.test(s) && /\d/.test(s)
    && /^[A-Za-z0-9\s-]+$/.test(s)
}
