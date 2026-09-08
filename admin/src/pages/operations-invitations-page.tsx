'use client'

import { useCallback, useEffect, useState } from 'react'
import { Copy, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { operationsApi, type InvitationCodeItem } from '@/lib/api/operations'

const statusLabels = ['未使用', '已使用', '已撤销'] as const

export default function OperationsInvitationsPage() {
  const [items, setItems] = useState<InvitationCodeItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('all')
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [count, setCount] = useState('1')
  const [quota, setQuota] = useState('0')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await operationsApi.listInvitations({
        page, pageSize: 20, status: status === 'all' ? undefined : Number(status) as 0 | 1 | 2,
      })
      setItems(response.data.items ?? response.data.list ?? [])
      setTotal(response.data.total)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '获取邀请码失败')
    } finally {
      setLoading(false)
    }
  }, [page, status])

  useEffect(() => { void load() }, [load])

  const create = async () => {
    const parsedCount = Number(count)
    const parsedQuota = Number(quota)
    if (!Number.isInteger(parsedCount) || parsedCount < 1 || parsedCount > 100 || parsedQuota < 0) {
      toast.error('数量须为 1 至 100，初始额度不能小于 0')
      return
    }
    setSaving(true)
    try {
      const response = await operationsApi.createInvitations({ count: parsedCount, initialQuotaUsd: parsedQuota })
      toast.success(`已创建 ${response.data.count} 个邀请码`)
      setCreateOpen(false)
      setPage(1)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建失败')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (item: InvitationCodeItem) => {
    if (!window.confirm(`确认撤销邀请码 ${item.code}？`)) return
    try {
      await operationsApi.deleteInvitation(item.id)
      toast.success('邀请码已撤销')
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '撤销失败')
    }
  }

  return (
    <DashboardLayout title="邀请码管理" description="管理当前组织的 Sudowork 注册邀请码">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Select value={status} onValueChange={(value) => { setStatus(value); setPage(1) }}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="0">未使用</SelectItem>
              <SelectItem value="1">已使用</SelectItem>
              <SelectItem value="2">已撤销</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Button variant="outline" size="icon" title="刷新" onClick={() => void load()}><RefreshCw className="size-4" /></Button>
            <Button onClick={() => setCreateOpen(true)}><Plus className="mr-2 size-4" />批量创建</Button>
          </div>
        </div>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader><TableRow><TableHead>邀请码</TableHead><TableHead>状态</TableHead><TableHead>初始额度</TableHead><TableHead>使用者</TableHead><TableHead>创建时间</TableHead><TableHead className="w-24">操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {loading ? Array.from({ length: 6 }, (_, index) => <TableRow key={index}><TableCell colSpan={6}><Skeleton className="h-7 w-full" /></TableCell></TableRow>) : items.map(item => (
                <TableRow key={item.id}>
                  <TableCell className="font-mono text-sm">{item.code}</TableCell>
                  <TableCell><Badge variant={item.status === 0 ? 'default' : 'secondary'}>{statusLabels[item.status]}</Badge></TableCell>
                  <TableCell>{item.initial_quota_usd}</TableCell>
                  <TableCell>{item.used_by_user_id ?? '-'}</TableCell>
                  <TableCell className="whitespace-nowrap">{item.created_at || '-'}</TableCell>
                  <TableCell><div className="flex gap-1"><Button variant="ghost" size="icon" title="复制" onClick={() => { void navigator.clipboard.writeText(item.code); toast.success('已复制') }}><Copy className="size-4" /></Button>{item.status === 0 ? <Button variant="ghost" size="icon" title="撤销" onClick={() => void remove(item)}><Trash2 className="size-4" /></Button> : null}</div></TableCell>
                </TableRow>
              ))}
              {!loading && items.length === 0 ? <TableRow><TableCell colSpan={6} className="py-12 text-center text-muted-foreground">暂无邀请码</TableCell></TableRow> : null}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between text-sm text-muted-foreground"><span>共 {total} 条</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</Button><span className="self-center">第 {page} 页</span><Button variant="outline" size="sm" disabled={page * 20 >= total} onClick={() => setPage(value => value + 1)}>下一页</Button></div></div>
      </div>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent><DialogHeader><DialogTitle>批量创建邀请码</DialogTitle></DialogHeader><div className="grid gap-4 py-2"><div className="grid gap-2"><Label htmlFor="invite-count">数量</Label><Input id="invite-count" type="number" min={1} max={100} value={count} onChange={event => setCount(event.target.value)} /></div><div className="grid gap-2"><Label htmlFor="invite-quota">注册赠送额度</Label><Input id="invite-quota" type="number" min={0} step="0.01" value={quota} onChange={event => setQuota(event.target.value)} /></div></div><DialogFooter><Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button><Button disabled={saving} onClick={() => void create()}>创建</Button></DialogFooter></DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
