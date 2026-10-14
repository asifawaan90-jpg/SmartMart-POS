import { NextRequest, NextResponse } from 'next/server'

/**
 * Task 50 — iPhone-only stale data fix (Next.js 16 `proxy` convention,
 * formerly `middleware`).
 *
 * The service worker already skips every /api/ request (network-only), but the
 * requests STILL go through the browser's own HTTP cache. iOS Safari applies
 * *heuristic* caching to GET responses that arrive without an explicit
 * Cache-Control header — it will happily reuse yesterday's /api/dashboard
 * response for hours. Desktop Chrome and Android are far less aggressive,
 * which is exactly why the user saw correct data on the laptop and Android
 * phone but stale data on the iPhone.
 *
 * Every API response now carries hard no-store headers so no browser, PWA
 * webview or intermediary may ever reuse an API response. Writes were never
 * affected — this closes the read path.
 */
export function proxy(_req: NextRequest) {
  const res = NextResponse.next()
  res.headers.set('Cache-Control', 'no-store, max-age=0, must-revalidate')
  res.headers.set('Pragma', 'no-cache')
  res.headers.set('Expires', '0')
  return res
}

export const config = {
  matcher: '/api/:path*',
}
