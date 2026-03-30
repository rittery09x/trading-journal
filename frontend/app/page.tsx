export const dynamic = 'force-dynamic'

import { createServiceClient } from '@/lib/supabase/server'
import { StatsRow } from '@/components/dashboard/stats-cards'
import { PnlChart } from '@/components/dashboard/pnl-chart'
import { OpenCampaignsPreview } from '@/components/dashboard/open-campaigns-preview'
import { RecentActivity } from '@/components/dashboard/recent-activity'
import type { Campaign, ChartPoint, RawExecution } from '@/lib/types'

async function fetchDashboardData() {
  try {
    const supabase = createServiceClient()

    const [
      { data: campaigns },
      { data: snapshots },
      { data: executions },
    ] = await Promise.all([
      supabase
        .from('campaigns')
        .select(
          'id, underlying, status, total_option_premium, realized_pnl_total, open_option_legs, currency',
        ),
      supabase
        .from('account_snapshots')
        .select('snapshot_date, net_liquidation_usd')
        .order('snapshot_date', { ascending: true })
        .limit(500),
      supabase
        .from('raw_executions')
        .select(
          'ibkr_trade_id, symbol, underlying, asset_class, action, quantity, price, currency, realized_pnl, trade_date',
        )
        .order('trade_date', { ascending: false })
        .limit(12),
    ])

    return { campaigns, snapshots, executions }
  } catch {
    // Supabase not configured yet — return empty data
    return { campaigns: null, snapshots: null, executions: null }
  }
}

export default async function DashboardPage() {
  const { campaigns, snapshots, executions } = await fetchDashboardData()

  const allCampaigns  = (campaigns ?? []) as Campaign[]
  const openCampaigns = allCampaigns.filter((c) => c.status === 'open')

  const totalPnl      = allCampaigns.reduce((s, c) => s + (c.realized_pnl_total ?? 0), 0)
  const totalPremium  = allCampaigns.reduce((s, c) => s + (c.total_option_premium ?? 0), 0)
  const openLegs      = openCampaigns.reduce((s, c) => s + (c.open_option_legs ?? 0), 0)

  const chartData: ChartPoint[] = (snapshots ?? []).map((s) => ({
    time:  s.snapshot_date,
    value: s.net_liquidation_usd,
  }))
  const latestNav = chartData.length > 0 ? chartData[chartData.length - 1].value : null

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-semibold text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Übersicht deines Trading-Journals</p>
      </div>

      {/* KPI cards */}
      <StatsRow
        totalPnl={totalPnl}
        totalPremium={totalPremium}
        openCampaigns={openCampaigns.length}
        openLegs={openLegs}
        latestNav={latestNav}
      />

      {/* P&L Chart */}
      <PnlChart data={chartData} />

      {/* Bottom grid: open campaigns + recent activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <OpenCampaignsPreview campaigns={openCampaigns} />
        <RecentActivity executions={(executions ?? []) as RawExecution[]} />
      </div>
    </div>
  )
}
