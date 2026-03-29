'use client'

import {
  ComposedChart, Bar, Cell, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'

export interface MonthlyRow {
  month: string        // YYYY-MM
  label: string        // "Jan 25"
  net: number
  cumulative: number
  count: number
}

function formatEur(val: number) {
  return (val >= 0 ? '+' : '') + val.toLocaleString('de-DE', { maximumFractionDigits: 0 })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const net  = payload.find((p: any) => p.dataKey === 'net')?.value ?? 0
  const cum  = payload.find((p: any) => p.dataKey === 'cumulative')?.value ?? 0
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg space-y-1">
      <p className="font-semibold text-foreground">{label}</p>
      <p className={net >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}>
        Monat: {formatEur(net)}
      </p>
      <p className="text-muted-foreground">Kumulativ: {formatEur(cum)}</p>
    </div>
  )
}

export function MonthlyChart({ data }: { data: MonthlyRow[] }) {
  if (data.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
        Keine Daten vorhanden
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v) => (v >= 0 ? '+' : '') + v.toLocaleString('de-DE', { maximumFractionDigits: 0 })}
          width={64}
        />
        <Tooltip content={<CustomTooltip />} />
        <ReferenceLine y={0} stroke="hsl(var(--border))" />
        <Bar dataKey="net" radius={[3, 3, 0, 0]}>
          {data.map((entry, index) => (
            <Cell key={index} fill={entry.net >= 0 ? '#22c55e' : '#ef4444'} />
          ))}
        </Bar>
        <Line
          dataKey="cumulative"
          type="monotone"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}
