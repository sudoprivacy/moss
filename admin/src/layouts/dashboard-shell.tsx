'use client'

import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/lib/hooks/use-auth'
import { AppSidebar } from '@/components/app-sidebar'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { Loader2, TriangleAlert } from 'lucide-react'

export function DashboardShell() {
  const { authError, isAuthenticated, isLoading, retryAuth, activeOrgId } = useAuth()

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

  if (authError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md space-y-4 text-center" role="alert">
          <TriangleAlert className="mx-auto size-9 text-muted-foreground" aria-hidden="true" />
          <div>
            <h1 className="text-lg font-semibold">暂时无法验证登录状态</h1>
            <p className="mt-2 text-sm text-muted-foreground">{authError}</p>
          </div>
          <Button type="button" onClick={() => void retryAuth()}>重新验证</Button>
        </div>
      </div>
    )
  }

  return (
    <SidebarProvider className="h-svh min-h-0 overflow-hidden bg-background">
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden bg-background">
        <Outlet key={activeOrgId ?? 'no-organization'} />
      </SidebarInset>
    </SidebarProvider>
  )
}
