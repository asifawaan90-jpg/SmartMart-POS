/**
 * SmartMart barcode scan engine (Task 39 — fast scanning).
 *
 * Why: BrowserMultiFormatReader.decodeFromStream decodes the FULL 1280×720 camera
 * frame on every attempt with TRY_HARDER enabled, and on a failed attempt it
 * binarizes the whole frame a SECOND time (GlobalHistogram fallback inside
 * BrowserCodeReader.decode). Measured on desktop: ~40 ms/attempt; on a mid-range
 * Android that is 150–500 ms between attempts, which feels like "slow scanning".
 *
 * What this engine does instead:
 *  1. ANDROID CHROME (the common checkout device): native BarcodeDetector —
 *     hardware/ML-accelerated detection in ~5–20 ms per frame. Far faster AND
 *     more tolerant of blur/tilt than any JS decoder.
 *  2. Everywhere else (iOS Safari, desktop without native support): ZXing core
 *     on a CENTER-CROPPED ROI (90% × 58% of the frame — the aiming reticle area):
 *     - halves luminance + binarizer pixels,
 *     - drops TRY_HARDER for 3 of every 4 attempts (25 center-out row samples
 *       instead of scanning every row of the frame — measured 12× faster),
 *     - every 4th attempt runs TRY_HARDER as a thorough fallback for tilted
 *       or partially framed barcodes,
 *     - calls MultiFormatReader.decodeWithState with pre-built readers
 *       (the library's own recommended continuous-scan API — zero realloc).
 *
 * The engine only DECODES; dedupe/cooldown/feedback stays in the UI components
 * so behaviour (echo guards, cooldowns) is unchanged.
 *
 * Presence-aware emission (Task 40): a code fires when it first appears in the
 * frame; while it STAYS in view it never fires again; it re-arms only after
 * being absent for REARM_MS. This keeps scanning fast but stops the same
 * barcode being added over and over while it is still held in front of the
 * camera ("too fast" complaint) — lift the product away and re-scan to add
 * another unit, exactly like a hardware scanner behaves.
 */

/* ---- minimal typings for the (not yet in lib.dom) BarcodeDetector API ---- */
interface NativeDetection {
  rawValue: string
  boundingBox?: { x: number; y: number; width: number; height: number }
}
interface NativeDetector {
  detect: (source: HTMLVideoElement) => Promise<NativeDetection[]>
}
interface NativeDetectorCtor {
  new (opts?: { formats?: string[] }): NativeDetector
  getSupportedFormats?: () => Promise<string[]>
}

export type ScanEngineKind = 'native' | 'zxing'

export interface BarcodeScannerHandle {
  stop: () => void
  kind: ScanEngineKind
}

