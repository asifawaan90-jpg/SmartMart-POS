import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok, fail, handleError, readBody, requirePerm, requireAnyPerm, requireActiveSub, audit,
  num, r2, ApiError, requireStr, clientIp,
} from '@/lib/api'
import { generateBarcode, bizKey, isValidEan13 } from '@/lib/barcode'
import { maybeAutoBackup } from '@/lib/backup-auto'

export const dynamic = 'force-dynamic'

// GET /api/products?search=&categoryId=&active=&lowStock=&page=&pageSize=&all=1
export async function GET(req: NextRequest) {
  try {
    // POS cashiers/managers read the catalog through their 'pos' perm;
    // 'products' perm grants the same read for the Products view.
    const ctx = await requireAnyPerm(req, ['products', 'pos'])
    const sub = await requireActiveSub(ctx)
    const url = new URL(req.url)
    const search = url.searchParams.get('search')?.trim() || ''
    const categoryId = url.searchParams.get('categoryId') || ''
    const status = url.searchParams.get('status') || 'active' // active | inactive | all
    const lowStock = url.searchParams.get('lowStock') === '1'
    const all = url.searchParams.get('all') === '1'
    const page = Math.max(1, num(url.searchParams.get('page'), 1))
    const pageSize = all ? 5000 : Math.min(100, Math.max(5, num(url.searchParams.get('pageSize'), 20)))

    const where: Record<string, unknown> = { businessId: ctx.businessId }
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { sku: { contains: search } },
        { barcode: { contains: search } },
      ]
    }
    if (categoryId) where.categoryId = categoryId
    if (status !== 'all') where.isActive = status === 'active'
    if (lowStock) where.stock = { lte: 0 } // refined below with minStock via raw filter
    if (lowStock) {
      // SQLite: compare columns via Prisma raw is limited; fetch candidates then filter
      const candidates = await db.product.findMany({
        where: { ...where, stock: undefined },
        include: { category: true, unit: true, supplier: true },
        orderBy: { name: 'asc' },
      })
      const low = candidates.filter(p => p.stock <= p.minStock)
      const start = (page - 1) * pageSize
      return ok({
        items: low.slice(start, start + pageSize),
        total: low.length, page, pageSize,
        subscription: sub,
      })
    }

    const [items, total] = await Promise.all([
      db.product.findMany({
        where,
        include: { category: true, unit: true, supplier: true, brand: true },
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.product.count({ where }),
    ])
    return ok({ items, total, page, pageSize })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/products
export async function POST(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'products')
    await requireActiveSub(ctx)
    const b = await readBody<Record<string, unknown>>(req)
    const name = requireStr(b.name, 'Product name', 200)
    const costPrice = r2(num(b.costPrice))
    const retailPrice = r2(num(b.retailPrice))
    let barcode = typeof b.barcode === 'string' ? b.barcode.trim() : ''
    let sku = typeof b.sku === 'string' ? b.sku.trim().slice(0, 64) : ''

    if (barcode) {
      const dup = await db.product.findFirst({ where: { businessId: ctx.businessId, barcode } })
      if (dup) throw new ApiError(409, 'DUPLICATE_BARCODE', `Barcode already used by "${dup.name}".`)
    } else {
      // auto-generate unique barcode
      const key = bizKey(ctx.businessId)
      for (let i = 0; i < 5; i++) {
        const cand = generateBarcode(key)
        const exists = await db.product.findFirst({ where: { businessId: ctx.businessId, barcode: cand } })
        if (!exists) { barcode = cand; break }
      }
      if (!barcode) throw new ApiError(500, 'BARCODE_GEN', 'Could not generate a unique barcode. Try manual entry.')
    }
    if (sku) {
      const dup = await db.product.findFirst({ where: { businessId: ctx.businessId, sku } })
      if (dup) throw new ApiError(409, 'DUPLICATE', `SKU already used by "${dup.name}".`)
    } else {
      sku = `SKU-${barcode.slice(-8)}`
    }

    const openingStock = num(b.openingStock)
    const product = await db.$transaction(async (tx) => {
      const p = await tx.product.create({
        data: {
          businessId: ctx.businessId, name, sku, barcode,
          categoryId: b.categoryId ? String(b.categoryId) : null,
          brandId: b.brandId ? String(b.brandId) : null,
          unitId: b.unitId ? String(b.unitId) : null,
          supplierId: b.supplierId ? String(b.supplierId) : null,
          image: typeof b.image === 'string' ? b.image.slice(0, 400_000) : '',
          costPrice, lastCostPrice: costPrice,
          retailPrice, wholesalePrice: r2(num(b.wholesalePrice, retailPrice)),
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
            businessId: ctx.businessId, productId: p.id, type: 'OPENING',
            quantity: openingStock, stockBefore: 0, stockAfter: openingStock,
            unitCost: costPrice, refType: 'Manual', note: 'Opening stock', userId: ctx.user.uid,
          },
        })
      }
      return p
    })

    await audit(ctx.businessId, ctx.user.uid, 'PRODUCT_CREATED', 'Product', product.id, { name, barcode }, clientIp(req))
    void maybeAutoBackup(ctx.businessId, ctx.user, 'product saved', { name, barcode })
    return ok(product, 201)
  } catch (e) {
    return handleError(e)
  }
}

// PUT /api/products?id=...
export async function PUT(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'products')
    await requireActiveSub(ctx)
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return fail(400, 'VALIDATION', 'Product id required.')
    const b = await readBody<Record<string, unknown>>(req)
    const existing = await db.product.findFirst({ where: { id, businessId: ctx.businessId } })
    if (!existing) return fail(404, 'NOT_FOUND', 'Product not found.')

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

    // barcode change — guarded
    if (b.barcode !== undefined) {
      const newBarcode = String(b.barcode).trim()
      if (newBarcode && newBarcode !== existing.barcode) {
        const dup = await db.product.findFirst({ where: { businessId: ctx.businessId, barcode: newBarcode } })
        if (dup) throw new ApiError(409, 'DUPLICATE_BARCODE', `Barcode already used by "${dup.name}".`)
        data.barcode = newBarcode
      }
    }
    if (b.sku !== undefined) {
      const newSku = String(b.sku).trim()
      if (newSku && newSku !== existing.sku) {
        const dup = await db.product.findFirst({ where: { businessId: ctx.businessId, sku: newSku } })
        if (dup) throw new ApiError(409, 'DUPLICATE', `SKU already used by "${dup.name}".`)
        data.sku = newSku
      }
    }

    const product = await db.product.update({ where: { id }, data })
    await audit(ctx.businessId, ctx.user.uid, 'PRODUCT_UPDATED', 'Product', id, { name: product.name }, clientIp(req))
    void maybeAutoBackup(ctx.businessId, ctx.user, 'product updated', { name: product.name })
    return ok(product)
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/products?id= (archive)
export async function DELETE(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'products')
    await requireActiveSub(ctx)
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return fail(400, 'VALIDATION', 'Product id required.')
    const existing = await db.product.findFirst({ where: { id, businessId: ctx.businessId } })
    if (!existing) return fail(404, 'NOT_FOUND', 'Product not found.')
    // archive (financial records may reference it)
    const product = await db.product.update({ where: { id }, data: { isActive: false } })
    await audit(ctx.businessId, ctx.user.uid, 'PRODUCT_ARCHIVED', 'Product', id, { name: existing.name }, clientIp(req))
    return ok(product)
  } catch (e) {
    return handleError(e)
  }
}

void isValidEan13
