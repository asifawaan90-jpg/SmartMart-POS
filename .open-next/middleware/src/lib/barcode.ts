// EAN-13 barcode generation with checksum (internal strategy: 200-prefix for in-store codes)
export function ean13Checksum(digits12: string): number {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += parseInt(digits12[i], 10) * (i % 2 === 0 ? 1 : 3)
  return (10 - (sum % 10)) % 10
}

export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false
  return ean13Checksum(code.slice(0, 12)) === parseInt(code[12], 10)
}

/**
 * Generates a unique in-store EAN-13 barcode.
 * Strategy: prefix "20" (in-store range) + businessKey (2 digits) + base36 timestamp + random.
 */
export function generateBarcode(businessKey = '01'): string {
  const ts = Date.now().toString(36).toUpperCase().replace(/[^0-9A-Z]/g, '')
  let body = `20${businessKey.replace(/\D/g, '').padStart(2, '0').slice(-2)}`
  // fill remaining to 12 digits with digits derived from timestamp+random
  let rand = ''
  for (let i = 0; i < 16; i++) rand += Math.floor(Math.random() * 10)
  const fill = (ts.replace(/\D/g, '') + rand).slice(0, 12 - body.length)
  body += fill
  return body + ean13Checksum(body)
}

/** Deterministic business key from businessId for barcode prefix */
export function bizKey(businessId: string): string {
  let h = 0
  for (let i = 0; i < businessId.length; i++) h = (h * 31 + businessId.charCodeAt(i)) >>> 0
  return String((h % 90) + 10) // 10..99
}
