'use client'

import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type Theme } from '@/components/theme-provider'
import { cn } from '@/lib/utils'

interface DashboardLayoutProps {
  children: React.ReactNode
  title: string
  description?: string
}

const THEME_OPTIONS: { value: Theme; icon: typeof Sun; label: string }[] = [
  { value: 'light', icon: Sun, label: '浅色' },
  { value: 'dark', icon: Moon, label: '深色' },
  { value: 'system', icon: Monitor, label: '跟随系统' },
]

function ThemeSwitch() {
  const { theme, setTheme } = useTheme()
  return (
    <div className="flex items-center gap-0.5 rounded-md border p-0.5">
      {THEME_OPTIONS.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
          className={cn(
            'rounded p-1.5 transition-colors',
            theme === value
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  )
}

export function DashboardLayout({ children, title, description }: DashboardLayoutProps) {
  return (
    <div className="flex flex-col h-full">
      <header className="border-b px-6 py-4 shrink-0 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-medium">{title}</h1>
          {description ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        <ThemeSwitch />
      </header>
      <main className="flex-1 overflow-auto p-6">{children}</main>
    </div>
  )
}
