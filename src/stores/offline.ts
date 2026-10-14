'use client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useAuthStore } from '@/stores/auth'

export type SyncStatus = 'ONLINE' | 'OFFLINE' | 'SYNCING' | 'SYNC_ERROR'

/** Every write the device can queue while offline. */
export type QueueKind = 'SALE' | 'STOCK_ADJUSTMENT' | 'PURCHASE' | 'KHATA_PAYMENT' | 'PRODUCT'

export const KIND_LABEL: Record<QueueKind, string> = {
  SALE: 'Sale',
  STOCK_ADJUSTMENT: 'Stock adjustment',
  PURCHASE: 'Purchase',
  KHATA_PAYMENT: 'Khata payment',
  PRODUCT: 'Product',
}

export interface QueuedItem {
  clientRef: string
  kind: QueueKind
  payload: Record<string, unknown>
  createdAt: number
  attempts: number
  lastError?: string
  holdUntil?: number
}

/** Legacy name kept for the sales-only era of this queue. */
export type QueuedSale = QueuedItem

export interface QueueInput {
  clientRef: string
  kind?: QueueKind
  payload: Record<string, unknown>
  createdAt?: number
  attempts?: number
}

interface OfflineState {
  status: SyncStatus
  queue: QueuedItem[]
  lastSyncedAt: number | null
  deviceId: string
  setStatus: (s: SyncStatus) => void
  enqueue: (item: QueueInput) => void
  dequeue: (clientRef: string) => void
  markAttempt: (clientRef: string, error: string) => void
  setLastSynced: (t: number) => void
  clearQueue: () => void
}

export const useOfflineStore = create<OfflineState>()(
  persist(
    (set) => ({
      status: 'ONLINE',
      queue: [],
      lastSyncedAt: null,
      deviceId: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `dev-${Math.random().toString(36).slice(2)}`,
      setStatus: (status) => set({ status }),
      enqueue: (item) => set((st) => ({
        queue: [
          ...st.queue.filter(q => q.clientRef !== item.clientRef),
          {
            clientRef: item.clientRef,
            kind: item.kind ?? 'SALE', // items saved before kinds existed were all sales
            payload: item.payload,
            createdAt: item.createdAt ?? Date.now(),
            attempts: item.attempts ?? 0,
          },
        ],
      })),
      dequeue: (clientRef) => set((st) => ({ queue: st.queue.filter(q => q.clientRef !== clientRef) })),
      markAttempt: (clientRef, error) => set((st) => ({
        queue: st.queue.map(q => q.clientRef === clientRef
          ? { ...q, attempts: q.attempts + 1, lastError: error, holdUntil: Date.now() + Math.min(5 * 60_000, 2000 * 2 ** Math.min(q.attempts, 6)) }
          : q),
      })),
      setLastSynced: (lastSyncedAt) => set({ lastSyncedAt }),
      clearQueue: () => set({ queue: [] }),
    }),
    {
      name: 'smartmart-offline',
      // Migrate pre-kind queues (all sales) so nothing saved before this
      // upgrade is lost on first boot.
      migrate: (persisted) => {
        const p = persisted as { queue?: (QueuedItem & { kind?: QueueKind })[] } | undefined
        if (p?.queue) p.queue = p.queue.map(q => ({ ...q, kind: q.kind ?? 'SALE' }))
        return p as OfflineState
      },
      version: 1,
    }
  )
)

let syncing = false
let started = false

export type SyncSkipped = 'BUSY' | 'AUTH'
export interface SyncResult { pushed: number; failed: number; skipped?: SyncSkipped }

/** Push offline queue to server. Safe to call any time; only one sync runs at once.
 *  Task 70 — force=true (user pressed a Sync now button) ALWAYS does a real
 *  server round-trip so the Last-synced stamp moves even with an empty queue,
 *  and retries ops sitting in error backoff-hold. The auto engine (every 20s /
 *  focus / online) stays cheap: no server ping when there is nothing to push.
 *  Task 72 — the auto engine fires on every return-to-app (visibilitychange),
 *  exactly when users tap "Sync now". The old code silently bailed out while a
 *  sync was in flight and the dashboard then claimed "All synced" with an
 *  UNMOVED date — the user's exact complaint. A force press now waits (max 8s)
 *  for the in-flight sync to finish and still runs its real round-trip; auto
 *  callers keep the cheap bail-out. skipped=BUSY/AUTH tells the UI honestly
 *  why nothing happened instead of a fake "All synced". */
