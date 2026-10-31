import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail, handleError, requireAuth } from '@/lib/api'
import { hasPerm } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

const SALE_ITEM_SELECT = {
  id: true, name: true, sku: true, barcode: true,
  quantity: true, price: true, discount: true, total: true, returnedQty: true,
}

function norm(s: string): string {
  return s.trim().toUpperCase().replace(/[\s-]/g, '')
}

/**
 * GET /api/lookup/invoice?code=INV-20260920-00016
 *
 * Universal invoice barcode lookup — scans the CODE128 barcode printed on any
 * document and instantly resolves it:
 *   1. Sale invoice      (INV-…)        → full invoice + items + returns
 *   2. Sale return slip  (RET-…)        → return + parent invoice
 *   3. Purchase invoice  (PUR-…)        → purchase + items + supplier
 *   4. Purchase return   (PRET-…)       → return + parent purchase
 *
 * Matching is strict: exact number first, then a normalized (case/space/dash
 * insensitive) fallback over a bounded candidate set — never a fuzzy guess.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth(req)
    const url = new URL(req.url)
    const code = (url.searchParams.get('code') || '').trim()
    if (!code || code.length < 4) return fail(400, 'VALIDATION', 'Scan or enter an invoice number.')
    if (code.length > 64) return fail(400, 'VALIDATION', 'Invalid invoice number.')

    const canSales = hasPerm(ctx.role, ctx.perms, 'sales')
    const canPurchases = hasPerm(ctx.role, ctx.perms, 'purchases')
    if (!canSales && !canPurchases) {
      return fail(403, 'FORBIDDEN', 'You do not have permission to look up invoices.')
    }

    const nCode = norm(code)
    // tail = last dash/space-separated segment (e.g. "000016") — used for the
    // normalized fallback when the scan differs slightly from the stored number
    const tail = code.split(/[\s-]/).pop() || code

    // ── 1 + 2. Sales side ─────────────────────────────────────
    if (canSales) {
      const sale = await db.sale.findFirst({
        where: { businessId: ctx.businessId, invoiceNo: code },
        include: { items: { select: SALE_ITEM_SELECT }, customer: true, returns: true },
      })
      if (sale) return ok({ kind: 'SALE', sale })

      const saleReturn = await db.saleReturn.findFirst({
        where: { businessId: ctx.businessId, returnNo: code },
      })
      if (saleReturn) {
        const parent = await db.sale.findUnique({
          where: { id: saleReturn.saleId },
          include: { items: { select: SALE_ITEM_SELECT }, customer: true, returns: true },
        })
        if (parent) return ok({ kind: 'SALE_RETURN', return: saleReturn, sale: parent })
      }

      // normalized fallback on sale invoice numbers (case / space / dash drift)
      const cands = await db.sale.findMany({
        where: { businessId: ctx.businessId, invoiceNo: { contains: tail } },
        include: { items: { select: SALE_ITEM_SELECT }, customer: true, returns: true },
        orderBy: { createdAt: 'desc' },
        take: 25,
      })
      const hit = cands.find(s => norm(s.invoiceNo) === nCode)
      if (hit) return ok({ kind: 'SALE', sale: hit })
    }

    // ── 3 + 4. Purchases side ─────────────────────────────────
    if (canPurchases) {
      const purchase = await db.purchase.findFirst({
        where: { businessId: ctx.businessId, invoiceNo: code },
        include: { items: true, supplier: true, returns: true },
      })
      if (purchase) return ok({ kind: 'PURCHASE', purchase })

      const purchaseReturn = await db.purchaseReturn.findFirst({
        where: { businessId: ctx.businessId, returnNo: code },
      })
      if (purchaseReturn) {
        const parent = await db.purchase.findUnique({
          where: { id: purchaseReturn.purchaseId },
          include: { items: true, supplier: true, returns: true },
        })
        if (parent) return ok({ kind: 'PURCHASE_RETURN', return: purchaseReturn, purchase: parent })
      }
    }

    return fail(404, 'NOT_FOUND', 'No invoice matches this barcode.')
  } catch (e) {
    return handleError(e)
  }
}
