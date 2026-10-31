import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
const shops = await prisma.shop.findMany({ where: { name: { contains: 'madina', mode: 'insensitive' } } })
console.log('Al Madina Shops:', shops)

for (const s of shops) {
  const count = await prisma.sale.count({ where: { shopId: s.id } })
  console.log(`\nShop: ${s.name} (${s.id}) -> Total Sales in DB: ${count}`)
  
  const limited = await prisma.sale.findMany({ where: { shopId: s.id }, take: 11, orderBy: { createdAt: 'desc' } })
  console.log(`With take:11 -> ${limited.length} (yehi tumhe mil raha hai)`)
  
  const all = await prisma.sale.findMany({ where: { shopId: s.id }, orderBy: { createdAt: 'desc' } })
  console.log(`Without take -> ${all.length} (ye ana chahiye)`)
}
await prisma.$disconnect()
