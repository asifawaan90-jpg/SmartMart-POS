import * as XLSX from 'xlsx'

/**
 * Client-safe backup helpers (NO server imports — used by both the API routes
 * and the Settings → Backup UI).
 */

export interface BackupRange {
  from?: string // ISO date (inclusive)
  to?: string   // ISO date (inclusive)
}

export type BackupTable = Record<string, unknown>[]

export interface BackupData {
  meta: {
    app: string
    version: string
    businessId: string
    businessName: string
    exportedAt: string
    range: { from?: string; to?: string }
    counts: Record<string, number>
    note: string
  }
  business: BackupTable
  users: BackupTable
  categories: BackupTable
  brands: BackupTable
  units: BackupTable
  products: BackupTable
  inventoryTransactions: BackupTable
  sales: BackupTable
  saleItems: BackupTable
  saleReturns: BackupTable
  purchases: BackupTable
  purchaseItems: BackupTable
  purchaseReturns: BackupTable
  customers: BackupTable
  customerTransactions: BackupTable
  suppliers: BackupTable
  supplierTransactions: BackupTable
  expenseCategories: BackupTable
  expenses: BackupTable
  settings: BackupTable
}

/** Sheet order & labels for the Excel workbook / PDF / CSV exports. */
export const BACKUP_SHEETS: { key: keyof Omit<BackupData, 'meta'>; label: string }[] = [
  { key: 'business', label: 'Business' },
  { key: 'users', label: 'Users' },
  { key: 'categories', label: 'Categories' },
  { key: 'brands', label: 'Brands' },
  { key: 'units', label: 'Units' },
  { key: 'products', label: 'Products' },
  { key: 'inventoryTransactions', label: 'Inventory Txns' },
  { key: 'sales', label: 'Sales' },
  { key: 'saleItems', label: 'Sale Items' },
  { key: 'saleReturns', label: 'Sale Returns' },
  { key: 'purchases', label: 'Purchases' },
  { key: 'purchaseItems', label: 'Purchase Items' },
  { key: 'purchaseReturns', label: 'Purchase Returns' },
  { key: 'customers', label: 'Customers' },
  { key: 'customerTransactions', label: 'Customer Txns' },
  { key: 'suppliers', label: 'Suppliers' },
  { key: 'supplierTransactions', label: 'Supplier Txns' },
  { key: 'expenseCategories', label: 'Expense Categories' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'settings', label: 'Settings' },
]

/** Build a multi-sheet XLSX workbook as bytes (works in Node AND browser). */
export function buildWorkbookBytes(data: BackupData): Uint8Array {
  const wb = XLSX.utils.book_new()

  const summary = [
    ['SmartMart POS — Data Backup'],
    ['Business', data.meta.businessName],
    ['Business ID', data.meta.businessId],
    ['Exported at', data.meta.exportedAt],
    ['Date range', data.meta.range.from ? `${data.meta.range.from} → ${data.meta.range.to || 'today'}` : 'All time'],
    [],
    ['Table', 'Rows'],
    ...BACKUP_SHEETS.map(s => [s.label, data.meta.counts[s.key] ?? 0]),
    [],
    ['Note', data.meta.note],
  ]
  const wsSummary = XLSX.utils.aoa_to_sheet(summary)
  wsSummary['!cols'] = [{ wch: 24 }, { wch: 60 }]
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary')

  for (const sheet of BACKUP_SHEETS) {
    const rows = data[sheet.key] as BackupTable
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Info: 'No records' }], {
      header: rows.length ? Object.keys(rows[0]) : ['Info'],
    })
    ws['!cols'] = (rows.length ? Object.keys(rows[0]) : ['Info']).map(k => ({
      wch: Math.min(38, Math.max(10, k.length + 4)),
    }))
    XLSX.utils.book_append_sheet(wb, ws, sheet.label.slice(0, 31))
  }

  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array
}

/**
 * Task 42 — ONE workbook containing EVERY business's full sheet set, each
 * sheet prefixed "1 - ", "2 - ", … plus a Platform Summary sheet. Used by the
 * Platform Owner Panel → Data tab "Export ALL businesses" button.
 */
