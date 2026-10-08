import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { modelBillingApi, type ModelAccount, type ModelToken, type ModelUsage } from '@/lib/api/model-billing'
import type { AuthUser } from '@/lib/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const statusLabels: Record<string, string> = { ready: '就绪', pending: '待开通', needs_review: '待核对', disabled: '已停用', active: '可用', exhausted: '额度不足', expired: '已过期', parent_disabled: '组织已停用', revoked: '已撤销' }
export function ModelAccountManagement({ orgId }: { orgId?: string | null }) {
  const [account, setAccount] = useState<ModelAccount>()
  const [service, setService] = useState<ModelToken>()
  const [limit, setLimit] = useState('')
  const [serviceAmount, setServiceAmount] = useState('')
  const operation = useRef<{ input: string; key: string } | null>(null)
  const onServiceAction = async (input: string, run: (key: string) => Promise<unknown>) => {
    if (operation.current?.input !== input) operation.current = { input, key: crypto.randomUUID() }
    await onAction(async () => { await run(operation.current!.key); operation.current = null })
  }
  const [error, setError] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const onRefresh = useCallback(async () => {
    setError('')
    try {
      const [data, members] = await Promise.all([modelBillingApi.account(), modelBillingApi.members()])
      setAccount(data); setService(members.find(m => m.purpose === 'service')); setLimit(data.default_member_limit_usd ?? '')
    } catch (e) { setAccount(undefined); setError((e as Error).message) }
  }, [])
  useEffect(() => { setAccount(undefined); void onRefresh() }, [orgId, onRefresh])
  const onAction = async (run: () => Promise<unknown>) => {
    setIsBusy(true)
    try { await run(); await onRefresh(); toast.success('已更新') } catch (e) { toast.error((e as Error).message) } finally { setIsBusy(false) }
  }
  return <section className="rounded-xl border p-4 space-y-3">
    <div className="flex items-center justify-between"><h3 className="font-semibold">组织模型账户</h3><Button variant="outline" disabled={isBusy} onClick={() => void onRefresh()}>刷新</Button></div>
    {error ? <p className="text-sm text-muted-foreground">{error}</p> : account && <>
      <p>余额 <strong>${account.model_balance_usd ?? '—'}</strong> · 累计使用 ${account.used_amount_usd ?? '—'} · {statusLabels[account.account_status] ?? account.account_status}</p>
      <p className="text-sm text-muted-foreground">组织成员共享账户余额；成员限额独立设置。充值请由组织管理员登录 Sudowork 充值中心操作。</p>
      <div className="flex items-end gap-3"><div className="space-y-1"><Label htmlFor="default-member-limit">新成员默认限额（USD，留空表示不限额）</Label><Input id="default-member-limit" value={limit} onChange={e => setLimit(e.target.value)} /></div><Button disabled={isBusy} onClick={() => void onAction(() => modelBillingApi.defaults(limit.trim() || null))}>保存默认限额</Button></div>
      <p className="text-xs text-muted-foreground">只影响后续创建和邀请码注册的成员，已有成员限额保持不变。</p>
      {service && <p className="text-sm">默认服务 Key：{service.key_masked ?? '未就绪'} · 剩余限额 ${service.remaining_limit_usd ?? '—'} · 已用 ${service.used_amount_usd ?? '—'} · {statusLabels[service.effective_status ?? service.provisioning_status]}</p>}
      {service?.token_id && <div className="flex items-end flex-wrap gap-2"><div><Label htmlFor="service-limit-delta">默认服务 Key 限额调整（USD）</Label><Input id="service-limit-delta" value={serviceAmount} onChange={e => setServiceAmount(e.target.value)} /></div><Button disabled={isBusy} variant="outline" onClick={() => void onServiceAction(`service-increase:${serviceAmount}`, key => modelBillingApi.serviceLimit(serviceAmount, 'increase', key))}>增加限额</Button><Button disabled={isBusy} variant="outline" onClick={() => void onServiceAction(`service-decrease:${serviceAmount}`, key => modelBillingApi.serviceLimit(serviceAmount, 'decrease', key))}>减少限额</Button><Button disabled={isBusy} variant="outline" onClick={() => { const status = service.admin_status === 'disabled' ? 'enabled' : 'disabled'; void onServiceAction(`service:${status}`, key => modelBillingApi.serviceStatus(status, key)) }}>{service.admin_status === 'disabled' ? '启用服务 Key' : '停用服务 Key'}</Button></div>}
      {['ready', 'disabled'].includes(account.account_status) && <Button disabled={isBusy} variant="outline" onClick={() => { const status = account.account_status === 'disabled' ? 'enabled' : 'disabled'; void onServiceAction(`account:${status}`, key => modelBillingApi.accountStatus(status, key)) }}>{account.account_status === 'disabled' ? '启用组织模型服务' : '停用组织模型服务'}</Button>}
      {account.account_status !== 'ready' && <><p className="text-sm">开户或入账结果不确定时需核对远端记录，重试不会重复加额。</p><Button disabled={isBusy} onClick={() => void onAction(modelBillingApi.retry)}>继续开户</Button></>}
    </>}
  </section>
}

