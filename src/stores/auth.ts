'use client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { refreshOfflineSession, type OfflineSessionSnapshot } from '@/lib/offline-auth'

export interface AuthUser {
  id: string
  name: string
  email: string
  role: string
  businessId: string | null
  phone: string
}

export interface SubInfo {
  status: string
  planCode: string
  planName: string
  daysRemaining: number | null
  endDate: string | null
  isLifetime: boolean
}

export interface BusinessInfo {
  id: string; name: string; ownerName: string; email: string
  phone: string; address: string; currency: string; logo: string; bizType: string
}

interface AuthState {
  token: string | null
  user: AuthUser | null
  subscription: SubInfo | null
  business: BusinessInfo | null
  settings: Record<string, unknown>
  setSession: (t: { token: string; user: AuthUser; subscription?: SubInfo | null }) => void
  setBusiness: (b: BusinessInfo | null) => void
  setSubscription: (s: SubInfo | null) => void
  setSettings: (s: Record<string, unknown>) => void
  restoreOfflineSession: (snap: OfflineSessionSnapshot) => void
  logout: (reason?: 'user' | 'rejected') => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      subscription: null,
      business: null,
      settings: {},
      setSession: ({ token, user, subscription }) => set({ token, user, subscription: subscription ?? null }),
      setBusiness: (business) => set({ business }),
      setSubscription: (subscription) => set({ subscription }),
      setSettings: (settings) => set({ settings }),
      // Offline sign-in: restore a full session snapshot saved by a previous
      // ONLINE sign-in on this device (token may be re-validated by the server
      // on reconnect; until then the app runs in offline mode).
      restoreOfflineSession: (snap) => set({
        token: snap.token,
        user: snap.user,
        subscription: snap.subscription ?? null,
        business: snap.business ?? null,
        settings: snap.settings ?? {},
      }),
      // 'rejected' = the server itself refused this session (bad/expired
      // token) — never refresh the saved offline sign-in with a dead token.
      logout: (reason) => {
        const s = get()
        if (reason !== 'rejected' && s.user?.email && s.token) {
          try {
            refreshOfflineSession(s.user.email, {
              token: s.token,
              user: s.user,
              subscription: s.subscription,
              business: s.business,
              settings: s.settings,
            })
          } catch { /* best effort */ }
        }
        set({ token: null, user: null, subscription: null, business: null, settings: {} })
      },
    }),
    { name: 'smartmart-auth' }
  )
)

export function hasPerm(user: AuthUser | null, perm: string): boolean {
  if (!user) return false
  if (user.role === 'OWNER') return true
  const matrix: Record<string, string[]> = {
    MANAGER: ['pos', 'products', 'inventory', 'sales', 'sales_return', 'purchases', 'customers', 'khata', 'khata_manage', 'suppliers', 'expenses', 'reports', 'users'],
    CASHIER: ['pos', 'sales', 'customers'],
    INVENTORY_STAFF: ['products', 'inventory', 'purchases', 'suppliers'],
    ACCOUNTANT: ['reports', 'expenses', 'sales', 'purchases', 'customers', 'khata', 'suppliers'],
  }
  return (matrix[user.role] || []).includes(perm)
}
