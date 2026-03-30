/**
 * POST /api/import/xml
 * ====================
 * Accepts a multipart form upload with an IBKR Flex XML file,
 * parses it via the Python microservice, and persists to Supabase.
 *
 * Form fields:
 *   activity_xml  — required, Activity Feed (AF) XML file
 *   confirms_xml  — optional, Trade Confirms (TCF) XML file
 *
 * Flow: identical to /api/import/flex but skips the IBKR fetch step.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { logImport } from '@/lib/logger'

export const runtime     = 'nodejs'
export const maxDuration = 120

const PARSER_URL = process.env.PYTHON_PARSER_URL ?? 'http://backend:8000'
const BATCH      = 500

// ── Supabase batch helpers (same as /api/import/flex) ────────────────────────

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

// ── Mappers ───────────────────────────────────────────────────────────────────

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
  // Generate a stable synthetic ID if IBKR didn't provide one
  let ibkrId = f.ibkr_trade_id as string | null
  if (!ibkrId) {
    const raw  = `${f.trade_date}|${f.from_currency}|${f.to_currency}|${f.from_amount}|${f.description ?? ''}`
    const hash = Buffer.from(raw).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)
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

function toOptionLeg(leg: RawExec): RawExec {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { execution_ibkr_id, ...rest } = leg as { execution_ibkr_id?: unknown } & RawExec
  return rest
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const runId = crypto.randomUUID()

  try {
    const form = await req.formData()
    const activityFile = form.get('activity_xml')
    const confirmsFile = form.get('confirms_xml')

    if (!activityFile || typeof activityFile === 'string') {
      return NextResponse.json({ error: 'activity_xml Datei fehlt' }, { status: 400 })
    }

    const activityXml = await (activityFile as File).text()
    const confirmsXml = confirmsFile && typeof confirmsFile !== 'string'
      ? await (confirmsFile as File).text()
      : null

    const supabase = createServiceClient()
    await logImport('info', 'system', 'XML-Datei-Import gestartet', {
      filename: (activityFile as File).name,
      size_kb:  Math.round((activityFile as File).size / 1024),
    }, runId)

    // ── 1. Parse via Python microservice ─────────────────────────────────────
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

    const newExecutions = parsed.executions        as RawExec[] ?? []
    const fxTransactions = parsed.fx_transactions  as RawExec[] ?? []
    const cashTxns       = parsed.cash_transactions as RawExec[] ?? []
    const snapshots      = parsed.account_snapshots as RawExec[] ?? []

    await logImport('info', 'parser', 'Parsing abgeschlossen', {
      executions: newExecutions.length, fx_transactions: fxTransactions.length,
      cash_transactions: cashTxns.length, account_snapshots: snapshots.length,
    }, runId)

    // ── 2. Upsert raw data to Supabase ────────────────────────────────────────
    await logImport('info', 'supabase', 'Rohdaten werden in Supabase gespeichert…', undefined, runId)
    try {
      await Promise.all([
        upsertBatched(supabase, 'raw_executions',    newExecutions.map(toRawExecution),   'ibkr_trade_id'),
        upsertBatched(supabase, 'fx_transactions',   fxTransactions.map(toFxTransaction), 'ibkr_trade_id'),
        upsertBatched(supabase, 'account_snapshots', snapshots.map(toAccountSnapshot),    'snapshot_date'),
      ])

      const cashWithId    = cashTxns.filter(c => c.ibkr_trade_id).map(toCashTransaction)
      const cashWithout   = cashTxns.filter(c => !c.ibkr_trade_id).map(toCashTransaction)
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

    // ── 3. Fetch ALL executions for cross-import grouping ─────────────────────
    const { data: allExecutions, error: fetchErr } = await supabase
      .from('raw_executions')
      .select('*')
      .order('trade_date', { ascending: true })
    if (fetchErr) throw new Error(`Fetch all executions: ${fetchErr.message}`)

    await logImport('info', 'parser', 'Grouping-Engine wird aufgerufen…', {
      total_executions: allExecutions?.length ?? 0,
    }, runId)

    // ── 4. Run grouping engine via Python ─────────────────────────────────────
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

    // ── 5. Upsert campaigns + option_legs ─────────────────────────────────────
    try {
      await upsertBatched(supabase, 'campaigns',   campaigns,                           'id')
      await upsertBatched(supabase, 'option_legs', optionLegs.map(toOptionLeg),         'id')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await logImport('error', 'supabase', `Campaign-Upsert fehlgeschlagen: ${msg}`, undefined, runId)
      throw err
    }

    // ── 6. Link raw_executions → campaign_id + leg_group_id ──────────────────
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

    await logImport('info', 'system', 'XML-Import erfolgreich abgeschlossen', {
      executions: newExecutions.length, fx_transactions: fxTransactions.length,
      cash_transactions: cashTxns.length, account_snapshots: snapshots.length,
      campaigns: campaigns.length, option_legs: optionLegs.length,
      rolls: stats?.rolls ?? 0,
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
    console.error('[import/xml]', message)
    await logImport('error', 'system', `XML-Import abgebrochen: ${message}`, undefined, runId)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
