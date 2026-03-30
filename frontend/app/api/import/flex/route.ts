/**
 * POST /api/import/flex
 * =====================
 * Authenticates via Bearer token (IMPORT_SECRET), fetches both IBKR Flex
 * Queries in parallel (AF + TCF), parses them via the Python microservice,
 * and persists everything to Supabase.
 *
 * Flow:
 *   1. Auth check
 *   2. Fetch AF + TCF from IBKR in parallel (with async polling)
 *   3. POST /parse → Python → structured executions + fx + cash + snapshots
 *   4. Upsert raw_executions, fx_transactions, cash_transactions, account_snapshots
 *   5. POST /group → Python → campaigns + option_legs + execution_updates
 *      (uses ALL raw_executions from Supabase for cross-import roll detection)
 *   6. Upsert campaigns, option_legs
 *   7. Batch-update raw_executions with campaign_id + leg_group_id
 *
 * Every step is logged to the import_logs table with the same import_run_id
 * so all entries for a single run can be grouped together.
 */

import { NextRequest, NextResponse } from 'next/server'
import { fetchFlexQuery } from '@/lib/ibkr'
import { createServiceClient } from '@/lib/supabase/server'
import { logImport } from '@/lib/logger'

export const runtime    = 'nodejs'
export const maxDuration = 120  // 2 min — Flex Query polling can take up to 60s

const PARSER_URL = process.env.PYTHON_PARSER_URL ?? 'http://backend:8000'

// ── Auth ──────────────────────────────────────────────────────────────────────

function isAuthorized(req: NextRequest): boolean {
  const header = req.headers.get('authorization') ?? ''
  const secret = process.env.IMPORT_SECRET
  if (!secret) return false
  return header === `Bearer ${secret}`
}

// ── Supabase batch helpers ────────────────────────────────────────────────────

const BATCH = 500  // max rows per Supabase upsert call

