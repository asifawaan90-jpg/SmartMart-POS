const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
(async () => {
  const db = new PrismaClient();
  const hash = await bcrypt.hash('123456', 10);
  const users = await db.user.findMany();
  console.log('Users:', users.map(u => u.email));
  for (const u of users) {
    try {
      await db.user.update({ where: { id: u.id }, data: { passwordHash: hash } });
      console.log('Updated passwordHash for', u.email);
    } catch {}
    try {
      await db.user.update({ where: { id: u.id }, data: { password: hash } });
      console.log('Updated password for', u.email);
    } catch {}
  }
  console.log('Done - password is 123456');
  await db.$disconnect();
})();