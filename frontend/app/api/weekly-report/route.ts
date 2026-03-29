/**
 * POST /api/weekly-report
 * =======================
 * Aggregates last 7 days of trading activity and sends an HTML email via SMTP.
 *
 * Auth: Bearer IMPORT_SECRET (same token as import)
 *
 * Email sections:
 *   - Summary (total PnL, premiums collected, expirations, assignments)
 *   - Open campaigns with upcoming expirations
 *   - Closed/expired this week
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

function isAuthorized(req: NextRequest): boolean {
  const header = req.headers.get('authorization') ?? ''
  const secret = process.env.IMPORT_SECRET
  if (!secret) return false
  return header === `Bearer ${secret}`
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function weekRange(): { from: string; to: string } {
  const now = new Date()
  const to  = new Date(now)
  const from = new Date(now)
  from.setDate(from.getDate() - 7)
  return { from: isoDate(from), to: isoDate(to) }
}

// ── HTML template ─────────────────────────────────────────────────────────────

function fmtCurrency(val: number | null, currency = 'USD'): string {
  if (val === null || isNaN(val)) return '—'
  const sign  = val >= 0 ? '+' : ''
  const color = val >= 0 ? '#22c55e' : '#ef4444'
  return `<span style="color:${color};font-weight:600">${sign}${val.toFixed(2)} ${currency}</span>`
}

function buildHtml(data: {
  from: string
  to: string
  totalPnl: number
  premiumsCollected: number
  expirations: number
  assignments: number
  openCampaigns: {
    underlying: string
    open_option_legs: number
    total_option_premium: number
    currency: string
    next_expiry: string | null
  }[]
  closedThisWeek: {
    underlying: string
    leg_type: string
    strike: number
    expiry: string
    status: string
    net_pnl: number | null
    currency: string
  }[]
}): string {
  const { from, to, totalPnl, premiumsCollected, expirations, assignments } = data

  const openRows = data.openCampaigns.map(c => `
    <tr>
      <td style="padding:6px 12px;font-weight:600">${c.underlying}</td>
      <td style="padding:6px 12px;text-align:center">${c.open_option_legs}</td>
      <td style="padding:6px 12px">${fmtCurrency(c.total_option_premium, c.currency)}</td>
      <td style="padding:6px 12px">${c.next_expiry ?? '—'}</td>
    </tr>
  `).join('')

  const statusColor: Record<string, string> = {
    expired:  '#22c55e',
    assigned: '#f97316',
    closed:   '#6b7280',
    rolled:   '#8b5cf6',
  }

  const closedRows = data.closedThisWeek.map(l => `
    <tr>
      <td style="padding:6px 12px;font-weight:600">${l.underlying}</td>
      <td style="padding:6px 12px">${l.leg_type.replace('_', ' ')}</td>
      <td style="padding:6px 12px">${l.strike}</td>
      <td style="padding:6px 12px">${l.expiry}</td>
      <td style="padding:6px 12px">
        <span style="color:${statusColor[l.status] ?? '#6b7280'}">${l.status}</span>
      </td>
      <td style="padding:6px 12px">${fmtCurrency(l.net_pnl, l.currency)}</td>
    </tr>
  `).join('')

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Wochenbericht ${from} – ${to}</title>
</head>
<body style="font-family:system-ui,sans-serif;background:#f1f5f9;margin:0;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">

    <!-- Header -->
    <div style="background:#1e293b;color:#fff;padding:24px 32px">
      <h1 style="margin:0;font-size:20px">Trading Journal — Wochenbericht</h1>
      <p style="margin:4px 0 0;color:#94a3b8;font-size:14px">${from} bis ${to}</p>
    </div>

    <!-- Summary -->
    <div style="padding:24px 32px;border-bottom:1px solid #e2e8f0">
      <h2 style="margin:0 0 16px;font-size:16px;color:#1e293b">Zusammenfassung</h2>
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:6px 0;color:#64748b">Realisiertes P&amp;L (Woche)</td>
          <td style="padding:6px 0;text-align:right">${fmtCurrency(totalPnl)}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#64748b">Prämien eingenommen</td>
          <td style="padding:6px 0;text-align:right">${fmtCurrency(premiumsCollected)}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#64748b">Verfallene Optionen</td>
          <td style="padding:6px 0;text-align:right">${expirations}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#64748b">Assignments</td>
          <td style="padding:6px 0;text-align:right">${assignments}</td>
        </tr>
      </table>
    </div>

    <!-- Open campaigns -->
    ${data.openCampaigns.length > 0 ? `
    <div style="padding:24px 32px;border-bottom:1px solid #e2e8f0">
      <h2 style="margin:0 0 16px;font-size:16px;color:#1e293b">Offene Campaigns</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#f8fafc;color:#64748b">
            <th style="padding:6px 12px;text-align:left">Underlying</th>
            <th style="padding:6px 12px;text-align:center">Legs</th>
            <th style="padding:6px 12px;text-align:left">Gesamt Prämie</th>
            <th style="padding:6px 12px;text-align:left">Nächster Verfall</th>
          </tr>
        </thead>
        <tbody>${openRows}</tbody>
      </table>
    </div>
    ` : ''}

    <!-- Closed this week -->
    ${data.closedThisWeek.length > 0 ? `
    <div style="padding:24px 32px">
      <h2 style="margin:0 0 16px;font-size:16px;color:#1e293b">Geschlossen diese Woche</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#f8fafc;color:#64748b">
            <th style="padding:6px 12px;text-align:left">Underlying</th>
            <th style="padding:6px 12px;text-align:left">Typ</th>
            <th style="padding:6px 12px;text-align:left">Strike</th>
            <th style="padding:6px 12px;text-align:left">Verfall</th>
            <th style="padding:6px 12px;text-align:left">Status</th>
            <th style="padding:6px 12px;text-align:left">Net P&amp;L</th>
          </tr>
        </thead>
        <tbody>${closedRows}</tbody>
      </table>
    </div>
    ` : ''}

    <!-- Footer -->
    <div style="padding:16px 32px;background:#f8fafc;border-top:1px solid #e2e8f0">
      <p style="margin:0;font-size:12px;color:#94a3b8;text-align:center">
        Trading Journal · automatisch generiert
      </p>
    </div>

  </div>
</body>
</html>`
}

// ── SMTP sender ───────────────────────────────────────────────────────────────

async function sendEmail(subject: string, html: string): Promise<void> {
  // Dynamic import — nodemailer is only used server-side
  const nodemailer = await import('nodemailer')

  const transporter = nodemailer.default.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })

  await transporter.sendMail({
    from:    process.env.SMTP_USER,
    to:      process.env.REPORT_EMAIL,
    subject,
    html,
  })
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = createServiceClient()
    const { from, to } = weekRange()

    // ── Query: option legs closed/expired this week ───────────────────────────
    const { data: closedLegs, error: legsErr } = await supabase
      .from('option_legs')
      .select(`
        id,
        leg_type,
        status,
        strike,
        expiry,
        net_pnl,
        campaign:campaigns (
          underlying,
          currency
        )
      `)
      .in('status', ['closed', 'expired', 'assigned', 'rolled'])
      .gte('close_date', from)
      .lte('close_date', to)
      .order('close_date', { ascending: true })

    if (legsErr) throw new Error(legsErr.message)

    // ── Query: all open campaigns ─────────────────────────────────────────────
    const { data: openCampaigns, error: campErr } = await supabase
      .from('campaigns')
      .select(`
        underlying,
        open_option_legs,
        total_option_premium,
        currency,
        option_legs (
          expiry,
          status
        )
      `)
      .eq('status', 'open')
      .order('underlying')

    if (campErr) throw new Error(campErr.message)

    // ── Aggregate summary ─────────────────────────────────────────────────────
    let totalPnl          = 0
    let premiumsCollected = 0
    let expirations       = 0
    let assignments       = 0

    const closedThisWeek = (closedLegs ?? []).map((l: Record<string, unknown>) => {
      const pnl    = (l.net_pnl as number | null) ?? 0
      const camp   = (l.campaign as Record<string, unknown> | null) ?? {}
      const status = l.status as string

      totalPnl += pnl
      if (status === 'expired') {
        expirations++
        premiumsCollected += pnl
      } else if (status === 'assigned') {
        assignments++
      } else if (status === 'closed') {
        premiumsCollected += pnl
      }

      return {
        underlying: (camp.underlying as string) ?? '?',
        leg_type:   l.leg_type as string,
        strike:     l.strike as number,
        expiry:     (l.expiry as string)?.slice(0, 10) ?? '?',
        status,
        net_pnl:    l.net_pnl as number | null,
        currency:   (camp.currency as string) ?? 'USD',
      }
    })

    const openCampaignData = (openCampaigns ?? []).map((c: Record<string, unknown>) => {
      const legs = (c.option_legs as { expiry: string | null; status: string }[]) ?? []
      const openLegs = legs.filter(l => l.status === 'open' && l.expiry)
      openLegs.sort((a, b) => (a.expiry ?? '').localeCompare(b.expiry ?? ''))
      return {
        underlying:           c.underlying as string,
        open_option_legs:     c.open_option_legs as number,
        total_option_premium: c.total_option_premium as number,
        currency:             c.currency as string,
        next_expiry:          openLegs[0]?.expiry?.slice(0, 10) ?? null,
      }
    })

    // ── Build + send email ────────────────────────────────────────────────────
    const html = buildHtml({
      from,
      to,
      totalPnl,
      premiumsCollected,
      expirations,
      assignments,
      openCampaigns:  openCampaignData,
      closedThisWeek,
    })

    const subject = `Trading Journal ${from} – ${to} | PnL ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} USD`

    await sendEmail(subject, html)

    return NextResponse.json({
      status: 'sent',
      period: { from, to },
      summary: {
        total_pnl:          totalPnl,
        premiums_collected: premiumsCollected,
        expirations,
        assignments,
        open_campaigns:    openCampaignData.length,
        closed_this_week:  closedThisWeek.length,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[weekly-report]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
