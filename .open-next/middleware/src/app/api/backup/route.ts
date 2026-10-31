import { NextRequest } from 'next/server'
import {
  ok, handleError, requirePerm, requireActiveSub, audit, clientIp,
} from '@/lib/api'
import { collectBackupData } from '@/lib/backup'

export const dynamic = 'force-dynamic'

/**
 * GET /api/backup?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Full tenant-scoped data snapshot (OWNER / settings-perm only).
 * User password hashes are NEVER included. Every export is audit-logged.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requirePerm(req, 'settings')
    await requireActiveSub(ctx)

    const url = new URL(req.url)
    const from = url.searchParams.get('from') || undefined
    const to = url.searchParams.get('to') || undefined

    const data = await collectBackupData(ctx.businessId, { from, to })

    await audit(ctx.businessId, ctx.user.uid, 'DATA_BACKUP_EXPORTED', 'Business', ctx.businessId,
      { from: from || 'all', to: to || 'all', counts: data.meta.counts }, clientIp(req))

    return ok(data)
  } catch (e) {
    return handleError(e)
  }
}
