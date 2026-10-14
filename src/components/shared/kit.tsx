'use client'

import { ReactNode, useEffect } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AlertTriangle, Inbox } from 'lucide-react'

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
      <div>
        <h1 className="text-xl md:text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle ? <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2 flex-wrap">{actions}</div> : null}
    </div>
  )
}

export function StatCard({ title, value, sub, icon, tone }: {
  title: string; value: string; sub?: string; icon?: ReactNode; tone?: 'default' | 'good' | 'warn' | 'bad'
}) {
  const toneClass = tone === 'good' ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'warn' ? 'text-amber-600 dark:text-amber-400'
    : tone === 'bad' ? 'text-red-600 dark:text-red-400' : ''
  return (
    <Card className="py-4">
      <CardHeader className="px-4 pb-0 pt-0">
        <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          {icon}{title}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-0">
        <div className={`text-lg md:text-xl font-bold mt-1 truncate ${toneClass}`}>{value}</div>
        {sub ? <p className="text-xs text-muted-foreground mt-0.5 truncate">{sub}</p> : null}
      </CardContent>
    </Card>
  )
}

/**
 * Mobile-friendly replacement for wide data tables (rendered below the `md`
 * breakpoint; the table itself stays for tablets/desktop). Everything the row
 * offers — values AND action buttons — stays on screen, nothing is cut off to
 * the right, which was the #1 complaint about running the app on phones.
 */
export function MobileCardList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`md:hidden space-y-2 ${className || ''}`}>{children}</div>
}

export function MobileCard({ title, subtitle, badge, meta, actions, leading }: {
  title: ReactNode
  subtitle?: ReactNode
  badge?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  leading?: ReactNode
}) {
  return (
    <div className="rounded-lg border bg-card p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5 min-w-0">
          {leading ? <div className="shrink-0">{leading}</div> : null}
          <div className="min-w-0">
            <div className="font-medium text-sm break-words">{title}</div>
            {subtitle ? <div className="text-[11px] text-muted-foreground break-all mt-0.5">{subtitle}</div> : null}
          </div>
        </div>
        {badge ? <div className="shrink-0 text-right">{badge}</div> : null}
      </div>
      {meta ? <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">{meta}</div> : null}
      {actions ? <div className="flex flex-wrap items-center gap-1.5 pt-1.5 border-t">{actions}</div> : null}
    </div>
  )
}

/** One "Label: value" line inside a MobileCard meta grid. */
export function MetaItem({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className || ''}`}>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground block">{label}</span>
      <span className="font-medium break-words">{children}</span>
    </div>
  )
}

export function LoadingBlock({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
    </div>
  )
}

export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
      <Inbox className="h-10 w-10 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground max-w-sm">{message}</p>
      {action}
    </div>
  )
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  // Task 50 — a view that hit a network error must recover BY ITSELF when the
  // connection returns (or the app is reopened): no more sitting on the
  // "no internet" banner with previous data until the user finds Retry.
  // This one shared component gives every screen the self-healing behaviour.
  useEffect(() => {
    if (!onRetry) return
    const retryIfOnline = () => { if (navigator.onLine) onRetry() }
    const onOnline = () => setTimeout(retryIfOnline, 600)
    const onVis = () => { if (document.visibilityState === 'visible') setTimeout(retryIfOnline, 200) }
    // v23 gap closed: an app PUBLISH takes the server down and back up while
    // the user keeps the app open — navigator.onLine stays true the whole
    // time, so no `online` event ever fires and the view sat on the banner
    // with previous data until the user manually left and returned. A gentle
    // 30s retry heals the view by itself; if the server is still down the
    // fetch fails quietly and the next tick tries again.
    const iv = setInterval(() => { if (document.visibilityState === 'visible') retryIfOnline() }, 30_000)
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVis)
      clearInterval(iv)
    }
  }, [onRetry])
  return (
    <div className="mx-4 my-3 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 p-3 flex items-center gap-3">
      <AlertTriangle className="h-4 w-4 text-red-600 shrink-0" />
      <span className="text-sm text-red-700 dark:text-red-300 flex-1">{message}</span>
      {onRetry ? <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button> : null}
    </div>
  )
}
