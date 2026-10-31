import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

// Saare models check karo
console.log('Available models:', Object.keys(prisma).filter(k=>!k.startsWith('_') && !k.startsWith('$')).join(', '))

// Try different names for shop
let shopModel = prisma.shop || prisma.store || prisma.Shop || prisma.Store
if (!shopModel) {
  // list tables directly via raw query
  const tables = await prisma.$queryRaw`SELECT name FROM sqlite_master WHERE type='table'`
  console.log('Tables in DB:', tables)
} else {
  const shops = await shopModel.findMany()
  console.log('Shops:', shops)
  
  for (const s of shops) {
    if (s.name?.toLowerCase().includes('madina')) {
      console.log(`\n=== FOUND Al Madina: ${s.name} ID:${s.id} ===`)
      // count sales
      let saleModel = prisma.sale || prisma.order || prisma.Sale || prisma.Order
      if (saleModel) {
        const count = await saleModel.count({ where: { shopId: s.id } }).catch(async ()=> {
          // try storeId
          return await saleModel.count({ where: { storeId: s.id } })
        })
        console.log('Total sales:', count)
        
        const sales11 = await saleModel.findMany({ where: { shopId: s.id }, take: 11, orderBy: { createdAt: 'desc' } }).catch(async ()=>{
          return await saleModel.findMany({ where: { storeId: s.id }, take: 11, orderBy: { createdAt: 'desc' } })
        })
        console.log('With take 11:', sales11.length)
        
        const allSales = await saleModel.findMany({ where: { shopId: s.id }, orderBy: { createdAt: 'desc' } }).catch(async ()=>{
          return await saleModel.findMany({ where: { storeId: s.id }, orderBy: { createdAt: 'desc' } })
        })
        console.log('Without take:', allSales.length, '=> YE SAHI HAI')
      }
    }
  }
}
await prisma.$disconnect()