export function ModelMemberDialog({ target, onClose, onChanged }: { target: AuthUser; onClose(): void; onChanged(): Promise<void> | void }) {
  const [token, setToken] = useState<ModelToken>()
  const [error, setError] = useState('')
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState('')
  const [remaining, setRemaining] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const request = useRef<{ payload: string; key: string } | null>(null)
  const onRefresh = useCallback(async () => {
    try { setToken((await modelBillingApi.members()).find(m => m.user_id === target.id)); setError('') } catch (e) { setError((e as Error).message) }
  }, [target.id])
  useEffect(() => { void onRefresh() }, [onRefresh])
  const onAction = async (payload: string, run: (reference: string) => Promise<unknown>) => {
    setIsBusy(true)
    if (request.current?.payload !== payload) request.current = { payload, key: crypto.randomUUID() }
    try { await run(request.current.key); request.current = null; await onRefresh(); await onChanged() } catch (e) { setError((e as Error).message) } finally { setIsBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent><DialogHeader><DialogTitle>{target.displayName || target.name} · 模型限额与 Key</DialogTitle><DialogDescription>调整成员限额不会充值或扣减组织账户余额。</DialogDescription></DialogHeader>
    {error && <p className="text-sm text-destructive">{error}</p>}
    {token && <div className="space-y-2"><p>状态：{statusLabels[token.effective_status ?? token.provisioning_status] ?? token.provisioning_status}</p><p>剩余限额：{token.unlimited ? '不限额' : `$${token.remaining_limit_usd ?? '—'}`}</p><p>累计用量：${token.used_amount_usd ?? '—'}</p><p>{token.key_masked}</p></div>}
    {token?.token_id ? <>
      <Label htmlFor="member-limit-mode">限额模式</Label>
      <select id="member-limit-mode" className="rounded border p-2" value={mode || (token.unlimited ? 'unlimited' : 'limited')} onChange={e => { setMode(e.target.value); setRemaining('') }} disabled={isBusy}>
        <option value="limited">限额</option><option value="unlimited">不限额</option>
      </select>
      {mode && (mode === 'unlimited') !== !!token.unlimited && <>
        {mode === 'limited' && <><Label htmlFor="member-new-remaining">新的剩余可用限额（USD，可为 0）</Label><Input id="member-new-remaining" value={remaining} onChange={e => setRemaining(e.target.value)} /></>}
        <p className="text-xs text-muted-foreground">不限额仍受组织余额约束。切回限额后从此金额继续消费，累计用量保留。</p>
        <Button disabled={isBusy || mode === 'limited' && !remaining} onClick={() => void onAction(`mode:${mode}:${remaining}`, ref => modelBillingApi.limitMode(target.id, mode === 'unlimited' ? null : remaining, ref))}>保存限额模式</Button>
      </>}
      {!token.unlimited && <><Label htmlFor="member-limit-delta">调整金额（USD）</Label><Input id="member-limit-delta" value={amount} onChange={e => setAmount(e.target.value)} placeholder="例如 5.00" /><div className="flex gap-2"><Button disabled={isBusy} onClick={() => void onAction(`increase:${amount}`, ref => modelBillingApi.limit(target.id, amount, 'increase', ref))}>增加限额</Button><Button variant="outline" disabled={isBusy} onClick={() => void onAction(`decrease:${amount}`, ref => modelBillingApi.limit(target.id, amount, 'decrease', ref))}>减少限额</Button></div></>}
      <Button variant="outline" disabled={isBusy || target.status !== 'active' && token.admin_status === 'disabled'} onClick={() => { const status = token.admin_status === 'disabled' ? 'enabled' : 'disabled'; void onAction(status, ref => modelBillingApi.status(target.id, status, ref)) }}>{token.admin_status === 'disabled' ? '启用 Key' : '停用 Key'}</Button>
    </> : <Button disabled={isBusy} onClick={() => void onAction('provision', () => modelBillingApi.provision(target.id))}>开通成员 Key</Button>}
  </DialogContent></Dialog>
}

export function ModelUsageDialog({ target, onClose }: { target: AuthUser; onClose(): void }) {
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [data, setData] = useState<ModelUsage>()
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    setData(undefined); setError('')
    void modelBillingApi.usage(target.id, page).then(value => { if (current) setData(value) }).catch(e => { if (current) setError((e as Error).message) })
    return () => { current = false }
  }, [target.id, page, revision])
  const token = data?.member
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-auto"><DialogHeader><DialogTitle>{target.displayName || target.name} · 模型使用情况</DialogTitle><DialogDescription>仅显示此成员 Key 的累计消费与明细，金额单位为 USD。</DialogDescription></DialogHeader>
    <Button variant="outline" onClick={() => setRevision(v => v + 1)}>刷新</Button>
    {error ? <p role="alert" className="text-destructive">{error}</p> : !data ? <p>正在加载…</p> : <>
      {token ? <div className="space-y-1 text-sm"><p>Token #{token.token_id} · {token.token_name} · {token.key_masked}</p><p>状态：{statusLabels[token.effective_status ?? ''] ?? token.effective_status} · {token.admin_status === 'disabled' ? '已停用' : '已启用'}</p><p>剩余限额：{token.unlimited ? '不限额' : `$${token.remaining_limit_usd}`} · 累计消费：${token.used_amount_usd}</p></div> : <p>模型凭据尚未就绪</p>}
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['时间', '模型', '输入 Token', '输出 Token', '费用 USD', '耗时（秒）'].map(label => <th key={label} className="p-2 text-left">{label}</th>)}</tr></thead><tbody>{data.items.map(row => <tr key={row.id} className="border-t"><td className="p-2 whitespace-nowrap">{new Date(row.created_at * 1000).toLocaleString()}</td><td>{row.model_name}</td><td>{row.input_tokens}</td><td>{row.output_tokens}</td><td>${row.amount_usd}</td><td>{row.duration ?? '—'}</td></tr>)}</tbody></table></div>
      {!data.items.length && <p className="text-muted-foreground">暂无使用明细</p>}
      <div className="flex items-center justify-between"><span>共 {data.total} 条 · 第 {page} 页</span><div className="flex gap-2"><Button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</Button><Button disabled={page * 20 >= data.total} onClick={() => setPage(p => p + 1)}>下一页</Button></div></div>
    </>}
  </DialogContent></Dialog>
}
