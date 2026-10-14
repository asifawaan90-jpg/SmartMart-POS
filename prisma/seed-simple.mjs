import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
const db = new PrismaClient()
async function main(){
  const hash = await bcrypt.hash('admin123', 10)
  const biz = await db.business.upsert({
    where: { id: 'biz_1' },
    update: {},
    create: { id: 'biz_1', name: 'SmartMart', slug: 'smartmart' }
  })
  console.log('biz', biz.id)
  const user = await db.user.upsert({
    where: { email: 'admin@smartmart.com' },
    update: { passwordHash: hash },
    create: { email: 'admin@smartmart.com', name: 'Admin', passwordHash: hash, role: 'ADMIN', businessId: biz.id }
  })
  console.log('user created', user.email)
}
main().finally(()=>db.$disconnect())