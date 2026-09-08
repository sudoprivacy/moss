'use client'

import { useEffect, useState } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { useLocation } from 'react-router-dom'
import { useAuth } from '@/lib/hooks/use-auth'
import { AppSidebar } from '@/components/app-sidebar'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Loader2, Menu } from 'lucide-react'

export function DashboardShell() {
  const { isAuthenticated, isLoading } = useAuth()
  const { pathname } = useLocation()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  useEffect(() => { setMobileMenuOpen(false) }, [pathname])

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
      <AppSidebar className="hidden md:flex" />
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex h-12 shrink-0 items-center border-b px-3 md:hidden">
          <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="打开导航菜单">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 gap-0 p-0 [&>button]:right-3 [&>button]:top-4">
              <SheetTitle className="sr-only">导航菜单</SheetTitle>
              <AppSidebar className="w-full border-r-0" />
            </SheetContent>
          </Sheet>
          <span className="ml-2 text-sm font-semibold">moss 中控平台</span>
        </div>
        <Outlet />
      </div>
    </div>
  )
}
