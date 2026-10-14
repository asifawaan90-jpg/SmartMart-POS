/**
 * Safe UUID generator — the POS checkout, purchases, khata and inventory
 * writes all need a clientRef. `crypto.randomUUID()` is only available in
 * SECURE contexts (HTTPS) and only on Safari 15.4+ / iOS 15.4+. The app is
 * regularly opened over plain-HTTP LAN addresses and on older iPhones, where
 * the bare call throws `crypto.randomUUID is not a function` — the sale dies
 * mid-checkout and "the data did not save". This helper always returns a
 * well-formed 36-char UUIDv4-shaped string on every browser we support.
 */
export function uuid(): string {
  // Modern secure context (Android Chrome, desktop, iOS 15.4+ over HTTPS)
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID() } catch { /* Safari private-mode can throw */ }
  }
  // getRandomValues exists on every browser back to iOS 7 — build RFC4122 v4
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const b = new Uint8Array(16)
    crypto.getRandomValues(b)
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
  // Last resort (ancient browsers): still unique enough for a clientRef
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
