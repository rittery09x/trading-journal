/**
 * GET /api/cron/import
 * ====================
 * Called by an external cron service (e.g. cron-job.org, Coolify cron)
 * to trigger an automatic IBKR import when auto_import_enabled = true.
 *
 * Protected by CRON_SECRET header.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime     = 'nodejs'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET ?? process.env.IMPORT_SECRET
  const auth   = req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret')

  if (!secret || auth !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from('app_settings')
      .select('auto_import_enabled')
      .single()

    if (!data?.auto_import_enabled) {
      return NextResponse.json({ skipped: true, reason: 'auto_import_enabled = false' })
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }

  // Delegate to the main import route
  const appUrl  = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const secret2 = process.env.IMPORT_SECRET ?? ''

  const res = await fetch(`${appUrl}/api/import/flex`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${secret2}` },
  })

  const json = await res.json()
  return NextResponse.json({ triggered: true, result: json }, { status: res.status })
}
