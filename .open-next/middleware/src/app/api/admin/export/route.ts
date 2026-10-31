import { NextRequest } from 'next/server'
import { ok, handleError, audit, ApiError } from '@/lib/api'
import { requireSuperAdmin } from '@/lib/admin'
import { collectAllBusinessesData } from '@/lib/platform-backup'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/export?businessId=<id|all>
 *
 * Platform Owner Panel → Data tab. Returns full BackupData snapshot(s) as
 * JSON — the client builds the Excel workbook(s) locally (same engine as the
 * business backup), so huge exports never pass through a download endpoint
 * and work offline in the panel.
 *   - businessId=<uuid> → single business snapshot
 *   - businessId=all    → EVERY business (the "save all users data" export)
 * SUPER_ADMIN only; every export is audit-logged.
 */
export async function GET(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req)
    const url = new URL(req.url)
    const target = url.searchParams.get('businessId') || 'all'

    const list = await collectAllBusinessesData()

    if (target !== 'all') {
      const one = list.find(b => b.id === target)
      if (!one) throw new ApiError(404, 'NOT_FOUND', 'Business not found.')
      if (!one.data) throw new ApiError(500, 'COLLECT_FAILED', one.error || 'Could not collect this business data.')
      await audit(null, admin.uid, 'PLATFORM_DATA_EXPORTED', 'Business', target,
        { scope: 'single', business: one.name }, req.headers.get('x-forwarded-for') || '')
      return ok({ businesses: [{ id: one.id, name: one.name, email: one.email, data: one.data }] })
    }

    await audit(null, admin.uid, 'PLATFORM_DATA_EXPORTED', 'PlatformConfig', 'backup',
      { scope: 'all', businesses: list.filter(b => b.data).length }, req.headers.get('x-forwarded-for') || '')
    return ok({
      businesses: list.map(b => ({ id: b.id, name: b.name, email: b.email, data: b.data || null, error: b.error || null })),
    })
  } catch (e) {
    return handleError(e)
  }
}
