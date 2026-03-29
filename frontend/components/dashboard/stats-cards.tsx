import { cn } from '@/lib/utils'

interface StatCardProps {
  label: string
  value: number | string
  unit?: string
  /** Apply green/red coloring based on sign */
  colored?: boolean
  subtext?: string
}

export function StatCard({ label, value, unit, colored = false, subtext }: StatCardProps) {
  const isNumber = typeof value === 'number'
  const isPositive = isNumber && (value as number) >= 0

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground mb-1.5">{label}</p>
      <p
        className={cn(
          'text-2xl font-semibold tabular-nums',
          colored && isNumber
            ? isPositive
              ? 'text-profit'
              : 'text-loss'
            : 'text-foreground',
        )}
      >
        {isNumber ? (colored && value !== 0 ? (isPositive ? '+' : '') : '') : ''}
        {isNumber ? (value as number).toLocaleString('de-DE', { maximumFractionDigits: 0 }) : value}
        {unit && (
          <span className="text-sm font-normal text-muted-foreground ml-1">{unit}</span>
        )}
      </p>
      {subtext && <p className="text-xs text-muted-foreground mt-1">{subtext}</p>}
    </div>
  )
}

interface StatsRowProps {
  totalPnl: number
  totalPremium: number
  openCampaigns: number
  openLegs: number
  latestNav: number | null
  currency?: string
}

export function StatsRow({
  totalPnl,
  totalPremium,
  openCampaigns,
  openLegs,
  latestNav,
  currency = 'USD',
}: StatsRowProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
      <StatCard
        label="Realisiertes P&L"
        value={totalPnl}
        unit={currency}
        colored
      />
      <StatCard
        label="Prämien eingenommen"
        value={totalPremium}
        unit={currency}
        colored
      />
      <StatCard
        label="Offene Campaigns"
        value={openCampaigns}
      />
      <StatCard
        label="Offene Legs"
        value={openLegs}
      />
      <StatCard
        label="Konto (aktuell)"
        value={latestNav ?? '—'}
        unit={latestNav !== null ? currency : undefined}
      />
    </div>
  )
}
