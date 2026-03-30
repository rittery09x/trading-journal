export const dynamic = 'force-dynamic'

import { createServiceClient } from '@/lib/supabase/server'
import { MonthlyChart } from '@/components/cashflow/monthly-chart'
import type { MonthlyRow } from '@/components/cashflow/monthly-chart'

// ── Data fetching ─────────────────────────────────────────────────────────────

interface ClosedLeg {
  close_date: string
  gross_pnl:  number | null
  commission_total: number
  net_pnl:    number | null
}

async function fetchClosedLegs(): Promise<ClosedLeg[]> {
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from('option_legs')
      .select('close_date, gross_pnl, commission_total, net_pnl')
      .not('close_date', 'is', null)
      .not('net_pnl', 'is', null)
      .order('close_date', { ascending: true })
    return (data ?? []) as ClosedLeg[]
  } catch {
    return []
  }
}

// ── Grouping ──────────────────────────────────────────────────────────────────

const MONTH_LABELS = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez']

function groupByMonth(legs: ClosedLeg[]): MonthlyRow[] {
  const map = new Map<string, { gross: number; commission: number; net: number; count: number }>()
  for (const leg of legs) {
    if (!leg.close_date) continue
    const key = leg.close_date.slice(0, 7)
    const cur = map.get(key) ?? { gross: 0, commission: 0, net: 0, count: 0 }
    cur.gross      += leg.gross_pnl ?? 0
    cur.commission += leg.commission_total ?? 0
    cur.net        += leg.net_pnl ?? 0
    cur.count      += 1
    map.set(key, cur)
  }
  let cumulative = 0
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, data]) => {
      cumulative += data.net
      const [y, m] = month.split('-')
      return {
        month,
        label: `${MONTH_LABELS[parseInt(m) - 1]} ${y.slice(2)}`,
        net:   data.net,
        cumulative,
        count: data.count,
      }
    })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtNum(val: number, sign = false) {
  const prefix = sign && val > 0 ? '+' : ''
  return prefix + val.toLocaleString('de-DE', { maximumFractionDigits: 0 })
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function CashflowPage() {
  const legs    = await fetchClosedLegs()
  const monthly = groupByMonth(legs)

  const totalNet   = monthly.reduce((s, r) => s + r.net, 0)
  const totalComm  = legs.reduce((s, l) => s + (l.commission_total ?? 0), 0)
  const totalGross = legs.reduce((s, l) => s + (l.gross_pnl ?? 0), 0)
  const bestMonth  = monthly.length > 0 ? monthly.reduce((a, b) => b.net > a.net ? b : a) : null
  const worstMonth = monthly.length > 0 ? monthly.reduce((a, b) => b.net < a.net ? b : a) : null

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Cashflow</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Monatliche Prämieneinnahmen und kumulativer P&L</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Gesamt Netto P&L',   value: fmtNum(totalNet, true),   colored: true  },
          { label: 'Gesamt Brutto P&L',  value: fmtNum(totalGross, true), colored: true  },
          { label: 'Gesamt Kommission',  value: fmtNum(-Math.abs(totalComm)), colored: false },
          { label: 'Monate mit Daten',   value: monthly.length.toString(), colored: false },
        ].map(({ label, value, colored }) => {
          const num = parseFloat(value.replace(/[^-\d.]/g, ''))
          const cls = colored ? (isNaN(num) ? '' : num >= 0 ? 'text-profit' : 'text-loss') : ''
          return (
            <div key={label} className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground mb-1">{label}</p>
              <p className={`text-xl font-semibold tabular-nums ${cls || 'text-foreground'}`}>
                {value}
              </p>
            </div>
          )
        })}
      </div>

      {/* Chart */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-foreground">Monatlicher Netto P&L</h2>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 rounded bg-primary inline-block opacity-80" />
              Kumulativ
            </span>
          </div>
        </div>
        <MonthlyChart data={monthly} />
      </div>

      {/* Best / Worst */}
      {(bestMonth || worstMonth) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {bestMonth && (
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground mb-1">Bester Monat</p>
              <p className="text-lg font-semibold text-foreground">{bestMonth.label}</p>
              <p className="text-profit tabular-nums font-medium">{fmtNum(bestMonth.net, true)}</p>
            </div>
          )}
          {worstMonth && (
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground mb-1">Schlechtester Monat</p>
              <p className="text-lg font-semibold text-foreground">{worstMonth.label}</p>
              <p className={`tabular-nums font-medium ${worstMonth.net >= 0 ? 'text-profit' : 'text-loss'}`}>
                {fmtNum(worstMonth.net, true)}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Monthly table */}
      {monthly.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/30">
                <tr>
                  {['Monat', 'Trades', 'Netto P&L', 'Kumulativ'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted-foreground whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...monthly].reverse().map((row, i) => (
                  <tr
                    key={row.month}
                    className={`border-b border-border/50 hover:bg-accent/20 transition-colors ${
                      i % 2 === 0 ? '' : 'bg-muted/10'
                    }`}
                  >
                    <td className="px-4 py-2.5 font-medium text-foreground tabular-nums">
                      {row.label}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground tabular-nums">
                      {row.count}
                    </td>
                    <td className={`px-4 py-2.5 tabular-nums font-medium ${row.net >= 0 ? 'text-profit' : 'text-loss'}`}>
                      {fmtNum(row.net, true)}
                    </td>
                    <td className={`px-4 py-2.5 tabular-nums font-medium ${row.cumulative >= 0 ? 'text-profit' : 'text-loss'}`}>
                      {fmtNum(row.cumulative, true)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {monthly.length === 0 && (
        <div className="rounded-lg border border-border bg-card p-12 text-center">
          <p className="text-muted-foreground text-sm">
            Noch keine abgeschlossenen Trades vorhanden.
          </p>
        </div>
      )}
    </div>
  )
}
