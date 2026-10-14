import { readFile } from 'fs/promises';
import path from 'path';
import { NextResponse } from 'next/server';

/**
 * Task 68 — Android TWA asset links verification file.
 * Served via rewrite: /.well-known/assetlinks.json → /api/well-known/assetlinks.json
 * The fingerprint must match android/smartmart.keystore (SmartMart APK signing key).
 * This lets the Android app open the site without a browser URL bar (Digital Asset Links).
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const file = path.join(process.cwd(), 'android', 'assetlinks.json');
    const json = await readFile(file, 'utf8');
    return new NextResponse(json, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: 'assetlinks unavailable' },
      { status: 404 },
    );
  }
}
