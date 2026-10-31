'use client'

import { useEffect, useMemo, useState } from 'react'
import { printHTML, PRINT_BASE_CSS } from '@/lib/export'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Loader2, Printer, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export type PreviewDoc = {
  /** dialog title */
  title: string
  /** exact HTML that will be sent to the printer */
  html: string
  /** natural document width for the preview pane */
  widthMm?: number
}

/**
 * Universal on-screen PRINT VIEW — shows the exact document HTML (same string
 * that goes to the printer) in a style-isolated iframe, then prints it 1:1.
 * Used by POS receipt, sales history and any other printable flow.
 */
export default function PrintPreviewDialog({ doc, onClose }: {
  doc: PreviewDoc | null
  onClose: () => void
}) {
  const [printing, setPrinting] = useState(false)

  const srcDoc = useMemo(() => doc ? wrapPreviewHtml(doc.html, doc.widthMm || 80) : '', [doc])

  // lock body scroll while the preview is open
  useEffect(() => {
    if (!doc) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [doc])

  const doPrint = async () => {
    if (!doc || printing) return
    setPrinting(true)
    try {
      // resolves exactly when the native print dialog closes (Task 13 lifecycle)
      await printHTML(doc.title, doc.html)
    } finally { setPrinting(false) }
  }

  return (
    <Dialog open={!!doc} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-lg md:max-w-2xl p-0">
        <DialogHeader className="sticky top-0 z-10 min-w-0 px-4 py-3 border-b bg-muted rounded-t-lg flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-sm font-semibold flex items-center gap-2 min-w-0">
            <Printer className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">{doc?.title || 'Print view'}</span>
          </DialogTitle>
          <div className="flex items-center gap-2 shrink-0">
            <Button size="sm" onClick={doPrint} disabled={printing}>
              {printing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Printer className="h-4 w-4 mr-1" />}
              {printing ? 'Printing…' : 'Print'}
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close print view"><X className="h-4 w-4" /></Button>
          </div>
        </DialogHeader>
        <div data-print-preview="" className="min-w-0 bg-neutral-200 dark:bg-neutral-900 max-h-[calc(100dvh-12rem)] overflow-auto p-3 flex items-start justify-center">
          {doc ? (
            <iframe
              title="Print preview"
              srcDoc={srcDoc}
              className={cn('max-w-full bg-white border shadow-lg shrink-0', printing && 'opacity-60 pointer-events-none')}
              style={{ width: `min(100%, ${(doc.widthMm || 80) * 3.78}px)`, minHeight: '420px', height: '58vh' }}
              sandbox="allow-same-origin"
            />
          ) : null}
        </div>
        <p className="rounded-b-lg px-4 py-2 text-[11px] text-muted-foreground border-t bg-muted/30">
          This is exactly what will be printed — press Print to open the printer dialog.
        </p>
      </DialogContent>
    </Dialog>
  )
}

/** Wrap raw document HTML in a minimal page shell — same base styles as the real
 *  print document, so the preview is a faithful 1:1 of what prints. On phones
 *  the iframe is only ~300px wide, far narrower than paper (80mm receipt =
 *  302px, A4 = 794px), which used to shove the document half off-screen inside
 *  the frame — the narrow-viewport rules shrink the preview to the frame
 *  instead. Printing always uses the RAW html, so paper output is unchanged. */
function wrapPreviewHtml(html: string, widthMm: number): string {
  return `<!doctype html><html><head><meta charset="utf-8" />
<style>${PRINT_BASE_CSS}
  html,body { margin:0; padding:8px; background:#fff; }
  .doc { width:${widthMm}mm; margin:0 auto; }
  @media (max-width: 520px) {
    .doc { width: auto !important; max-width: 100% !important; overflow-wrap: anywhere; }
    table { table-layout: fixed !important; border-collapse: collapse !important; }
    th, td { box-sizing: border-box; overflow-wrap: anywhere; word-break: break-word; }
    .head { flex-wrap: wrap; gap: 6px; }
    img, svg { max-width: 100% !important; }
  }
</style></head><body><div class="doc">${html}</div></body></html>`
}
