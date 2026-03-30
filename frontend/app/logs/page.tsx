export const dynamic = 'force-dynamic'

import { createServiceClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { cn } from '@/lib/utils'

// ── Types ─────────────────────────────────────────────────────────────────────

type LogLevel  = 'info' | 'warning' | 'error'
type LogSource = 'ibkr' | 'parser' | 'supabase' | 'system'

interface ImportLog {
  id:            string
  created_at:    string
  level:         LogLevel
  source:        LogSource
  message:       string
  details:       Record<string, unknown> | null
  import_run_id: string | null
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchLogs(level?: string, source?: string): Promise<ImportLog[]> {
  try {
    const supabase = createServiceClient()
    let q = supabase
      .from('import_logs')
      .select('id, created_at, level, source, message, details, import_run_id')
      .order('created_at', { ascending: false })
      .limit(300)

    if (level  && level  !== 'all') q = q.eq('level',  level)
    if (source && source !== 'all') q = q.eq('source', source)

    const { data } = await q
    return (data ?? []) as ImportLog[]
  } catch {
    return []
  }
}

// ── Style maps ────────────────────────────────────────────────────────────────

const LEVEL_STYLES: Record<LogLevel, string> = {
  info:    'bg-blue-500/15 text-blue-400   border-blue-500/25',
  warning: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/25',
  error:   'bg-red-500/15   text-red-400   border-red-500/25',
}

const SOURCE_STYLES: Record<LogSource, string> = {
  ibkr:     'bg-purple-500/15 text-purple-400',
  parser:   'bg-orange-500/15 text-orange-400',
  supabase: 'bg-green-500/15  text-green-400',
  system:   'bg-gray-500/15   text-gray-400',
}

const LEVEL_DOT: Record<LogLevel, string> = {
  info:    'bg-blue-400',
  warning: 'bg-yellow-400',
  error:   'bg-red-400',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTs(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('de-DE', {
    day:    '2-digit',
    month:  '2-digit',
    year:   'numeric',
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

// ── Page ──────────────────────────────────────────────────────────────────────

const LEVELS  = ['all', 'info', 'warning', 'error']  as const
const SOURCES = ['all', 'ibkr', 'parser', 'supabase', 'system'] as const

export default async function LogsPage({
  searchParams,
}: {
  searchParams: { level?: string; source?: string }
}) {
  const activeLevel  = searchParams.level  ?? 'all'
  const activeSource = searchParams.source ?? 'all'

  const logs = await fetchLogs(activeLevel, activeSource)

  // Collect distinct run IDs for the run-grouping indicator
  const runIds = Array.from(new Set(logs.map(l => l.import_run_id).filter(Boolean)))

  function filterHref(level: string, source: string) {
    const p = new URLSearchParams()
    if (level  !== 'all') p.set('level',  level)
    if (source !== 'all') p.set('source', source)
    const qs = p.toString()
    return `/logs${qs ? `?${qs}` : ''}`
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Import Logs</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Chronologisches Protokoll aller Import-Läufe und Fehler
        </p>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-4">
        {/* Level filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground mr-1">Status:</span>
          {LEVELS.map((l) => (
            <Link
              key={l}
              href={filterHref(l, activeSource)}
              className={cn(
                'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                activeLevel === l
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
              )}
            >
              {l === 'all' ? 'Alle' : l.charAt(0).toUpperCase() + l.slice(1)}
            </Link>
          ))}
        </div>

        {/* Source filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground mr-1">Quelle:</span>
          {SOURCES.map((s) => (
            <Link
              key={s}
              href={filterHref(activeLevel, s)}
              className={cn(
                'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                activeSource === s
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
              )}
            >
              {s === 'all' ? 'Alle' : s}
            </Link>
          ))}
        </div>

        <span className="ml-auto text-xs text-muted-foreground">
          {logs.length} Einträge · {runIds.length} Import-Läufe
        </span>
      </div>

      {/* Log list */}
      {logs.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-12 text-center">
          <p className="text-muted-foreground text-sm">Keine Log-Einträge vorhanden.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Starte einen Import unter{' '}
            <Link href="/import" className="text-primary hover:underline">
              /import
            </Link>{' '}
            um Logs zu erzeugen.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="divide-y divide-border/50">
            {logs.map((log, idx) => {
              // Show run separator when run_id changes
              const prevRunId = idx > 0 ? logs[idx - 1].import_run_id : undefined
              const showRunDivider = log.import_run_id && log.import_run_id !== prevRunId && idx > 0

              return (
                <div key={log.id}>
                  {showRunDivider && (
                    <div className="flex items-center gap-2 px-4 py-1.5 bg-muted/20">
                      <div className="h-px flex-1 bg-border/50" />
                      <span className="text-[10px] text-muted-foreground font-mono">
                        Run {log.import_run_id?.slice(0, 8)}…
                      </span>
                      <div className="h-px flex-1 bg-border/50" />
                    </div>
                  )}

                  <div className="flex items-start gap-3 px-4 py-3 hover:bg-accent/10 transition-colors">
                    {/* Level dot */}
                    <div className="flex-shrink-0 mt-1.5">
                      <span className={cn('block w-2 h-2 rounded-full', LEVEL_DOT[log.level])} />
                    </div>

                    {/* Timestamp */}
                    <div className="w-36 flex-shrink-0 text-xs text-muted-foreground tabular-nums pt-0.5">
                      {fmtTs(log.created_at)}
                    </div>

                    {/* Badges */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className={cn(
                        'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border',
                        LEVEL_STYLES[log.level],
                      )}>
                        {log.level}
                      </span>
                      <span className={cn(
                        'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium',
                        SOURCE_STYLES[log.source],
                      )}>
                        {log.source}
                      </span>
                    </div>

                    {/* Message + details */}
                    <div className="flex-1 min-w-0">
                      <p className={cn(
                        'text-sm',
                        log.level === 'error' ? 'text-red-400' : 'text-foreground',
                      )}>
                        {log.message}
                      </p>
                      {log.details && Object.keys(log.details).length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5">
                          {Object.entries(log.details).map(([k, v]) => (
                            <span key={k} className="text-[11px] text-muted-foreground font-mono">
                              <span className="text-muted-foreground/60">{k}:</span>{' '}
                              <span className="text-foreground/70">{String(v)}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Run ID (compact) */}
                    {log.import_run_id && (
                      <div className="flex-shrink-0 text-[10px] text-muted-foreground/50 font-mono pt-0.5 hidden lg:block">
                        {log.import_run_id.slice(0, 8)}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