export function buildMultiWorkbookBytes(items: { name: string; data: BackupData }[]): Uint8Array {
  const wb = XLSX.utils.book_new()

  const summary: (string | number)[][] = [
    ['SmartMart POS — Platform data export (ALL businesses)'],
    ['Exported at', new Date().toLocaleString('en-CA', { hour12: false })],
    ['Businesses', items.length],
    [],
    ['Business', 'Total rows'],
    ...items.map(it => [it.name, Object.values(it.data.meta.counts).reduce((a: number, b) => a + Number(b || 0), 0)]),
  ]
  const wsSummary = XLSX.utils.aoa_to_sheet(summary)
  wsSummary['!cols'] = [{ wch: 32 }, { wch: 14 }]
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Platform Summary')

  items.forEach((item, i) => {
    const prefix = `${i + 1} - `
    for (const sheet of BACKUP_SHEETS) {
      const rows = item.data[sheet.key] as BackupTable
      const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Info: 'No records' }], {
        header: rows.length ? Object.keys(rows[0]) : ['Info'],
      })
      ws['!cols'] = (rows.length ? Object.keys(rows[0]) : ['Info']).map(k => ({
        wch: Math.min(38, Math.max(10, k.length + 4)),
      }))
      XLSX.utils.book_append_sheet(wb, ws, `${prefix}${sheet.label}`.slice(0, 31))
    }
  })

  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array
}

/** Plain-text summary used as the email body. */
export function buildSummaryText(data: BackupData): string {
  const lines = [
    `SmartMart POS — backup for ${data.meta.businessName}`,
    `Exported: ${data.meta.exportedAt}`,
    data.meta.range.from ? `Range: ${data.meta.range.from} → ${data.meta.range.to || 'today'}` : 'Range: all time',
    '',
    ...BACKUP_SHEETS.map(s => `• ${s.label}: ${data.meta.counts[s.key] ?? 0} rows`),
    '',
    'The complete workbook (all tables) is attached as an Excel file.',
    'User passwords are never included in backups.',
  ]
  return lines.join('\n')
}

/** Safe filename segment: SmartMart-Backup-<Biz>-<YYYY-MM-DD-HHmm>.xlsx */
export function backupFilename(businessName: string, ext: string): string {
  const biz = (businessName || 'store').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `SmartMart-Backup-${biz}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`
}

/** Minimal RFC-4180 CSV serializer for one backup table. */
export function tableToCsv(rows: BackupTable): string {
  if (!rows.length) return ''
  const cols = Array.from(rows.reduce((set, r) => { Object.keys(r).forEach(k => set.add(k)); return set }, new Set<string>()))
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = cols.map(esc).join(',')
  const body = rows.map(r => cols.map(c => esc(r[c])).join(',')).join('\n')
  return header + '\n' + body
}

/** Printable HTML (A4) of the whole backup — print → Save as PDF. */
export function backupPdfHtml(data: BackupData): string {
  const money = (n: unknown) => typeof n === 'number' ? n.toLocaleString('en-PK', { maximumFractionDigits: 2 }) : String(n ?? '')
  const section = (label: string, rows: BackupTable, maxRows = 400) => {
    if (!rows.length) return `<h2>${label}</h2><p class="muted">No records.</p>`
    const cols = Object.keys(rows[0]).filter(c => rows.slice(0, 5).some(r => String(r[c] ?? '').length <= 60))
    const body = rows.slice(0, maxRows).map(r =>
      `<tr>${cols.map(c => `<td>${typeof r[c] === 'number' ? money(r[c]) : esc(String(r[c] ?? ''))}</td>`).join('')}</tr>`).join('')
    const more = rows.length > maxRows ? `<p class="muted">… ${rows.length - maxRows} more rows — see the Excel backup for the full table.</p>` : ''
    return `<h2>${label} <span class="badge">${rows.length}</span></h2>
      <table><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>${more}`
  }
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `
  <h1>SmartMart POS — Data Backup</h1>
  <div class="head">
    <div><b>${esc(data.meta.businessName)}</b><div class="muted">Business ID: ${esc(data.meta.businessId)}</div></div>
    <div style="text-align:right;"><b>Exported</b><div class="muted">${esc(data.meta.exportedAt)}</div>
    <div class="muted">${data.meta.range.from ? `Range: ${esc(data.meta.range.from)} → ${esc(data.meta.range.to || 'today')}` : 'All time'}</div></div>
  </div>
  <p class="muted">${esc(data.meta.note)}</p>
  ${section('Business', data.business)}
  ${section('Users', data.users)}
  ${section('Products', data.products)}
  ${section('Sales', data.sales)}
  ${section('Sale Items', data.saleItems)}
  ${section('Sale Returns', data.saleReturns)}
  ${section('Purchases', data.purchases)}
  ${section('Purchase Items', data.purchaseItems)}
  ${section('Customers', data.customers)}
  ${section('Customer Transactions', data.customerTransactions)}
  ${section('Suppliers', data.suppliers)}
  ${section('Supplier Transactions', data.supplierTransactions)}
  ${section('Expenses', data.expenses)}
  ${section('Categories', data.categories)}
  ${section('Inventory Transactions', data.inventoryTransactions)}
  <style>
    @media print { h2 { page-break-after: avoid; } table { page-break-inside: auto; } tr { page-break-inside: avoid; } }
  </style>`
}
