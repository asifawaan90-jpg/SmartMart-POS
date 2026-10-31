import { db } from '@/lib/db'
import { ApiError, num, r2, requireStr } from '@/lib/api'
import { generateBarcode, bizKey } from '@/lib/barcode'

/**
 * Task 67-b — offline product create/edit, applied idempotently by the sync
 * engine (kind: PRODUCT).
 *
 * Why: sales, stock adjustments, purchases and khata payments were all queued
 * on the device when offline, but a product create/edit had NO offline path —
 * the app even showed "your data is saved on this device" while dropping the
 * change forever. Shop owners editing products/stock with a flaky connection
 * (the exact scenario of the Oct 7 data-loss report) lost those edits.
 *
 * Idempotency: the device generates the product id itself for creates, so a
 * retried sync upserts the same row (never duplicates). Edits update by id —
 * naturally idempotent (last write wins; repeated retries converge).
 */

export interface ProductSyncInput {
  mode: 'create' | 'edit'
  id?: string
  name?: unknown
  sku?: unknown
  barcode?: unknown
  categoryId?: unknown
  brandId?: unknown
  unitId?: unknown
  supplierId?: unknown
  image?: unknown
  costPrice?: unknown
  retailPrice?: unknown
  wholesalePrice?: unknown
  minPrice?: unknown
  taxRate?: unknown
  minStock?: unknown
  openingStock?: unknown
  expiryDate?: unknown
  description?: unknown
  isActive?: unknown
  clientRef?: string
  deviceTs?: string
}

/** Barcode/SKU assignment shared by online POST and offline sync (create). */
async function assignBarcodeSku(businessId: string, b: ProductSyncInput): Promise<{ barcode: string; sku: string }> {
  let barcode = typeof b.barcode === 'string' ? b.barcode.trim() : ''
  let sku = typeof b.sku === 'string' ? b.sku.trim().slice(0, 64) : ''
  if (barcode) {
    const dup = await db.product.findFirst({ where: { businessId, barcode, id: { not: b.id || undefined } } })
    if (dup) throw new ApiError(409, 'DUPLICATE_BARCODE', `Barcode already used by "${dup.name}".`)
  } else {
    const key = bizKey(businessId)
    for (let i = 0; i < 5; i++) {
      const cand = generateBarcode(key)
      const exists = await db.product.findFirst({ where: { businessId, barcode: cand } })
      if (!exists) { barcode = cand; break }
    }
    if (!barcode) throw new ApiError(500, 'BARCODE_GEN', 'Could not generate a unique barcode. Try manual entry.')
  }
  if (sku) {
    const dup = await db.product.findFirst({ where: { businessId, sku, id: { not: b.id || undefined } } })
    if (dup) throw new ApiError(409, 'DUPLICATE', `SKU already used by "${dup.name}".`)
  } else {
    sku = `SKU-${barcode.slice(-8)}`
  }
  return { barcode, sku }
}

