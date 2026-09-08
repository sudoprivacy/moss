'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { operationsApi, type BillingOrderItem, type CreditApplicationItem, type RechargeRecordItem } from '@/lib/api/operations'

type BillingTab = 'orders' | 'records' | 'credits'

export default function OperationsBillingPage() {
  const [tab, setTab] = useState<BillingTab>('orders')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [orders, setOrders] = useState<BillingOrderItem[]>([])
  const [records, setRecords] = useState<RechargeRecordItem[]>([])
  const [credits, setCredits] = useState<CreditApplicationItem[]>([])
  const [creditAction, setCreditAction] = useState<{ item: CreditApplicationItem; kind: 'approve' | 'reject' } | null>(null)
  const [approvedPoints, setApprovedPoints] = useState('')
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (tab === 'orders') {
        const response = await operationsApi.listBillingOrders({ page, pageSize: 20 })
        setOrders(response.data.list ?? response.data.items ?? [])
        setTotal(response.data.total)
      } else if (tab === 'records') {
        const response = await operationsApi.listRechargeRecords({ page, pageSize: 20 })
        setRecords(response.data.list ?? response.data.items ?? [])
        setTotal(response.data.total)
      } else {
        const response = await operationsApi.listCreditApplications({ page, pageSize: 20 })
        setCredits(response.data.list ?? response.data.items ?? [])
        setTotal(response.data.total)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '获取账务数据失败')
    } finally {
      setLoading(false)
    }
  }, [page, tab])

  useEffect(() => { void load() }, [load])

  const syncOrder = async (orderNo: string) => {
    try {
      await operationsApi.syncBillingOrder(orderNo)
      toast.success('订单状态已同步')
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '同步失败')
    }
  }

  const submitCredit = async () => {
    if (!creditAction) return
    setSaving(true)
    try {
      if (creditAction.kind === 'approve') {
        const points = approvedPoints ? Number(approvedPoints) : undefined
        if (points !== undefined && (!Number.isFinite(points) || points <= 0)) {
          toast.error('批准积分必须大于 0')
          return
        }
        await operationsApi.approveCreditApplication(creditAction.item.id, { approvedPoints: points, adminComment: comment || undefined })
        toast.success('授信申请已通过')
      } else {
        await operationsApi.rejectCreditApplication(creditAction.item.id, comment || undefined)
        toast.success('授信申请已拒绝')
      }
      setCreditAction(null)
      setApprovedPoints('')
      setComment('')
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '审批失败')
    } finally {
      setSaving(false)
    }
  }

  const pager = <div className="flex items-center justify-between text-sm text-muted-foreground"><span>共 {total} 条</span><div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</Button><span>第 {page} 页</span><Button variant="outline" size="sm" disabled={page * 20 >= total} onClick={() => setPage(value => value + 1)}>下一页</Button></div></div>
  const loadingRows = Array.from({ length: 6 }, (_, index) => <TableRow key={index}><TableCell colSpan={8}><Skeleton className="h-7 w-full" /></TableCell></TableRow>)

  return (
    <DashboardLayout title="账务运营" description="统一查看充值订单、入账记录与授信申请">
      <Tabs value={tab} onValueChange={value => { setTab(value as BillingTab); setPage(1) }} className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><TabsList><TabsTrigger value="orders">订单</TabsTrigger><TabsTrigger value="records">充值记录</TabsTrigger><TabsTrigger value="credits">授信申请</TabsTrigger></TabsList><Button variant="outline" size="icon" title="刷新" onClick={() => void load()}><RefreshCw className="size-4" /></Button></div>
        <TabsContent value="orders" className="space-y-4"><div className="overflow-x-auto rounded-md border"><Table><TableHeader><TableRow><TableHead>订单号</TableHead><TableHead>用户</TableHead><TableHead>金额</TableHead><TableHead>积分</TableHead><TableHead>支付方式</TableHead><TableHead>状态</TableHead><TableHead>创建时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{loading ? loadingRows : orders.map(item => <TableRow key={item.id}><TableCell className="font-mono text-xs">{item.order_no}</TableCell><TableCell>{item.user_nickname || item.user_phone || '-'}</TableCell><TableCell>¥{item.amount_cny ?? '-'}</TableCell><TableCell>{item.points ?? '-'}</TableCell><TableCell>{item.payment_method ?? '-'}</TableCell><TableCell><Badge variant={item.status === 2 ? 'default' : 'secondary'}>{item.status_text ?? item.status}</Badge></TableCell><TableCell className="whitespace-nowrap">{item.created_at}</TableCell><TableCell><Button variant="ghost" size="sm" onClick={() => void syncOrder(item.order_no)}>同步</Button></TableCell></TableRow>)}</TableBody></Table></div>{pager}</TabsContent>
        <TabsContent value="records" className="space-y-4"><div className="overflow-x-auto rounded-md border"><Table><TableHeader><TableRow><TableHead>类型</TableHead><TableHead>订单号</TableHead><TableHead>用户</TableHead><TableHead>积分</TableHead><TableHead>金额</TableHead><TableHead>原因</TableHead><TableHead>时间</TableHead></TableRow></TableHeader><TableBody>{loading ? loadingRows : records.map(item => <TableRow key={item.id}><TableCell><Badge variant="outline">{item.type}</Badge></TableCell><TableCell className="font-mono text-xs">{item.order_no ?? '-'}</TableCell><TableCell>{item.user_nickname || item.user_phone || '-'}</TableCell><TableCell>{item.points}</TableCell><TableCell>{item.amount_cny == null ? '-' : `¥${item.amount_cny}`}</TableCell><TableCell>{item.reason ?? '-'}</TableCell><TableCell className="whitespace-nowrap">{item.created_at}</TableCell></TableRow>)}</TableBody></Table></div>{pager}</TabsContent>
        <TabsContent value="credits" className="space-y-4"><div className="overflow-x-auto rounded-md border"><Table><TableHeader><TableRow><TableHead>申请单</TableHead><TableHead>用户</TableHead><TableHead>申请积分</TableHead><TableHead>批准积分</TableHead><TableHead>状态</TableHead><TableHead>原因</TableHead><TableHead>时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{loading ? loadingRows : credits.map(item => <TableRow key={item.id}><TableCell className="font-mono text-xs">{item.application_no ?? item.id}</TableCell><TableCell>{item.user_nickname || item.user_phone || '-'}</TableCell><TableCell>{item.requested_points ?? '-'}</TableCell><TableCell>{item.approved_points ?? '-'}</TableCell><TableCell><Badge variant="secondary">{item.status}</Badge></TableCell><TableCell>{item.reason ?? '-'}</TableCell><TableCell className="whitespace-nowrap">{item.created_at}</TableCell><TableCell><div className="flex gap-1"><Button variant="ghost" size="icon" title="通过" onClick={() => setCreditAction({ item, kind: 'approve' })}><Check className="size-4" /></Button><Button variant="ghost" size="icon" title="拒绝" onClick={() => setCreditAction({ item, kind: 'reject' })}><X className="size-4" /></Button></div></TableCell></TableRow>)}</TableBody></Table></div>{pager}</TabsContent>
      </Tabs>
      <Dialog open={creditAction !== null} onOpenChange={open => { if (!open) setCreditAction(null) }}><DialogContent><DialogHeader><DialogTitle>{creditAction?.kind === 'approve' ? '通过授信申请' : '拒绝授信申请'}</DialogTitle></DialogHeader><div className="grid gap-4 py-2">{creditAction?.kind === 'approve' ? <div className="grid gap-2"><Label htmlFor="approved-points">批准积分</Label><Input id="approved-points" type="number" min={0.01} value={approvedPoints} placeholder={String(creditAction.item.requested_points ?? '')} onChange={event => setApprovedPoints(event.target.value)} /></div> : null}<div className="grid gap-2"><Label htmlFor="credit-comment">审批说明</Label><Input id="credit-comment" value={comment} onChange={event => setComment(event.target.value)} /></div></div><DialogFooter><Button variant="outline" onClick={() => setCreditAction(null)}>取消</Button><Button disabled={saving} onClick={() => void submitCredit()}>确认</Button></DialogFooter></DialogContent></Dialog>
    </DashboardLayout>
  )
}
