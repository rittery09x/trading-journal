/**
 * GET /api/campaigns
 * ==================
 * Returns all campaigns with aggregated option leg counts.
 *
 * Query params:
 *   ?status=open|closed   — filter by campaign status (default: all)
 *   ?underlying=NVDA      — filter by underlying symbol
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl
    const status     = searchParams.get('status')
    const underlying = searchParams.get('underlying')

    const supabase = createServiceClient()

    let query = supabase
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
        last_updated,
        option_legs (
          id,
          leg_type,
          status,
          strike,
          expiry,
          open_price,
          quantity,
          multiplier,
          net_pnl,
          cost_basis_carried
        )
      `)
      .order('started_at', { ascending: false })

    if (status === 'open' || status === 'closed') {
      query = query.eq('status', status)
    }
    if (underlying) {
      query = query.ilike('underlying', underlying.toUpperCase())
    }

    const { data, error } = await query

    if (error) throw new Error(error.message)

    return NextResponse.json({ campaigns: data ?? [] })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
