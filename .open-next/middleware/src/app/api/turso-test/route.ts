import { NextResponse } from 'next/server'
import { pushToTurso, verifyTurso } from '@/lib/turso-backup'

export async function GET() {
  try {
    const v = await verifyTurso()
    return NextResponse.json(v)
  } catch(e:any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 })
  }
}
export async function POST() {
  try {
    const r = await pushToTurso()
    return NextResponse.json(r)
  } catch(e:any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 })
  }
}
