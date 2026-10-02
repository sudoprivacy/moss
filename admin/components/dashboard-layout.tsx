'use client'

import type { ReactNode } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type Theme } from '@/components/theme-provider'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

interface DashboardLayoutProps {
  children: ReactNode
  title: string
  description?: ReactNode
  /** Actions that sit beside the persistent theme switcher. */
  headerActions?: ReactNode
  /** Extends the scrollable content region without imposing a global max width. */
  contentClassName?: string
  /** A persistent bottom region for page-level actions, such as a save bar. */
  footer?: ReactNode
  footerClassName?: string
}

const THEME_OPTIONS: { value: Theme; icon: typeof Sun; label: string }[] = [
  { value: 'light', icon: Sun, label: '浅色' },
  { value: 'dark', icon: Moon, label: '深色' },
  { value: 'system', icon: Monitor, label: '跟随系统' },
]

function ThemeSwitch() {
  const { theme, setTheme } = useTheme()
  return (
    <div
      className="flex items-center rounded-md border border-border bg-background p-0.5"
      aria-label="主题设置"
      role="group"
    >
      {THEME_OPTIONS.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
          className={cn(
            'flex size-7 items-center justify-center rounded-[5px] transition-colors',
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

export function DashboardLayout({
  children,
  title,
  description,
  headerActions,
  contentClassName,
  footer,
  footerClassName,
}: DashboardLayoutProps) {
  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b bg-background px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-start gap-2">
          <SidebarTrigger aria-label="展开或收起导航" title="展开或收起导航（⌘ / Ctrl + B）" className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <h1 className="text-xl leading-7 font-semibold tracking-[-0.02em]">{title}</h1>
            {description ? (
              <div className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</div>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {headerActions ? <div className="flex items-center gap-2">{headerActions}</div> : null}
          {headerActions ? <div className="h-4 w-px bg-border" aria-hidden="true" /> : null}
          <ThemeSwitch />
        </div>
      </header>

      <div
        data-slot="dashboard-content"
        className={cn(
          'min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-6 sm:py-6 lg:px-8',
          contentClassName,
        )}
      >
        {children}
      </div>

      {footer ? (
        <footer className={cn('shrink-0 border-t bg-background px-4 py-3 sm:px-6 lg:px-8', footerClassName)}>
          {footer}
        </footer>
      ) : null}
    </section>
  )
}
