'use client'

interface DashboardLayoutProps {
  children: React.ReactNode
  title: string
  description?: string
}

export function DashboardLayout({ children, title, description }: DashboardLayoutProps) {
  return (
    <div className="flex flex-col h-full">
      <header className="border-b px-6 py-4 shrink-0">
        <h1 className="text-lg font-medium">{title}</h1>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </header>
      <main className="flex-1 overflow-auto p-6">{children}</main>
    </div>
  )
}
