/**
 * SmartMart POS — development seed.
 * Run: bunx tsx prisma/seed.ts  (or bun prisma/seed.ts)
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const db = new PrismaClient()

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

function ean13(body12: string): string {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += parseInt(body12[i], 10) * (i % 2 === 0 ? 1 : 3)
  return body12 + ((10 - (sum % 10)) % 10)
}

let seedCounter = 1000
function genBarcode(): string {
  seedCounter++
  const base = `20${String(seedCounter).padStart(10, '0')}` // 12 digits
  return ean13(base) // + checksum = 13
}

async function main() {
  console.log('Seeding…')

  // ── Plans ─────────────────────────────────────────────────
  const trial = await db.subscriptionPlan.upsert({
    where: { code: 'TRIAL' },
    update: {},
    create: {
      code: 'TRIAL', name: 'Free Trial', price: 0, durationDays: 7, sortOrder: 0,
      features: JSON.stringify(['All features for 7 days', 'POS + Inventory + Reports', 'No credit card required']),
      limits: JSON.stringify({ users: 3, products: 500 }),
    },
  })
  const monthly = await db.subscriptionPlan.upsert({
    where: { code: 'MONTHLY' },
    update: {},
    create: {
      code: 'MONTHLY', name: 'Monthly — PKR 3,000 / Month', price: 3000, durationDays: 30, sortOrder: 1,
      features: JSON.stringify(['Unlimited sales & invoicing', 'Inventory + Barcode system', 'Khata / Credit ledger', 'Full reports & exports', 'Thermal & PDF printing', 'Cloud sync + backup']),
      limits: JSON.stringify({ users: 10, products: 10000 }),
    },
  })
  await db.subscriptionPlan.upsert({
    where: { code: 'LIFETIME' },
    update: {},
    create: {
      code: 'LIFETIME', name: 'Lifetime — PKR 250,000 (one-time)', price: 250000, durationDays: -1, sortOrder: 2,
      features: JSON.stringify(['Everything in Monthly, forever', 'Priority support', 'Free onboarding & training', 'All future updates included']),
      limits: JSON.stringify({ users: 25, products: 100000 }),
    },
  })

  // ── Platform super admin ──────────────────────────────────
  // Task 53-b — the seed is BOOTSTRAP-ONLY: it creates what is missing and
  // NEVER modifies an existing row. Every upsert below has update: {} —
  // an update/publish that re-runs the seed (the usual deploy step) used to
  // silently overwrite live data behind the platform owner's back.
  const superAdmin = await db.user.upsert({
    where: { email: 'asifawaan90@gmail.com' },
    update: {},
    create: {
      name: 'Platform Owner', email: 'asifawaan90@gmail.com', role: 'SUPER_ADMIN',
      passwordHash: await bcrypt.hash('owner@12345', 10),
    },
  })

  // ── Demo business ─────────────────────────────────────────
  let business = await db.business.findFirst({ where: { email: 'demo@smartmart.app' } })
  if (!business) {
    business = await db.business.create({
      data: {
        name: 'Al-Madina Mini Mart', ownerName: 'Ahmed Raza', email: 'demo@smartmart.app',
        phone: '0300-1234567', bizType: 'mini_mart', address: 'Shop #12, Main Bazaar, Lahore',
        currency: 'PKR',
      },
    })
  }

  // Subscription: active monthly (so a FRESH demo is fully usable).
  // Task 53-b — THE headline fix: this upsert used to run
  //   update: { status: 'ACTIVE', planId: monthly.id, endDate: now+365d }
  // on EVERY seed run, so every update/publish that executes the seed
  // WIPED whatever plan the platform owner had assigned via the Owner
  // Panel (change_plan) — the exact "subscription has already been
  // changed as platform owner set, but unfortunately data loss" report.
  // Now: create-only. An existing subscription row — owner-set plan,
  // status and expiry — is untouchable by the seed.
  await db.subscription.upsert({
    where: { businessId: business.id },
    update: {},
    create: {
      businessId: business.id, planId: monthly.id, status: 'ACTIVE',
      startDate: new Date(Date.now() - 5 * 86400000),
      endDate: new Date(Date.now() + 25 * 86400000),
    },
  })

  // Settings
  await db.setting.upsert({
    where: { businessId: business.id },
    update: {},
    create: {
      businessId: business.id,
      data: JSON.stringify({
        currency: 'PKR',
        taxEnabled: false,
        defaultTaxRate: 0,
        theme: 'classic',
        receipt: { width: 80, showLogo: true, footer: 'Thank you for shopping with us! | Ph: 0300-1234567', phone: '0300-1234567' },
        invoice: { prefix: 'INV-' },
        purchasePrefix: 'PUR-',
        barcode: { strategy: 'EAN13_INTERNAL', autoGenerate: true, labelWidth: 50, labelHeight: 30, copies: 1 },
        shortcuts: { search: 'F1', newSale: 'F2', hold: 'F4', payment: 'F8', close: 'Escape' },
        notifications: { trialReminders: true, lowStock: true },
        ownerEmail: 'demo@smartmart.app',
      }),
    },
  })

  // ── Users ─────────────────────────────────────────────────
  const owner = await db.user.upsert({
    where: { email: 'demo@smartmart.app' },
    update: {},
    create: {
      name: 'Ahmed Raza', email: 'demo@smartmart.app', phone: '0300-1234567',
      businessId: business.id, role: 'OWNER',
      passwordHash: await bcrypt.hash('Demo@12345', 10),
    },
  })
  const staff = [
    { name: 'Bilal Khan', email: 'manager@smartmart.app', role: 'MANAGER', pw: 'Manager@123' },
    { name: 'Sana Ali', email: 'cashier@smartmart.app', role: 'CASHIER', pw: 'Cashier@123' },
    { name: 'Usman Tariq', email: 'inventory@smartmart.app', role: 'INVENTORY_STAFF', pw: 'Stock@123' },
    { name: 'Fatima Noor', email: 'accounts@smartmart.app', role: 'ACCOUNTANT', pw: 'Account@123' },
  ]
  for (const s of staff) {
    // Task 53-b — update: {} (was: force-reset role AND passwordHash on
    // every seed run). A staff password the owner changed must survive an
    // app update; the seed only provides the accounts when they are new.
    await db.user.upsert({
      where: { email: s.email },
      update: {},
      create: {
        name: s.name, email: s.email, businessId: business.id, role: s.role,
        passwordHash: await bcrypt.hash(s.pw, 10),
      },
    })
  }

  // ── Categories / Units / Brands ───────────────────────────
  const catNames = ['Grocery', 'Beverages', 'Snacks', 'Dairy', 'Bakery', 'Household', 'Personal Care', 'Stationery', 'Toys', 'Gift Items']
  const catMap = new Map<string, string>()
  for (const n of catNames) {
    const c = await db.category.upsert({ where: { businessId_name: { businessId: business.id, name: n } }, update: {}, create: { businessId: business.id, name: n } })
    catMap.set(n, c.id)
  }
  const unitDefs = [['Piece', 'pcs'], ['Kilogram', 'kg'], ['Gram', 'g'], ['Litre', 'L'], ['Dozen', 'dzn'], ['Pack', 'pack']]
  const unitMap = new Map<string, string>()
  for (const [name, shortName] of unitDefs) {
    const u = await db.unit.upsert({ where: { businessId_name: { businessId: business.id, name } }, update: {}, create: { businessId: business.id, name, shortName } })
    unitMap.set(name, u.id)
  }
  const brandNames = ['National', 'Dalda', 'Nestle', 'Tapal', 'Surf Excel', 'Colgate', 'Lays', 'Olpers']
  const brandMap = new Map<string, string>()
  for (const n of brandNames) {
    const b = await db.brand.upsert({ where: { businessId_name: { businessId: business.id, name: n } }, update: {}, create: { businessId: business.id, name: n } })
    brandMap.set(n, b.id)
  }

  // ── Products (32) ─────────────────────────────────────────
  const products: [string, string, number, number, number, string, string, string][] = [
    // name, category, cost, retail, stock, unit, brand, description
    ['Basmati Rice 5kg', 'Grocery', 1850, 2200, 40, 'Pack', 'National', 'Premium aged basmati rice'],
    ['Sunflower Cooking Oil 5L', 'Grocery', 2750, 3100, 25, 'Pack', 'Dalda', 'Cooking oil tin'],
    ['White Sugar 1kg', 'Grocery', 138, 160, 120, 'Kilogram', 'National', 'Refined white sugar'],
    ['All-Purpose Flour 10kg', 'Grocery', 1050, 1250, 30, 'Pack', 'National', 'Chakki fresh atta'],
    ['Red Chilli Powder 200g', 'Grocery', 210, 260, 60, 'Piece', 'National', ''],
    ['Tapal Danedar Tea 450g', 'Beverages', 720, 850, 45, 'Piece', 'Tapal', 'Bold blended tea'],
    ['Nestle Nescafe Classic 50g', 'Beverages', 480, 560, 35, 'Piece', 'Nestle', 'Instant coffee jar'],
    ['Olpers Milk 1L', 'Dairy', 175, 210, 80, 'Litre', 'Olpers', 'UHT full cream milk'],
    ['Nestle Yogurt 1kg', 'Dairy', 190, 230, 40, 'Kilogram', 'Nestle', 'Fresh dahi'],
    ['Butter 200g', 'Dairy', 320, 380, 25, 'Piece', 'Nestle', ''],
    ['Lays Masala 30g', 'Snacks', 42, 50, 200, 'Piece', 'Lays', 'Crispy potato chips'],
    ['Kurkure Masala Munch 30g', 'Snacks', 40, 50, 180, 'Piece', 'Lays', ''],
    ['Biscuits Family Pack', 'Snacks', 95, 120, 90, 'Pack', 'National', ''],
    ['Chocolate Bar 50g', 'Snacks', 85, 100, 150, 'Piece', 'Nestle', ''],
    ['Bakery Bread Large', 'Bakery', 110, 140, 20, 'Piece', 'National', 'Daily fresh'],
    ['Bun Pack 6pc', 'Bakery', 60, 80, 30, 'Pack', 'National', ''],
    ['Cake Rusk 400g', 'Bakery', 240, 290, 35, 'Pack', 'National', ''],
    ['Surf Excel 1kg', 'Household', 520, 620, 40, 'Piece', 'Surf Excel', 'Washing detergent powder'],
    ['Dishwashing Bar 3pk', 'Household', 95, 120, 70, 'Pack', 'Surf Excel', ''],
    ['Floor Cleaner 1L', 'Household', 280, 350, 30, 'Litre', 'Surf Excel', ''],
    ['Garbage Bags 20pc', 'Household', 150, 190, 45, 'Pack', 'National', ''],
    ['Colgate Toothpaste 100g', 'Personal Care', 210, 250, 65, 'Piece', 'Colgate', 'Cavity protection'],
    ['Shampoo 360ml', 'Personal Care', 480, 580, 28, 'Piece', 'Nestle', 'Anti-dandruff'],
    ['Bath Soap 4pk', 'Personal Care', 260, 320, 50, 'Pack', 'Colgate', ''],
    ['Hand Sanitizer 250ml', 'Personal Care', 190, 240, 40, 'Piece', 'Colgate', ''],
    ['School Notebook 200pg', 'Stationery', 90, 120, 100, 'Piece', 'National', ''],
    ['Ball Pen Pack 10pc', 'Stationery', 80, 110, 85, 'Pack', 'National', ''],
    ['Pencil Box', 'Stationery', 180, 250, 25, 'Piece', 'National', ''],
    ['Toy Car Die-Cast', 'Toys', 350, 480, 18, 'Piece', 'National', ''],
    ['Puzzle Set 100pc', 'Toys', 420, 550, 12, 'Piece', 'National', ''],
    ['Gift Mug Set', 'Gift Items', 550, 700, 10, 'Pack', 'National', 'Ceramic mugs'],
    ['Scented Candle Gift Box', 'Gift Items', 640, 800, 8, 'Pack', 'National', ''],
  ]
  const productIdByName = new Map<string, string>()
  for (const [name, cat, cost, retail, stock, unit, brand, desc] of products) {
    const existing = await db.product.findFirst({ where: { businessId: business.id, name } })
    if (existing) { productIdByName.set(name, existing.id); continue }
    const p = await db.product.create({
      data: {
        businessId: business.id, name, sku: `SM-${name.replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase()}${Math.floor(Math.random() * 90 + 10)}`,
        barcode: genBarcode(),
        categoryId: catMap.get(cat)!, unitId: unitMap.get(unit)!, brandId: brandMap.get(brand)!,
        costPrice: cost, lastCostPrice: cost, retailPrice: retail,
        wholesalePrice: r2(retail * 0.92), minPrice: r2(cost * 1.05),
        stock, openingStock: stock, minStock: Math.max(5, Math.round(stock * 0.15)),
        description: desc, taxRate: 0,
      },
    })
    productIdByName.set(name, p.id)
    await db.inventoryTransaction.create({
      data: {
        businessId: business.id, productId: p.id, type: 'OPENING',
        quantity: stock, stockBefore: 0, stockAfter: stock, unitCost: cost,
        refType: 'Manual', note: 'Opening stock (seed)', userId: owner.id,
      },
    })
  }

  // ── Suppliers ─────────────────────────────────────────────
  const supplierDefs = [
    ['Khan Traders', 'Khan Distribution', '0321-1112223', 'Karachi'],
    ['Metro Wholesale', 'Metro Group', '0333-4445556', 'Lahore'],
    ['Fresh Dairy Supply', 'FDS Pvt Ltd', '0345-7778889', 'Sahiwal'],
  ]
  const supplierIds: string[] = []
  for (const [name, company, phone, address] of supplierDefs) {
    const s = await db.supplier.upsert({
      where: { businessId_phone: { businessId: business.id, phone } },
      update: {},
      create: { businessId: business.id, name, company, phone, address },
    })
    supplierIds.push(s.id)
  }

  // ── Customers ─────────────────────────────────────────────
  const customerDefs = [
    ['Walk-in Customer', '', 0],
    ['Rashid Mehmood', '0301-9876543', 450],
    ['Zainab Traders', '0302-8765432', 0],
    ['Imran Store', '0303-7654321', 1200],
    ['Mrs. Shaista', '0304-6543210', 0],
    ['Cafe Deems', '0305-5432109', 2300],
  ]
  const customerIdByName = new Map<string, string>()
  for (const [name, phone, opening] of customerDefs as [string, string, number][]) {
    const key = phone || `walkin-${name}`
    let c = await db.customer.findFirst({ where: { businessId: business.id, name } })
    if (!c) {
      c = await db.customer.create({
        data: {
          businessId: business.id, name, phone,
          openingBalance: opening,
          creditLimit: name === 'Cafe Deems' ? 5000 : 0,
        },
      })
      if (opening > 0) {
        await db.customerTransaction.create({
          data: {
            businessId: business.id, customerId: c.id, type: 'OPENING',
            amount: opening, balanceAfter: opening, refNo: 'OPENING', note: 'Opening balance', userId: owner.id,
          },
        })
      }
    }
    customerIdByName.set(name, c.id)
  }

  // ── Purchases (3) ─────────────────────────────────────────
  const purchaseCount = await db.purchase.count({ where: { businessId: business.id } })
  if (purchaseCount === 0) {
    const purchases: [number, [string, number, number][]][] = [
      [0, [['Basmati Rice 5kg', 20, 1850], ['White Sugar 1kg', 80, 138], ['Tapal Danedar Tea 450g', 30, 720]]],
      [1, [['Lays Masala 30g', 150, 42], ['Surf Excel 1kg', 30, 520], ['Colgate Toothpaste 100g', 50, 210]]],
      [2, [['Olpers Milk 1L', 60, 175], ['Nestle Yogurt 1kg', 30, 190]]],
    ]
    let pi = 1
    for (const [supIdx, items] of purchases) {
      const subtotal = r2(items.reduce((s, [, q, c]) => s + q * c, 0))
      const paidOptions = [subtotal, r2(subtotal * 0.6), subtotal]
      const paid = paidOptions[pi - 1]
      const invoiceNo = `PUR-20260901-${String(pi).padStart(5, '0')}`
      const purchase = await db.purchase.create({
        data: {
          businessId: business.id, invoiceNo, supplierId: supplierIds[supIdx],
          subtotal, total: subtotal, paid, dueAmount: r2(subtotal - paid),
          status: 'RECEIVED',
        },
      })
      for (const [pname, qty, cost] of items) {
        const pid = productIdByName.get(pname)!
        await db.purchaseItem.create({
          data: { purchaseId: purchase.id, productId: pid, name: pname, quantity: qty, unitCost: cost, total: r2(qty * cost) },
        })
        const prod = await db.product.findUnique({ where: { id: pid } })
        const before = prod!.stock
        const after = r2(before + qty)
        const avg = r2((before * prod!.costPrice + qty * cost) / after)
        await db.product.update({ where: { id: pid }, data: { stock: after, costPrice: avg, lastCostPrice: cost } })
        await db.inventoryTransaction.create({
          data: {
            businessId: business.id, productId: pid, type: 'PURCHASE',
            quantity: qty, stockBefore: before, stockAfter: after, unitCost: cost,
            refType: 'Purchase', refId: purchase.id, refNo: invoiceNo, note: `Purchase ${invoiceNo}`, userId: owner.id,
          },
        })
      }
      const agg = await db.supplierTransaction.aggregate({ where: { businessId: business.id, supplierId: supplierIds[supIdx] }, _sum: { amount: true } })
      const sup = await db.supplier.findUnique({ where: { id: supplierIds[supIdx] } })
      const bal = r2((agg._sum.amount || 0) + (sup?.openingBalance || 0))
      await db.supplierTransaction.create({
        data: {
          businessId: business.id, supplierId: supplierIds[supIdx], type: 'PURCHASE_CREDIT',
          amount: subtotal, balanceAfter: r2(bal + subtotal), refType: 'Purchase', refId: purchase.id, refNo: invoiceNo, note: `Purchase ${invoiceNo}`, userId: owner.id,
        },
      })
      if (paid > 0) {
        await db.supplierTransaction.create({
          data: {
            businessId: business.id, supplierId: supplierIds[supIdx], type: 'PAYMENT',
            amount: -paid, balanceAfter: r2(bal + subtotal - paid), refType: 'Purchase', refId: purchase.id, refNo: invoiceNo, note: `Paid with ${invoiceNo}`, userId: owner.id,
          },
        })
      }
      pi++
    }
  }

  // ── Sales (25 across last 10 days) ────────────────────────
  const saleCount = await db.sale.count({ where: { businessId: business.id } })
  if (saleCount === 0) {
    const methods = ['CASH', 'CASH', 'CARD', 'CASH', 'DIGITAL', 'KHATA']
    const productNames = [...productIdByName.keys()].filter(n => n !== 'Walk-in Customer')
    let inv = 1
    for (let d = 10; d >= 0; d--) {
      const salesToday = d === 0 ? 5 : 2 + Math.floor(Math.random() * 3)
      for (let s = 0; s < salesToday; s++) {
        const created = new Date(Date.now() - d * 86400000 + 9 * 3600000 + s * 5400000)
        const itemCount = 1 + Math.floor(Math.random() * 4)
        const chosen: string[] = []
        while (chosen.length < itemCount) {
          const n = productNames[Math.floor(Math.random() * productNames.length)]
          if (!chosen.includes(n)) chosen.push(n)
        }
        const isKhata = d > 0 && Math.random() < 0.25
        const custName = isKhata ? (customerIdByName.get('Rashid Mehmood') ? 'Rashid Mehmood' : 'Imran Store') : (Math.random() < 0.5 ? 'Walk-in Customer' : productNames && customerDefs[Math.floor(Math.random() * customerDefs.length)][0])
        let subtotal = 0
        const lines: { productId: string; name: string; sku: string; barcode: string; quantity: number; price: number; costAtSale: number; discount: number; taxRate: number; taxAmount: number; total: number }[] = []
        const invNo = `INV-2026${String(9).padStart(2, '0')}${String(20 - d).padStart(2, '0')}-${String(inv).padStart(5, '0')}`
        for (const pname of chosen) {
          const prod = await db.product.findUnique({ where: { id: productIdByName.get(pname)! } })
          if (!prod || prod.stock < 3) continue
          const qty = 1 + Math.floor(Math.random() * 3)
          subtotal = r2(subtotal + qty * prod.retailPrice)
          lines.push({
            productId: prod.id, name: prod.name, sku: prod.sku, barcode: prod.barcode,
            quantity: qty, price: prod.retailPrice, costAtSale: prod.costPrice,
            discount: 0, taxRate: 0, taxAmount: 0, total: r2(qty * prod.retailPrice),
          })
        }
        if (lines.length === 0) continue
        const method = isKhata ? 'KHATA' : methods[Math.floor(Math.random() * methods.length)]
        const paid = isKhata ? r2(subtotal * 0.5) : subtotal
        const due = r2(subtotal - paid)
        const profit = r2(lines.reduce((acc, l) => acc + (l.price - l.costAtSale) * l.quantity, 0))
        const sale = await db.sale.create({
          data: {
            businessId: business.id, invoiceNo: invNo, clientRef: `seed-${invNo}`,
            customerId: customerIdByName.get(custName) || null,
            cashierId: owner.id, cashierName: owner.name,
            subtotal, discount: 0, tax: 0, total: subtotal, paid, dueAmount: due,
            profit, paymentMethod: method, status: 'COMPLETED',
            createdAt: created, updatedAt: created,
          },
        })
        inv++
        for (const l of lines) {
          await db.saleItem.create({ data: { ...l, saleId: sale.id } })
          const prod = await db.product.findUnique({ where: { id: l.productId } })
          const before = prod!.stock
          const after = r2(before - l.quantity)
          await db.product.update({ where: { id: prod!.id }, data: { stock: after } })
          await db.inventoryTransaction.create({
            data: {
              businessId: business.id, productId: l.productId, type: 'SALE',
              quantity: -l.quantity, stockBefore: before, stockAfter: after, unitCost: l.costAtSale,
              refType: 'Sale', refId: sale.id, refNo: invNo, note: `Sale ${invNo}`, userId: owner.id,
              createdAt: created,
            },
          })
        }
        if (isKhata && due > 0) {
          const cid = sale.customerId!
          const agg = await db.customerTransaction.aggregate({ where: { businessId: business.id, customerId: cid }, _sum: { amount: true } })
          const cust = await db.customer.findUnique({ where: { id: cid } })
          const bal = r2((agg._sum.amount || 0) + (cust?.openingBalance || 0))
          await db.customerTransaction.create({
            data: {
              businessId: business.id, customerId: cid, type: 'SALE_CREDIT', amount: due,
              balanceAfter: r2(bal + due), refType: 'Sale', refId: sale.id, refNo: invNo,
              note: `Credit sale ${invNo}`, userId: owner.id, createdAt: created,
            },
          })
        }
      }
    }
    // a khata payment
    const rashid = customerIdByName.get('Rashid Mehmood')
    if (rashid) {
      const agg = await db.customerTransaction.aggregate({ where: { businessId: business.id, customerId: rashid }, _sum: { amount: true } })
      const cust = await db.customer.findUnique({ where: { id: rashid } })
      const bal = r2((agg._sum.amount || 0) + (cust?.openingBalance || 0))
      await db.customerTransaction.create({
        data: {
          businessId: business.id, customerId: rashid, type: 'PAYMENT', amount: -500,
          balanceAfter: r2(bal - 500), refNo: 'PAY-C-SEED1', note: 'Payment received (CASH)', userId: owner.id,
          createdAt: new Date(Date.now() - 2 * 86400000),
        },
      })
    }
  }

  // ── Expenses ──────────────────────────────────────────────
  const expCount = await db.expense.count({ where: { businessId: business.id } })
  if (expCount === 0) {
    const expCats = await db.expenseCategory.findMany({ where: { businessId: business.id } })
    const catId = (n: string) => expCats.find(c => c.name === n)?.id
    const expenses: [string, number, string][] = [
      ['Shop rent — September', 45000, 'Rent'],
      ['Electricity bill', 18500, 'Electricity'],
      ['Staff salary — Sana', 32000, 'Salary'],
      ['Staff salary — Bilal', 38000, 'Salary'],
      ['Delivery van fuel', 6500, 'Transport'],
      ['Internet bill', 4500, 'Internet'],
      ['AC repair', 3200, 'Maintenance'],
      ['Packaging bags', 2800, 'Other'],
    ]
    let i = 0
    for (const [title, amount, cat] of expenses) {
      await db.expense.create({
        data: {
          businessId: business.id, categoryId: catId(cat) || null,
          title, amount, paymentMethod: 'CASH', paidTo: '',
          expenseDate: new Date(Date.now() - i * 3 * 86400000), userId: owner.id,
        },
      })
      i++
    }
  }

  console.log('Seed complete.')
  console.log('  Platform owner : asifawaan90@gmail.com / owner@12345')
  console.log('  Demo owner     : demo@smartmart.app / Demo@12345')
  console.log('  Manager        : manager@smartmart.app / Manager@123')
  console.log('  Cashier        : cashier@smartmart.app / Cashier@123')
  void trial; void superAdmin
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
