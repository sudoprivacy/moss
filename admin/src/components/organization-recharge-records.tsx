import { useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { modelBillingApi, type ModelAccount, type OrganizationRechargeOrder } from '@/lib/api/model-billing'
import { useAuth } from '@/lib/hooks/use-auth'

const creditLabels: Record<string, string> = { pending: '待处理', sending: '到账处理中', credited: '已到账', needs_review: '需人工核对', failed: '明确未执行' }
const paymentLabels: Record<string, string> = { pending: '待支付', paying: '支付中', paid: '已付款', cancelled: '已取消', not_required: '无需支付' }
const resolutionLabels: Record<string, string> = { automatic: '自动处理', needs_review: '待核对', ready: '可处理', partial: '部分补充', closed: '处理完成' }
const formatTime = (value: number | null) => value == null ? '—' : new Date(value).toLocaleString('zh-CN', { hour12: false })

export function OrganizationRechargeRecords() {
  const { user, activeOrgId } = useAuth()
  const isOperator = user?.role === 'super_admin'
  const [items, setItems] = useState<OrganizationRechargeOrder[]>([])
  const [account, setAccount] = useState<ModelAccount>()
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [source, setSource] = useState('all')
  const [revision, setRevision] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [creditTarget, setCreditTarget] = useState<{ related: OrganizationRechargeOrder | null }>()
  const [detail, setDetail] = useState<OrganizationRechargeOrder>()
  const onChanged = () => { setRevision(value => value + 1); setDetail(undefined) }
  useEffect(() => {
    let current = true
    setIsLoading(true); setError(''); setItems([])
    void Promise.all([modelBillingApi.orders(page, source), modelBillingApi.account()]).then(([result, balance]) => {
      if (current) { setItems(result.items); setTotal(result.total); setAccount(balance) }
    }).catch((cause: unknown) => {
      if (current) { setItems([]); setTotal(0); setAccount(undefined); setError(cause instanceof Error ? cause.message : '加载组织充值记录失败') }
    }).finally(() => { if (current) setIsLoading(false) })
    return () => { current = false }
  }, [page, source, revision, activeOrgId])
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-3">
      <p className="flex-1 text-sm text-muted-foreground">组织余额 ${account?.model_balance_usd ?? '—'} · 线上充值由组织管理员在 Sudowork 操作。异常补充请从原订单详情关联处理。</p>
      <select aria-label="充值来源" className="rounded border p-2" value={source} onChange={e => { setSource(e.target.value); setPage(1) }}><option value="all">全部来源</option><option value="online">富友在线充值</option><option value="manual">后台充值</option></select>
      <Button variant="outline" disabled={isLoading} onClick={onChanged}>刷新</Button>
      {isOperator && <Button disabled={!account?.router_user_id || isLoading} onClick={() => setCreditTarget({ related: null })}>后台充值</Button>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="overflow-x-auto rounded-md border"><Table><TableHeader><TableRow>
      {['来源 / 单号', '组织账户', '付款人 / 操作人', '金额（USD）', '付款信息', '到账 / 处理状态', '创建时间', '到账时间', '操作'].map(label => <TableHead key={label}>{label}</TableHead>)}
    </TableRow></TableHeader><TableBody>
      {items.map(order => <TableRow key={order.order_no}>
        <TableCell><Badge variant="outline">{order.source === 'manual' ? '后台充值' : '富友在线充值'}</Badge><div className="mt-1 font-mono text-xs">{order.order_no}</div>{order.payment_test_mode && <span className="text-xs">测试订单</span>}</TableCell>
        <TableCell>#{order.router_user_id}</TableCell><TableCell>{order.payer_nickname || order.payer_username || order.payer_user_id}</TableCell>
        <TableCell>${order.purchase_amount_usd}{order.source === 'online' && <div className="text-xs text-muted-foreground">赠送 ${order.bonus_amount_usd}</div>}</TableCell>
        <TableCell>{order.source === 'manual' ? '无需支付' : <><div>¥{((order.amount_cny_fen ?? 0) / 100).toFixed(2)} · {paymentLabels[order.payment_status]}</div><div className="text-xs">{formatTime(order.paid_at)}</div></>}</TableCell>
        <TableCell><Badge variant={order.credit_status === 'needs_review' ? 'destructive' : 'secondary'}>{creditLabels[order.credit_status]}</Badge>{order.resolution?.is_manual && <div className="text-xs mt-1">{resolutionLabels[order.resolution.status]}</div>}</TableCell>
        <TableCell className="whitespace-nowrap">{formatTime(order.created_at)}</TableCell><TableCell className="whitespace-nowrap">{formatTime(order.credited_at)}</TableCell>
        <TableCell><Button variant="link" onClick={() => setDetail(order)}>详情</Button></TableCell>
      </TableRow>)}
      {!items.length && <TableRow><TableCell colSpan={9} className="h-28 text-center">{isLoading ? '加载中…' : '暂无充值记录'}</TableCell></TableRow>}
    </TableBody></Table></div>
    <div className="flex items-center justify-between text-sm"><span>共 {total} 笔</span><div className="flex items-center gap-2"><Button variant="outline" disabled={isLoading || page <= 1} onClick={() => setPage(v => v - 1)}>上一页</Button><span>第 {page} 页</span><Button variant="outline" disabled={isLoading || page * 20 >= total} onClick={() => setPage(v => v + 1)}>下一页</Button></div></div>
    {creditTarget && account && <ManualCreditDialog account={account} related={creditTarget.related} onClose={() => setCreditTarget(undefined)} onChanged={onChanged} />}
    {detail && <RechargeDetail key={detail.order_no} order={detail} isOperator={isOperator} onClose={() => setDetail(undefined)} onChanged={onChanged} onCredit={() => { setCreditTarget({ related: detail }); setDetail(undefined) }} />}
  </div>
}

function ManualCreditDialog({ account, related, onClose, onChanged }: { account: ModelAccount; related: OrganizationRechargeOrder | null; onClose(): void; onChanged(): void }) {
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [isConfirmed, setIsConfirmed] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<{ payload: string; key: string } | null>(null)
  const onSubmit = async () => {
    if (isBusy || !isConfirmed) return
    const body = { amount_usd: amount, reason, related_order_no: related?.order_no ?? null }
    const payload = JSON.stringify(body)
    if (request.current?.payload !== payload) request.current = { payload, key: crypto.randomUUID() }
    setIsBusy(true); setError('')
    try { await modelBillingApi.manualCredit(body, request.current.key); onChanged(); onClose() } catch (e) { setError((e as Error).message) } finally { setIsBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !isBusy) onClose() }}><DialogContent><DialogHeader><DialogTitle>后台充值</DialogTitle><DialogDescription>直接增加组织美元余额，无支付扣款和额外赠送。提交后以充值记录的到账状态为准。</DialogDescription></DialogHeader>
    <p className="text-sm break-all">组织：{account.org_id}<br />SudoRouter 账户：#{account.router_user_id}</p>
    {related && <p className="text-sm">关联 {related.order_no}<br />原应到账 ${related.resolution?.expected_amount_usd} · 已人工到账 ${related.resolution?.manual_credited_usd} · 差额 ${related.resolution?.difference_usd}</p>}
    <Label htmlFor="manual-credit-amount">充值金额（USD）</Label><Input id="manual-credit-amount" value={amount} disabled={isBusy} onChange={e => { setAmount(e.target.value); setIsConfirmed(false) }} placeholder="0.01 – 10000.00" />
    <Label htmlFor="manual-credit-reason">充值原因</Label><Input id="manual-credit-reason" value={reason} disabled={isBusy} maxLength={1000} onChange={e => { setReason(e.target.value); setIsConfirmed(false) }} />
    <label className="flex gap-2 text-sm"><input type="checkbox" disabled={isBusy} checked={isConfirmed} onChange={e => setIsConfirmed(e.target.checked)} />确认给账户 #{account.router_user_id} 增加 ${amount || '0.00'}，原因和关联订单已核对</label>
    {error && <p role="alert" className="text-destructive">{error}</p>}<Button disabled={isBusy || !isConfirmed || !reason.trim() || !amount} onClick={() => void onSubmit()}>{isBusy ? '提交中…' : '确认充值'}</Button>
  </DialogContent></Dialog>
}

function RechargeDetail({ order, isOperator, onClose, onChanged, onCredit }: { order: OrganizationRechargeOrder; isOperator: boolean; onClose(): void; onChanged(): void; onCredit(): void }) {
  const [evidence, setEvidence] = useState('')
  const [outcome, setOutcome] = useState('unknown')
  const [isFinished, setIsFinished] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<{ payload: string; key: string } | null>(null)
  const isManual = order.source === 'manual'
  const resolution = order.resolution
  const onAction = async (action: 'takeover' | 'original_result' | 'close' | 'resolve' | 'retry') => {
    if (isBusy) return
    const body = { action, outcome, evidence, confirm_request_finished: isFinished }
    const payload = JSON.stringify(body)
    if (request.current?.payload !== payload) request.current = { payload, key: crypto.randomUUID() }
    setIsBusy(true); setError('')
    try { await modelBillingApi.reconcile(isManual ? 'credits' : 'orders', order.order_no, isManual ? action === 'retry' ? 'retry' : 'resolve' : 'resolution', body, request.current.key); onChanged() } catch (e) { setError((e as Error).message) } finally { setIsBusy(false) }
  }
  const canResolve = isManual ? ['sending', 'needs_review'].includes(order.credit_status) : order.payment_status === 'paid' && order.credit_status !== 'credited' && (!resolution?.is_manual || resolution.original_outcome === 'unknown')
  const audit = isManual ? order.audit : resolution?.audit
  return <Dialog open onOpenChange={open => { if (!open && !isBusy) onClose() }}><DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl"><DialogHeader><DialogTitle>充值详情 · {isManual ? '后台充值' : '富友在线充值'}</DialogTitle><DialogDescription>{order.order_no} · 账户 #{order.router_user_id}</DialogDescription></DialogHeader>
    <p>金额 ${order.purchase_amount_usd}{!isManual && ` + 赠送 $${order.bonus_amount_usd}`} · {creditLabels[order.credit_status]}</p>
    {order.reason && <p>原因：{order.reason}</p>}{order.related_order_no && <p className="break-all">关联订单：{order.related_order_no}</p>}
    {resolution && <div className="space-y-1 text-sm"><p>人工处理：{resolutionLabels[resolution.status]}</p><p>原应到账 ${resolution.expected_amount_usd} · 原确认到账 ${resolution.original_credited_usd}</p><p>人工累计到账 ${resolution.manual_credited_usd} · 差额 ${resolution.difference_usd}</p>{resolution.related_credits.map(c => <p key={c.credit_no}>{c.credit_no} · ${c.amount_usd} · {creditLabels[c.status] ?? c.status}</p>)}</div>}
    {order.attempts?.map(a => <p key={a.reference} className="text-xs break-all">到账尝试：{a.reference} · {creditLabels[a.status] ?? a.status} · {formatTime(a.created_at)}</p>)}
    {audit?.map((a, i) => <p key={i} className="text-xs">{formatTime(a.created_at)} · {a.actor_user_id} · {a.action}：{a.evidence}</p>)}
    {isOperator && <div className="space-y-3 border-t pt-3">
      <p className="text-xs text-muted-foreground">未知结果请核对远端原请求，不能仅凭余额判断。确认已到账仅修复记录；确认未执行后才允许再次加额。</p>
      <Label htmlFor="credit-evidence">处理原因 / 核对依据</Label><Input id="credit-evidence" value={evidence} disabled={isBusy} onChange={e => setEvidence(e.target.value)} maxLength={1000} />
      {canResolve && <><select aria-label="核对结果" className="w-full rounded border p-2" value={outcome} disabled={isBusy} onChange={e => setOutcome(e.target.value)}><option value="unknown">无法确认，保持待核对</option><option value="credited">已确认到账（只修复记录）</option><option value="not_executed">已确认原请求未执行</option></select><label className="flex gap-2 text-sm"><input type="checkbox" checked={isFinished} disabled={isBusy} onChange={e => setIsFinished(e.target.checked)} />已核实原请求结束，不会继续执行</label><Button disabled={isBusy || !evidence.trim() || outcome !== 'unknown' && !isFinished} onClick={() => void onAction(isManual ? 'resolve' : 'original_result')}>登记{isManual ? '' : '原入账'}核对结果</Button></>}
      <div className="flex gap-2 flex-wrap">
        {!isManual && order.payment_status === 'paid' && order.credit_status !== 'credited' && !resolution?.is_manual && <Button disabled={isBusy || !evidence.trim()} onClick={() => void onAction('takeover')}>转人工处理（关闭自动加额）</Button>}
        {!isManual && resolution?.is_manual && resolution.status !== 'closed' && <><Button disabled={isBusy || resolution.original_outcome !== 'not_executed' || resolution.unsettled_count > 0} onClick={onCredit}>关联后台充值</Button><Button variant="outline" disabled={isBusy || !evidence.trim() || resolution.original_outcome === 'unknown' || resolution.unsettled_count > 0 || Number(resolution.difference_usd) > 0} onClick={() => void onAction('close')}>登记处理完成</Button></>}
        {isManual && ['failed', 'pending'].includes(order.credit_status) && <Button disabled={isBusy} onClick={() => void onAction('retry')}>再次尝试到账（同一充值单）</Button>}
      </div>
    </div>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </DialogContent></Dialog>
}
