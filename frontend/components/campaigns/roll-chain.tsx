import { ArrowDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { OptionLeg } from '@/lib/types'

// ── Roll chain builder ────────────────────────────────────────────────────────
// A BTC with rolled_to_leg_id forms a "roll step" together with the new STO.
// Multiple steps for the same direction (Put/Call) are shown as a chain.

interface RollStep {
  btc: OptionLeg
  newSto: OptionLeg
}

interface ChainGroup {
  direction: 'Put' | 'Call'
  steps: RollStep[]
}

export function buildRollChainGroups(legs: OptionLeg[]): {
  chains: ChainGroup[]
  standalone: OptionLeg[]
} {
  const byId = new Map(legs.map((l) => [l.id, l]))
  const usedIds = new Set<string>()
  const rollSteps: RollStep[] = []

  // Collect all roll steps: BTC (has rolled_to_leg_id) + new STO
  for (const leg of legs) {
    if (leg.rolled_to_leg_id) {
      const newSto = byId.get(leg.rolled_to_leg_id)
      if (newSto) {
        rollSteps.push({ btc: leg, newSto })
        usedIds.add(leg.id)
        usedIds.add(newSto.id)
      }
    }
  }

  // Group roll steps by direction (Put / Call)
  const putSteps  = rollSteps.filter((s) => s.btc.leg_type.includes('put')).sort(
    (a, b) => a.btc.open_date.localeCompare(b.btc.open_date),
  )
  const callSteps = rollSteps.filter((s) => s.btc.leg_type.includes('call')).sort(
    (a, b) => a.btc.open_date.localeCompare(b.btc.open_date),
  )

  const chains: ChainGroup[] = []
  if (putSteps.length)  chains.push({ direction: 'Put',  steps: putSteps })
  if (callSteps.length) chains.push({ direction: 'Call', steps: callSteps })

  const standalone = legs.filter((l) => !usedIds.has(l.id))

  return { chains, standalone }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('de-DE', {
    day: '2-digit', month: '2-digit', year: '2-digit',
  })
}

function fmtPnl(val: number | null, prefix = true) {
  if (val === null) return '—'
  const sign = prefix && val >= 0 ? '+' : ''
  return sign + val.toLocaleString('de-DE', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
}

function breakEven(leg: OptionLeg): number | null {
  const { strike, open_price, cost_basis_carried, quantity, multiplier } = leg
  if (!quantity || !multiplier) return null
  const adj = cost_basis_carried / (Math.abs(quantity) * multiplier)
  return strike - (open_price - adj)
}

// ── Sub-components ────────────────────────────────────────────────────────────

function LegCard({
  leg,
  role,
}: {
  leg: OptionLeg
  role: 'btc' | 'sto' | 'standalone'
}) {
  const be = role !== 'btc' ? breakEven(leg) : null
  const isOpen = leg.status === 'open'
  const pnl = leg.net_pnl

  const borderColor = {
    btc:        'border-l-loss',
    sto:        isOpen ? 'border-l-profit' : 'border-l-border',
    standalone: isOpen ? 'border-l-status-open' : 'border-l-border',
  }[role]

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card/60 px-4 py-3 border-l-4',
        borderColor,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground">
              {role === 'btc' ? 'BTC' : 'STO'}{' '}
              {leg.leg_type.includes('put') ? 'Put' : 'Call'}{' '}
              {leg.strike}
            </span>
            <Badge
              variant={
                leg.status === 'open'     ? 'open'
                : leg.status === 'rolled' ? 'rolled'
                : leg.status === 'expired' ? 'expired'
                : leg.status === 'assigned' ? 'assigned'
                : 'closed'
              }
            >
              {leg.status}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Verfall: {fmtDate(leg.expiry)} · Prämie: {leg.open_price.toFixed(2)} · Qty: {Math.abs(leg.quantity)}
          </p>
          {be !== null && (
            <p className={cn('text-xs font-medium', leg.cost_basis_carried < 0 ? 'text-loss' : 'text-muted-foreground')}>
              Break-Even: {be.toFixed(2)}
              {leg.cost_basis_carried !== 0 && (
                <span className={cn('ml-2', leg.cost_basis_carried < 0 ? 'text-loss' : 'text-profit')}>
                  (cost basis: {fmtPnl(leg.cost_basis_carried)})
                </span>
              )}
            </p>
          )}
        </div>

        {/* PnL (only for closed/non-open legs) */}
        {pnl !== null && !isOpen && (
          <div className="text-right flex-shrink-0">
            <p
              className={cn(
                'text-sm font-semibold tabular-nums',
                pnl >= 0 ? 'text-profit' : 'text-loss',
              )}
            >
              {fmtPnl(pnl)}
            </p>
            <p className="text-xs text-muted-foreground">Net P&L</p>
          </div>
        )}
      </div>
    </div>
  )
}

function RollConnector({ costBasis }: { costBasis: number }) {
  return (
    <div className="flex items-center gap-3 pl-4">
      <div className="w-0.5 h-6 bg-border flex-shrink-0 ml-1" />
      <div className="flex items-center gap-2">
        <ArrowDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        <span className="text-xs text-muted-foreground">Roll</span>
        {costBasis !== 0 && (
          <span
            className={cn(
              'text-xs font-medium tabular-nums',
              costBasis >= 0 ? 'text-profit' : 'text-loss',
            )}
          >
            {costBasis >= 0 ? '+' : ''}
            {costBasis.toLocaleString('de-DE', { maximumFractionDigits: 2 })} übertragen
          </span>
        )}
      </div>
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export function RollChain({ legs }: { legs: OptionLeg[] }) {
  const { chains, standalone } = buildRollChainGroups(legs)

  if (chains.length === 0 && standalone.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center">
        Keine Option-Legs vorhanden
      </p>
    )
  }

  return (
    <div className="space-y-8">
      {/* Roll chains (grouped by Put/Call direction) */}
      {chains.map((group) => (
        <div key={group.direction}>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            {group.direction} Roll-Chain ({group.steps.length} Roll
            {group.steps.length !== 1 ? 's' : ''})
          </h3>
          <div className="space-y-0">
            {group.steps.map((step, i) => (
              <div key={step.btc.id}>
                {/* BTC card */}
                <LegCard leg={step.btc} role="btc" />

                {/* Connector with cost basis */}
                <RollConnector costBasis={step.newSto.cost_basis_carried} />

                {/* New STO card */}
                <LegCard leg={step.newSto} role="sto" />

                {/* Gap between roll pairs */}
                {i < group.steps.length - 1 && (
                  <div className="h-4 border-l-2 border-dashed border-border/50 ml-2 mt-0.5" />
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Standalone legs (not part of any roll) */}
      {standalone.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Einzelne Legs ({standalone.length})
          </h3>
          <div className="space-y-2">
            {standalone.map((leg) => (
              <LegCard key={leg.id} leg={leg} role="standalone" />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
