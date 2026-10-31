import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, handleError, num } from '@/lib/api'

export const dynamic = 'force-dynamic'

// GET /api/audit?action=&page= — audit log viewer
export async function GET(req: NextRequest) {
  try {
    const ctx = await import('@/lib/api').then(m => m.requirePerm(req, 'settings'))
    const url = new URL(req.url)
    const action = url.searchParams.get('action') || ''
    const page = Math.max(1, num(url.searchParams.get('page'), 1))
    const where: Record<string, unknown> = { businessId: ctx.businessId }
    if (action) where.action = { contains: action }
    const [items, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        include: { user: { select: { name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * 30,
        take: 30,
      }),
      db.auditLog.count({ where }),
    ])
    return ok({ items, total, page })
  } catch (e) {
    return handleError(e)
  }
}
