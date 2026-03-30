/**
 * POST /api/import/flex
 * =====================
 * Fetches both IBKR Flex Queries (AF + TCF), parses via Python, stores raw data,
 * then delegates grouping to /api/recompute.
 *
 * Auth: Bearer token (IMPORT_SECRET env var).
 * Credentials (token + query IDs) are read from app_settings DB, falling back to env vars.
 */

import { NextRequest, NextResponse } from 'next/server'
import { fetchFlexQuery } from '@/lib/ibkr'
import { createServiceClient } from '@/lib/supabase/server'
import { logImport } from '@/lib/logger'

export const runtime     = 'nodejs'
export const maxDuration = 120

const PARSER_URL = process.env.PYTHON_PARSER_URL ?? 'http://backend:8000'
const BATCH      = 500

function isAuthorized(req: NextRequest): boolean {
  const header = req.headers.get('authorization') ?? ''
  const secret = process.env.IMPORT_SECRET
  if (!secret) return false
  return header === `Bearer ${secret}`
}

type RawExec = Record<string, unknown>

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

function toRawExecution(e: RawExec): RawExec {
  return {
    ibkr_trade_id:        e.ibkr_trade_id,
    account_id:           e.account_id           ?? null,
    symbol:               e.symbol,
    underlying:           e.underlying            ?? null,
    asset_class:          e.asset_class,
    action:               e.action,
    quantity:             e.quantity,
    price:                e.price,
    currency:             e.currency,
    commission:           e.commission            ?? 0,
    realized_pnl:         e.realized_pnl          ?? null,
    trade_date:           e.trade_date,
    settle_date:          e.settle_date           ?? null,
    option_expiry:        e.option_expiry         ?? null,
    option_strike:        e.option_strike         ?? null,
    option_type:          e.option_type           ?? null,
    option_multiplier:    e.option_multiplier      ?? 100,
    notes:                e.notes                 ?? null,
    brokerage_order_id:   e.brokerage_order_id    ?? null,
    open_close_indicator: e.open_close_indicator  ?? null,
    is_expired:           e.is_expired            ?? false,
    is_assignment:        e.is_assignment         ?? false,
    is_sto:               e.is_sto                ?? false,
    is_btc:               e.is_btc                ?? false,
  }
}

function toFxTransaction(f: RawExec): RawExec {
  let ibkrId = f.ibkr_trade_id as string | null
  if (!ibkrId) {
    const base = `${f.trade_date}|${f.from_currency}|${f.to_currency}|${f.from_amount}|${f.to_amount}|${f.rate}|${f.description ?? ''}`
    const hash = Buffer.from(base).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)
    ibkrId = `fx-${hash}`
  }
  return {
    ibkr_trade_id: ibkrId,
    from_currency:  f.from_currency,
    to_currency:    f.to_currency,
    from_amount:    f.from_amount,
    to_amount:      f.to_amount,
    rate:           f.rate,
    trade_date:     f.trade_date,
    description:    f.description ?? null,
  }
}

function toCashTransaction(c: RawExec): RawExec {
  return {
    ibkr_trade_id: c.ibkr_trade_id ?? null,
    type:          c.type,
    amount:        c.amount,
    currency:      c.currency,
    description:   c.description,
    date:          c.date,
    campaign_id:   null,
  }
}

