'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Eye, RefreshCw, RotateCw, Undo2, X } from 'lucide-react'
import { toast } from 'sonner'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { operationsApi, type BillingOrderItem, type CreditApplicationItem, type RechargeRecordItem } from '@/lib/api/operations'
import { billingOrderActions, creditApplicationActions, parseOptionalIntegerPoints } from '../operations-billing'

type BillingTab = 'orders' | 'records' | 'credits'
type OrderAction = { kind: 'detail' | 'refund'; item: BillingOrderItem } | null
type CreditAction = { kind: 'detail' | 'approve' | 'reject'; item: CreditApplicationItem } | null

const orderStatusOptions = [
  ['all', '全部状态'], ['0', '待支付'], ['1', '支付中'], ['2', '支付成功'],
  ['3', '支付失败'], ['4', '已退款'], ['5', '已取消'],
] as const

const creditStatusOptions = [
  ['all', '全部状态'], ['PENDING', '待审批'], ['PROCESSING', '处理中'], ['APPROVED', '已通过'],
  ['REJECTED', '已拒绝'], ['SYNC_FAILED', '同步失败'], ['SYNC_UNKNOWN', '待人工核对'],
] as const

export default function OperationsBillingPage() {
  const [tab, setTab] = useState<BillingTab>('orders')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [total, setTotal] = useState(0)
  const [orders, setOrders] = useState<BillingOrderItem[]>([])
  const [records, setRecords] = useState<RechargeRecordItem[]>([])
  const [credits, setCredits] = useState<CreditApplicationItem[]>([])
  const [stats, setStats] = useState<Record<string, unknown>>({})
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState('all')
  const [type, setType] = useState('all')
  const [paymentMethod, setPaymentMethod] = useState('all')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [orderAction, setOrderAction] = useState<OrderAction>(null)
  const [orderDetail, setOrderDetail] = useState<Record<string, unknown> | null>(null)
  const [refundQuote, setRefundQuote] = useState<Record<string, unknown> | null>(null)
  const [refundReason, setRefundReason] = useState('')
  const [creditAction, setCreditAction] = useState<CreditAction>(null)
  const [creditDetail, setCreditDetail] = useState<Record<string, unknown> | null>(null)
  const [approvedPoints, setApprovedPoints] = useState('')
  const [comment, setComment] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (tab === 'orders') {
        const [response, statsResponse] = await Promise.all([
          operationsApi.listBillingOrders({
            page, pageSize: 20,
            status: status === 'all' ? undefined : status,
            orderNo: keyword.trim() || undefined,
            userPhone: keyword.trim() || undefined,
            startDate: startDate || undefined,
            endDate: endDate || undefined,
          }),
          operationsApi.getRechargeStats(),
        ])
        setOrders(response.data.list ?? response.data.items ?? [])
        setTotal(response.data.total)
        setStats(statsResponse.data)
      } else if (tab === 'records') {
        const response = await operationsApi.listRechargeRecords({
          page, pageSize: 20, keyword: keyword.trim() || undefined,
          type: type === 'all' ? undefined : type,
          paymentMethod: paymentMethod === 'all' ? undefined : paymentMethod,
        })
        setRecords(response.data.list ?? response.data.items ?? [])
        setTotal(response.data.total)
      } else {
        const response = await operationsApi.listCreditApplications({
          page, pageSize: 20, keyword: keyword.trim() || undefined,
          status: status === 'all' ? undefined : status,
        })
        setCredits(response.data.list ?? response.data.items ?? [])
        setTotal(response.data.total)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '获取账务数据失败')
    } finally {
      setLoading(false)
    }
  }, [endDate, keyword, page, paymentMethod, startDate, status, tab, type])

  useEffect(() => { void load() }, [load])

  const resetFilters = () => {
    setKeyword(''); setStatus('all'); setType('all'); setPaymentMethod('all')
    setStartDate(''); setEndDate(''); setPage(1)
  }

  const mutate = async (operation: () => Promise<unknown>, success: string) => {
    setSaving(true)
    try { await operation(); toast.success(success); await load() }
    catch (error) { toast.error(error instanceof Error ? error.message : '操作失败'); throw error }
    finally { setSaving(false) }
  }

  const openOrder = async (item: BillingOrderItem, kind: 'detail' | 'refund') => {
    setOrderAction({ item, kind }); setOrderDetail(null); setRefundQuote(null); setRefundReason('')
    setSaving(true)
    try {
      const detail = await operationsApi.getBillingOrder(item.order_no)
      setOrderDetail(detail.data as Record<string, unknown>)
      if (kind === 'refund') setRefundQuote((await operationsApi.getRefundCalculation(item.order_no)).data)
    } catch (error) { toast.error(error instanceof Error ? error.message : '加载订单详情失败'); setOrderAction(null) }
    finally { setSaving(false) }
  }

  const submitCredit = async () => {
    if (!creditAction || creditAction.kind === 'detail') return
    try {
      const points = parseOptionalIntegerPoints(approvedPoints)
      if (creditAction.kind === 'reject' && !comment.trim()) throw new Error('请输入拒绝原因')
      await mutate(
        () => creditAction.kind === 'approve'
          ? operationsApi.approveCreditApplication(creditAction.item.id, { approvedPoints: points, adminComment: comment.trim() || undefined })
          : operationsApi.rejectCreditApplication(creditAction.item.id, comment.trim()),
        creditAction.kind === 'approve' ? '授信申请已通过' : '授信申请已拒绝',
      )
      setCreditAction(null); setApprovedPoints(''); setComment('')
    } catch (error) {
      if (error instanceof Error && /正整数|拒绝原因/.test(error.message)) toast.error(error.message)
    }
  }

  const openCredit = async (item: CreditApplicationItem, kind: 'detail' | 'approve' | 'reject') => {
    setCreditAction({ item, kind }); setApprovedPoints(''); setComment(''); setCreditDetail(null)
    if (kind !== 'detail') return
    setSaving(true)
    try { setCreditDetail((await operationsApi.getCreditApplication(item.id)).data as Record<string, unknown>) }
    catch (error) { toast.error(error instanceof Error ? error.message : '加载申请详情失败') }
    finally { setSaving(false) }
  }

  const pager = <div className="flex items-center justify-between text-sm text-muted-foreground"><span>共 {total} 条</span><div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</Button><span>第 {page} 页</span><Button variant="outline" size="sm" disabled={page * 20 >= total} onClick={() => setPage(value => value + 1)}>下一页</Button></div></div>
  const loadingRows = Array.from({ length: 6 }, (_, index) => <TableRow key={index}><TableCell colSpan={10}><Skeleton className="h-7 w-full" /></TableCell></TableRow>)
  const totalStats = (stats.total ?? {}) as Record<string, unknown>
  const todayStats = (stats.today ?? {}) as Record<string, unknown>

  return (
    <DashboardLayout title="账务运营" description="统一处理充值订单、后台充值记录与授信申请">
      <Tabs value={tab} onValueChange={value => { setTab(value as BillingTab); resetFilters() }} className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList><TabsTrigger value="orders">订单</TabsTrigger><TabsTrigger value="records">充值记录</TabsTrigger><TabsTrigger value="credits">授信申请</TabsTrigger></TabsList>
          <div className="flex gap-2"><Button variant="outline" size="sm" onClick={resetFilters}>重置筛选</Button><Button variant="outline" size="icon" title="刷新" onClick={() => void load()}><RefreshCw className="size-4" /></Button></div>
        </div>

        {tab === 'orders' ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Stat label="今日充值" value={`$${String(todayStats.amount_usd ?? 0)}`} /><Stat label="今日订单" value={String(todayStats.orders ?? 0)} /><Stat label="累计充值" value={`$${String(totalStats.amount_usd ?? 0)}`} /><Stat label="待处理" value={String(totalStats.pending_count ?? 0)} /></div> : null}

        <div className="flex flex-wrap gap-2">
          <Input className="w-56" value={keyword} onChange={event => { setKeyword(event.target.value); setPage(1) }} placeholder={tab === 'orders' ? '订单号或手机号' : tab === 'records' ? '用户、订单号或原因' : '用户或申请单号'} />
          {tab !== 'records' ? <Select value={status} onValueChange={value => { setStatus(value); setPage(1) }}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent>{(tab === 'orders' ? orderStatusOptions : creditStatusOptions).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select> : null}
          {tab === 'orders' ? <><Input className="w-40" type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /><Input className="w-40" type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /><Button variant="outline" onClick={() => { void mutate(() => operationsApi.syncPendingBillingOrders(), '待处理订单同步完成').catch(() => undefined) }} disabled={saving}><RotateCw className="mr-2 size-4" />批量同步</Button></> : null}
          {tab === 'records' ? <><Select value={type} onValueChange={setType}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部类型</SelectItem><SelectItem value="CLIENT">客户端充值</SelectItem><SelectItem value="ADMIN">后台充值</SelectItem></SelectContent></Select><Select value={paymentMethod} onValueChange={setPaymentMethod}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部支付方式</SelectItem><SelectItem value="ALIPAY">支付宝</SelectItem><SelectItem value="WECHAT">微信</SelectItem></SelectContent></Select></> : null}
        </div>

        <TabsContent value="orders" className="space-y-4"><div className="overflow-x-auto rounded-md border"><Table><TableHeader><TableRow><TableHead>订单号</TableHead><TableHead>用户</TableHead><TableHead>金额</TableHead><TableHead>积分</TableHead><TableHead>支付方式</TableHead><TableHead>状态</TableHead><TableHead>创建时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{loading ? loadingRows : orders.map(item => <TableRow key={item.id}><TableCell className="font-mono text-xs">{item.order_no}</TableCell><TableCell>{item.user_nickname || item.user_phone || '-'}</TableCell><TableCell>${item.amount_usd ?? '-'} / ¥{item.amount_cny ?? '-'}</TableCell><TableCell>{item.points ?? '-'}{item.bonus_points ? ` + ${item.bonus_points}` : ''}</TableCell><TableCell>{item.payment_method ?? '-'}</TableCell><TableCell><Badge variant={item.status === 2 ? 'default' : 'secondary'}>{item.status_text ?? item.status}</Badge></TableCell><TableCell className="whitespace-nowrap">{item.created_at}</TableCell><TableCell><div className="flex gap-1">{billingOrderActions(item.status).map(action => <Button key={action} variant="ghost" size="icon" title={action === 'detail' ? '详情' : action === 'sync' ? '同步' : action === 'retry' ? '重试' : '退款'} onClick={() => action === 'detail' || action === 'refund' ? void openOrder(item, action) : void mutate(() => action === 'sync' ? operationsApi.syncBillingOrder(item.order_no) : operationsApi.retryBillingOrder(item.id), action === 'sync' ? '订单状态已同步' : '订单已重试').catch(() => undefined)}>{action === 'detail' ? <Eye className="size-4" /> : action === 'refund' ? <Undo2 className="size-4" /> : <RotateCw className="size-4" />}</Button>)}</div></TableCell></TableRow>)}</TableBody></Table></div>{pager}</TabsContent>

        <TabsContent value="records" className="space-y-4"><div className="overflow-x-auto rounded-md border"><Table><TableHeader><TableRow><TableHead>类型</TableHead><TableHead>订单号</TableHead><TableHead>用户</TableHead><TableHead>积分/额度</TableHead><TableHead>金额/支付</TableHead><TableHead>操作人</TableHead><TableHead>来源</TableHead><TableHead>原因</TableHead><TableHead>时间</TableHead></TableRow></TableHeader><TableBody>{loading ? loadingRows : records.map(item => <TableRow key={item.id}><TableCell><Badge variant="outline">{item.type === 'ADMIN' ? '后台充值' : '客户端充值'}</Badge></TableCell><TableCell className="font-mono text-xs">{item.order_no ?? '-'}</TableCell><TableCell>{item.user_nickname || item.user_phone || '-'}</TableCell><TableCell>{item.points} / {item.quota ?? '-'}</TableCell><TableCell>{item.amount_cny == null ? '-' : `¥${item.amount_cny}`} {item.payment_method ?? ''}</TableCell><TableCell>{item.admin_nickname ?? '-'}</TableCell><TableCell>{item.source_text ?? item.source ?? '-'}</TableCell><TableCell>{item.reason ?? '-'}</TableCell><TableCell className="whitespace-nowrap">{item.created_at}</TableCell></TableRow>)}</TableBody></Table></div>{pager}</TabsContent>

        <TabsContent value="credits" className="space-y-4"><div className="overflow-x-auto rounded-md border"><Table><TableHeader><TableRow><TableHead>申请单</TableHead><TableHead>用户/企业</TableHead><TableHead>申请积分</TableHead><TableHead>批准积分</TableHead><TableHead>状态</TableHead><TableHead>原因/备注</TableHead><TableHead>时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{loading ? loadingRows : credits.map(item => <TableRow key={item.id}><TableCell className="font-mono text-xs">{item.application_no ?? item.id}</TableCell><TableCell>{item.user_nickname || item.user_phone || '-'}<div className="text-xs text-muted-foreground">{item.enterprise_name ?? ''}</div></TableCell><TableCell>{item.requested_points ?? '-'}</TableCell><TableCell>{item.approved_points ?? '-'}</TableCell><TableCell><Badge variant="secondary">{item.status}</Badge></TableCell><TableCell>{item.reason ?? '-'}<div className="text-xs text-muted-foreground">{item.admin_comment ?? ''}</div></TableCell><TableCell className="whitespace-nowrap">{item.created_at}</TableCell><TableCell><div className="flex gap-1">{creditApplicationActions(item.status).map(action => <Button key={action} variant="ghost" size="icon" title={action === 'detail' ? '详情' : action === 'approve' ? '通过' : action === 'reject' ? '拒绝' : '重试同步'} onClick={() => action === 'retry_sync' ? void mutate(() => operationsApi.retryCreditApplicationSync(item.id), '额度同步重试成功').catch(() => undefined) : void openCredit(item, action)}>{action === 'detail' ? <Eye className="size-4" /> : action === 'approve' ? <Check className="size-4" /> : action === 'reject' ? <X className="size-4" /> : <RotateCw className="size-4" />}</Button>)}</div></TableCell></TableRow>)}</TableBody></Table></div>{pager}</TabsContent>
      </Tabs>

      <Dialog open={orderAction !== null} onOpenChange={open => { if (!open) setOrderAction(null) }}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{orderAction?.kind === 'refund' ? '订单退款' : '订单详情'}</DialogTitle><DialogDescription>{orderAction?.item.order_no}</DialogDescription></DialogHeader>{saving ? <Skeleton className="h-40" /> : <JsonDetails value={orderDetail} />}{orderAction?.kind === 'refund' ? <div className="space-y-3"><JsonDetails value={refundQuote} /><div className="space-y-2"><Label htmlFor="refund-reason">退款原因</Label><Textarea id="refund-reason" value={refundReason} onChange={event => setRefundReason(event.target.value)} /></div></div> : null}<DialogFooter><Button variant="outline" onClick={() => setOrderAction(null)}>关闭</Button>{orderAction?.kind === 'refund' ? <Button variant="destructive" disabled={saving || !refundReason.trim()} onClick={() => { void mutate(() => operationsApi.refundBillingOrder(orderAction.item.order_no, refundReason.trim()), '退款成功').then(() => setOrderAction(null)).catch(() => undefined) }}>确认退款</Button> : null}</DialogFooter></DialogContent></Dialog>

      <Dialog open={creditAction !== null} onOpenChange={open => { if (!open) setCreditAction(null) }}><DialogContent><DialogHeader><DialogTitle>{creditAction?.kind === 'approve' ? '通过授信申请' : creditAction?.kind === 'reject' ? '拒绝授信申请' : '授信申请详情'}</DialogTitle><DialogDescription>{creditAction?.item.application_no ?? creditAction?.item.id}</DialogDescription></DialogHeader>{creditAction?.kind === 'detail' ? <JsonDetails value={creditDetail} /> : <div className="grid gap-4 py-2">{creditAction?.kind === 'approve' ? <div className="grid gap-2"><Label htmlFor="approved-points">批准积分</Label><Input id="approved-points" inputMode="numeric" value={approvedPoints} placeholder={String(creditAction.item.requested_points ?? '')} onChange={event => setApprovedPoints(event.target.value)} /></div> : null}<div className="grid gap-2"><Label htmlFor="credit-comment">审批说明</Label><Textarea id="credit-comment" value={comment} onChange={event => setComment(event.target.value)} /></div></div>}<DialogFooter><Button variant="outline" onClick={() => setCreditAction(null)}>关闭</Button>{creditAction?.kind !== 'detail' ? <Button disabled={saving} onClick={() => void submitCredit()}>确认</Button> : null}</DialogFooter></DialogContent></Dialog>
    </DashboardLayout>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{label}</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{value}</CardContent></Card>
}

function JsonDetails({ value }: { value: Record<string, unknown> | null }) {
  const entries = useMemo(() => Object.entries(value ?? {}), [value])
  if (entries.length === 0) return <div className="rounded-md border py-8 text-center text-sm text-muted-foreground">暂无详情</div>
  return <dl className="grid max-h-72 grid-cols-[minmax(100px,160px)_1fr] gap-x-4 gap-y-2 overflow-auto rounded-md border p-4 text-sm">{entries.map(([key, item]) => <div key={key} className="contents"><dt className="text-muted-foreground">{key.replaceAll('_', ' ')}</dt><dd className="break-all">{item && typeof item === 'object' ? JSON.stringify(item) : String(item ?? '-')}</dd></div>)}</dl>
}
