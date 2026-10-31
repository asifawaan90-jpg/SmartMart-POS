'use client'
import { useAuthStore } from '@/stores/auth'

export class ApiClientError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function api<T = unknown>(path: string, opts?: Omit<RequestInit, 'body'> & { body?: unknown }): Promise<T> {
  const token = typeof window !== 'undefined' ? useAuthStore.getState().token : null
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(path, {
    ...opts,
    // Task 50 — never let the browser reuse a previous API response from its
    // own HTTP cache. iOS Safari in particular heuristically caches GETs that
    // lack Cache-Control headers, which made iPhones show old data even
    // though the Android app and desktop were fine. (The server now ALSO
    // sends no-store on every /api/ response via middleware — this is the
    // belt-and-suspenders client side.)
    cache: 'no-store',
    headers: { ...headers, ...(opts?.headers as Record<string, string>) },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  let json: { ok?: boolean; data?: T; code?: string; message?: string } = {}
  try { json = await res.json() } catch { /* non-JSON */ }
  if (!res.ok || json.ok === false) {
    throw new ApiClientError(res.status, json.code || 'ERROR', json.message || `Request failed (${res.status})`)
  }
  return json.data as T
}

export function errMsg(e: unknown): string {
  if (e instanceof ApiClientError) return e.message
  if (e instanceof Error) {
    if (isNetworkError(e)) {
      // Task 67-b — this message MUST NOT claim the data was saved: whether it
      // is queued on the device depends on the caller (sales/stock queue;
      // product edits used to be lost while this text promised a save).
      return 'You are offline — the server could not be reached. This change has NOT been saved yet.'
    }
    return e.message
  }
  return 'Something went wrong.'
}

/** True when the failure means "the server was never reached" (offline, DNS,
 *  connection refused/dropped, timeout, CORS/proxy outage). Callers queue the
 *  operation on the device in this case — it is always safe, because the sync
 *  engine is idempotent per clientRef. */
export function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true
  if (e instanceof ApiClientError) return false // server WAS reached and answered
  if (e instanceof Error) {
    return /Failed to fetch|NetworkError|Load failed|network|timed? ?out|aborted|connection/i.test(e.message)
  }
  return false
}

/** HTTP status of an api() error, if any (0 = never reached the server). */
export function statusOf(e: unknown): number {
  return e instanceof ApiClientError ? e.status : 0
}
