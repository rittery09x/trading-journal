'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, LogIn } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router   = useRouter()
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState<string | null>(null)
  const [loading,  setLoading]  = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const supabase = createBrowserClient()
      const { error: authError } = await supabase.auth.signInWithPassword({
        email:    email.trim(),
        password,
      })

      if (authError) {
        setError(authError.message === 'Invalid login credentials'
          ? 'Ungültige E-Mail-Adresse oder falsches Passwort.'
          : authError.message,
        )
        return
      }

      // Hard-navigate so the middleware re-reads the new session cookie
      router.push('/')
      router.refresh()
    } catch {
      setError('Ein unbekannter Fehler ist aufgetreten.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full max-w-sm">
      {/* Logo / title */}
      <div className="flex flex-col items-center gap-3 mb-8">
        <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center text-primary-foreground font-bold text-lg">
          TJ
        </div>
        <div className="text-center">
          <h1 className="text-xl font-semibold text-foreground">Trading Journal</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Bitte melde dich an</p>
        </div>
      </div>

      {/* Form card */}
      <form
        onSubmit={handleSubmit}
        className="rounded-xl border border-border bg-card p-6 space-y-4 shadow-lg"
      >
        <div className="space-y-1.5">
          <label htmlFor="email" className="block text-sm font-medium text-foreground">
            E-Mail
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-colors"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="password" className="block text-sm font-medium text-foreground">
            Passwort
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-colors"
          />
        </div>

        {error && (
          <p className="text-sm text-loss rounded-md bg-loss/10 border border-loss/20 px-3 py-2">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors mt-2"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Anmelden…
            </>
          ) : (
            <>
              <LogIn className="h-4 w-4" />
              Anmelden
            </>
          )}
        </button>
      </form>
    </div>
  )
}
