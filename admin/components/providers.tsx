'use client'

import { Toaster } from '@/components/ui/sonner'
import { AuthProvider } from '@/lib/hooks/use-auth'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      {children}
      <Toaster position="top-right" richColors />
    </AuthProvider>
  )
}
