import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { createServiceClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import type { Campaign } from '@/lib/types'

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchCampaigns(status?: string): Promise<Campaign[]> {
  try {
    const supabase = createServiceClient()
    let q = supabase
      .from('campaigns')
      .select(
        'id, underlying, status, strategy_type, started_at, closed_at, ' +
        'stock_quantity, effective_avg_cost, broker_avg_cost, ' +
        'total_option_premium, cost_basis_adjustment, realized_pnl_total, ' +
        'open_option_legs, currency, last_updated',
      )
      .order('status', { ascending: true })   // open first
      .order('underlying', { ascending: true })

    if (status === 'open' || status === 'closed') {
      q = q.eq('status', status)
    }

    const { data } = await q
    return (data ?? []) as Campaign[]
  } catch {
    return []
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

function fmtNum(val: number | null, prefix = false) {
  if (val === null) return '—'
  const sign = prefix && val > 0 ? '+' : ''
  return sign + val.toLocaleString('de-DE', { maximumFractionDigits: 0 })
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function PositionenPage({
  searchParams,
}: {
  searchParams: { status?: string }
}) {
  const statusFilter = searchParams.status
  const campaigns    = await fetchCampaigns(statusFilter)

  const openCount   = campaigns.filter((c) => c.status === 'open').length
  const closedCount = campaigns.filter((c) => c.status === 'closed').length

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Positionen</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {campaigns.length} Campaign{campaigns.length !== 1 ? 's' : ''} ·{' '}
            {openCount} offen · {closedCount} geschlossen
          </p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 border-b border-border pb-0">
        {([
          { label: 'Alle', value: undefined },
          { label: 'Offen', value: 'open' },
          { label: 'Geschlossen', value: 'closed' },
        ] as const).map(({ label, value }) => {
          const active = statusFilter === value || (!statusFilter && !value)
          return (
            <Link
              key={label}
              href={value ? `/positionen?status=${value}` : '/positionen'}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </Link>
          )
        })}
      </div>

      {/* Table */}
      {campaigns.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-12 text-center">
          <p className="text-muted-foreground text-sm">
            Keine Campaigns vorhanden.{' '}
            <Link href="/import" className="text-primary hover:underline">
              Import starten →
            </Link>
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/30">
                <tr>
                  {[
                    'Underlying',
                    'Status',
                    'Seit',
                    'Aktien',
                    'Avg Cost',
                    'Prämien',
                    'Realis. P&L',
                    'Offene Legs',
                    '',
                  ].map((h) => (
                    <th
                      key={h}
                      className="px-4 py-3 text-left text-xs font-medium text-muted-foreground whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c, i) => (
                  <tr
                    key={c.id}
                    className={`border-b border-border/50 hover:bg-accent/20 transition-colors ${
                      i % 2 === 0 ? '' : 'bg-muted/10'
                    }`}
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/positionen/${c.underlying}`}
                        className="font-semibold text-foreground hover:text-primary transition-colors"
                      >
                        {c.underlying}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={c.status === 'open' ? 'open' : 'closed'}>
                        {c.status === 'open' ? 'offen' : 'geschlossen'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground tabular-nums whitespace-nowrap">
                      {fmtDate(c.started_at)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {c.stock_quantity !== 0 ? c.stock_quantity : '—'}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {c.broker_avg_cost !== null ? c.broker_avg_cost.toFixed(2) : '—'}
                    </td>
                    <td
                      className={`px-4 py-3 tabular-nums font-medium ${
                        c.total_option_premium >= 0 ? 'text-profit' : 'text-loss'
                      }`}
                    >
                      {fmtNum(c.total_option_premium, true)}
                    </td>
                    <td
                      className={`px-4 py-3 tabular-nums font-medium ${
                        c.realized_pnl_total >= 0 ? 'text-profit' : 'text-loss'
                      }`}
                    >
                      {fmtNum(c.realized_pnl_total, true)}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {c.open_option_legs > 0 ? (
                        <span className="text-status-open font-medium">
                          {c.open_option_legs}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/positionen/${c.underlying}`}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={`Details ${c.underlying}`}
                      >
                        <ArrowUpRight className="h-4 w-4" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
