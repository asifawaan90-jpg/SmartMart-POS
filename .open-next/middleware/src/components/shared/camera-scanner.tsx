'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { beepOk } from '@/lib/scanner'
import { startBarcodeScanner, applyScanTrackOptimizations, type BarcodeScannerHandle } from '@/lib/barcode-engine'
import { ScanLine, Flashlight, CheckCircle2 } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  /** Called for every uniquely decoded code (deduped, echo-guarded). */
  onScan: (code: string) => void
  title?: string
  hint?: string
}

/**
 * Reusable camera barcode-scanner dialog (Sales / Purchases invoice desks).
 * Professional behavior carried over from the POS scanner:
 *  - back camera preferred, stream owned here → leak-free stop on close/unmount
 *  - "Starting camera…" overlay cleared the moment the video is LIVE
 *  - fast scan engine: native BarcodeDetector on Android, ZXing center-ROI
 *    adaptive decoder elsewhere (12× less decode work than the old full-frame loop)
 *  - same-code cooldown + frame-echo guard → one scan never fires twice
 *  - torch toggle, aiming reticle with scan line, green flash on hit
 *  - friendly permission/device errors; beep on every hit
 */
export default function CameraScannerDialog({ open, onClose, onScan, title, hint }: Props) {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [torchOn, setTorchOn] = useState(false)
  const [flash, setFlash] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const scanEngineRef = useRef<BarcodeScannerHandle | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const openRef = useRef(false)
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan

  const stop = useCallback(() => {
    openRef.current = false
    scanEngineRef.current?.stop()
    scanEngineRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setTorchOn(false)
  }, [])

  // never leak the stream on unmount
  useEffect(() => () => stop(), [stop])

  useEffect(() => {
    if (!open) { stop(); return }
    openRef.current = true
    setLog([]); setError(''); setStarting(true)
    let cancelled = false
    ;(async () => {
      // wait for the <video> element (dialog mount/animation)
      let video = videoRef.current
      for (let i = 0; i < 30 && !video; i++) {
        await new Promise(r => setTimeout(r, 100))
        if (!openRef.current || cancelled) return
        video = videoRef.current
      }
      if (!openRef.current || cancelled) return
      if (!video) { setStarting(false); setError('Video element not ready — close and reopen the scanner.'); return }
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw Object.assign(new Error('Camera unsupported'), { name: 'NotSupportedError' })
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
        if (!openRef.current || cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        video.srcObject = stream
        await video.play().catch(() => { /* autoplay policy */ })
        // video LIVE → clear overlay NOW (the engine runs until stop() below,
        // so nothing after this needs to resolve)
        setStarting(false)
        applyScanTrackOptimizations(stream) // continuous autofocus where supported (Android)
        let lastCode = ''
        let lastAt = 0
        const engine = await startBarcodeScanner({
          video,
          onResult: (code) => {
            if (!code || !openRef.current) return
            const t = Date.now()
            if (code === lastCode && t - lastAt < 2000) return // same-code cooldown (engine re-arm 1s + extra margin)
            if (t - lastAt < 300) return                       // frame-echo guard
            lastCode = code
            lastAt = t
            setFlash(true)
            window.setTimeout(() => setFlash(false), 350)
            beepOk()
            setLog(l => [`✓ ${code}`, ...l].slice(0, 6))
            onScanRef.current(code)
          },
        })
        if (!openRef.current) { engine?.stop(); return } // closed while the engine was spinning up
        scanEngineRef.current = engine
      } catch (e) {
        setStarting(false)
        const name = (e as { name?: string })?.name || ''
        setError(
          name === 'NotAllowedError' ? 'Camera permission denied. Allow camera access in your browser and try again.'
          : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No usable camera found on this device.'
          : name === 'NotReadableError' ? 'Camera is busy — close other apps using it and try again.'
          : 'Camera not available. Use a USB/Bluetooth scanner or type the invoice number.'
        )
      }
    })()
    return () => { cancelled = true; stop() }
  }, [open, stop])

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    try {
      const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>
      if (!('torch' in caps)) return
      await track.applyConstraints({ advanced: [{ torch: !torchOn } as unknown as MediaTrackConstraints] })
      setTorchOn(v => !v)
    } catch { /* torch unsupported */ }
  }

  return (
    <Dialog open={open} onOpenChange={v => (v ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 min-w-0">
            <ScanLine className="h-5 w-5 shrink-0 text-primary" /> {title || 'Scan Invoice Barcode'}
          </DialogTitle>
        </DialogHeader>
        <div className="relative">
          <video ref={videoRef} className="w-full max-h-[36svh] rounded-lg bg-black aspect-[4/3] object-cover" muted autoPlay playsInline />
          {starting && !error ? (
            <div className="absolute inset-0 grid place-items-center text-xs text-white/80 bg-black/60 rounded-lg">Starting camera…</div>
          ) : null}
          {!starting && !error ? (
            <div className="absolute inset-0 pointer-events-none grid place-items-center" aria-hidden>
              <div className={cn(
                'relative w-[80%] h-[46%] rounded-lg transition-shadow duration-150',
                flash ? 'shadow-[0_0_0_3px_rgba(16,185,129,0.95)]' : 'shadow-[0_0_0_2px_rgba(255,255,255,0.6)]'
              )}>
                <span className="absolute -top-px -left-px w-6 h-6 border-t-[3px] border-l-[3px] border-white/90 rounded-tl-lg" />
                <span className="absolute -top-px -right-px w-6 h-6 border-t-[3px] border-r-[3px] border-white/90 rounded-tr-lg" />
                <span className="absolute -bottom-px -left-px w-6 h-6 border-b-[3px] border-l-[3px] border-white/90 rounded-bl-lg" />
                <span className="absolute -bottom-px -right-px w-6 h-6 border-b-[3px] border-r-[3px] border-white/90 rounded-br-lg" />
                <span className="absolute left-2 right-2 h-[2px] bg-red-500/85 shadow-[0_0_8px_rgba(239,68,68,0.8)] animate-scanline" />
              </div>
            </div>
          ) : null}
          {torchOn ? <div className="absolute top-2 right-2 text-[10px] font-bold text-amber-300 bg-black/50 rounded px-1.5 py-0.5">TORCH ON</div> : null}
        </div>
        {error ? (
          <div className="text-xs font-medium text-red-700 bg-red-50 dark:bg-red-950/40 dark:text-red-300 border border-red-200 dark:border-red-900 rounded px-2 py-1.5">{error}</div>
        ) : null}
        {log.length > 0 ? (
          <div className="max-h-24 overflow-y-auto rounded-lg border bg-secondary/50 px-2.5 py-2 space-y-1">
            {log.map((l, i) => (
              <div key={i} className="text-xs font-medium text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5 min-w-0">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> <span className="min-w-0 break-all">{l}</span>
              </div>
            ))}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground text-center sm:hidden">
          {hint || 'Scanner active — hold the barcode inside the frame.'}
        </p>
        <p className="hidden sm:block text-xs text-muted-foreground text-center">
          {hint || 'Scanner active — hold the invoice barcode steady inside the frame. The document opens on screen instantly. USB & Bluetooth scanners work too.'}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={() => void toggleTorch()}><Flashlight className="h-4 w-4 mr-1" /> Torch</Button>
          <Button className="flex-1 font-bold" onClick={onClose}>Done (Esc)</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
