import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { Campaign } from '@/lib/types'

interface OpenCampaignsPreviewProps {
  campaigns: Campaign[]
}

function fmt(n: number, currency = 'USD') {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toLocaleString('de-DE', { maximumFractionDigits: 0 })} ${currency}`
}

export function OpenCampaignsPreview({ campaigns }: OpenCampaignsPreviewProps) {
  const sorted = [...campaigns]
    .sort((a, b) => b.open_option_legs - a.open_option_legs)
    .slice(0, 6)

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-foreground">Offene Campaigns</h2>
        <Link
          href="/positionen?status=open"
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
        >
          Alle anzeigen <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          Keine offenen Campaigns
        </p>
      ) : (
        <div className="space-y-2">
          {sorted.map((c) => (
            <Link
              key={c.id}
              href={`/positionen/${c.underlying}`}
              className="flex items-center justify-between py-2.5 px-3 rounded-md hover:bg-accent/50 transition-colors group"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-semibold text-sm text-foreground w-16 flex-shrink-0">
                  {c.underlying}
                </span>
                <Badge variant="open" className="text-xs">
                  {c.open_option_legs} Leg{c.open_option_legs !== 1 ? 's' : ''}
                </Badge>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`text-sm font-medium tabular-nums ${
                    c.total_option_premium >= 0 ? 'text-profit' : 'text-loss'
                  }`}
                >
                  {fmt(c.total_option_premium, c.currency)}
                </span>
                <ArrowRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
