import type { RawExecution } from '@/lib/types'

interface RecentActivityProps {
  executions: RawExecution[]
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  })
}

function actionLabel(action: string, assetClass: string) {
  if (assetClass === 'OPT') {
    return action === 'SELL' ? 'STO' : 'BTC'
  }
  return action
}

export function RecentActivity({ executions }: RecentActivityProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <h2 className="text-sm font-medium text-foreground mb-4">Letzte Trades</h2>

      {executions.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          Noch keine Trades importiert
        </p>
      ) : (
        <div className="space-y-0 -mx-2">
          {executions.map((e) => {
            const pnl = e.realized_pnl
            return (
              <div
                key={e.ibkr_trade_id}
                className="flex items-center justify-between px-2 py-2 rounded-md hover:bg-accent/30 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs text-muted-foreground w-14 flex-shrink-0 tabular-nums">
                    {fmtDate(e.trade_date)}
                  </span>
                  <span className="text-xs font-medium text-foreground truncate max-w-[90px]">
                    {e.underlying ?? e.symbol}
                  </span>
                  <span
                    className={`text-xs font-semibold flex-shrink-0 ${
                      e.action === 'SELL' ? 'text-profit' : 'text-loss'
                    }`}
                  >
                    {actionLabel(e.action, e.asset_class)}
                  </span>
                  <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">
                    {Math.abs(e.quantity)}×{' '}
                    {e.price.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
                {pnl !== null && pnl !== 0 && (
                  <span
                    className={`text-xs font-medium tabular-nums flex-shrink-0 ${
                      pnl >= 0 ? 'text-profit' : 'text-loss'
                    }`}
                  >
                    {pnl >= 0 ? '+' : ''}
                    {pnl.toLocaleString('de-DE', { maximumFractionDigits: 0 })}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
