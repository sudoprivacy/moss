'use client'

import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/lib/hooks/use-auth'
import { AppSidebar } from '@/components/app-sidebar'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { Loader2 } from 'lucide-react'

export function DashboardShell() {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return (
    <SidebarProvider className="h-svh min-h-0 overflow-hidden bg-background">
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden bg-background">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  )
}
