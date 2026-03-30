export const dynamic = 'force-dynamic'

import { createServiceClient } from '@/lib/supabase/server'
import Link from 'next/link'
import type { Campaign, OptionLeg } from '@/lib/types'

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchStats() {
  try {
    const supabase = createServiceClient()
    const [{ data: campaigns }, { data: legs }] = await Promise.all([
      supabase
        .from('campaigns')
        .select('id, underlying, status, total_option_premium, realized_pnl_total, started_at, closed_at, currency'),
      supabase
        .from('option_legs')
        .select('id, campaign_id, leg_type, status, strike, expiry, open_date, close_date, net_pnl, gross_pnl, commission_total, quantity, multiplier, open_price'),
    ])
    return {
      campaigns: (campaigns ?? []) as Campaign[],
      legs:      (legs ?? []) as OptionLeg[],
    }
  } catch {
    return { campaigns: [], legs: [] }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtNum(val: number, sign = false) {
  const prefix = sign && val > 0 ? '+' : ''
  return prefix + val.toLocaleString('de-DE', { maximumFractionDigits: 0 })
}

function avg(arr: number[]) {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length
}

function dte(openDate: string, expiry: string) {
  return Math.round((new Date(expiry).getTime() - new Date(openDate).getTime()) / 86_400_000)
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${color ?? 'text-foreground'}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function StatistikenPage() {
  const { campaigns, legs } = await fetchStats()

  // Closed legs with a final P&L
  const closedLegs = legs.filter((l) => l.status !== 'open' && l.net_pnl !== null)
  const winLegs    = closedLegs.filter((l) => (l.net_pnl ?? 0) > 0)
  const lossLegs   = closedLegs.filter((l) => (l.net_pnl ?? 0) <= 0)
  const winRate    = closedLegs.length > 0 ? (winLegs.length / closedLegs.length) * 100 : 0

  const totalPnl      = closedLegs.reduce((s, l) => s + (l.net_pnl ?? 0), 0)
  const totalComm     = legs.reduce((s, l) => s + (l.commission_total ?? 0), 0)
  const avgWin        = avg(winLegs.map((l) => l.net_pnl!))
  const avgLoss       = avg(lossLegs.map((l) => l.net_pnl!))
  const profitFactor  = avgLoss < 0 ? Math.abs(avgWin / avgLoss) : null

  // DTE stats (short puts/calls only)
  const stoLegs = legs.filter((l) => l.leg_type.startsWith('short') && l.open_date && l.expiry)
  const avgDte  = stoLegs.length > 0 ? Math.round(avg(stoLegs.map((l) => dte(l.open_date, l.expiry)))) : null

  // Days to close (closed legs)
  const closedStoLegs = stoLegs.filter((l) => l.close_date)
  const avgDtc        = closedStoLegs.length > 0
    ? Math.round(avg(closedStoLegs.map((l) => dte(l.open_date, l.close_date!))))
    : null

  // Per-underlying breakdown
  const campMap = new Map(campaigns.map((c) => [c.id, c]))
  const byUnderlying = new Map<string, { premium: number; pnl: number; count: number; wins: number }>()
  for (const c of campaigns) {
    byUnderlying.set(c.underlying, {
      premium: c.total_option_premium,
      pnl:     c.realized_pnl_total,
      count:   1,
      wins:    c.realized_pnl_total > 0 ? 1 : 0,
    })
  }
  // Merge multi-entry underlyings (shouldn't happen with 1:1 campaigns, but be safe)
  const sortedByPnl = Array.from(byUnderlying.entries())
    .sort(([, a], [, b]) => b.pnl - a.pnl)

  const openCampaigns   = campaigns.filter((c) => c.status === 'open')
  const closedCampaigns = campaigns.filter((c) => c.status === 'closed')

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Statistiken</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Performance-Kennzahlen auf einen Blick</p>
      </div>

      {/* Win / Loss stats */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Win / Loss</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Win Rate"
            value={`${winRate.toFixed(1)} %`}
            sub={`${winLegs.length} Wins / ${closedLegs.length} gesamt`}
            color={winRate >= 50 ? 'text-profit' : 'text-loss'}
          />
          <StatCard
            label="Profit Factor"
            value={profitFactor !== null ? profitFactor.toFixed(2) : '—'}
            sub={profitFactor ? `Avg Win ${fmtNum(avgWin, true)} · Avg Loss ${fmtNum(avgLoss)}` : undefined}
            color={profitFactor !== null ? (profitFactor >= 1 ? 'text-profit' : 'text-loss') : undefined}
          />
          <StatCard
            label="Ø Gewinn / Trade"
            value={winLegs.length > 0 ? fmtNum(avgWin, true) : '—'}
            color="text-profit"
          />
          <StatCard
            label="Ø Verlust / Trade"
            value={lossLegs.length > 0 ? fmtNum(avgLoss) : '—'}
            color="text-loss"
          />
        </div>
      </div>

      {/* Totals */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Gesamtzahlen</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Realisiertes P&L"
            value={fmtNum(totalPnl, true)}
            color={totalPnl >= 0 ? 'text-profit' : 'text-loss'}
          />
          <StatCard
            label="Kommissionen"
            value={fmtNum(-Math.abs(totalComm))}
            sub={`${legs.length} Legs total`}
          />
          <StatCard
            label="Campaigns"
            value={campaigns.length.toString()}
            sub={`${openCampaigns.length} offen · ${closedCampaigns.length} geschlossen`}
          />
          <StatCard
            label="Abgeschl. Trades"
            value={closedLegs.length.toString()}
          />
        </div>
      </div>

      {/* Timing stats */}
      {(avgDte !== null || avgDtc !== null) && (
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Timing</h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {avgDte !== null && (
              <StatCard
                label="Ø DTE bei Eröffnung"
                value={`${avgDte} Tage`}
                sub={`${stoLegs.length} Short Legs`}
              />
            )}
            {avgDtc !== null && (
              <StatCard
                label="Ø Haltedauer"
                value={`${avgDtc} Tage`}
                sub={`${closedStoLegs.length} geschlossene Short Legs`}
              />
            )}
          </div>
        </div>
      )}

      {/* Per-underlying breakdown */}
      {sortedByPnl.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <h2 className="text-sm font-medium text-foreground">Performance nach Underlying</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/30">
                <tr>
                  {['Underlying', 'Realis. P&L', 'Prämien', 'Campaigns'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted-foreground whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedByPnl.map(([underlying, data], i) => (
                  <tr
                    key={underlying}
                    className={`border-b border-border/50 hover:bg-accent/20 transition-colors ${i % 2 === 0 ? '' : 'bg-muted/10'}`}
                  >
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/positionen/${underlying}`}
                        className="font-semibold text-foreground hover:text-primary transition-colors"
                      >
                        {underlying}
                      </Link>
                    </td>
                    <td className={`px-4 py-2.5 tabular-nums font-medium ${data.pnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                      {fmtNum(data.pnl, true)}
                    </td>
                    <td className={`px-4 py-2.5 tabular-nums font-medium ${data.premium >= 0 ? 'text-profit' : 'text-loss'}`}>
                      {fmtNum(data.premium, true)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {data.count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {campaigns.length === 0 && (
        <div className="rounded-lg border border-border bg-card p-12 text-center">
          <p className="text-muted-foreground text-sm">
            Noch keine Daten vorhanden.{' '}
            <Link href="/import" className="text-primary hover:underline">
              Import starten →
            </Link>
          </p>
        </div>
      )}
    </div>
  )
}
