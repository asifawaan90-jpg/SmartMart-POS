import { formatMoney } from './currency'
import { bizTodayISO, bizDaysAgoISO } from './bizday'

export function fmtMoney(n: number | null | undefined, currency = 'PKR'): string {
  return formatMoney(n, currency)
}

export function fmtNum(n: number | null | undefined): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return v.toLocaleString('en-PK', { maximumFractionDigits: 2 })
}

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function todayISO(): string {
  // Task 71 — BUSINESS day (PKT, UTC+5), not UTC. toISOString() here made
  // 00:00–04:59 local sales fall under "yesterday" and vanish from filters.
  return bizTodayISO()
}

export function daysAgoISO(n: number): string {
  return bizDaysAgoISO(n)
}
