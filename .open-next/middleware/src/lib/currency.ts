/**
 * Task 50 — currency registry (curated list per user request, Task 51-b).
 *
 * The app used to hard-code a 7-currency list (PKR/USD/EUR/GBP/AED/INR/SAR) and
 * format everything as "CODE 1,234.00". Money now flows through this registry:
 * `fmtMoney()` (format.ts), the thermal-print / PDF builders (print.ts) and the
 * Settings picker all read from here — change the shop's currency once and the
 * whole application (screen + receipts) switches.
 *
 * User-requested lineup (Task 51-b): Pakistan, US, Kuwait, UAE (Dubai),
 * Oman, Qatar and Saudi Arabia ONLY — every other currency was removed.
 *
 * `decimals: 0` for zero-decimal currencies (none in this list).
 * Symbols are chosen to render on every platform (browser, iOS print sheet,
 * thermal receipt HTML).
 */
export interface CurrencyInfo {
  code: string
  symbol: string
  name: string
  decimals: 0 | 2
}

export const CURRENCIES: CurrencyInfo[] = [
  { code: 'PKR', symbol: 'Rs', name: 'Pakistani Rupee', decimals: 2 },
  { code: 'USD', symbol: '$', name: 'US Dollar', decimals: 2 },
  { code: 'KWD', symbol: 'د.ك', name: 'Kuwaiti Dinar', decimals: 2 },
  { code: 'AED', symbol: 'د.إ', name: 'UAE Dirham', decimals: 2 },
  { code: 'OMR', symbol: 'ر.ع.', name: 'Omani Rial', decimals: 2 },
  { code: 'QAR', symbol: 'ر.ق', name: 'Qatari Riyal', decimals: 2 },
  { code: 'SAR', symbol: 'ر.س', name: 'Saudi Riyal', decimals: 2 },
]

const BY_CODE = new Map(CURRENCIES.map(c => [c.code, c]))

export function currencyInfo(code?: string | null): CurrencyInfo {
  const hit = code ? BY_CODE.get(code) : undefined
  return hit || BY_CODE.get('PKR')!
}

/**
 * Single money formatter for screens AND print documents.
 * Letter-style symbols read better with a gap ("Rs 1,200", "RM 40");
 * glyph symbols attach directly ("$1,200", "€9.50"). Negatives put the
 * sign in front of the symbol ("-Rs 500") instead of "$-500".
 */
export function formatMoney(n: number | null | undefined, code = 'PKR'): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
  const c = currencyInfo(code)
  const num = Math.abs(v).toLocaleString('en-US', c.decimals === 0
    ? { maximumFractionDigits: 0 }
    : { maximumFractionDigits: 2 })
  const symbol = /^[A-Za-z]/.test(c.symbol) ? `${c.symbol} ` : c.symbol
  return `${v < 0 ? '-' : ''}${symbol}${num}`
}
