'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { operationsApi, type AuditEventItem } from '@/lib/api/operations'

export default function OperationsAuditPage() {
  const [items, setItems] = useState<AuditEventItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [action, setAction] = useState('')
  const [userId, setUserId] = useState('')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await operationsApi.listAuditEvents({
        page, pageSize: 20, action: action.trim() || undefined,
        userId: /^\d+$/.test(userId) ? Number(userId) : undefined,
      })
      setItems(response.data.items ?? response.data.list ?? [])
      setTotal(response.data.total)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '获取业务审计日志失败')
    } finally {
      setLoading(false)
    }
  }, [action, page, userId])

  useEffect(() => { void load() }, [load])

  const toggle = (id: string) => setExpanded(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  return (
    <DashboardLayout title="业务审计" description="统一身份、组织、账务及兼容操作记录">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Input className="w-56" value={action} placeholder="操作类型" onChange={event => { setAction(event.target.value); setPage(1) }} />
          <Input className="w-44" inputMode="numeric" value={userId} placeholder="旧用户数字 ID" onChange={event => { setUserId(event.target.value); setPage(1) }} />
          <Button variant="outline" size="icon" title="刷新" onClick={() => void load()}><RefreshCw className="size-4" /></Button>
        </div>
        <div className="overflow-x-auto rounded-md border">
          <Table><TableHeader><TableRow><TableHead className="w-10" /><TableHead>时间</TableHead><TableHead>操作人</TableHead><TableHead>动作</TableHead><TableHead>资源</TableHead><TableHead>请求</TableHead><TableHead>状态</TableHead><TableHead>耗时</TableHead></TableRow></TableHeader><TableBody>
            {loading ? Array.from({ length: 8 }, (_, index) => <TableRow key={index}><TableCell colSpan={8}><Skeleton className="h-7 w-full" /></TableCell></TableRow>) : items.flatMap(item => {
              const key = String(item.id)
              const isExpanded = expanded.has(key)
              return [
                <TableRow key={key} className="cursor-pointer" onClick={() => toggle(key)}><TableCell>{isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</TableCell><TableCell className="whitespace-nowrap">{item.created_at}</TableCell><TableCell>{item.user_phone || item.user_nickname || item.user_id || '-'}</TableCell><TableCell><Badge variant="outline">{item.action}</Badge></TableCell><TableCell>{item.resource ?? '-'}{item.resource_id == null ? '' : ` #${item.resource_id}`}</TableCell><TableCell className="font-mono text-xs">{item.method ?? ''} {item.path ?? '-'}</TableCell><TableCell>{item.response_status ?? '-'}</TableCell><TableCell>{item.duration_ms == null ? '-' : `${item.duration_ms} ms`}</TableCell></TableRow>,
                ...(isExpanded ? [<TableRow key={`${key}-detail`}><TableCell colSpan={8} className="bg-muted/30"><pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ request: parseJson(item.request_data), response: parseJson(item.response_data), error: item.error_message }, null, 2)}</pre></TableCell></TableRow>] : []),
              ]
            })}
            {!loading && items.length === 0 ? <TableRow><TableCell colSpan={8} className="py-12 text-center text-muted-foreground"><Search className="mx-auto mb-2 size-7 opacity-50" />暂无审计记录</TableCell></TableRow> : null}
          </TableBody></Table>
        </div>
        <div className="flex items-center justify-between text-sm text-muted-foreground"><span>共 {total} 条</span><div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</Button><span>第 {page} 页</span><Button variant="outline" size="sm" disabled={page * 20 >= total} onClick={() => setPage(value => value + 1)}>下一页</Button></div></div>
      </div>
    </DashboardLayout>
  )
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null
  try { return JSON.parse(value) as unknown } catch { return value }
}
