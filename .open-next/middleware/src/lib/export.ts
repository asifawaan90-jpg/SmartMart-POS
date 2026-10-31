'use client'

// Export utilities: CSV, Excel (SheetJS).
// Print/PDF generation (printHTML + all document builders) lives in ./print —
// re-exported here so existing `from '@/lib/export'` imports keep working.
// Views that need PRINTING should import from '@/lib/print' directly: the module
// is lightweight (no xlsx) so it can be statically imported and still run inside
// the user's tap/click gesture — required for mobile printing.
import * as XLSX from 'xlsx'

export * from './print'

export interface ExportColumn {
  key: string
  label: string
  width?: number
}

function cellValue(row: Record<string, unknown>, key: string): string {
  const v = row[key]
  if (v == null) return ''
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

export function downloadCSV(filename: string, columns: ExportColumn[], rows: Record<string, unknown>[]) {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
  const header = columns.map(c => esc(c.label)).join(',')
  const body = rows.map(r => columns.map(c => esc(cellValue(r, c.key))).join(',')).join('\n')
  const blob = new Blob(['\uFEFF' + header + '\n' + body], { type: 'text/csv;charset=utf-8;' })
  triggerDownload(blob, `${filename}.csv`)
}

export function downloadExcel(filename: string, sheetName: string, columns: ExportColumn[], rows: Record<string, unknown>[]) {
  const data = rows.map(r => {
    const o: Record<string, unknown> = {}
    for (const c of columns) o[c.label] = typeof r[c.key] === 'number' ? r[c.key] : cellValue(r, c.key)
    return o
  })
  const ws = XLSX.utils.json_to_sheet(data, { header: columns.map(c => c.label) })
  ws['!cols'] = columns.map(c => ({ wch: c.width || Math.max(12, c.label.length + 2) }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31))
  XLSX.writeFile(wb, `${filename}.xlsx`)
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 200)
}
