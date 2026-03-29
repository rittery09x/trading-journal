'use client'

import { useEffect, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import { cn } from '@/lib/utils'
import type { ChartPoint } from '@/lib/types'

type Range = '1W' | '1M' | '3M' | '1Y' | 'Alle'
const RANGES: Range[] = ['1W', '1M', '3M', '1Y', 'Alle']

function sliceByRange(data: ChartPoint[], range: Range): ChartPoint[] {
  if (range === 'Alle' || !data.length) return data
  const days: Record<string, number> = { '1W': 7, '1M': 30, '3M': 90, '1Y': 365 }
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days[range])
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  return data.filter((p) => p.time >= cutoffStr)
}

export function PnlChart({ data }: { data: ChartPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef = useRef<any>(null)
  const { resolvedTheme } = useTheme()
  const [range, setRange] = useState<Range>('3M')

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let chart: any = null
    let observer: ResizeObserver | null = null

    async function init() {
      if (!containerRef.current) return

      // Dynamic import — avoids SSR crash (lightweight-charts needs window)
      const { createChart, ColorType } = await import('lightweight-charts')

      const isDark = resolvedTheme !== 'light'
      const textColor  = isDark ? '#64748b' : '#94a3b8'
      const gridColor  = isDark ? '#1e2a3a' : '#e2e8f0'
      const crossColor = isDark ? '#475569' : '#cbd5e1'
      const labelBg    = isDark ? '#1e293b' : '#f1f5f9'

      const filtered = sliceByRange(data, range)
      const isUp =
        filtered.length >= 2 &&
        filtered[filtered.length - 1].value >= filtered[0].value

      const lineColor   = isUp ? '#22c55e' : '#ef4444'
      const topColor    = isUp ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)'
      const bottomColor = 'rgba(0,0,0,0)'

      chart = createChart(containerRef.current!, {
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor,
        },
        grid: {
          vertLines: { color: gridColor },
          horzLines: { color: gridColor },
        },
        crosshair: {
          vertLine: { color: crossColor, labelBackgroundColor: labelBg },
          horzLine: { color: crossColor, labelBackgroundColor: labelBg },
        },
        timeScale: {
          borderColor: gridColor,
          fixLeftEdge: true,
          fixRightEdge: true,
          timeVisible: false,
        },
        rightPriceScale: { borderColor: gridColor },
        handleScroll: false,
        handleScale: false,
        width: containerRef.current!.clientWidth,
        height: 220,
      })

      const area = chart.addAreaSeries({
        lineColor,
        topColor,
        bottomColor,
        lineWidth: 2,
        priceFormat: { type: 'price', precision: 0, minMove: 1 },
      })

      if (filtered.length) {
        area.setData(filtered)
        chart.timeScale().fitContent()
      }

      chartRef.current = chart

      observer = new ResizeObserver(() => {
        chart?.applyOptions({
          width: containerRef.current?.clientWidth ?? 600,
        })
      })
      observer.observe(containerRef.current!)
    }

    init()

    return () => {
      observer?.disconnect()
      chart?.remove()
      chartRef.current = null
    }
  }, [data, range, resolvedTheme])

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-medium text-foreground">Konto-Entwicklung</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Net Liquidation USD</p>
        </div>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={cn(
                'px-2 py-1 text-xs rounded transition-colors',
                r === range
                  ? 'bg-accent text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {data.length === 0 ? (
        <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground">
          Noch keine Konto-Snapshots vorhanden
        </div>
      ) : (
        <div ref={containerRef} className="w-full" />
      )}
    </div>
  )
}
