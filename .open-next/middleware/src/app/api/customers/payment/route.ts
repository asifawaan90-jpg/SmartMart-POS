import { NextRequest } from 'next/server'
import {
  ok, handleError, readBody, requirePerm, requireActiveSub, audit, clientIp,
} from '@/lib/api'
import { createKhataPayment } from '@/lib/khata-service'
import { maybeAutoBackup } from '@/lib/backup-auto'

export const dynamic = 'force-dynamic'

// POST /api/customers/payment?customerId= — khata payment { amount, note, method }
export async function POST(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'khata_manage')
    await requireActiveSub(ctx)
    const customerId = new URL(req.url).searchParams.get('customerId')
    const b = await readBody<{ amount: number; note?: string; method?: string; clientRef?: string }>(req)
    const result = await createKhataPayment({
      businessId: ctx.businessId,
      userId: ctx.user.uid,
      input: {
        customerId: String(customerId || ''),
        amount: b.amount,
        note: b.note,
        method: b.method,
        clientRef: b.clientRef,
      },
    })

    if (!result.duplicate) {
      await audit(ctx.businessId, ctx.user.uid, 'KHATA_PAYMENT', 'Customer', String(customerId),
        { amount: b.amount, customer: result.customerName }, clientIp(req))
      void maybeAutoBackup(ctx.businessId, ctx.user, 'khata payment saved', { amount: b.amount, customer: result.customerName })
    }
    return ok({ id: result.id, refNo: result.refNo, balanceAfter: result.balanceAfter }, result.duplicate ? 200 : 201)
  } catch (e) {
    return handleError(e)
  }
}
