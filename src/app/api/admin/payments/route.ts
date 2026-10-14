import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail, handleError, clientIp, audit } from '@/lib/api'
import { requireSuperAdmin } from '@/lib/admin'

export const dynamic = 'force-dynamic'

// GET /api/admin/payments?status=
export async function GET(req: NextRequest) {
  try {
    await requireSuperAdmin(req)
    const status = new URL(req.url).searchParams.get('status') || ''
    const payments = await db.subscriptionPayment.findMany({
      where: status ? { status } : {},
      include: { business: { select: { name: true, email: true, ownerName: true } }, plan: { select: { name: true, code: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    return ok(payments)
  } catch (e) {
    return handleError(e)
  }
}
void audit; void clientIp; void fail
