import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken } from '@/lib/auth'
import { ApiError } from '@/lib/api'

/** Guard for /api/admin/* — platform SUPER_ADMIN only. */
export async function requireSuperAdmin(req: NextRequest) {
  const session = await verifyToken((req.headers.get('authorization') || '').replace('Bearer ', ''))
  if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in.')
  if (session.role !== 'SUPER_ADMIN') throw new ApiError(403, 'FORBIDDEN', 'Platform owner access required.')
  return session
}
