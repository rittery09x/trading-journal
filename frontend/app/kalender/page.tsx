export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { createServiceClient } from '@/lib/supabase/server'
import { cn } from '@/lib/utils'
import type { OptionLeg } from '@/lib/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}

/** Returns Mon=0 … Sun=6 for the 1st of the given month */
function getFirstWeekday(year: number, month: number) {
  const d = new Date(year, month, 1).getDay()
  return d === 0 ? 6 : d - 1
}

const MONTHS   = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember']
const WEEKDAYS = ['Mo','Di','Mi','Do','Fr','Sa','So']

// ── Data fetching ─────────────────────────────────────────────────────────────

type LegWithUnderlying = OptionLeg & { underlying: string }

async function fetchLegsForMonth(year: number, month: number): Promise<LegWithUnderlying[]> {
  try {
    const supabase = createServiceClient()
    const mm  = String(month + 1).padStart(2, '0')
    const dd  = String(getDaysInMonth(year, month)).padStart(2, '0')
    const [{ data: legs }, { data: campaigns }] = await Promise.all([
      supabase
        .from('option_legs')
        .select('id, campaign_id, leg_type, status, strike, expiry, net_pnl, quantity, multiplier, open_price, close_price, close_date, open_date, gross_pnl, commission_total, cost_basis_carried, rolled_to_leg_id, rolled_from_leg_id')
        .gte('expiry', `${year}-${mm}-01`)
        .lte('expiry', `${year}-${mm}-${dd}`)
        .order('expiry', { ascending: true }),
      supabase.from('campaigns').select('id, underlying'),
    ])
    const campMap = new Map((campaigns ?? []).map((c) => [c.id as string, c.underlying as string]))
    return (legs ?? []).map((l) => ({ ...(l as OptionLeg), underlying: campMap.get(l.campaign_id) ?? '?' }))
  } catch {
    return []
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function KalenderPage({
  searchParams,
}: {
  searchParams: { year?: string; month?: string }
}) {
  const now   = new Date()
  const year  = parseInt(searchParams.year  ?? String(now.getFullYear()))
  const month = parseInt(searchParams.month ?? String(now.getMonth()))   // 0-based

  const legs = await fetchLegsForMonth(year, month)

  // Group legs by day (1-based key)
  const byDay = new Map<number, LegWithUnderlying[]>()
  for (const leg of legs) {
    const day = parseInt(leg.expiry.slice(8, 10))
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day)!.push(leg)
  }

  const daysInMonth  = getDaysInMonth(year, month)
  const firstWeekday = getFirstWeekday(year, month)
  const today        = now.getFullYear() === year && now.getMonth() === month ? now.getDate() : -1

  const prevYear  = month === 0  ? year - 1 : year
  const prevMonth = month === 0  ? 11 : month - 1
  const nextYear  = month === 11 ? year + 1 : year
  const nextMonth = month === 11 ? 0  : month + 1

  // Build grid: leading blanks + day numbers
  const cells: (number | null)[] = [
    ...Array(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]
  while (cells.length % 7 !== 0) cells.push(null)

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Kalender</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Option-Verfalltage im Überblick</p>
      </div>

      {/* Month navigation */}
      <div className="flex items-center justify-between">
        <Link
          href={`/kalender?year=${prevYear}&month=${prevMonth}`}
          className="p-2 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <h2 className="text-lg font-semibold text-foreground">
          {MONTHS[month]} {year}
        </h2>
        <Link
          href={`/kalender?year=${nextYear}&month=${nextMonth}`}
          className="p-2 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight className="h-5 w-5" />
        </Link>
      </div>

      {/* Calendar grid */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {/* Weekday headers */}
        <div className="grid grid-cols-7 border-b border-border">
          {WEEKDAYS.map((d) => (
            <div key={d} className="py-2 text-center text-xs font-medium text-muted-foreground">
              {d}
            </div>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7">
          {cells.map((day, idx) => {
            const dayLegs = day ? (byDay.get(day) ?? []) : []
            const isToday = day === today
            const isLastCol = idx % 7 === 6
            return (
              <div
                key={idx}
                className={cn(
                  'min-h-[80px] p-1.5 border-b border-r border-border/50 text-xs',
                  isLastCol && 'border-r-0',
                  !day && 'bg-muted/10',
                )}
              >
                {day && (
                  <>
                    <span className={cn(
                      'inline-flex h-6 w-6 items-center justify-center rounded-full font-medium mb-1',
                      isToday
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground',
                    )}>
                      {day}
                    </span>
                    <div className="space-y-0.5">
                      {dayLegs.map((leg) => {
                        const isPut   = leg.leg_type.includes('put')
                        const isOpen  = leg.status === 'open'
                        const pnlCls  = isOpen
                          ? 'bg-blue-500/20 text-blue-400'
                          : leg.net_pnl !== null && leg.net_pnl >= 0
                            ? 'bg-green-500/20 text-green-400'
                            : 'bg-red-500/20 text-red-400'
                        return (
                          <Link
                            key={leg.id}
                            href={`/positionen/${leg.underlying}`}
                            className={cn(
                              'block px-1.5 py-0.5 rounded text-[10px] leading-tight truncate font-medium transition-opacity hover:opacity-80',
                              pnlCls,
                            )}
                          >
                            {leg.underlying} {isPut ? 'P' : 'C'}{leg.strike}
                          </Link>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-blue-500/20 inline-block" /> Offen
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-green-500/20 inline-block" /> Gewinn / Expired wertlos
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-red-500/20 inline-block" /> Verlust
        </span>
      </div>

      {/* Monthly summary list */}
      {legs.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-5">
          <h3 className="text-sm font-medium text-foreground mb-3">
            {legs.length} Leg{legs.length !== 1 ? 's' : ''} im {MONTHS[month]}
          </h3>
          <div className="space-y-1.5">
            {legs.map((leg) => {
              const isPut  = leg.leg_type.includes('put')
              const isOpen = leg.status === 'open'
              const pnlCls = isOpen
                ? 'text-blue-400'
                : leg.net_pnl !== null && leg.net_pnl >= 0 ? 'text-profit' : 'text-loss'
              return (
                <div key={leg.id} className="flex items-center justify-between text-sm py-0.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <Link
                      href={`/positionen/${leg.underlying}`}
                      className="font-medium text-foreground hover:text-primary transition-colors flex-shrink-0"
                    >
                      {leg.underlying}
                    </Link>
                    <span className="text-muted-foreground truncate">
                      {isPut ? 'Put' : 'Call'} {leg.strike} · Verfall {leg.expiry.slice(0, 10)}
                    </span>
                  </div>
                  <span className={cn('tabular-nums font-medium flex-shrink-0 ml-4', pnlCls)}>
                    {leg.net_pnl !== null && leg.net_pnl !== 0
                      ? (leg.net_pnl >= 0 ? '+' : '') +
                        leg.net_pnl.toLocaleString('de-DE', { maximumFractionDigits: 0 })
                      : leg.status}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {legs.length === 0 && (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <p className="text-muted-foreground text-sm">
            Keine Verfalltermine im {MONTHS[month]} {year}.
          </p>
        </div>
      )}
    </div>
  )
}
