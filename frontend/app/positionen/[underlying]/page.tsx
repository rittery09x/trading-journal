import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft, TrendingUp, TrendingDown, Package } from 'lucide-react'
import { createServiceClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { RollChain } from '@/components/campaigns/roll-chain'
import { LegsTable } from '@/components/campaigns/legs-table'
import type { Campaign, OptionLeg } from '@/lib/types'

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchCampaign(underlying: string) {
  try {
    const supabase  = createServiceClient()
    const symbol    = decodeURIComponent(underlying).toUpperCase()

    const { data: campaign, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('underlying', symbol)
      .single()

    if (error || !campaign) return null

    const { data: legs } = await supabase
      .from('option_legs')
      .select(
        'id, campaign_id, leg_type, status, strike, expiry, open_date, close_date, ' +
        'open_price, close_price, quantity, multiplier, gross_pnl, commission_total, ' +
        'net_pnl, cost_basis_carried, rolled_to_leg_id, rolled_from_leg_id',
      )
      .eq('campaign_id', campaign.id)
      .order('open_date', { ascending: true })

    const { data: executions } = await supabase
      .from('raw_executions')
      .select(
        'ibkr_trade_id, symbol, asset_class, action, quantity, price, currency, ' +
        'realized_pnl, trade_date, option_expiry, option_strike, option_type, leg_group_id',
      )
      .eq('campaign_id', campaign.id)
      .order('trade_date', { ascending: false })
      .limit(50)

    return {
      campaign: campaign as Campaign,
      legs:     (legs ?? []) as unknown as OptionLeg[],
      executions: executions ?? [],
    }
  } catch {
    return null
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function MetricCard({
  label,
  value,
  colored,
  sub,
}: {
  label: string
  value: string
  colored?: boolean
  sub?: string
}) {
  const num = parseFloat(value.replace(/[^-\d.]/g, ''))
  const color = colored
    ? isNaN(num) ? '' : num >= 0 ? 'text-profit' : 'text-loss'
    : ''
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${color || 'text-foreground'}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}

// ── Executions mini-table ─────────────────────────────────────────────────────

function ExecutionsTable({ executions }: { executions: Record<string, unknown>[] }) {
  if (executions.length === 0) return null

  function fmtDt(iso: string) {
    return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {['Datum', 'Symbol', 'Aktion', 'Qty', 'Preis', 'Realis. P&L'].map((h) => (
              <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {executions.map((e) => {
            const pnl    = e.realized_pnl as number | null
            const action = e.action as string
            const ac     = e.asset_class as string
            const label  = ac === 'OPT' ? (action === 'SELL' ? 'STO' : 'BTC') : action
            return (
              <tr key={e.ibkr_trade_id as string} className="border-b border-border/50 hover:bg-accent/20 transition-colors">
                <td className="px-3 py-2 text-muted-foreground tabular-nums whitespace-nowrap">
                  {fmtDt(e.trade_date as string)}
                </td>
                <td className="px-3 py-2 text-foreground font-medium max-w-[140px] truncate">
                  {e.symbol as string}
                </td>
                <td className={`px-3 py-2 font-semibold ${action === 'SELL' ? 'text-profit' : 'text-loss'}`}>
                  {label}
                </td>
                <td className="px-3 py-2 tabular-nums text-muted-foreground">
                  {Math.abs(e.quantity as number)}
                </td>
                <td className="px-3 py-2 tabular-nums text-muted-foreground">
                  {(e.price as number).toFixed(2)}
                </td>
                <td className={`px-3 py-2 tabular-nums font-medium ${
                  pnl === null ? 'text-muted-foreground' : pnl >= 0 ? 'text-profit' : 'text-loss'
                }`}>
                  {pnl !== null && pnl !== 0
                    ? (pnl >= 0 ? '+' : '') + pnl.toLocaleString('de-DE', { maximumFractionDigits: 0 })
                    : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function UnderlyingPage({
  params,
}: {
  params: { underlying: string }
}) {
  const data = await fetchCampaign(params.underlying)
  if (!data) notFound()

  const { campaign: c, legs, executions } = data

  const openLegs    = legs.filter((l) => l.status === 'open')
  const rolledLegs  = legs.filter((l) => l.status === 'rolled' || l.rolled_to_leg_id)
  const hasRolls    = rolledLegs.length > 0

  const premFmt = (c.total_option_premium >= 0 ? '+' : '') +
    c.total_option_premium.toLocaleString('de-DE', { maximumFractionDigits: 0 })

  const pnlFmt = (c.realized_pnl_total >= 0 ? '+' : '') +
    c.realized_pnl_total.toLocaleString('de-DE', { maximumFractionDigits: 0 })

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Breadcrumb */}
      <div>
        <Link
          href="/positionen"
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-4 transition-colors w-fit"
        >
          <ChevronLeft className="h-3 w-3" /> Positionen
        </Link>

        {/* Campaign header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-foreground">{c.underlying}</h1>
            <Badge variant={c.status === 'open' ? 'open' : 'closed'} className="text-sm px-2.5 py-0.5">
              {c.status === 'open' ? 'Offen' : 'Geschlossen'}
            </Badge>
            {c.stock_quantity > 0 && (
              <Badge variant="secondary" className="gap-1">
                <Package className="h-3 w-3" />
                {c.stock_quantity} Aktien
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Seit {fmtDate(c.started_at)}
            {c.closed_at && ` · Geschlossen ${fmtDate(c.closed_at)}`}
          </p>
        </div>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Prämien (netto)"
          value={`${premFmt} ${c.currency}`}
          colored
        />
        <MetricCard
          label="Realisiertes P&L"
          value={`${pnlFmt} ${c.currency}`}
          colored
        />
        <MetricCard
          label="Offene Legs"
          value={openLegs.length.toString()}
          sub={openLegs.length > 0
            ? `nächster Verfall: ${openLegs.sort((a,b) => a.expiry.localeCompare(b.expiry))[0]?.expiry?.slice(0,10) ?? '—'}`
            : undefined}
        />
        <MetricCard
          label="Break-Even (effektiv)"
          value={c.effective_avg_cost !== null
            ? c.effective_avg_cost.toFixed(2)
            : c.broker_avg_cost !== null
              ? c.broker_avg_cost.toFixed(2)
              : '—'}
          sub={c.effective_avg_cost !== null && c.broker_avg_cost !== null
            ? `Broker-Basis: ${c.broker_avg_cost.toFixed(2)}`
            : undefined}
        />
      </div>

      {/* Two-column layout: roll chain + legs table */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Roll Chain */}
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="flex items-center gap-2 mb-4">
            {hasRolls ? (
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <TrendingDown className="h-4 w-4 text-muted-foreground" />
            )}
            <h2 className="text-sm font-medium text-foreground">
              Roll-Chain{hasRolls ? ` (${rolledLegs.filter(l => l.rolled_to_leg_id).length} Rolls)` : ''}
            </h2>
          </div>
          <RollChain legs={legs} />
        </div>

        {/* Legs Table */}
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="text-sm font-medium text-foreground mb-4">
            Option-Legs ({legs.length})
          </h2>
          <LegsTable legs={legs} currency={c.currency} />
        </div>
      </div>

      {/* Executions */}
      {executions.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="text-sm font-medium text-foreground mb-4">
            Ausführungen ({executions.length})
          </h2>
          <ExecutionsTable executions={executions as unknown as Record<string, unknown>[]} />
        </div>
      )}
    </div>
  )
}
