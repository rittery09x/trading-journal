'use client'

import { useState } from 'react'
import { Upload, CheckCircle, AlertCircle, Loader2, RefreshCw } from 'lucide-react'

interface ImportResult {
  ok: boolean
  message?: string
  campaigns_upserted?: number
  legs_upserted?: number
  executions_upserted?: number
  rolls_detected?: number
}

export default function ImportPage() {
  const [secret, setSecret]     = useState('')
  const [loading, setLoading]   = useState(false)
  const [result, setResult]     = useState<ImportResult | null>(null)

  async function handleImport() {
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
        setResult({ ok: true, ...json })
      } else {
        setResult({ ok: false, message: json.error ?? `HTTP ${res.status}` })
      }
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Netzwerkfehler' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Import</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          IBKR Flex Query Daten importieren (Activity Feed + Trade Confirms)
        </p>
      </div>

      {/* Import form */}
      <div className="rounded-lg border border-border bg-card p-6 space-y-5">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Import Secret
          </label>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !loading && handleImport()}
            placeholder="Dein IMPORT_SECRET aus .env.local"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-colors"
          />
          <p className="text-xs text-muted-foreground mt-1.5">
            Entspricht dem Wert von <code className="font-mono bg-muted px-1 py-0.5 rounded">IMPORT_SECRET</code> in deiner
            {' '}<code className="font-mono bg-muted px-1 py-0.5 rounded">.env.local</code>.
          </p>
        </div>

        <div className="rounded-md border border-border bg-muted/20 p-4 space-y-2 text-xs text-muted-foreground">
          <p className="font-medium text-foreground text-sm">Was passiert beim Import?</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>Activity Feed (AF) und Trade Confirms (TCF) werden von IBKR abgerufen</li>
            <li>Beide Feeds werden per tradeID zusammengeführt</li>
            <li>Neue Executions werden in Supabase gespeichert</li>
            <li>Python-Grouping-Engine erkennt Rolls, Assignments und Campaigns</li>
            <li>Campaigns und Option-Legs werden idempotent aktualisiert</li>
          </ol>
          <p className="pt-1">
            Dauer: ca. 15–60 Sekunden (abhängig von IBKR-Serverzeit)
          </p>
        </div>

        <button
          onClick={handleImport}
          disabled={loading || !secret.trim()}
          className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Import läuft…
            </>
          ) : (
            <>
              <Upload className="h-4 w-4" />
              Import starten
            </>
          )}
        </button>
      </div>

      {/* Result */}
      {result && (
        <div className={`rounded-lg border p-5 ${
          result.ok
            ? 'border-green-500/30 bg-green-500/5'
            : 'border-red-500/30 bg-red-500/5'
        }`}>
          <div className="flex items-start gap-3">
            {result.ok ? (
              <CheckCircle className="h-5 w-5 text-profit flex-shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="h-5 w-5 text-loss flex-shrink-0 mt-0.5" />
            )}
            <div className="space-y-2 flex-1 min-w-0">
              <p className={`text-sm font-medium ${result.ok ? 'text-profit' : 'text-loss'}`}>
                {result.ok ? 'Import erfolgreich' : 'Import fehlgeschlagen'}
              </p>
              {result.ok ? (
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
                  {result.campaigns_upserted !== undefined && (
                    <span>Campaigns: <span className="text-foreground font-medium">{result.campaigns_upserted}</span></span>
                  )}
                  {result.legs_upserted !== undefined && (
                    <span>Option Legs: <span className="text-foreground font-medium">{result.legs_upserted}</span></span>
                  )}
                  {result.executions_upserted !== undefined && (
                    <span>Executions: <span className="text-foreground font-medium">{result.executions_upserted}</span></span>
                  )}
                  {result.rolls_detected !== undefined && (
                    <span>Rolls erkannt: <span className="text-foreground font-medium">{result.rolls_detected}</span></span>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground break-words">{result.message}</p>
              )}
            </div>
            <button
              onClick={() => setResult(null)}
              className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              aria-label="Schließen"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Info */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <h2 className="text-sm font-medium text-foreground">Benötigte Umgebungsvariablen</h2>
        <div className="space-y-2 font-mono text-xs">
          {[
            ['FLEX_QUERY_TOKEN',          'Flex Web Service Token (IBKR Account Management)'],
            ['FLEX_QUERY_ID_ACTIVITY',   'Query ID des Activity Flex Statements'],
            ['FLEX_QUERY_ID_CONFIRMS',   'Query ID des Trade Confirms Flex Statements'],
            ['IMPORT_SECRET',            'Beliebiges sicheres Passwort für diesen Button'],
          ].map(([key, desc]) => (
            <div key={key} className="flex items-start gap-3">
              <code className="bg-muted px-1.5 py-0.5 rounded text-foreground whitespace-nowrap flex-shrink-0">{key}</code>
              <span className="text-muted-foreground font-sans text-xs leading-relaxed">{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
