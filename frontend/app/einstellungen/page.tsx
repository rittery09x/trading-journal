'use client'

import { useState, useEffect } from 'react'
import { Save, Plug, Loader2, CheckCircle, AlertCircle, RefreshCw, Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Settings {
  flex_token_masked:      string
  flex_token_set:         boolean
  flex_query_id_activity: string
  flex_query_id_confirms: string
  auto_import_enabled:    boolean
  last_import_at:         string | null
  last_import_status:     string | null
  last_import_message:    string | null
}

type FeedbackState = { ok: boolean; message: string } | null

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return null
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
      status === 'success'
        ? 'bg-green-500/10 text-profit'
        : 'bg-red-500/10 text-loss',
    )}>
      {status === 'success'
        ? <CheckCircle className="h-3 w-3" />
        : <AlertCircle className="h-3 w-3" />}
      {status === 'success' ? 'Erfolgreich' : 'Fehler'}
    </span>
  )
}

export default function EinstellungenPage() {
  const [settings, setSettings]       = useState<Settings | null>(null)
  const [loadError, setLoadError]     = useState<string | null>(null)

  // Form state
  const [token, setToken]             = useState('')
  const [queryAF, setQueryAF]         = useState('')
  const [queryTCF, setQueryTCF]       = useState('')
  const [autoImport, setAutoImport]   = useState(false)
  const [showToken, setShowToken]     = useState(false)

  // Action states
  const [saving, setSaving]           = useState(false)
  const [testing, setTesting]         = useState(false)
  const [saveFeedback, setSaveFeedback]   = useState<FeedbackState>(null)
  const [testFeedback, setTestFeedback]   = useState<FeedbackState>(null)

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((data: Settings) => {
        setSettings(data)
        setQueryAF(data.flex_query_id_activity)
        setQueryTCF(data.flex_query_id_confirms)
        setAutoImport(data.auto_import_enabled)
      })
      .catch(e => setLoadError(String(e)))
  }, [])

  async function handleSave() {
    setSaving(true)
    setSaveFeedback(null)
    try {
      const body: Record<string, unknown> = {
        flex_query_id_activity: queryAF,
        flex_query_id_confirms: queryTCF,
        auto_import_enabled:    autoImport,
      }
      if (token.trim()) body.flex_token = token.trim()

      const res  = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json()
      if (res.ok) {
        setSaveFeedback({ ok: true, message: 'Einstellungen gespeichert.' })
        setToken('')
        // Refresh last-import info
        const fresh = await fetch('/api/settings').then(r => r.json())
        setSettings(fresh)
      } else {
        setSaveFeedback({ ok: false, message: json.error ?? `HTTP ${res.status}` })
      }
    } catch (e) {
      setSaveFeedback({ ok: false, message: String(e) })
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    setTestFeedback(null)
    try {
      const res  = await fetch('/api/settings/test', { method: 'POST' })
      const json = await res.json()
      setTestFeedback({ ok: json.ok, message: json.message })
    } catch (e) {
      setTestFeedback({ ok: false, message: String(e) })
    } finally {
      setTesting(false)
    }
  }

  function formatDate(iso: string | null) {
    if (!iso) return '—'
    return new Date(iso).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  if (loadError) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <p className="text-sm text-loss">Fehler beim Laden: {loadError}</p>
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="p-6 max-w-2xl mx-auto flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Lade Einstellungen…</span>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Einstellungen</h1>
        <p className="text-sm text-muted-foreground mt-0.5">IBKR Verbindung und automatischer Import</p>
      </div>

      {/* ── IBKR Credentials ─────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card p-6 space-y-5">
        <h2 className="text-sm font-semibold text-foreground">IBKR Flex Query</h2>

        {/* Token */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Aktiver Prüfcode (Flex-Query-Token)
          </label>
          <div className="relative">
            <input
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder={settings.flex_token_set ? settings.flex_token_masked : 'Token eingeben…'}
              className="w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors"
            />
            <button
              type="button"
              onClick={() => setShowToken(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {settings.flex_token_set && (
            <p className="text-xs text-muted-foreground mt-1">
              Token ist gesetzt. Nur ausfüllen wenn du ihn ändern möchtest.
            </p>
          )}
        </div>

        {/* Query AF */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Flex-Query-ID für Kontoumsätze / Trades
          </label>
          <input
            type="text"
            value={queryAF}
            onChange={e => setQueryAF(e.target.value)}
            placeholder="z. B. 123456"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors"
          />
        </div>

        {/* Query TCF */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Flex-Query-ID für Handelsbestätigungen
          </label>
          <input
            type="text"
            value={queryTCF}
            onChange={e => setQueryTCF(e.target.value)}
            placeholder="z. B. 789012"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors"
          />
        </div>

        {/* Auto-import toggle */}
        <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 px-4 py-3">
          <div>
            <p className="text-sm font-medium text-foreground">Automatischen Import erlauben</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Ermöglicht externen Cron-Jobs den Import via <code className="font-mono bg-muted px-1 rounded">/api/cron/import</code>
            </p>
          </div>
          <button
            role="switch"
            aria-checked={autoImport}
            onClick={() => setAutoImport(v => !v)}
            className={cn(
              'relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none',
              autoImport ? 'bg-primary' : 'bg-muted',
            )}
          >
            <span className={cn(
              'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
              autoImport ? 'translate-x-5' : 'translate-x-0',
            )} />
          </button>
        </div>

        {/* Save + Test buttons */}
        <div className="flex gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Speichern
          </button>
          <button
            onClick={handleTest}
            disabled={testing || !settings.flex_token_set}
            className="flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title={!settings.flex_token_set ? 'Erst Token speichern' : undefined}
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
            Verbindung testen
          </button>
        </div>

        {/* Save feedback */}
        {saveFeedback && (
          <div className={cn(
            'flex items-center gap-2 rounded-md px-3 py-2 text-sm',
            saveFeedback.ok ? 'bg-green-500/10 text-profit' : 'bg-red-500/10 text-loss',
          )}>
            {saveFeedback.ok
              ? <CheckCircle className="h-4 w-4 flex-shrink-0" />
              : <AlertCircle className="h-4 w-4 flex-shrink-0" />}
            {saveFeedback.message}
          </div>
        )}

        {/* Test feedback */}
        {testFeedback && (
          <div className={cn(
            'flex items-center gap-2 rounded-md px-3 py-2 text-sm',
            testFeedback.ok ? 'bg-green-500/10 text-profit' : 'bg-red-500/10 text-loss',
          )}>
            {testFeedback.ok
              ? <CheckCircle className="h-4 w-4 flex-shrink-0" />
              : <AlertCircle className="h-4 w-4 flex-shrink-0" />}
            {testFeedback.message}
          </div>
        )}
      </div>

      {/* ── Last import status ────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Letzter Import</h2>
          <button
            onClick={() => fetch('/api/settings').then(r => r.json()).then(setSettings)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Aktualisieren"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Zeitpunkt</span>
            <span className="text-foreground">{formatDate(settings.last_import_at)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Status</span>
            <StatusBadge status={settings.last_import_status} />
          </div>
          {settings.last_import_message && (
            <div className="flex items-start justify-between gap-4">
              <span className="text-muted-foreground flex-shrink-0">Details</span>
              <span className="text-foreground text-right text-xs">{settings.last_import_message}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Cron-Job Hinweis ──────────────────────────────────────────────── */}
      {autoImport && (
        <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-2 text-xs text-muted-foreground">
          <p className="font-medium text-foreground text-sm">Cron-Job einrichten</p>
          <p>Richte auf <a href="https://cron-job.org" target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-2">cron-job.org</a> (kostenlos) einen Job ein:</p>
          <div className="font-mono bg-muted rounded px-3 py-2 text-foreground break-all">
            GET https://trading.cari-digital.de/api/cron/import?secret=<span className="opacity-50">[IMPORT_SECRET]</span>
          </div>
          <p>Empfohlen: alle 4–6 Stunden. Das Secret findest du in deinen Coolify-Umgebungsvariablen unter <code className="bg-muted px-1 rounded">IMPORT_SECRET</code>.</p>
        </div>
      )}
    </div>
  )
}
