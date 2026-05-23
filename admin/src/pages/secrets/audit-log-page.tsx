'use client'

import { useEffect, useState, useCallback } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { Search, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { getAuditLog, getConfigItems, type AuditLogEntry, type ConfigItem } from '@/lib/api/secrets'
import { format } from 'date-fns'

const actionLabels: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  created: { label: '创建', variant: 'default' },
  updated: { label: '更新', variant: 'secondary' },
  deleted: { label: '删除', variant: 'destructive' },
  enabled: { label: '启用', variant: 'default' },
  disabled: { label: '禁用', variant: 'outline' },
  auth_proxy_request: { label: '代理请求', variant: 'secondary' },
}

function AuditSkeleton() {
  return <div className="space-y-2">{[...Array(10)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
}

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([])
  const [configItems, setConfigItems] = useState<ConfigItem[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [searchParams] = useSearchParams()

  // Filters (init from URL params)
  const [actionFilter, setActionFilter] = useState<string>(searchParams.get('action') || 'all')
  const [configItemFilter, setConfigItemFilter] = useState<string>(searchParams.get('config_item_id') || 'all')

  // Expandable rows
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  const fetchData = useCallback(async () => {
    try {
      const [logRes, itemsRes] = await Promise.all([
        getAuditLog({
          action: actionFilter !== 'all' ? actionFilter : undefined,
          config_item_id: configItemFilter !== 'all' ? Number(configItemFilter) : undefined,
        }),
        getConfigItems(),
      ])
      setEntries(logRes.items)
      setTotal(logRes.total)
      setConfigItems(itemsRes.items)
    } catch {
      toast.error('获取审计日志失败')
    } finally {
      setIsLoading(false)
    }
  }, [actionFilter, configItemFilter])

  useEffect(() => { fetchData() }, [fetchData])

  const toggleRow = (id: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
    else next.add(id)
      return next
    })
  }

  const getConfigItemName = (id: number | null) => {
    if (!id) return '-'
    return configItems.find(c => c.id === id)?.name ?? `#${id}`
  }

  if (isLoading) {
    return <DashboardLayout title="审计日志" description="凭据操作历史记录"><AuditSkeleton /></DashboardLayout>
  }

  return (
    <DashboardLayout title="审计日志" description="凭据操作历史记录">
      <div className="space-y-6">
        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          <Select value={actionFilter} onValueChange={setActionFilter}>
            <SelectTrigger className="w-[140px]"><SelectValue placeholder="操作类型" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部操作</SelectItem>
              {Object.entries(actionLabels).map(([key, val]) => (
                <SelectItem key={key} value={key}>{val.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={configItemFilter} onValueChange={setConfigItemFilter}>
            <SelectTrigger className="w-[160px]"><SelectValue placeholder="配置项" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部配置项</SelectItem>
              {configItems.map(item => (
                <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => { setActionFilter('all'); setConfigItemFilter('all') }}>
            重置
          </Button>
        </div>

        {/* Table */}
        <div className="border rounded-lg">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>时间</TableHead>
                <TableHead>操作人</TableHead>
                <TableHead>操作类型</TableHead>
                <TableHead>配置项</TableHead>
                <TableHead>凭据路径</TableHead>
                <TableHead>IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map(entry => {
                const config = actionLabels[entry.action] || { label: entry.action, variant: 'outline' as const }
                const isExpanded = expandedRows.has(entry.id)
                return (
                  <>
                    <TableRow key={entry.id} className="cursor-pointer" onClick={() => toggleRow(entry.id)}>
                      <TableCell>
                        {entry.detail ? (
                          isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />
                        ) : null}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">{format(entry.created_at, 'MM-dd HH:mm:ss')}</TableCell>
                      <TableCell className="text-sm">{entry.actor_name}</TableCell>
                      <TableCell><Badge variant={config.variant}>{config.label}</Badge></TableCell>
                      <TableCell className="text-sm">{getConfigItemName(entry.config_item_id)}</TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">{entry.namespace}/{entry.key}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{entry.ip_address ?? '-'}</TableCell>
                    </TableRow>
                    {isExpanded && entry.detail && (
                      <TableRow key={`${entry.id}-detail`}>
                        <TableCell colSpan={7} className="bg-muted/30">
                          <pre className="text-xs font-mono p-2 overflow-x-auto">
                            {JSON.stringify(entry.detail, null, 2)}
                          </pre>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                )
              })}
              {entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-12">
                    <div className="flex flex-col items-center text-muted-foreground">
                      <Search className="size-8 mb-2 opacity-50" />
                      <p>没有找到审计记录</p>
                      <p className="text-xs mt-1">尝试调整筛选条件</p>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="text-sm text-muted-foreground">共 {total} 条记录</div>
      </div>
    </DashboardLayout>
  )
}
