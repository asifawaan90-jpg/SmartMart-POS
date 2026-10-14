'use client'

import { useEffect, useRef } from 'react'

/* ------------------------------------------------------------------ */
/* 1. Product lookup engine (professional-grade)                       */
/* ------------------------------------------------------------------ */

/**
 * Normalizes a barcode/SKU for comparison: uppercase, strip spaces & dashes.
 * Handles scanner quirks: UPC-A scanned as EAN-13 (leading zero added),
 * 14-digit GTIN, stray whitespace, scanner separators.
 */
function normalizeCode(s: string): string {
  return s.trim().toUpperCase().replace(/[\s-]/g, '')
}

export interface ScanMatch<P> {
  product: P
  matchedBy: 'barcode' | 'sku'
}

/**
 * Finds a product for a scanned code with strict, professional ordering:
 *   1. exact barcode (raw)          — includes UPC-A→EAN-13 / GTIN variants
 *   2. exact barcode (normalized)   — case/space/dash insensitive
 *   3. exact SKU (normalized)
 * Returns null when nothing matches — NEVER a fuzzy guess, so a scan can
 * never silently add the wrong product.
 */
export function findProductByCode<P extends { barcode: string; sku: string }>(
  products: P[],
  raw: string,
): ScanMatch<P> | null {
  const code = raw.trim()
  if (!code) return null

  // candidate variants for scanner quirks
  const variants = new Set<string>([code, code.trim().toUpperCase()])
  const digits = code.replace(/\D/g, '')
  if (/^\d{14}$/.test(digits)) {
    // GTIN-14 → try EAN-13 (drop leading 0) and UPC-A (drop two leading 0s)
    variants.add(digits.slice(1))
    if (digits[0] === '0' && digits[1] === '0') variants.add(digits.slice(2))
  }
  if (/^\d{13}$/.test(digits) && digits.startsWith('0')) {
    variants.add(digits.slice(1)) // EAN-13 with leading 0 → UPC-A 12
  }
  if (/^\d{12}$/.test(digits)) {
    variants.add('0' + digits) // UPC-A → EAN-13 form
  }

  // 1. exact barcode match (raw or variant)
  const byExact = products.find(p => p.barcode && variants.has(p.barcode))
  if (byExact) return { product: byExact, matchedBy: 'barcode' }

  const nCode = normalizeCode(code)
  // 2. normalized barcode (case / space / dash differences)
  const byNorm = products.find(p => p.barcode && normalizeCode(p.barcode) === nCode)
  if (byNorm) return { product: byNorm, matchedBy: 'barcode' }

  // 3. SKU match
  const bySku = products.find(p => p.sku && normalizeCode(p.sku) === nCode)
  if (bySku) return { product: bySku, matchedBy: 'sku' }

  return null
}

/** True when the string looks like a scanned barcode (numeric, ≥6 digits). */
export function looksLikeBarcode(q: string): boolean {
  const digits = q.replace(/\D/g, '')
  return q.length >= 6 && digits.length >= 6 && /^[0-9][0-9\s-]*$/.test(q.trim())
}

/* ------------------------------------------------------------------ */
/* 2. Audio feedback engine (WebAudio — offline, zero assets)          */
/* ------------------------------------------------------------------ */

const SOUND_KEY = 'smartmart_scan_sound'
let audioCtx: AudioContext | null = null

function ctx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    if (!audioCtx) audioCtx = new AC()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    return audioCtx
  } catch {
    return null
  }
}

export function scanSoundOn(): boolean {
  if (typeof window === 'undefined') return true
  return localStorage.getItem(SOUND_KEY) !== 'off'
}

export function setScanSoundOn(on: boolean): void {
  try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off') } catch { /* private mode */ }
}

function tone(freq: number, at: number, dur: number, type: OscillatorType, vol: number) {
  const ac = ctx()
  if (!ac) return
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, at)
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(vol, at + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  o.connect(g)
  g.connect(ac.destination)
  o.start(at)
  o.stop(at + dur + 0.03)
}

/** Success beep — classic cash-register "bip-bip" rising two-tone. */
export function beepOk(): void {
  if (!scanSoundOn()) return
  const ac = ctx()
  if (!ac) return
  const t = ac.currentTime
  tone(1046.5, t, 0.08, 'sine', 0.16)       // C6
  tone(1568, t + 0.085, 0.11, 'sine', 0.16) // G6
}

/** Error buzz — low double-pulse, unmistakably negative. */
export function beepErr(): void {
  if (!scanSoundOn()) return
  const ac = ctx()
  if (!ac) return
  const t = ac.currentTime
  tone(233, t, 0.13, 'square', 0.07)        // Bb3
  tone(233, t + 0.18, 0.16, 'square', 0.07)
}

/* ------------------------------------------------------------------ */
/* 3. Keyboard-wedge hook — global hardware scanner capture            */
/* ------------------------------------------------------------------ */

/**
 * Captures USB / Bluetooth barcode scanners ("keyboard wedge" devices) ANYWHERE
 * on the page — the scan box does NOT need focus, exactly like professional
 * POS software (Square, Loyverse, Lightspeed).
 *
 * How it works: scanners type 20–60 chars/sec and finish with Enter.
 * We buffer keystrokes made outside text fields; when a fast burst
 * (every gap < 90 ms/char) is terminated by Enter — or followed by silence —
 * it is treated as a scan and passed to onScan.
 *
 * Behavior notes:
 *  - Focus inside any input/textarea/select → hook stands down (that field owns
 *    the keystrokes; the scan box handles its own Enter).
 *  - Enter from a scan is consumed (preventDefault + stopPropagation) so it can
 *    never re-click the last focused button (e.g. PAY).
 *  - Human typing never reaches scanner cadence, so it is ignored.
 */
export function useScannerWedge(onScan: (code: string) => void, enabled: boolean): void {
  const cbRef = useRef(onScan)
  cbRef.current = onScan

  useEffect(() => {
    if (!enabled) return
    let buffer = ''
    let firstTs = 0
    let lastTs = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const reset = () => {
      buffer = ''
      firstTs = 0
      lastTs = 0
      if (timer) { clearTimeout(timer); timer = null }
    }

    /** terminated=true → Enter received; false → silence timeout. */
    const flush = (terminated: boolean) => {
      const code = buffer
      reset()
      if (!code) return
      const chars = code.length
      const span = Math.max(lastTs - firstTs, 1)
      const msPerChar = span / Math.max(chars - 1, 1)
      if (terminated) {
        // Enter-suffixed scanner: ≥4 chars at scanner cadence
        if (chars >= 4 && msPerChar < 90) cbRef.current(code)
      } else {
        // No-suffix scanner: long, very fast burst then silence
        if (chars >= 8 && msPerChar < 45) cbRef.current(code)
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        reset() // a text field owns these keystrokes
        return
      }
      if (e.key === 'Enter') {
        if (buffer) {
          e.preventDefault()
          e.stopPropagation()
          flush(true)
        }
        return
      }
      if (e.key === 'Escape') { reset(); return }
      if (e.key.length === 1) {
        const now = performance.now()
        if (!buffer || now - lastTs > 250) {
          buffer = e.key
          firstTs = now
        } else {
          buffer += e.key
        }
        lastTs = now
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => flush(false), 220)
      }
    }

    window.addEventListener('keydown', onKeyDown, true) // capture: beat everything
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      if (timer) clearTimeout(timer)
    }
  }, [enabled])
}