function toAccountSnapshot(s: RawExec): RawExec {
  return {
    snapshot_date:       s.snapshot_date,
    net_liquidation_eur: s.net_liquidation_eur,
    net_liquidation_usd: s.net_liquidation_usd,
    cash_eur:            s.cash_eur,
    cash_usd:            s.cash_usd,
    raw_data:            s.raw_data ?? null,
  }
}

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

  const runId = crypto.randomUUID()

  try {
    const supabase = createServiceClient()
    await logImport('info', 'system', 'IBKR-Import gestartet', { query_af: queryAF, query_tcf: queryTCF }, runId)

    // ── 1. Fetch from IBKR ────────────────────────────────────────────────────
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

    // ── 2. Parse ──────────────────────────────────────────────────────────────
    await logImport('info', 'parser', 'Parser-Microservice wird aufgerufen…', undefined, runId)
    let parsed: Record<string, unknown>
    try {
      const res = await fetch(`${PARSER_URL}/parse`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ activity_xml: activityXml, confirms_xml: confirmsXml }),
      })
      if (!res.ok) throw new Error(`Parser HTTP ${res.status}: ${await res.text()}`)
      parsed = await res.json() as Record<string, unknown>
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await logImport('error', 'parser', `Parser fehlgeschlagen: ${msg}`, undefined, runId)
      throw err
    }

    const newExecutions  = parsed.executions         as RawExec[] ?? []
    const fxTransactions = parsed.fx_transactions    as RawExec[] ?? []
    const cashTxns       = parsed.cash_transactions  as RawExec[] ?? []
    const snapshots      = parsed.account_snapshots  as RawExec[] ?? []

    await logImport('info', 'parser', 'Parsing abgeschlossen', {
      executions: newExecutions.length, fx_transactions: fxTransactions.length,
      cash_transactions: cashTxns.length, account_snapshots: snapshots.length,
    }, runId)

    // ── 3. Upsert raw data ────────────────────────────────────────────────────
    await logImport('info', 'supabase', 'Rohdaten werden gespeichert…', undefined, runId)
    try {
      await Promise.all([
        upsertBatched(supabase, 'raw_executions',    newExecutions.map(toRawExecution),  'ibkr_trade_id'),
        upsertBatched(supabase, 'fx_transactions',   fxTransactions.map(toFxTransaction), 'ibkr_trade_id'),
        upsertBatched(supabase, 'account_snapshots', snapshots.map(toAccountSnapshot),    'snapshot_date'),
      ])
      const cashWithId  = cashTxns.filter(c => c.ibkr_trade_id).map(toCashTransaction)
      const cashWithout = cashTxns.filter(c => !c.ibkr_trade_id).map(toCashTransaction)
      if (cashWithId.length > 0)
        await upsertBatched(supabase, 'cash_transactions', cashWithId, 'ibkr_trade_id')
      if (cashWithout.length > 0) {
        for (let i = 0; i < cashWithout.length; i += BATCH)
          await supabase.from('cash_transactions').insert(cashWithout.slice(i, i + BATCH))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await logImport('error', 'supabase', `Supabase-Upsert fehlgeschlagen: ${msg}`, undefined, runId)
      throw err
    }

    await logImport('info', 'supabase', 'Rohdaten gespeichert — starte Grouping…', {
      executions: newExecutions.length,
    }, runId)

    // ── 4. Trigger recompute ──────────────────────────────────────────────────
    const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
    const recompRes = await fetch(`${appUrl}/api/recompute`, { method: 'POST' })
    const recomp    = await recompRes.json() as Record<string, unknown>
    if (!recompRes.ok) throw new Error(`Recompute fehlgeschlagen: ${recomp.error ?? recompRes.status}`)

    // Update last_import status in settings
    try {
      await supabase.from('app_settings').update({
        last_import_at:      new Date().toISOString(),
        last_import_status:  'success',
        last_import_message: `${newExecutions.length} Executions, ${recomp.campaigns} Campaigns, ${recomp.rolls} Rolls`,
      }).eq('id', true)
    } catch { /* non-critical */ }

    await logImport('info', 'system', 'IBKR-Import erfolgreich abgeschlossen', {
      executions: newExecutions.length, campaigns: recomp.campaigns, rolls: recomp.rolls,
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
        campaigns:   recomp.campaigns,
        option_legs: recomp.option_legs,
        rolls:       recomp.rolls,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[import/flex]', message)
    try {
      const supabase2 = createServiceClient()
      await supabase2.from('app_settings').update({
        last_import_at:     new Date().toISOString(),
        last_import_status: 'error',
        last_import_message: message,
      }).eq('id', true)
    } catch { /* non-critical */ }
    await logImport('error', 'system', `IBKR-Import abgebrochen: ${message}`, undefined, runId)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
