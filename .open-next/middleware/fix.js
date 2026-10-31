const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
async function main() {
  await prisma.$executeRawUnsafe('ALTER TABLE "Product" DISABLE ROW LEVEL SECURITY;')
  console.log("RLS OFF ho gaya")
}
main()