export async function applyProductSync(opts: {
  businessId: string
  userId: string
  input: ProductSyncInput
}): Promise<{ id: string; name: string; mode: string; duplicate: boolean }> {
  const { businessId, userId, input: b } = opts
  const mode = b.mode === 'edit' ? 'edit' : 'create'

  if (mode === 'edit') {
    const id = String(b.id || '')
    if (!id) throw new ApiError(400, 'VALIDATION', 'Product id required.')
    const existing = await db.product.findFirst({ where: { id, businessId } })
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Product not found.')
    const data: Record<string, unknown> = {}
    if (b.name != null) data.name = requireStr(b.name, 'Product name', 200)
    if (b.categoryId !== undefined) data.categoryId = b.categoryId ? String(b.categoryId) : null
    if (b.brandId !== undefined) data.brandId = b.brandId ? String(b.brandId) : null
    if (b.unitId !== undefined) data.unitId = b.unitId ? String(b.unitId) : null
    if (b.supplierId !== undefined) data.supplierId = b.supplierId ? String(b.supplierId) : null
    if (b.image !== undefined) data.image = typeof b.image === 'string' ? b.image.slice(0, 400_000) : ''
    if (b.costPrice != null) data.costPrice = r2(num(b.costPrice))
    if (b.retailPrice != null) data.retailPrice = r2(num(b.retailPrice))
    if (b.wholesalePrice != null) data.wholesalePrice = r2(num(b.wholesalePrice))
    if (b.minPrice != null) data.minPrice = r2(num(b.minPrice))
    if (b.taxRate != null) data.taxRate = num(b.taxRate)
    if (b.minStock != null) data.minStock = num(b.minStock)
    if (b.expiryDate !== undefined) data.expiryDate = b.expiryDate ? new Date(String(b.expiryDate)) : null
    if (b.description !== undefined) data.description = typeof b.description === 'string' ? b.description.slice(0, 1000) : ''
    if (b.isActive !== undefined) data.isActive = b.isActive === true
    if (b.barcode !== undefined && typeof b.barcode === 'string' && b.barcode.trim() && b.barcode.trim() !== existing.barcode) {
      const dup = await db.product.findFirst({ where: { businessId, barcode: b.barcode.trim(), id: { not: id } } })
      if (dup) throw new ApiError(409, 'DUPLICATE_BARCODE', `Barcode already used by "${dup.name}".`)
      data.barcode = b.barcode.trim()
    }
    if (b.sku !== undefined && typeof b.sku === 'string' && b.sku.trim() && b.sku.trim() !== existing.sku) {
      const dup = await db.product.findFirst({ where: { businessId, sku: b.sku.trim(), id: { not: id } } })
      if (dup) throw new ApiError(409, 'DUPLICATE', `SKU already used by "${dup.name}".`)
      data.sku = b.sku.trim()
    }
    const product = await db.product.update({ where: { id }, data })
    return { id: product.id, name: product.name, mode, duplicate: false }
  }

  // ── create ────────────────────────────────────────────────────────────────
  // The device supplies the id → a retried sync lands on the same primary key.
  // If the row already exists (previous attempt actually committed) this is a
  // duplicate: refresh it with the same payload and report honestly.
  const id = String(b.id || '') || undefined
  const name = requireStr(b.name, 'Product name', 200)
  if (id) {
    const existing = await db.product.findUnique({ where: { id } })
    if (existing && existing.businessId === businessId) {
      return { id: existing.id, name: existing.name, mode, duplicate: true }
    }
    if (existing) throw new ApiError(409, 'DUPLICATE', 'Product id already exists in another business.')
  }

  const { barcode, sku } = await assignBarcodeSku(businessId, b)
  const costPrice = r2(num(b.costPrice))
  const openingStock = num(b.openingStock)

  const product = await db.$transaction(async (tx) => {
    const p = await tx.product.create({
      data: {
        ...(id ? { id } : {}),
        businessId, name, sku, barcode,
        categoryId: b.categoryId ? String(b.categoryId) : null,
        brandId: b.brandId ? String(b.brandId) : null,
        unitId: b.unitId ? String(b.unitId) : null,
        supplierId: b.supplierId ? String(b.supplierId) : null,
        image: typeof b.image === 'string' ? b.image.slice(0, 400_000) : '',
        costPrice, lastCostPrice: costPrice,
        retailPrice: r2(num(b.retailPrice)),
        wholesalePrice: r2(num(b.wholesalePrice, num(b.retailPrice))),
        minPrice: r2(num(b.minPrice, costPrice)),
        taxRate: num(b.taxRate),
        stock: openingStock, openingStock,
        minStock: num(b.minStock),
        expiryDate: b.expiryDate ? new Date(String(b.expiryDate)) : null,
        description: typeof b.description === 'string' ? b.description.slice(0, 1000) : '',
        isActive: b.isActive !== false,
      },
    })
    if (openingStock !== 0) {
      await tx.inventoryTransaction.create({
        data: {
          businessId, productId: p.id, type: 'OPENING',
          quantity: openingStock, stockBefore: 0, stockAfter: openingStock,
          unitCost: costPrice, refType: 'Manual', note: 'Opening stock (offline)', userId,
          deviceTs: b.deviceTs ? new Date(b.deviceTs) : undefined,
          clientRef: (b.clientRef || '').slice(0, 64) || null,
        },
      })
    }
    return p
  })

  return { id: product.id, name: product.name, mode, duplicate: false }
}
