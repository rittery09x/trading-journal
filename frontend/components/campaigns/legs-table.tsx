import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { OptionLeg } from '@/lib/types'

interface LegsTableProps {
  legs: OptionLeg[]
  currency?: string
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  })
}

function fmtDte(expiryIso: string): number {
  const today  = new Date()
  today.setHours(0, 0, 0, 0)
  const expiry = new Date(expiryIso)
  return Math.round((expiry.getTime() - today.getTime()) / 86_400_000)
}

function fmtPnl(val: number | null) {
  if (val === null) return '—'
  return (val >= 0 ? '+' : '') + val.toLocaleString('de-DE', { maximumFractionDigits: 0 })
}

function breakEven(leg: OptionLeg): number | null {
  const { strike, open_price, cost_basis_carried, quantity, multiplier } = leg
  if (!quantity || !multiplier) return null
  const adj = cost_basis_carried / (Math.abs(quantity) * multiplier)
  return strike - (open_price - adj)
}

function legLabel(legType: string) {
  return legType
    .replace('short_put',  'Short Put')
    .replace('long_put',   'Long Put')
    .replace('short_call', 'Short Call')
    .replace('long_call',  'Long Call')
}

const STATUS_VARIANT: Record<string, 'open' | 'closed' | 'expired' | 'assigned' | 'rolled'> = {
  open:     'open',
  closed:   'closed',
  expired:  'expired',
  assigned: 'assigned',
  rolled:   'rolled',
}

export function LegsTable({ legs, currency = 'USD' }: LegsTableProps) {
  if (legs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center">
        Keine Option-Legs vorhanden
      </p>
    )
  }

  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {[
              'Typ', 'Status', 'Strike', 'Verfall', 'DTE',
              'Prämie', 'Qty', 'Break-Even', `Net P&L (${currency})`,
            ].map((h) => (
              <th
                key={h}
                className="px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {legs.map((leg) => {
            const dte = fmtDte(leg.expiry)
            const be  = breakEven(leg)
            const isOpen = leg.status === 'open'
            const dteFmt = isOpen
              ? dte < 0
                ? <span className="text-loss">{dte}d</span>
                : dte <= 7
                  ? <span className="text-yellow-400">{dte}d</span>
                  : <span>{dte}d</span>
              : '—'

            return (
              <tr
                key={leg.id}
                className="border-b border-border/50 hover:bg-accent/20 transition-colors"
              >
                <td className="px-3 py-2.5 font-medium text-foreground whitespace-nowrap">
                  {legLabel(leg.leg_type)}
                </td>
                <td className="px-3 py-2.5">
                  <Badge variant={STATUS_VARIANT[leg.status] ?? 'closed'}>
                    {leg.status}
                  </Badge>
                </td>
                <td className="px-3 py-2.5 tabular-nums font-medium">{leg.strike}</td>
                <td className="px-3 py-2.5 tabular-nums text-muted-foreground whitespace-nowrap">
                  {fmtDate(leg.expiry)}
                </td>
                <td className="px-3 py-2.5 tabular-nums">{dteFmt}</td>
                <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                  {leg.open_price.toFixed(2)}
                </td>
                <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                  {Math.abs(leg.quantity)}
                </td>
                <td className="px-3 py-2.5 tabular-nums">
                  {be !== null ? (
                    <span className={cn(
                      'font-medium',
                      leg.cost_basis_carried < 0 ? 'text-loss' : 'text-foreground'
                    )}>
                      {be.toFixed(2)}
                    </span>
                  ) : '—'}
                </td>
                <td
                  className={cn(
                    'px-3 py-2.5 tabular-nums font-medium',
                    leg.net_pnl === null
                      ? 'text-muted-foreground'
                      : leg.net_pnl >= 0
                        ? 'text-profit'
                        : 'text-loss',
                  )}
                >
                  {fmtPnl(leg.net_pnl)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
