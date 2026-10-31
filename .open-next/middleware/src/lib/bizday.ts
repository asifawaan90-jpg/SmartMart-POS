/**
 * Task 71 — the app's canonical BUSINESS-day definition.
 *
 * Bug this fixes: sales made between local midnight and ~05:00 PKT "vanished"
 * from the Sales view / single-day filters. Root cause was a timezone split:
 * the client computed filter dates with toISOString() (= UTC calendar day)
 * while the server parsed day strings as UTC midnight too — but the shop
 * operates in Pakistan Standard Time (UTC+5, no DST). A sale at 02:15 AM PKT
 * is stored as 21:15 UTC the PREVIOUS day, so every "today" or single-day
 * filter built from UTC days excluded it even though the printed receipt
 * (device-local time) showed the intended day.
 *
 * Rule from now on: a "day" means a BUSINESS day in PKT everywhere —
 * client defaults (todayISO/daysAgoISO) AND server day-boundary parsing.
 * Pure functions only (no node APIs, no Prisma) so both client bundles and
 * API routes can import this module safely.
 */

/** Pakistan Standard Time offset from UTC in hours (no DST, fixed year-round). */
export const BIZ_TZ_OFFSET_HOURS = 5

const OFFSET_STR = `+0${BIZ_TZ_OFFSET_HOURS}:00` // +05:00
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Current BUSINESS-day date string (YYYY-MM-DD) in PKT — NOT device/UTC date. */
export function bizTodayISO(now = Date.now()): string {
  return new Date(now + BIZ_TZ_OFFSET_HOURS * 3600_000).toISOString().slice(0, 10)
}

/** BUSINESS-day date string n days before today (PKT). */
export function bizDaysAgoISO(n: number, now = Date.now()): string {
  return bizTodayISO(now - n * 86400000)
}

/** UTC instant of business-local midnight for a YYYY-MM-DD business day. */
export function bizDayStart(dateStr: string): Date {
  if (!DATE_RE.test(dateStr)) return new Date(`${dateStr}T00:00:00Z`) // legacy/odd input → old UTC behavior
  return new Date(`${dateStr}T00:00:00.000${OFFSET_STR}`)
}

/** UTC instant of business-local end-of-day (23:59:59.999 PKT). */
export function bizDayEnd(dateStr: string): Date {
  if (!DATE_RE.test(dateStr)) return new Date(`${dateStr}T23:59:59.999Z`)
  return new Date(`${dateStr}T23:59:59.999${OFFSET_STR}`)
}
