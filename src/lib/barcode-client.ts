'use client'

import JsBarcode from 'jsbarcode'

function ean13Checksum(digits12: string): number {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += parseInt(digits12[i], 10) * (i % 2 === 0 ? 1 : 3)
  return (10 - (sum % 10)) % 10
}

/** Generates a valid in-store EAN-13 (20-prefix) with correct checksum. */
export function generateEan13(): string {
  let body = '20'
  const rand = () => Math.floor(Math.random() * 10)
  while (body.length < 12) body += String(rand())
  return body + ean13Checksum(body)
}

/**
 * Renders a REAL scannable barcode (EAN-13 when valid, CODE128 otherwise)
 * and returns SVG markup for embedding / printing.
 */
export function jsbarcodeSvg(code: string, opts?: { width?: number; height?: number }): string {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const isEan = /^\d{13}$/.test(code)
  try {
    JsBarcode(svg, code, {
      format: isEan ? 'EAN13' : 'CODE128',
      width: opts?.width ?? 1.6,
      height: opts?.height ?? 44,
      fontSize: 12,
      margin: 2,
      lineColor: '#000000',
    })
    return svg.outerHTML
  } catch {
    // fallback: simple CODE128
    try {
      JsBarcode(svg, code || '0000', { format: 'CODE128', fontSize: 12 })
      return svg.outerHTML
    } catch {
      return `<div style="font-family:monospace;font-size:12px;">${code}</div>`
    }
  }
}

/**
 * Renders a REAL scannable QR code (2-D barcode) as SVG markup — used by the
 * "Share App" dialog so another phone can scan the code straight off this
 * screen and open the app's login page. Encoding runs locally via the already
 * bundled @zxing/library (loaded lazily, offline-safe — no external QR API).
 */
export async function qrSvg(text: string, opts?: { size?: number; dark?: string; light?: string }): Promise<string> {
  const size = opts?.size ?? 232
  const dark = opts?.dark ?? '#111111'
  const light = opts?.light ?? '#ffffff'
  try {
    const { QRCodeWriter, EncodeHintType, BarcodeFormat } = await import('@zxing/library')
    const hints = new Map()
    hints.set(EncodeHintType.MARGIN, 1)
    hints.set(EncodeHintType.CHARACTER_SET, 'UTF-8')
    const matrix = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, hints)
    const n = matrix.getWidth()
    const cell = 1
    let rects = ''
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (matrix.get(x, y)) rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${dark}"/>`
      }
    }
    const quiet = 4
    const total = n * cell + quiet * 2
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${opts?.size ?? 232}" height="${opts?.size ?? 232}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${total}" height="${total}" fill="${light}"/><g transform="translate(${quiet},${quiet})">${rects}</g></svg>`
  } catch {
    return ''
  }
}
