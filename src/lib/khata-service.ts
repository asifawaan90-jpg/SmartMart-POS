import { db } from '@/lib/db'
import { ApiError, num, r2 } from '@/lib/api'

export interface KhataPaymentInput {
  customerId: string
  amount: number
  note?: string
  method?: string
  clientRef?: string
  deviceTs?: string
}

/**
 * Records a khata (customer credit) payment idempotently (clientRef unique
 * per business). Server-authoritative: recomputes the running balance from
 * the ledger + opening balance. Used by POST /api/customers/payment and by
 * the offline sync engine (kind: KHATA_PAYMENT).
 */
export async function createKhataPayment(opts: {
  businessId: string
  userId: string
  input: KhataPaymentInput
}): Promise<{ id: string; duplicate: boolean; refNo: string; customerName: string; balanceAfter: number }> {
  const { businessId, userId, input: b } = opts
  const customerId = String(b.customerId || '')
  if (!customerId) throw new ApiError(400, 'VALIDATION', 'customerId required.')
  const amount = r2(num(b.amount))
  if (amount <= 0) throw new ApiError(400, 'VALIDATION', 'Amount must be greater than zero.')
  const clientRef = (b.clientRef || '').slice(0, 64)

  // Idempotency fast-path — the same device payment never books twice.
  if (clientRef) {
    const existing = await db.customerTransaction.findUnique({
      where: { businessId_clientRef: { businessId, clientRef } },
      select: { id: true, refNo: true, balanceAfter: true, customer: { select: { name: true } } },
    })
    if (existing) {
      return { id: existing.id, duplicate: true, refNo: existing.refNo, customerName: existing.customer.name, balanceAfter: existing.balanceAfter }
    }
  }

  const result = await db.$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({ where: { id: customerId, businessId } })
    if (!customer) throw new ApiError(404, 'NOT_FOUND', 'Customer not found.')
    const agg = await tx.customerTransaction.aggregate({ where: { businessId, customerId }, _sum: { amount: true } })
    const balanceBefore = r2((agg._sum.amount || 0) + customer.openingBalance)
    const paymentNo = `PAY-C-${Date.now().toString(36).toUpperCase()}`
    const txn = await tx.customerTransaction.create({
      data: {
        businessId, customerId, type: 'PAYMENT',
        amount: -amount, balanceAfter: r2(balanceBefore - amount),
        refType: 'Manual', refNo: paymentNo,
        note: (b.note || `Payment received (${b.method || 'CASH'})`).slice(0, 300),
        userId,
        clientRef: clientRef || null,
      },
    })
    return { txn, customerName: customer.name }
  })

  return { id: result.txn.id, duplicate: false, refNo: result.txn.refNo, customerName: result.customerName, balanceAfter: result.txn.balanceAfter }
}
