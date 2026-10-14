'use client'

import { useState } from 'react'
import { useAuthStore } from '@/stores/auth'
import { api, errMsg } from '@/lib/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
}

/**
 * Self-service password change for the SIGNED-IN user (works for store owners,
 * staff and the platform admin alike — the API only needs the session token).
 * Verifies the current password server-side before applying the new one.
 */
export default function ChangePasswordDialog({ open, onOpenChange }: Props) {
  const user = useAuthStore(s => s.user)
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const reset = () => { setCur(''); setNext(''); setConfirm(''); setError(''); setDone(false) }

  const close = (v: boolean) => {
    if (!v) reset()
    onOpenChange(v)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (next.length < 6) { setError('New password must be at least 6 characters.'); return }
    if (next !== confirm) { setError('New password and confirmation do not match.'); return }
    if (next === cur) { setError('New password must be different from the current one.'); return }
    setBusy(true)
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword: cur, newPassword: next },
      })
      setDone(true)
      setCur(''); setNext(''); setConfirm('')
    } catch (err) {
      setError(errMsg(err))
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Change password
          </DialogTitle>
          <DialogDescription>
            Signed in as <b className="text-foreground">{user?.email}</b>
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="space-y-4">
            <p className="flex items-start gap-2 text-sm text-emerald-600 font-medium">
              <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
              Password changed successfully. Use the new password next time you sign in — your current session stays active.
            </p>
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="pw-current">Current password</Label>
              <Input id="pw-current" type="password" required autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw-next">New password</Label>
              <Input id="pw-next" type="password" required minLength={6} autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw-confirm">Confirm new password</Label>
              <Input id="pw-confirm" type="password" required minLength={6} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />
            </div>
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => close(false)} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy || !cur || !next || !confirm}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                Update password
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
