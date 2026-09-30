import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { modelBillingApi, type ModelAccount, type ModelToken } from '@/lib/api/model-billing'
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
      {!token.unlimited && <><Label htmlFor="member-limit-delta">调整金额（USD）</Label><Input id="member-limit-delta" value={amount} onChange={e => setAmount(e.target.value)} placeholder="例如 5.00" /><div className="flex gap-2"><Button disabled={isBusy} onClick={() => void onAction(`increase:${amount}`, ref => modelBillingApi.limit(target.id, amount, 'increase', ref))}>增加限额</Button><Button variant="outline" disabled={isBusy} onClick={() => void onAction(`decrease:${amount}`, ref => modelBillingApi.limit(target.id, amount, 'decrease', ref))}>减少限额</Button></div></>}
      <Button variant="outline" disabled={isBusy || target.status !== 'active' && token.admin_status === 'disabled'} onClick={() => { const status = token.admin_status === 'disabled' ? 'enabled' : 'disabled'; void onAction(status, ref => modelBillingApi.status(target.id, status, ref)) }}>{token.admin_status === 'disabled' ? '启用 Key' : '停用 Key'}</Button>
    </> : <Button disabled={isBusy} onClick={() => void onAction('provision', () => modelBillingApi.provision(target.id))}>开通成员 Key</Button>}
  </DialogContent></Dialog>
}
