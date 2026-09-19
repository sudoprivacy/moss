'use client'

import { Toaster } from '@/components/ui/sonner'
import { ThemeProvider } from '@/components/theme-provider'
import { AuthProvider } from '@/lib/hooks/use-auth'
import { UnsavedChangesProvider } from '@/lib/hooks/use-unsaved-changes'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <AuthProvider>
        <UnsavedChangesProvider>
          {children}
        </UnsavedChangesProvider>
        <Toaster position="top-right" richColors />
      </AuthProvider>
    </ThemeProvider>
  )
}
