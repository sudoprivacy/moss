'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

/**
 * The dark palette already exists in globals.css (`.dark { … }`) and the Tailwind
 * variant is wired (`@custom-variant dark`), but nothing ever put the class on
 * the document — so every token resolved to the light branch. This supplies the
 * missing half: one class on <html>, remembered per browser.
 */

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'moss-admin-theme'

interface ThemeContextValue {
  theme: Theme
  resolved: 'light' | 'dark'
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function readStored(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
  } catch {
    // Private windows and blocked site data throw on access; the default still works.
    return 'system'
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored)
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const resolved: 'light' | 'dark' = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark')
  }, [resolved])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Remembering the choice is a convenience; failing to store it must not
      // break the switch for this session.
    }
  }, [])

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}
