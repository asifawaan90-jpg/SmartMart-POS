'use client'
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw, Home, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  /** Human name of the wrapped screen, e.g. "POS Terminal". */
  viewName: string
  /** Optional escape hatch back to a known-good screen. */
  onGoHome?: () => void
  children: ReactNode
}

interface State {
  error: Error | null
  /** Bumped on "Try again" — keyed Fragment forces a true remount of the subtree. */
  attempt: number
}

/**
 * Task 45 — professional crash isolation.
 *
 * Before this boundary, ANY view that threw (a stale code chunk after an app
 * update, a hydration mismatch, a camera/scanner failure…) unmounted the whole
 * React tree: the user saw a dead app and reported "POS error, not open POS".
 * Now a crashed screen shows a friendly recovery card — the rest of the app
 * (header, navigation, sync engine) keeps working, and one tap reloads just
 * that screen or the whole app.
 */
export default class ViewBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[view-boundary] ${this.props.viewName} crashed:`, error.message, info.componentStack || '')
  }

  private retry = () => this.setState(s => ({ error: null, attempt: s.attempt + 1 }))

  render() {
    const { error, attempt } = this.state
    if (!error) {
      // keyed Fragment: on retry the subtree is freshly mounted, not reused
      return <Fragment key={attempt}>{this.props.children}</Fragment>
    }
    return (
      <div className="p-4 md:p-6 max-w-md mx-auto" data-testid="view-boundary">
        <div className="rounded-lg border bg-card p-6 text-center space-y-4 shadow-sm">
          <div className="mx-auto grid place-items-center h-12 w-12 rounded-full bg-red-50 dark:bg-red-950/40">
            <AlertTriangle className="h-6 w-6 text-red-600" />
          </div>
          <div className="space-y-1.5">
            <h2 className="font-semibold text-lg">{this.props.viewName} had a problem</h2>
            <p className="text-sm text-muted-foreground">
              This screen hit an unexpected error — <b>your data is safe</b>. Try again, or go back
              to the Dashboard; unsaved offline work keeps syncing in the background.
            </p>
            {error?.message ? (
              <p className="text-[11px] font-mono text-muted-foreground/70 break-words pt-1">{error.message.slice(0, 220)}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Button size="sm" onClick={this.retry} data-testid="boundary-retry">
              <RotateCcw className="h-4 w-4 mr-1" /> Try again
            </Button>
            {this.props.onGoHome ? (
              <Button size="sm" variant="outline" onClick={this.props.onGoHome} data-testid="boundary-home">
                <Home className="h-4 w-4 mr-1" /> Dashboard
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => window.location.reload()} data-testid="boundary-reload">
              <RefreshCw className="h-4 w-4 mr-1" /> Reload app
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
