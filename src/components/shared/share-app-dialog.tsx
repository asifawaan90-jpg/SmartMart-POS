'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAuthStore } from '@/stores/auth'
import { qrSvg } from '@/lib/barcode-client'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Check, Copy, QrCode, Share2, MessageCircle, Loader2 } from 'lucide-react'

/**
 * "Share App" dialog — shows a big scannable QR CODE of this app's address
 * (the login page). Another phone scans it with any camera and lands straight
 * on the SmartMart login screen — no typing URLs, no store install. The QR is
 * generated locally on-device (works fully offline).
 *
 * Actions: native Share sheet (phones), Copy link, WhatsApp.
 * Everything is sized to fit a 320px screen with no sideways scroll.
 */
export default function ShareAppDialog({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const businessName = useAuthStore(s => s.business?.name) || 'SmartMart POS'
  const [qr, setQr] = useState('')
  const [copied, setCopied] = useState(false)

  // The app URL (login screen). Read at open time so it is correct for whichever
  // host/LAN address the operator is using (localhost, LAN IP or domain).
  const appUrl = useMemo(() => {
    if (typeof window === 'undefined') return ''
    return window.location.origin + '/'
  }, [open])

  useEffect(() => {
    if (!open) { setQr(''); return }
    let dead = false
    qrSvg(appUrl, { size: 232 }).then(svg => { if (!dead) setQr(svg) })
    return () => { dead = true }
  }, [open, appUrl])

  const shareText = `Open ${businessName} (SmartMart POS) — scan or tap:\n${appUrl}`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(appUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard API can be denied — fall back to the old-school prompt.
      window.prompt('Copy this link:', appUrl)
    }
  }

  const nativeShare = async () => {
    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: businessName, text: shareText, url: appUrl }); return } catch { /* cancelled */ }
    }
    void copy()
  }

  const whatsapp = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, '_blank')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="h-5 w-5 text-primary" /> Share this App
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-2 text-center">
          {/* QR of the login page — scan with any phone camera */}
          <div className="rounded-xl border bg-white p-3 shadow-sm grid place-items-center">
            {qr ? (
              <div className="[&_svg]:h-48 [&_svg]:w-48 [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: qr }} aria-label={`QR code for ${appUrl}`} />
            ) : (
              <div className="h-48 w-48 grid place-items-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            )}
          </div>
          <p className="text-sm font-medium leading-snug">
            Point another phone&apos;s camera here to open <b>{businessName}</b>
          </p>
          <p className="text-xs text-muted-foreground break-all">
            {appUrl} <span className="opacity-70">— sign in on that phone and start billing.</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button className="flex-1 min-w-0 font-bold" onClick={() => void nativeShare()}>
            <Share2 className="h-4 w-4 mr-1" /> Share
          </Button>
          <Button variant="outline" className="flex-1 min-w-0" onClick={() => void whatsapp()}>
            <MessageCircle className="h-4 w-4 mr-1" /> WhatsApp
          </Button>
          <Button variant="outline" className="flex-1 min-w-0" onClick={() => void copy()}>
            {copied ? <Check className="h-4 w-4 mr-1 text-emerald-600" /> : <Copy className="h-4 w-4 mr-1" />}
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
