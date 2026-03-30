/**
 * POST /api/recompute
 * ===================
 * Runs the grouping engine on ALL raw_executions in Supabase and writes
 * the results back to campaigns + option_legs.
 *
 * Called automatically at the end of every import, and manually via the
 * "Neu berechnen" button on the Import page.
 *
 * This is the single source of truth for all grouping logic — import routes
 * only store raw data, they never run grouping themselves.
 */

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { logImport } from '@/lib/logger'

export const runtime     = 'nodejs'
export const maxDuration = 120

const PARSER_URL = process.env.PYTHON_PARSER_URL ?? 'http://backend:8000'
const BATCH      = 500

type RawExec = Record<string, unknown>

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function upsertBatched(
  client: ReturnType<typeof createServiceClient>,
  table: string,
  rows: RawExec[],
  onConflict: string,
): Promise<number> {
  if (rows.length === 0) return 0
  let total = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const { error, count } = await client
      .from(table)
      .upsert(batch, { onConflict, ignoreDuplicates: false, count: 'exact' })
      .select('id')
    if (error) throw new Error(`Supabase upsert ${table}: ${error.message}`)
    total += count ?? batch.length
  }
  return total
}

function toOptionLeg(leg: RawExec): RawExec {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { execution_ibkr_id, ...rest } = leg as { execution_ibkr_id?: unknown } & RawExec
  return rest
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST() {
  const runId = crypto.randomUUID()

  try {
    const supabase = createServiceClient()

    // ── 1. Fetch ALL raw_executions ───────────────────────────────────────────
    await logImport('info', 'parser', 'Neu berechnen: Lade alle Executions…', undefined, runId)

    const { data: allExecutions, error: fetchErr } = await supabase
      .from('raw_executions')
      .select('*')
      .order('trade_date', { ascending: true })
    if (fetchErr) throw new Error(`Fetch raw_executions: ${fetchErr.message}`)

    if (!allExecutions || allExecutions.length === 0) {
      return NextResponse.json({ status: 'ok', message: 'Keine Executions vorhanden.', campaigns: 0, option_legs: 0, rolls: 0 })
    }

    await logImport('info', 'parser', 'Grouping-Engine wird aufgerufen…', {
      total_executions: allExecutions.length,
    }, runId)

    // ── 2. Run grouping engine via Python ─────────────────────────────────────
    let grouped: Record<string, unknown>
    try {
      const groupRes = await fetch(`${PARSER_URL}/group`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ executions: allExecutions }),
      })
      if (!groupRes.ok) {
        const detail = await groupRes.text()
        throw new Error(`Grouping HTTP ${groupRes.status}: ${detail}`)
      }
      grouped = await groupRes.json() as Record<string, unknown>
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await logImport('error', 'parser', `Grouping-Engine fehlgeschlagen: ${msg}`, undefined, runId)
      throw err
    }

    const campaigns   = grouped.campaigns          as RawExec[] ?? []
    const optionLegs  = grouped.option_legs        as RawExec[] ?? []
    const execUpdates = grouped.execution_updates  as RawExec[] ?? []
    const stats       = grouped.stats as Record<string, number> | undefined

    await logImport('info', 'parser', 'Grouping abgeschlossen', {
      campaigns: campaigns.length, option_legs: optionLegs.length, rolls: stats?.rolls ?? 0,
    }, runId)

    // ── 3. Upsert campaigns + option_legs ─────────────────────────────────────
    // Two-pass for option_legs: insert without rolled_to_leg_id first to avoid
    // FK constraint violations, then patch roll references in a second pass.
    try {
      await upsertBatched(supabase, 'campaigns', campaigns, 'id')

      const legsWithoutRef = optionLegs.map(l => ({ ...toOptionLeg(l), rolled_to_leg_id: null }))
      await upsertBatched(supabase, 'option_legs', legsWithoutRef, 'id')

      const rollRefs = optionLegs.filter(l => l.rolled_to_leg_id)
      for (const leg of rollRefs) {
        await supabase
          .from('option_legs')
          .update({ rolled_to_leg_id: leg.rolled_to_leg_id })
          .eq('id', leg.id)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await logImport('error', 'supabase', `Campaign-Upsert fehlgeschlagen: ${msg}`, undefined, runId)
      throw err
    }

    // ── 4. Link raw_executions → campaign_id + leg_group_id ──────────────────
    const byCampaign  = new Map<string | null, string[]>()
    const legGroupMap = new Map<string, string>()

    for (const u of execUpdates) {
      const ibkrId = u.ibkr_trade_id as string
      const campId = u.campaign_id   as string | null
      const lgId   = u.leg_group_id  as string | null
      if (!byCampaign.has(campId)) byCampaign.set(campId, [])
      byCampaign.get(campId)!.push(ibkrId)
      if (lgId) legGroupMap.set(ibkrId, lgId)
    }

    const updatePromises: PromiseLike<unknown>[] = []
    for (const [campaignId, ibkrIds] of Array.from(byCampaign.entries())) {
      for (let i = 0; i < ibkrIds.length; i += BATCH) {
        updatePromises.push(
          supabase.from('raw_executions')
            .update({ campaign_id: campaignId })
            .in('ibkr_trade_id', ibkrIds.slice(i, i + BATCH))
            .then(),
        )
      }
    }
    for (const [ibkrId, lgId] of Array.from(legGroupMap.entries())) {
      updatePromises.push(
        supabase.from('raw_executions')
          .update({ leg_group_id: lgId })
          .eq('ibkr_trade_id', ibkrId)
          .then(),
      )
    }
    await Promise.all(updatePromises)

    await logImport('info', 'system', 'Neu berechnen abgeschlossen', {
      campaigns: campaigns.length, option_legs: optionLegs.length, rolls: stats?.rolls ?? 0,
    }, runId)

    return NextResponse.json({
      status:      'ok',
      campaigns:   campaigns.length,
      option_legs: optionLegs.length,
      rolls:       stats?.rolls ?? 0,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[recompute]', message)
    await logImport('error', 'system', `Neu berechnen fehlgeschlagen: ${message}`, undefined, runId)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
