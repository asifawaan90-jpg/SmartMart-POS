import bcrypt from 'bcryptjs'
import { SignJWT, jwtVerify } from 'jose'

const configuredSecret = process.env.JWT_SECRET
if (process.env.NODE_ENV === 'production' && (!configuredSecret || configuredSecret.length < 32)) {
  throw new Error('JWT_SECRET must be configured with at least 32 characters in production.')
}

const secret = new TextEncoder().encode(
  configuredSecret || 'smartmart-dev-secret-change-in-production-0123456789'
)

export interface SessionUser {
  uid: string
  bid: string | null // businessId (null for platform SUPER_ADMIN)
  role: string
  name: string
  email: string
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

export async function signToken(user: SessionUser, expiresIn = '7d'): Promise<string> {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret)
}

export async function verifyToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret)
    return {
      uid: payload.uid as string,
      bid: (payload.bid as string) ?? null,
      role: payload.role as string,
      name: payload.name as string,
      email: payload.email as string,
    }
  } catch {
    return null
  }
}

export function extractToken(req: Request): string | null {
  const header = req.headers.get('authorization') || ''
  if (header.startsWith('Bearer ')) return header.slice(7)
  return null
}
