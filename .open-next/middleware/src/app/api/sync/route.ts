import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, handleError, requirePerm, requireActiveSub, audit, clientIp } from '@/lib/api'
import { hasPerm, type Perm } from '@/lib/permissions'
import { createSale, type SaleInput } from '@/lib/sale-service'
import { createStockAdjustment } from '@/lib/inventory-service'
import { createPurchase } from '@/lib/purchase-service'
import { createKhataPayment } from '@/lib/khata-service'
import { applyProductSync, type ProductSyncInput } from '@/lib/product-service'

export const dynamic = 'force-dynamic'

type OpKind = 'SALE' | 'STOCK_ADJUSTMENT' | 'PURCHASE' | 'KHATA_PAYMENT' | 'PRODUCT'

const KIND_PERM: Record<OpKind, Perm> = {
  SALE: 'pos',
  STOCK_ADJUSTMENT: 'inventory',
  PURCHASE: 'purchases',
  KHATA_PAYMENT: 'khata_manage',
  PRODUCT: 'products',
}

const KIND_ENTITY: Record<OpKind, string> = {
  SALE: 'Sale',
  STOCK_ADJUSTMENT: 'Product',
  PURCHASE: 'Purchase',
  KHATA_PAYMENT: 'Customer',
  PRODUCT: 'Product',
}

/**
 * POST /api/sync — batch idempotent upload of offline-created operations.
 * Body: { ops: [{ kind, clientRef, payload }] } — each op carries a clientRef
 * (UUID) generated on device; legacy { sales: SaleInput[] } bodies are still
 * accepted (treated as kind: SALE).
 * Response: { results: [{clientRef, status: SYNCED|DUPLICATE|FAILED, error?}] }
 * Every kind is idempotent per business — a retried sync never double-applies.
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'pos')
    await requireActiveSub(ctx)

    const body = await req.json().catch(() => ({}) as Record<string, unknown>)
    type Op = { kind: OpKind; clientRef: string; payload: Record<string, unknown> }
    const ops: Op[] = []

    if (Array.isArray(body?.ops)) {
      for (const o of (body.ops as Record<string, unknown>[]).slice(0, 200)) {
        const kind: OpKind = (['SALE', 'STOCK_ADJUSTMENT', 'PURCHASE', 'KHATA_PAYMENT', 'PRODUCT'] as string[]).includes(String(o?.kind))
          ? (o.kind as OpKind)
          : 'SALE'
        ops.push({ kind, clientRef: String(o?.clientRef || (o?.payload as Record<string, unknown>)?.clientRef || ''), payload: (o?.payload as Record<string, unknown>) || {} })
      }
    } else if (Array.isArray(body?.sales)) {
      // legacy clients
      for (const s of (body.sales as Record<string, unknown>[]).slice(0, 200)) {
        ops.push({ kind: 'SALE', clientRef: String(s?.clientRef || ''), payload: s })
      }
    }

    const settings = await db.setting.findUnique({ where: { businessId: ctx.businessId } })
    const parsed = settings ? (JSON.parse(settings.data) as { invoice?: { prefix?: string }; purchasePrefix?: string }) : null
    const salePrefix = parsed?.invoice?.prefix ?? 'INV-'
    const purchasePrefix = parsed?.purchasePrefix ?? 'PUR-'

    const results: { clientRef: string; status: string; invoiceNo?: string; error?: string }[] = []
    for (const op of ops) {
      const clientRef = op.clientRef
      try {
        // Per-kind authorization — a cashier syncing sales cannot smuggle
        // purchase or khata writes through the same endpoint.
        if (!hasPerm(ctx.role, ctx.perms, KIND_PERM[op.kind])) {
          results.push({ clientRef, status: 'FAILED', error: `No permission for ${KIND_PERM[op.kind]}.` })
          continue
        }
        if (!clientRef) throw new Error('Missing clientRef')

        let status: 'SYNCED' | 'DUPLICATE' = 'SYNCED'
        let invoiceNo: string | undefined
        let entityId = clientRef
        const auditMeta: Record<string, unknown> = { clientRef }

        if (op.kind === 'SALE') {
          const sale = await createSale({
            businessId: ctx.businessId, userId: ctx.user.uid, cashierName: ctx.user.name,
            input: { ...(op.payload as unknown as SaleInput), clientRef }, prefix: salePrefix,
            // Task 67 — the sale physically happened on this device while
            // offline; a stock drift must never block the sync forever.
            allowNegativeStock: true,
          })
          status = sale.duplicate ? 'DUPLICATE' : 'SYNCED'
          invoiceNo = sale.invoiceNo
          entityId = sale.id
          auditMeta.invoiceNo = sale.invoiceNo
        } else if (op.kind === 'STOCK_ADJUSTMENT') {
          const adj = await createStockAdjustment({
            businessId: ctx.businessId, userId: ctx.user.uid,
            input: { ...(op.payload as unknown as Parameters<typeof createStockAdjustment>[0]['input']), clientRef },
          })
          status = adj.duplicate ? 'DUPLICATE' : 'SYNCED'
          entityId = adj.id
          auditMeta.productName = adj.productName
          auditMeta.stockAfter = adj.stockAfter
        } else if (op.kind === 'PRODUCT') {
          // Task 67-b — offline product create/edit (was silently dropped before).
          const prod = await applyProductSync({
            businessId: ctx.businessId, userId: ctx.user.uid,
            input: { ...(op.payload as unknown as ProductSyncInput), clientRef },
          })
          status = prod.duplicate ? 'DUPLICATE' : 'SYNCED'
          entityId = prod.id
          auditMeta.productName = prod.name
          auditMeta.mode = prod.mode
        } else if (op.kind === 'PURCHASE') {
          const pur = await createPurchase({
            businessId: ctx.businessId, userId: ctx.user.uid,
            input: { ...(op.payload as unknown as Parameters<typeof createPurchase>[0]['input']), clientRef },
          })
          status = pur.duplicate ? 'DUPLICATE' : 'SYNCED'
          invoiceNo = pur.invoiceNo
          entityId = pur.id
          auditMeta.invoiceNo = pur.invoiceNo
          auditMeta.total = pur.total
        } else {
          const pay = await createKhataPayment({
            businessId: ctx.businessId, userId: ctx.user.uid,
            input: { ...(op.payload as unknown as Parameters<typeof createKhataPayment>[0]['input']), clientRef },
          })
          status = pay.duplicate ? 'DUPLICATE' : 'SYNCED'
          entityId = pay.id
          auditMeta.refNo = pay.refNo
          auditMeta.customer = pay.customerName
        }

        results.push({ clientRef, status, invoiceNo })
        if (status === 'SYNCED') {
          await audit(ctx.businessId, ctx.user.uid, `OFFLINE_${op.kind}_SYNCED`, KIND_ENTITY[op.kind], entityId, auditMeta, clientIp(req))
        }
      } catch (err) {
        results.push({ clientRef, status: 'FAILED', error: err instanceof Error ? err.message : 'Sync failed' })
      }
    }
    const serverTime = new Date().toISOString()
    return ok({ results, serverTime })
  } catch (e) {
    return handleError(e)
  }
}
