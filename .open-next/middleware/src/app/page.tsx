'use client'

import { useSyncExternalStore } from 'react'
import AppShell from '@/components/app-shell'
import AuthView from '@/components/views/auth-view'
import { useAuthStore } from '@/stores/auth'

export default function Home() {
  const user = useAuthStore((state) => state.user)
  const hydrated = useSyncExternalStore(
    (onStoreChange) => useAuthStore.persist.onFinishHydration(onStoreChange),
    () => useAuthStore.persist.hasHydrated(),
    () => false,
  )

  if (!hydrated) {
    return (
      <main className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
        Loading SmartMart POS...
      </main>
    )
  }

  return user ? <AppShell /> : <AuthView />
}