async function upsertBatched(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: ReturnType<typeof createServiceClient>,
  table: string,
  rows: Record<string, unknown>[],
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

// ── Mappers: strip non-DB fields from parser output ───────────────────────────

type RawExec = Record<string, unknown>

function toRawExecution(exec: RawExec): RawExec {
  return {
    ibkr_trade_id:        exec.ibkr_trade_id,
    account_id:           exec.account_id ?? null,
    symbol:               exec.symbol,
    underlying:           exec.underlying ?? null,
    asset_class:          exec.asset_class,
    action:               exec.action,
    quantity:             exec.quantity,
    price:                exec.price,
    currency:             exec.currency,
    commission:           exec.commission ?? 0,
    realized_pnl:         exec.realized_pnl ?? null,
    trade_date:           exec.trade_date,
    settle_date:          exec.settle_date ?? null,
    option_expiry:        exec.option_expiry ?? null,
    option_strike:        exec.option_strike ?? null,
    option_type:          exec.option_type ?? null,
    option_multiplier:    exec.option_multiplier ?? 100,
    notes:                exec.notes ?? null,
    brokerage_order_id:   exec.brokerage_order_id ?? null,
    open_close_indicator: exec.open_close_indicator ?? null,
    is_expired:           exec.is_expired ?? false,
    is_assignment:        exec.is_assignment ?? false,
    is_sto:               exec.is_sto ?? false,
    is_btc:               exec.is_btc ?? false,
  }
}

function toFxTransaction(fx: RawExec): RawExec {
  return {
    ibkr_trade_id:  fx.ibkr_trade_id,
    from_currency:  fx.from_currency,
    to_currency:    fx.to_currency,
    from_amount:    fx.from_amount,
    to_amount:      fx.to_amount,
    rate:           fx.rate,
    trade_date:     fx.trade_date,
    description:    fx.description ?? null,
  }
}

function toCashTransaction(cash: RawExec): RawExec {
  return {
    ibkr_trade_id: cash.ibkr_trade_id ?? null,
    type:          cash.type,
    amount:        cash.amount,
    currency:      cash.currency,
    description:   cash.description,
    date:          cash.date,
    campaign_id:   null,
  }
}

function toAccountSnapshot(snap: RawExec): RawExec {
  return {
    snapshot_date:       snap.snapshot_date,
    net_liquidation_eur: snap.net_liquidation_eur,
    net_liquidation_usd: snap.net_liquidation_usd,
    cash_eur:            snap.cash_eur,
    cash_usd:            snap.cash_usd,
    raw_data:            snap.raw_data ?? null,
  }
}

function toOptionLeg(leg: RawExec): RawExec {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { execution_ibkr_id, ...rest } = leg as { execution_ibkr_id?: unknown } & RawExec
  return rest
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Credentials: DB settings take precedence over env vars
  let token    = process.env.FLEX_QUERY_TOKEN
  let queryAF  = process.env.FLEX_QUERY_ID_ACTIVITY
  let queryTCF = process.env.FLEX_QUERY_ID_CONFIRMS

  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from('app_settings')
      .select('flex_token, flex_query_id_activity, flex_query_id_confirms')
      .single()
    if (data?.flex_token)             token    = data.flex_token
    if (data?.flex_query_id_activity) queryAF  = data.flex_query_id_activity
    if (data?.flex_query_id_confirms) queryTCF = data.flex_query_id_confirms
  } catch { /* fall back to env vars */ }

  if (!token || !queryAF || !queryTCF) {
    return NextResponse.json(
      { error: 'Bitte Token und Query-IDs in den Einstellungen hinterlegen.' },
      { status: 500 },
    )
  }

  // Every log entry in this run shares the same runId for easy filtering
  const runId = crypto.randomUUID()

  try {
    const supabase = createServiceClient()

    await logImport('info', 'system', 'Import gestartet', { query_af: queryAF, query_tcf: queryTCF }, runId)

    // ── 1. Fetch both Flex Queries from IBKR in parallel ─────────────────────
    await logImport('info', 'ibkr', 'IBKR Flex Queries werden abgerufen…', undefined, runId)
    let activityXml: string
    let confirmsXml: string
    try {
      ;[activityXml, confirmsXml] = await Promise.all([
        fetchFlexQuery(token, queryAF),
        fetchFlexQuery(token, queryTCF),
      ])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await logImport('error', 'ibkr', `IBKR Flex Query fehlgeschlagen: ${msg}`, undefined, runId)
      throw err
    }
    await logImport('info', 'ibkr', 'IBKR Flex Queries erfolgreich abgerufen', undefined, runId)

    // ── 2. Parse via Python microservice ─────────────────────────────────────
    await logImport('info', 'parser', 'Parser-Microservice wird aufgerufen…', undefined, runId)
    let parsed: Record<string, unknown>
    try {
      const parseRes = await fetch(`${PARSER_URL}/parse`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ activity_xml: activityXml, confirms_xml: confirmsXml }),
      })
      if (!parseRes.ok) {
        const detail = await parseRes.text()
        throw new Error(`Parser HTTP ${parseRes.status}: ${detail}`)
      }
      parsed = await parseRes.json() as Record<string, unknown>
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await logImport('error', 'parser', `Parser fehlgeschlagen: ${msg}`, undefined, runId)
      throw err
    }

    const newExecutions: RawExec[]  = parsed.executions        as RawExec[] ?? []
    const fxTransactions: RawExec[] = parsed.fx_transactions   as RawExec[] ?? []
    const cashTxns: RawExec[]       = parsed.cash_transactions as RawExec[] ?? []
    const snapshots: RawExec[]      = parsed.account_snapshots as RawExec[] ?? []

    await logImport('info', 'parser', 'Parsing abgeschlossen', {
      executions:        newExecutions.length,
      fx_transactions:   fxTransactions.length,
      cash_transactions: cashTxns.length,
      account_snapshots: snapshots.length,
    }, runId)

    // ── 3. Upsert raw data to Supabase ────────────────────────────────────────
    await logImport('info', 'supabase', 'Rohdaten werden in Supabase gespeichert…', undefined, runId)
    try {
      await Promise.all([
        upsertBatched(supabase, 'raw_executions',    newExecutions.map(toRawExecution),   'ibkr_trade_id'),
        upsertBatched(supabase, 'fx_transactions',   fxTransactions.map(toFxTransaction), 'ibkr_trade_id'),
        upsertBatched(supabase, 'account_snapshots', snapshots.map(toAccountSnapshot),    'snapshot_date'),
      ])

      const cashWithId  = cashTxns.filter(c => c.ibkr_trade_id).map(toCashTransaction)
      const cashWithout = cashTxns.filter(c => !c.ibkr_trade_id).map(toCashTransaction)
      if (cashWithId.length > 0) {
        await upsertBatched(supabase, 'cash_transactions', cashWithId, 'ibkr_trade_id')
      }
      if (cashWithout.length > 0) {
        for (let i = 0; i < cashWithout.length; i += BATCH) {
          await supabase.from('cash_transactions').insert(cashWithout.slice(i, i + BATCH))
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await logImport('error', 'supabase', `Supabase-Upsert fehlgeschlagen: ${msg}`, undefined, runId)
      throw err
    }
    await logImport('info', 'supabase', 'Rohdaten gespeichert', {
      executions: newExecutions.length,
      snapshots:  snapshots.length,
    }, runId)

    // ── 4. Fetch ALL executions from Supabase for full re-grouping ────────────
    const { data: allExecutions, error: fetchErr } = await supabase
      .from('raw_executions')
      .select('*')
      .order('trade_date', { ascending: true })
    if (fetchErr) throw new Error(`Fetch all executions: ${fetchErr.message}`)

    await logImport('info', 'parser', 'Grouping-Engine wird aufgerufen…', {
      total_executions: allExecutions?.length ?? 0,
    }, runId)

    // ── 5. Run grouping engine via Python ─────────────────────────────────────
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

    const campaigns:   RawExec[] = grouped.campaigns         as RawExec[] ?? []
    const optionLegs:  RawExec[] = grouped.option_legs       as RawExec[] ?? []
    const execUpdates: RawExec[] = grouped.execution_updates as RawExec[] ?? []
    const stats = grouped.stats as Record<string, number> | undefined

    await logImport('info', 'parser', 'Grouping abgeschlossen', {
      campaigns:   campaigns.length,
      option_legs: optionLegs.length,
      rolls:       stats?.rolls ?? 0,
    }, runId)

    // ── 6. Upsert campaigns + option_legs ─────────────────────────────────────
    await logImport('info', 'supabase', 'Campaigns und Legs werden gespeichert…', undefined, runId)
    try {
      await upsertBatched(supabase, 'campaigns',   campaigns,                   'id')
      await upsertBatched(supabase, 'option_legs', optionLegs.map(toOptionLeg), 'id')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await logImport('error', 'supabase', `Campaign-Upsert fehlgeschlagen: ${msg}`, undefined, runId)
      throw err
    }

    // ── 7. Batch-update raw_executions with campaign_id + leg_group_id ────────
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

    // ── Done ──────────────────────────────────────────────────────────────────
    // Update last_import status in settings
    try {
      const supabase2 = createServiceClient()
      await supabase2.from('app_settings').update({
        last_import_at:      new Date().toISOString(),
        last_import_status:  'success',
        last_import_message: `${newExecutions.length} Executions, ${campaigns.length} Campaigns, ${stats?.rolls ?? 0} Rolls`,
      }).eq('id', true)
    } catch { /* non-critical */ }

    await logImport('info', 'system', 'Import erfolgreich abgeschlossen', {
      executions:        newExecutions.length,
      fx_transactions:   fxTransactions.length,
      cash_transactions: cashTxns.length,
      account_snapshots: snapshots.length,
      campaigns:         campaigns.length,
      option_legs:       optionLegs.length,
      rolls:             stats?.rolls ?? 0,
    }, runId)

    return NextResponse.json({
      status: 'ok',
      import_run_id: runId,
      imported: {
        executions:        newExecutions.length,
        fx_transactions:   fxTransactions.length,
        cash_transactions: cashTxns.length,
        account_snapshots: snapshots.length,
      },
      grouped: {
        campaigns:   campaigns.length,
        option_legs: optionLegs.length,
        rolls:       stats?.rolls ?? 0,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[import/flex]', message)
    try {
      const supabase2 = createServiceClient()
      await supabase2.from('app_settings').update({
        last_import_at:      new Date().toISOString(),
        last_import_status:  'error',
        last_import_message: message,
      }).eq('id', true)
    } catch { /* non-critical */ }
    await logImport('error', 'system', `Import abgebrochen: ${message}`, undefined, runId)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