export interface BarcodeScannerOptions {
  video: HTMLVideoElement
  onResult: (text: string) => void
  /** center-crop width fraction of the frame (default 0.9) */
  roiWRatio?: number
  /** center-crop height fraction of the frame (default 0.58) */
  roiHRatio?: number
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** a code must be ABSENT from the frame this long before it can fire again */
const REARM_MS = 1000

/**
 * Presence-aware emission shared by both engine paths.
 * - different code than last fired → fire immediately
 * - same code still (or again) in view within REARM_MS → suppressed
 * - same code after ≥REARM_MS of absence → fire (intentional re-scan)
 */
function createPresenceEmitter(onResult: (text: string) => void) {
  const lastSeen = new Map<string, number>()
  let lastFiredCode = ''
  return (code: string) => {
    const t = Date.now()
    const prevSeen = lastSeen.get(code) ?? 0
    lastSeen.set(code, t)
    if (lastSeen.size > 32) {
      for (const [k, v] of lastSeen) if (t - v > 10_000) lastSeen.delete(k)
    }
    if (code === lastFiredCode && t - prevSeen < REARM_MS) return
    lastFiredCode = code
    onResult(code)
  }
}

/** native BarcodeDetector format ids (subset: the shop's 1D formats, no QR) */
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf']

/**
 * Best-effort camera track tuning: continuous autofocus where the device
 * supports it (most Android phones) — hugely improves handheld hit rate.
 */
export function applyScanTrackOptimizations(stream: MediaStream): void {
  const track = stream.getVideoTracks()[0]
  if (!track) return
  try {
    const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>
    const focusModes = caps['focusMode'] as string[] | undefined
    const advanced: Record<string, unknown>[] = []
    if (Array.isArray(focusModes) && focusModes.includes('continuous')) {
      advanced.push({ focusMode: 'continuous' })
    }
    if (advanced.length) {
      void track.applyConstraints({ advanced } as unknown as MediaTrackConstraints).catch(() => { /* unsupported */ })
    }
  } catch { /* keep defaults */ }
}

export async function startBarcodeScanner(opts: BarcodeScannerOptions): Promise<BarcodeScannerHandle | null> {
  const wRatio = opts.roiWRatio ?? 0.9
  const hRatio = opts.roiHRatio ?? 0.58

  /* ---------- path 1: native BarcodeDetector (Android Chrome etc.) ---------- */
  const BDCtor = (typeof window !== 'undefined' ? (window as unknown as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector : undefined)
  if (BDCtor) {
    try {
      const supported = (await BDCtor.getSupportedFormats?.()) ?? NATIVE_FORMATS
      const formats = NATIVE_FORMATS.filter(f => supported.includes(f))
      if (formats.length > 0) {
        const detector = new BDCtor({ formats })
        const emit = createPresenceEmitter(opts.onResult)
        let stopped = false
        ;(async () => {
          while (!stopped) {
            const video = opts.video
            if (!video || video.readyState < 2 || !video.videoWidth) { await sleep(60); continue }
            try {
              const found = await detector.detect(video)
              if (stopped) return
              if (found.length) {
                // pick the detection closest to the frame centre (the reticle)
                const vw = video.videoWidth, vh = video.videoHeight
                let best: NativeDetection | null = null
                let bestD = Infinity
                for (const r of found) {
                  if (!r.rawValue) continue
                  const cx = r.boundingBox ? r.boundingBox.x + r.boundingBox.width / 2 : vw / 2
                  const cy = r.boundingBox ? r.boundingBox.y + r.boundingBox.height / 2 : vh / 2
                  const d = (cx - vw / 2) * (cx - vw / 2) + (cy - vh / 2) * (cy - vh / 2)
                  if (d < bestD) { bestD = d; best = r }
                }
                if (best) {
                  const text = best.rawValue.trim()
                  if (text) emit(text)
                }
              }
            } catch { /* transient frame errors — keep scanning */ }
            await sleep(45) // native detect is cheap → ~20 probes/sec, negligible CPU
          }
        })()
        return { stop: () => { stopped = true }, kind: 'native' }
      }
    } catch { /* fall through to the ZXing engine */ }
  }

  /* ---------- path 2: ZXing core on a center ROI, adaptive TRY_HARDER ---------- */
  try {
    const { MultiFormatReader, DecodeHintType, BarcodeFormat, BinaryBitmap, HybridBinarizer, RGBLuminanceSource } =
      await import('@zxing/library')
    const mkHints = (tryHarder: boolean) => {
      const hints = new Map()
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF,
      ])
      if (tryHarder) hints.set(DecodeHintType.TRY_HARDER, true)
      return hints
    }
    // two pre-built readers: fast (25 center-out rows) + thorough (every row)
    const fastReader = new MultiFormatReader()
    fastReader.setHints(mkHints(false))
    const thoroughReader = new MultiFormatReader()
    thoroughReader.setHints(mkHints(true))

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    let stopped = false
    let attempt = 0
    const emit = createPresenceEmitter(opts.onResult)
    ;(async () => {
      while (!stopped) {
        const video = opts.video
        if (!video || video.readyState < 2 || !video.videoWidth || !ctx) { await sleep(60); continue }
        const t0 = performance.now()
        try {
          const vw = video.videoWidth, vh = video.videoHeight
          const cw = Math.round(vw * wRatio), ch = Math.round(vh * hRatio)
          if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch }
          ctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, cw, ch)
          // RGBA → grayscale luminance (green-favouring, same formula the lib uses)
          const px = ctx.getImageData(0, 0, cw, ch).data
          const lum = new Uint8ClampedArray(cw * ch)
          for (let i = 0, j = 0; j < lum.length; i += 4, j++) {
            lum[j] = (px[i] * 306 + px[i + 1] * 601 + px[i + 2] * 117) >> 10
          }
          const source = new RGBLuminanceSource(lum, cw, ch)
          const reader = attempt % 4 === 3 ? thoroughReader : fastReader
          const bitmap = new BinaryBitmap(new HybridBinarizer(source))
          const result = reader.decodeWithState(bitmap)
          if (stopped) return
          const text = result.getText().trim()
          if (text) {
            emit(text)
            await sleep(120) // same code still in view → brief pause, let UI cooldown dedupe
          }
        } catch { /* NotFoundException etc. while aiming — expected, keep scanning */ }
        attempt++
        const elapsed = performance.now() - t0
        await sleep(Math.max(8, 60 - elapsed)) // target ~60 ms cycle on fast attempts
      }
    })()
    return { stop: () => { stopped = true }, kind: 'zxing' }
  } catch {
    return null // no engine available — UI falls back to typed/USB input
  }
}
