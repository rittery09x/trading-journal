'use client'

import { useState, useRef, useCallback, DragEvent, ChangeEvent } from 'react'
import { Upload, CheckCircle, AlertCircle, Loader2, RefreshCw, FileText, X, CloudDownload } from 'lucide-react'
import { cn } from '@/lib/utils'

type Tab = 'file' | 'ibkr'

interface ImportResult {
  ok: boolean
  message?: string
  imported?: { executions: number; fx_transactions: number; cash_transactions: number; account_snapshots: number }
  grouped?:  { campaigns: number; option_legs: number; rolls: number }
}

// ── File drop zone ────────────────────────────────────────────────────────────

function FileDropZone({
  file, onChange, label,
}: {
  file: File | null
  onChange: (f: File | null) => void
  label: string
}) {
  const inputRef  = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDrag(false)
    const f = e.dataTransfer.files[0]
    if (f) onChange(f)
  }, [onChange])

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null
    onChange(f)
  }

  return (
    <div>
      <p className="text-sm font-medium text-foreground mb-1.5">{label}</p>
      {file ? (
        <div className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-4 py-3">
          <FileText className="h-5 w-5 text-muted-foreground flex-shrink-0" />
          <span className="text-sm text-foreground flex-1 min-w-0 truncate">{file.name}</span>
          <span className="text-xs text-muted-foreground flex-shrink-0">
            {Math.round(file.size / 1024)} KB
          </span>
          <button
            onClick={() => onChange(null)}
            className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={handleDrop}
          className={cn(
            'flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-8 cursor-pointer transition-colors select-none',
            drag
              ? 'border-primary bg-primary/5'
              : 'border-border hover:border-primary/50 hover:bg-muted/20',
          )}
        >
          <Upload className={cn('h-7 w-7', drag ? 'text-primary' : 'text-muted-foreground')} />
          <p className="text-sm text-muted-foreground text-center">
            <span className="text-foreground font-medium">Datei auswählen</span>
            {' '}oder hier ablegen
          </p>
          <p className="text-xs text-muted-foreground">.xml</p>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".xml,text/xml,application/xml"
        className="hidden"
        onChange={handleChange}
      />
    </div>
  )
}

// ── Result banner ─────────────────────────────────────────────────────────────

function ResultBanner({ result, onClose }: { result: ImportResult; onClose: () => void }) {
  return (
    <div className={cn(
      'rounded-lg border p-5',
      result.ok ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5',
    )}>
      <div className="flex items-start gap-3">
        {result.ok
          ? <CheckCircle className="h-5 w-5 text-profit flex-shrink-0 mt-0.5" />
          : <AlertCircle className="h-5 w-5 text-loss flex-shrink-0 mt-0.5" />
        }
        <div className="space-y-2 flex-1 min-w-0">
          <p className={cn('text-sm font-medium', result.ok ? 'text-profit' : 'text-loss')}>
            {result.ok ? 'Import erfolgreich' : 'Import fehlgeschlagen'}
          </p>
          {result.ok && result.imported && result.grouped ? (
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <span>Executions: <span className="text-foreground font-medium">{result.imported.executions}</span></span>
              <span>Campaigns: <span className="text-foreground font-medium">{result.grouped.campaigns}</span></span>
              <span>Option Legs: <span className="text-foreground font-medium">{result.grouped.option_legs}</span></span>
              <span>Rolls erkannt: <span className="text-foreground font-medium">{result.grouped.rolls}</span></span>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground break-words">{result.message}</p>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ImportPage() {
  const [tab, setTab]           = useState<Tab>('file')
  const [loading, setLoading]   = useState(false)
  const [result, setResult]     = useState<ImportResult | null>(null)

  // File upload state
  const [activityFile, setActivityFile] = useState<File | null>(null)
  const [confirmsFile, setConfirmsFile] = useState<File | null>(null)

  // IBKR pull state
  const [secret, setSecret] = useState('')

  // ── File import handler ─────────────────────────────────────────────────────
  async function handleFileImport() {
    if (!activityFile) return
    setLoading(true)
    setResult(null)
    try {
      const form = new FormData()
      form.append('activity_xml', activityFile)
      if (confirmsFile) form.append('confirms_xml', confirmsFile)

      const res  = await fetch('/api/import/xml', { method: 'POST', body: form })
      const json = await res.json()
      setResult(res.ok ? { ok: true, ...json } : { ok: false, message: json.error ?? `HTTP ${res.status}` })
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Netzwerkfehler' })
    } finally {
      setLoading(false)
    }
  }

  // ── IBKR pull handler ───────────────────────────────────────────────────────
  async function handleIbkrImport() {
    if (!secret.trim()) return
    setLoading(true)
    setResult(null)
    try {
      const res  = await fetch('/api/import/flex', {
        method:  'POST',
        headers: { Authorization: `Bearer ${secret.trim()}` },
      })
      const json = await res.json()
      if (res.ok) {
        setResult({
          ok: true,
          imported: json.imported,
          grouped:  json.grouped,
        })
      } else {
        setResult({ ok: false, message: json.error ?? `HTTP ${res.status}` })
      }
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Netzwerkfehler' })
    } finally {
      setLoading(false)
    }
  }

  const tabs: { id: Tab; label: string; icon: typeof Upload }[] = [
    { id: 'file', label: 'XML hochladen',     icon: Upload        },
    { id: 'ibkr', label: 'Von IBKR abrufen',  icon: CloudDownload },
  ]

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Import</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          IBKR Flex Query Daten in das Journal importieren
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => { setTab(id); setResult(null) }}
            className={cn(
              'flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
              tab === id
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {/* ── File upload tab ─────────────────────────────────────────────────── */}
      {tab === 'file' && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-5">
          <FileDropZone
            file={activityFile}
            onChange={f => { setActivityFile(f); setResult(null) }}
            label="Activity Feed (AF) — erforderlich"
          />
          <FileDropZone
            file={confirmsFile}
            onChange={f => { setConfirmsFile(f); setResult(null) }}
            label="Trade Confirms (TCF) — optional"
          />

          <div className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">Wo finde ich die XML-Datei?</p>
            <p>IBKR → Reports → Flex Queries → deine Query → Run → XML herunterladen</p>
            <p>Tipp: Zeitraum auf &quot;Custom Date Range&quot; setzen um historische Daten zu importieren.</p>
          </div>

          <button
            onClick={handleFileImport}
            disabled={loading || !activityFile}
            className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <><Loader2 className="h-4 w-4 animate-spin" />Import läuft…</>
            ) : (
              <><Upload className="h-4 w-4" />Importieren</>
            )}
          </button>
        </div>
      )}

      {/* ── IBKR pull tab ───────────────────────────────────────────────────── */}
      {tab === 'ibkr' && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Import Secret
            </label>
            <input
              type="password"
              value={secret}
              onChange={e => setSecret(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !loading && handleIbkrImport()}
              placeholder="Dein IMPORT_SECRET aus .env.local"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-colors"
            />
          </div>

          <div className="rounded-md border border-border bg-muted/20 p-4 space-y-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground text-sm">Was passiert?</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Activity Feed + Trade Confirms werden direkt von IBKR abgerufen</li>
              <li>Beide Feeds werden zusammengeführt und geparst</li>
              <li>Executions, Campaigns und Rolls werden in Supabase gespeichert</li>
            </ol>
            <p className="pt-1">Dauer: ca. 15–60 Sekunden (IBKR-Serverzeit)</p>
          </div>

          <button
            onClick={handleIbkrImport}
            disabled={loading || !secret.trim()}
            className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <><Loader2 className="h-4 w-4 animate-spin" />Import läuft…</>
            ) : (
              <><CloudDownload className="h-4 w-4" />Von IBKR importieren</>
            )}
          </button>
        </div>
      )}

      {/* Result */}
      {result && <ResultBanner result={result} onClose={() => setResult(null)} />}
    </div>
  )
}
