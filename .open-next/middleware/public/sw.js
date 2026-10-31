/* SmartMart POS service worker — network-first with offline shell fallback */
// v16: iOS/professional round — safe uuid helper for checkout on older iPhones
// & plain-HTTP (crypto.randomUUID is secure-context + Safari 15.4+ only),
// fixed corrupted safe-area padding on the POS quick bar, build-version
// handshake (/api/version + build-guard) so no device ever stays stuck on an
// older build, sw.js itself now always revalidates (updateViaCache:'none').
// v23: a non-ok DOCUMENT response (500/502 while a deploy is mid-flight) no
// longer replaces the app — an error page has no JS so no self-heal script
// can run and the user was stuck on a dead screen after every update.
const CACHE = 'smartmart-v41'
const SHELL = ['/', '/manifest.webmanifest', '/brand/logo-512.png', '/favicon.ico', '/icon-192.png', '/apple-touch-icon.png']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  // never cache API traffic (data must be fresh; offline queue handles writes)
  if (url.pathname.startsWith('/api/')) return
  if (e.request.method !== 'GET') return
  const dest = e.request.destination // 'document' | 'script' | 'style' | 'image' | 'font' | 'manifest' | ...
  const isDoc = e.request.mode === 'navigate' || dest === 'document'
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // cache only good responses — a 404/500 (e.g. a chunk name that no
        // longer exists mid-deploy) must never be stored and served forever
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone()
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {})
          return res
        }
        // v23: a non-ok DOCUMENT (500/502 while the server reboots between
        // builds) must never replace a working app — the error page has no
        // JavaScript, so build-guard and self-heal can never run and the
        // phone shows a dead screen with no data. Serve the cached shell
        // instead: the app boots with its previous state and build-guard
        // lands it on the new build as soon as the server is healthy.
        if (isDoc) return caches.match(e.request).then(h => h || caches.match('/'))
        return res
      })
      .catch(() =>
        caches.match(e.request).then(hit => {
          if (hit) return hit
          // Network down AND this asset is not in the cache: it belongs to a
          // newer build than this device has. Fail fast so the app's self-heal
          // script can reload into the fresh build — do NOT answer with the
          // HTML shell (executing HTML as JS is what broke screens on phones).
          if (dest && dest !== 'document' && dest !== 'iframe') {
            return new Response('', { status: 504, statusText: 'Offline' })
          }
          return caches.match('/')
        })
      )
  )
})
