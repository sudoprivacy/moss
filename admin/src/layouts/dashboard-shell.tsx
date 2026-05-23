'use client'

import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/lib/hooks/use-auth'
import { AppSidebar } from '@/components/app-sidebar'
import { Loader2 } from 'lucide-react'

export function DashboardShell() {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <AppSidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Outlet />
      </div>
    </div>
  )
}
