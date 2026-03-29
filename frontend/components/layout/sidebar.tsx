'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { BarChart3, Layers, Calendar, TrendingUp, BarChart2, Upload, LogOut } from 'lucide-react'
import { ThemeToggle } from '@/components/theme-toggle'
import { createBrowserClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

const NAV = [
  { href: '/',             label: 'Dashboard',    icon: BarChart3  },
  { href: '/positionen',   label: 'Positionen',   icon: Layers     },
  { href: '/kalender',     label: 'Kalender',     icon: Calendar   },
  { href: '/cashflow',     label: 'Cashflow',     icon: TrendingUp },
  { href: '/statistiken',  label: 'Statistiken',  icon: BarChart2  },
  { href: '/import',       label: 'Import',       icon: Upload     },
] as const

export function Sidebar() {
  const pathname = usePathname()
  const router   = useRouter()

  async function handleSignOut() {
    const supabase = createBrowserClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <aside className="fixed inset-y-0 left-0 z-40 w-56 flex flex-col border-r border-border bg-card">
      {/* Logo */}
      <div className="flex h-14 items-center gap-3 px-4 border-b border-border flex-shrink-0">
        <div className="w-8 h-8 rounded bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm flex-shrink-0">
          TJ
        </div>
        <span className="font-semibold text-sm text-foreground truncate">Trading Journal</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                active
                  ? 'bg-accent text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
              )}
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              {label}
            </Link>
          )
        })}
      </nav>

      {/* Footer: theme toggle + logout */}
      <div className="p-3 border-t border-border space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Erscheinungsbild</span>
          <ThemeToggle />
        </div>
        <button
          onClick={handleSignOut}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
        >
          <LogOut className="h-4 w-4 flex-shrink-0" />
          Abmelden
        </button>
      </div>
    </aside>
  )
}
