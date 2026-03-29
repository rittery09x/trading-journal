/**
 * GET /api/campaigns/[id]
 * =======================
 * Returns a single campaign with all option legs and raw executions.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const supabase = createServiceClient()

    const { data: campaign, error: campErr } = await supabase
      .from('campaigns')
      .select(`
        id,
        underlying,
        status,
        strategy_type,
        started_at,
        closed_at,
        stock_quantity,
        effective_avg_cost,
        broker_avg_cost,
        total_option_premium,
        cost_basis_adjustment,
        realized_pnl_total,
        open_option_legs,
        currency,
        notes,
        last_updated
      `)
      .eq('id', params.id)
      .single()

    if (campErr) {
      if (campErr.code === 'PGRST116') {
        return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
      }
      throw new Error(campErr.message)
    }

    // Option legs ordered by open_date
    const { data: legs, error: legsErr } = await supabase
      .from('option_legs')
      .select(`
        id,
        leg_type,
        status,
        strike,
        expiry,
        open_date,
        close_date,
        open_price,
        close_price,
        quantity,
        multiplier,
        gross_pnl,
        commission_total,
        net_pnl,
        cost_basis_carried,
        rolled_to_leg_id,
        rolled_from_leg_id
      `)
      .eq('campaign_id', params.id)
      .order('open_date', { ascending: true })

    if (legsErr) throw new Error(legsErr.message)

    // Raw executions for this campaign
    const { data: executions, error: execErr } = await supabase
      .from('raw_executions')
      .select(`
        id,
        ibkr_trade_id,
        symbol,
        asset_class,
        action,
        quantity,
        price,
        currency,
        commission,
        realized_pnl,
        trade_date,
        option_expiry,
        option_strike,
        option_type,
        leg_group_id
      `)
      .eq('campaign_id', params.id)
      .order('trade_date', { ascending: true })

    if (execErr) throw new Error(execErr.message)

    return NextResponse.json({
      campaign: {
        ...campaign,
        option_legs: legs ?? [],
        executions:  executions ?? [],
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
