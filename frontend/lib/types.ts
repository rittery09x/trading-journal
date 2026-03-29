export type CampaignStatus = 'open' | 'closed'
export type LegType = 'short_put' | 'long_put' | 'short_call' | 'long_call'
export type LegStatus = 'open' | 'closed' | 'expired' | 'assigned' | 'rolled'

export interface Campaign {
  id: string
  underlying: string
  status: CampaignStatus
  strategy_type: string
  started_at: string
  closed_at: string | null
  stock_quantity: number
  effective_avg_cost: number | null
  broker_avg_cost: number | null
  total_option_premium: number
  cost_basis_adjustment: number
  realized_pnl_total: number
  open_option_legs: number
  currency: string
  notes: string | null
  last_updated: string
}

export interface OptionLeg {
  id: string
  campaign_id: string
  leg_type: LegType
  status: LegStatus
  strike: number
  expiry: string
  open_date: string
  close_date: string | null
  open_price: number
  close_price: number | null
  quantity: number
  multiplier: number
  gross_pnl: number | null
  commission_total: number
  net_pnl: number | null
  cost_basis_carried: number
  rolled_to_leg_id: string | null
  rolled_from_leg_id: string | null
}

export interface RawExecution {
  id?: string
  ibkr_trade_id: string
  symbol: string
  underlying: string | null
  asset_class: string
  action: string
  quantity: number
  price: number
  currency: string
  commission: number
  realized_pnl: number | null
  trade_date: string
  option_expiry: string | null
  option_strike: number | null
  option_type: string | null
  leg_group_id: string | null
}

export interface AccountSnapshot {
  snapshot_date: string
  net_liquidation_usd: number
  net_liquidation_eur: number
}

export interface ChartPoint {
  time: string   // YYYY-MM-DD
  value: number
}