export async function syncNow(force = false): Promise<SyncResult> {
  const { token } = useAuthStore.getState()
  if (!token) return { pushed: 0, failed: 0, skipped: 'AUTH' }
  if (syncing) {
    if (!force) return { pushed: 0, failed: 0 }
    const deadline = Date.now() + 8000
    while (syncing && Date.now() < deadline) await new Promise(r => setTimeout(r, 120))
    if (syncing) return { pushed: 0, failed: 0, skipped: 'BUSY' }
    if (!useAuthStore.getState().token) return { pushed: 0, failed: 0, skipped: 'AUTH' }
  }
  const st = useOfflineStore.getState()
  syncing = true
  st.setStatus('SYNCING')
  try {
    if (st.queue.length === 0) {
      if (!force) {
        st.setStatus(navigator.onLine ? 'ONLINE' : 'OFFLINE')
        return { pushed: 0, failed: 0 }
      }
      // Nothing queued + user asked for a sync → prove the server is actually
      // reachable, then stamp. Network failure falls through to the catch
      // below (SYNC_ERROR/OFFLINE + failed:1), so the date only moves on a
      // REAL round-trip, never on a guess.
      const ping = await fetch('/api/version', { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
      if (!ping.ok) throw new Error(`server responded ${ping.status}`)
      useOfflineStore.getState().setLastSynced(Date.now())
      useOfflineStore.getState().setStatus('ONLINE')
      return { pushed: 0, failed: 0 }
    }
    const now = Date.now()
    // force (user button) also retries ops that are in error backoff-hold
    const ready = st.queue.filter(q => force || !q.holdUntil || q.holdUntil <= now).slice(0, 100)
    if (ready.length === 0) {
      st.setStatus(navigator.onLine ? 'ONLINE' : 'OFFLINE')
      return { pushed: 0, failed: 0 }
    }
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        deviceId: st.deviceId,
        ops: ready.map(q => ({ kind: q.kind, clientRef: q.clientRef, payload: q.payload })),
      }),
    })
    if (res.status === 402 || res.status === 401) {
      // Task 67 — auth/subscription wall: the queue stays persisted and keeps
      // retrying every 20s. For 401 the user must log in again ONCE — syncNow
      // re-reads the fresh token from the auth store on every attempt, so the
      // whole backlog flushes automatically right after re-login.
      try { console.warn(`[sync] server rejected batch (${res.status}) — ${ready.length} op(s) stay queued`) } catch { /* ignore */ }
      useOfflineStore.getState().setStatus('SYNC_ERROR')
      syncing = false
      return { pushed: 0, failed: ready.length }
    }
    const json = await res.json()
    if (!json.ok) throw new Error(json.message || 'Sync failed')
    let pushed = 0
    let failed = 0
    for (const r of json.data.results as { clientRef: string; status: string; error?: string }[]) {
      if (r.status === 'SYNCED' || r.status === 'DUPLICATE') {
        useOfflineStore.getState().dequeue(r.clientRef)
        pushed++
      } else {
        useOfflineStore.getState().markAttempt(r.clientRef, r.error || 'Server rejected')
        failed++
      }
    }
    useOfflineStore.getState().setLastSynced(Date.now())
    useOfflineStore.getState().setStatus('ONLINE')
    return { pushed, failed }
  } catch {
    // Offline (WiFi off / airplane) is a normal state, not an error — show it honestly.
    useOfflineStore.getState().setStatus(navigator.onLine ? 'SYNC_ERROR' : 'OFFLINE')
    return { pushed: 0, failed: 1 }
  } finally {
    syncing = false
  }
}

/** Install global listeners once per app life. */
export function startSyncEngine() {
  if (started || typeof window === 'undefined') return
  started = true
  const updateOnline = () => {
    useOfflineStore.getState().setStatus(navigator.onLine ? 'ONLINE' : 'OFFLINE')
    if (navigator.onLine) setTimeout(syncNow, 800)
  }
  window.addEventListener('online', updateOnline)
  window.addEventListener('offline', updateOnline)
  useOfflineStore.getState().setStatus(navigator.onLine ? 'ONLINE' : 'OFFLINE')
  // Coming back to the app/tab is the most reliable "I have signal again"
  // signal on phones (mobile browsers often skip the `online` event).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) setTimeout(syncNow, 400)
  })
  // Boot sync: push anything queued while the app was closed (persisted token
  // needs a tick to rehydrate before syncNow can use it).
  setTimeout(() => { if (navigator.onLine) syncNow() }, 1500)
  // periodic sync
  setInterval(() => {
    if (navigator.onLine) syncNow()
  }, 20_000)
}

/** Update the locally cached product stock (pos_cache) after an offline
 *  adjustment/purchase so offline POS stock checks stay truthful until the
 *  next successful server refresh. Returns true when the cache was updated. */
export function applyLocalStockDelta(businessId: string | null | undefined, productId: string, delta: number): boolean {
  if (!businessId || typeof window === 'undefined') return false
  const key = `pos_cache_${businessId}_products`
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return false
    const items = JSON.parse(raw) as { id: string; stock: number }[]
    const hit = items.find(p => p.id === productId)
    if (!hit) return false
    hit.stock = Math.max(0, Math.round((hit.stock + delta) * 100) / 100)
    window.localStorage.setItem(key, JSON.stringify(items))
    return true
  } catch { return false }
}
