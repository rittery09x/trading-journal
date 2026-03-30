import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchFlexQuery } from '@/lib/ibkr'

export const runtime     = 'nodejs'
export const maxDuration = 90

export async function POST() {
  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('app_settings')
      .select('flex_token, flex_query_id_activity, flex_query_id_confirms')
      .single()

    if (error) throw new Error(`Einstellungen nicht gefunden: ${error.message}`)

    const { flex_token, flex_query_id_activity, flex_query_id_confirms } = data

    if (!flex_token || !flex_query_id_activity || !flex_query_id_confirms) {
      return NextResponse.json(
        { ok: false, message: 'Bitte zuerst Token und beide Query-IDs speichern.' },
        { status: 400 },
      )
    }

    // Test both queries in parallel — just check they return valid XML
    const [afXml, tcfXml] = await Promise.all([
      fetchFlexQuery(flex_token, flex_query_id_activity),
      fetchFlexQuery(flex_token, flex_query_id_confirms),
    ])

    const afOk  = afXml.includes('<FlexQueryResponse')  || afXml.includes('<FlexStatement')
    const tcfOk = tcfXml.includes('<FlexQueryResponse') || tcfXml.includes('<FlexStatement')

    if (!afOk || !tcfOk) {
      return NextResponse.json(
        { ok: false, message: 'Verbindung hergestellt, aber unerwartetes XML-Format.' },
        { status: 400 },
      )
    }

    return NextResponse.json({ ok: true, message: 'Verbindung erfolgreich.' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, message }, { status: 400 })
  }
}
