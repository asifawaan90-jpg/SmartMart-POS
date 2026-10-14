'use client'
import { useCallback, useRef, useState } from 'react'
import { api, errMsg } from '@/lib/client'

export type ExportKind = '' | 'csv' | 'xlsx'

/** Task 73 — shared export-all engine for every list view.
 *  The old exports wrote only the rows currently loaded in the view (one page
 *  of 20, or a 100-row API cap), so files looked like "data not showing".
 *  This hook pages the SAME filtered endpoint until the server's `total` is
 *  exhausted (hard cap 10,000 rows) and shows honest Preparing…/Saved ✓
 *  feedback — on phones the file silently lands in the Downloads folder and
 *  without feedback the user assumes nothing happened. */
export function useExportAll() {
  const [exporting, setExporting] = useState<ExportKind>('')
  const [savedFlash, setSavedFlash] = useState<ExportKind>('')
  const busy = useRef(false)

  /** run('csv', fetchAllRows, rows => downloadCSV(...), setError) */
  const run = useCallback(async (
    kind: 'csv' | 'xlsx',
    fetchAll: () => Promise<Record<string, unknown>[]>,
    write: (rows: Record<string, unknown>[]) => void,
    onError?: (msg: string) => void,
  ) => {
    if (busy.current) return
    busy.current = true
    setExporting(kind)
    setSavedFlash('')
    try {
      const rows = await fetchAll()
      write(rows)
      setSavedFlash(kind)
      setTimeout(() => setSavedFlash(f => (f === kind ? '' : f)), 2500)
    } catch (e) {
      onError?.(errMsg(e))
    } finally {
      busy.current = false
      setExporting('')
    }
  }, [])

  return { exporting, savedFlash, run }
}

/** Page through a list endpoint (`…?params` — page/pageSize are appended)
 *  collecting EVERY row up to `total` (cap 10,000). Works with any endpoint
 *  answering `{ items, total }` — purchases, expenses, customers, etc. */
export async function fetchAllPages<T>(
  baseUrl: string,
  cap = 10_000,
): Promise<T[]> {
  const pageSize = 100
  const sep = baseUrl.includes('?') ? '&' : '?'
  const first = await api<{ items: T[]; total: number }>(`${baseUrl}${sep}page=1&pageSize=${pageSize}`)
  const all: T[] = [...(first.items || [])]
  const maxPages = Math.max(1, Math.ceil(cap / pageSize))
  const pages = Math.min(Math.ceil((first.total || 0) / pageSize) || 1, maxPages)
  for (let p = 2; p <= pages; p++) {
    const d = await api<{ items: T[]; total: number }>(`${baseUrl}${sep}page=${p}&pageSize=${pageSize}`)
    if (!d.items?.length) break
    all.push(...d.items)
  }
  return all
}
