import type { ComponentProps, ReactNode } from 'react'
import { AlertCircle, Inbox, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export function ListToolbar({
  children,
  actions,
  className,
  ...props
}: ComponentProps<'div'> & { actions?: ReactNode }) {
  return (
    <div className={cn('flex min-w-0 flex-wrap items-start justify-between gap-3', className)} {...props}>
      <div className="flex min-w-0 flex-1 basis-72 flex-wrap items-center gap-2">{children}</div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function ListSummary({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-muted-foreground', className)} {...props} />
}

export function ListSurface({
  children,
  footer,
  className,
  ...props
}: ComponentProps<'section'> & { footer?: ReactNode }) {
  return (
    <section
      data-slot="list-surface"
      className={cn(
        'min-w-0 overflow-hidden rounded-lg border bg-card text-card-foreground',
        '[&_[data-slot=table-head]]:bg-muted/60 [&_[data-slot=table-head]]:px-4 [&_[data-slot=table-head]]:text-xs [&_[data-slot=table-head]]:text-muted-foreground',
        '[&_[data-slot=table-cell]]:px-4 [&_[data-slot=table-cell]]:py-3',
        className,
      )}
      {...props}
    >
      {children}
      {footer ? <div className="border-t px-4 py-3">{footer}</div> : null}
    </section>
  )
}

export function ListEmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string
  description: string
  icon?: ReactNode
  action?: ReactNode
}) {
  return (
    <Empty className="gap-4 rounded-none py-12 md:py-14">
      <EmptyHeader>
        <EmptyMedia variant="icon" aria-hidden="true">{icon ?? <Inbox />}</EmptyMedia>
        <EmptyTitle className="text-sm font-medium">{title}</EmptyTitle>
        <EmptyDescription className="text-[13px]">{description}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}

export function ListError({
  title,
  description,
  onRetry,
  retrying = false,
}: {
  title: string
  description: string
  onRetry: () => void
  retrying?: boolean
}) {
  return (
    <div role="alert" className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3">
      <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 break-words text-[13px] text-muted-foreground">{description}</p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
        <RefreshCw className={cn('size-3.5', retrying && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" />
        {retrying ? '正在重试' : '重新加载'}
      </Button>
    </div>
  )
}

export function ListSkeleton({ label = '正在加载列表', rows = 6 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-busy="true" className="min-w-0 overflow-hidden rounded-lg border">
      <span className="sr-only">{label}</span>
      <div className="h-10 border-b bg-muted/60" aria-hidden="true" />
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden="true" className="flex items-center gap-4 border-b px-4 py-4 last:border-b-0">
          <Skeleton className="h-8 w-8 shrink-0 rounded-md motion-reduce:animate-none" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3 w-2/3 max-w-48 motion-reduce:animate-none" />
            <Skeleton className="h-2.5 w-1/3 max-w-24 motion-reduce:animate-none" />
          </div>
          <Skeleton className="h-5 w-14 shrink-0 motion-reduce:animate-none" />
          <Skeleton className="hidden h-3 w-24 motion-reduce:animate-none sm:block" />
        </div>
      ))}
    </div>
  )
}

export type ListStatusTone = 'neutral' | 'positive' | 'danger'

const statusClasses: Record<ListStatusTone, string> = {
  neutral: 'border-border bg-muted text-muted-foreground',
  positive: 'border-primary/20 bg-primary/10 text-primary',
  danger: 'border-destructive/20 bg-destructive/10 text-destructive',
}

export function ListStatusBadge({
  tone = 'neutral',
  className,
  children,
  ...props
}: ComponentProps<'span'> & { tone?: ListStatusTone }) {
  return (
    <Badge variant="outline" className={cn('gap-1.5 font-medium', statusClasses[tone], className)} {...props}>
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      {children}
    </Badge>
  )
}
