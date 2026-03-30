import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('app_settings')
      .select('flex_token, flex_query_id_activity, flex_query_id_confirms, auto_import_enabled, last_import_at, last_import_status, last_import_message')
      .single()

    if (error) throw error

    // Mask token for display — return only last 6 chars
    return NextResponse.json({
      flex_token_masked:         data.flex_token ? `${'•'.repeat(20)}${data.flex_token.slice(-6)}` : '',
      flex_token_set:            !!data.flex_token,
      flex_query_id_activity:    data.flex_query_id_activity    ?? '',
      flex_query_id_confirms:    data.flex_query_id_confirms    ?? '',
      auto_import_enabled:       data.auto_import_enabled       ?? false,
      last_import_at:            data.last_import_at            ?? null,
      last_import_status:        data.last_import_status        ?? null,
      last_import_message:       data.last_import_message       ?? null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>
    const supabase = createServiceClient()

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }

    // Only update fields that were explicitly sent
    if (typeof body.flex_token === 'string' && body.flex_token.trim())
      patch.flex_token = body.flex_token.trim()
    if (typeof body.flex_query_id_activity === 'string')
      patch.flex_query_id_activity = body.flex_query_id_activity.trim() || null
    if (typeof body.flex_query_id_confirms === 'string')
      patch.flex_query_id_confirms = body.flex_query_id_confirms.trim() || null
    if (typeof body.auto_import_enabled === 'boolean')
      patch.auto_import_enabled = body.auto_import_enabled

    const { error } = await supabase
      .from('app_settings')
      .update(patch)
      .eq('id', true)

    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
