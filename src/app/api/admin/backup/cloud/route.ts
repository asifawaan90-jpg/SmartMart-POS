import { NextRequest } from 'next/server'
import { ok, fail, handleError, readBody } from '@/lib/api'
import { requireSuperAdmin } from '@/lib/admin'
import { cloudStatus, pushCloudBackup, verifyCloudBackup } from '@/lib/firebase-backup'

export const dynamic = 'force-dynamic'

// GET /api/admin/backup/cloud — status for the Data tab card (no secrets leaked)
export async function GET(req: NextRequest) {
  try {
    await requireSuperAdmin(req)
    return ok(await cloudStatus())
  } catch (e) { return handleError(e) }
}

// POST /api/admin/backup/cloud — { action: 'push' | 'verify' }
export async function POST(req: NextRequest) {
  try {
    await requireSuperAdmin(req)
    const b = await readBody<{ action?: string }>(req)
    if (b.action === 'verify') return ok({ verify: await verifyCloudBackup() })
    if (b.action === 'push') return ok({ push: await pushCloudBackup('manual') })
    return fail(400, 'VALIDATION', 'action must be push or verify.')
  } catch (e) { return handleError(e) }
}
