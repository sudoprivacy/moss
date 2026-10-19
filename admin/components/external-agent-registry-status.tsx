import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { createExternalAgentsApi, type RegistryStatus, type RegistryMigrationPlan } from '@/lib/api/external-agents'
import { externalAgentError } from '@/lib/external-agent-errors'

export function ExternalAgentRegistryStatus({ agentId, onMigrated }: { agentId: string; onMigrated: () => void }) {
  const controller = useRef(new AbortController())
  const api = useMemo(() => createExternalAgentsApi(undefined, () => controller.current.signal), [])
  const [status, setStatus] = useState<RegistryStatus | null>(null)
  const [plan, setPlan] = useState<RegistryMigrationPlan | null>(null)
  const [error, setError] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [isConfirmed, setIsConfirmed] = useState(false)
  const busy = useRef(false)
  useEffect(() => {
    if (controller.current.signal.aborted) controller.current = new AbortController()
    const active = controller.current
    void api.registryStatus(agentId).then(value => { if (!active.signal.aborted) setStatus(value) }).catch(cause => { if (!active.signal.aborted) setError(externalAgentError(cause)) })
    return () => active.abort()
  }, [agentId, api])
  async function run(action: () => Promise<void>) {
    if (busy.current) return
    busy.current = true; setIsBusy(true); setError('')
    try { await action() } catch (cause) { if (!controller.current.signal.aborted) setError(externalAgentError(cause)) }
    finally { busy.current = false; if (!controller.current.signal.aborted) setIsBusy(false) }
  }
  return <section className="space-y-2 rounded-md border p-3" aria-label="版本注册中心">
    <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">版本注册中心</strong>
      {status && <Badge variant="outline">{status.authority === 'nexus_registry' ? status.state === 'active' ? 'Nexus 已启用' : '迁移待完成' : 'Moss 现有目录'}</Badge>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {status?.state === 'active' && <p className="text-xs text-muted-foreground">版本审批、频道和撤销状态以 Nexus 为准。无法读取有效审批时暂停执行。</p>}
    {status?.state === 'preparing' && <p role="status" className="text-sm">迁移尚未完成，此智能体暂停接收新任务。恢复连接后可重新检查并继续迁移。</p>}
    {status && status.state !== 'active' && (status.configured ? <>
      <p className="text-xs text-muted-foreground">迁移会保留历史版本和会话。先检查任务，再由运维在维护窗口停止旧版本服务并启用维护模式。</p>
      <Button type="button" size="sm" variant="outline" disabled={isBusy} onClick={() => void run(async () => {
        const next = await api.registryPlan(agentId)
        if (!controller.current.signal.aborted) { setPlan(next); setIsConfirmed(false) }
      })}>检查迁移条件</Button>
      {plan && <div className="space-y-2 text-sm">
        <p>待保留版本：{plan.version_count}；未结束或待核对任务：{plan.active_tasks}</p>
        <p className="break-all text-xs text-muted-foreground">目标身份：{plan.principal.trust_domain}/{plan.principal.agent_name}</p>
        {!status.maintenance && <p className="text-xs text-muted-foreground">当前未启用维护模式，仅可检查，暂不能执行迁移。</p>}
        {status.maintenance && <>
          <label className="flex items-start gap-2"><input type="checkbox" checked={isConfirmed} disabled={isBusy} onChange={event => setIsConfirmed(event.target.checked)} />已停止旧版本服务，确认当前处于维护窗口。</label>
          <Button type="button" size="sm" disabled={isBusy || !isConfirmed || plan.active_tasks > 0} onClick={() => void run(async () => {
            await api.migrateRegistry(agentId, plan.plan_digest)
            const current = await api.registryStatus(agentId)
            if (!controller.current.signal.aborted) { setStatus(current); setPlan(null); onMigrated() }
          })}>{isBusy ? '正在核对并迁移…' : '备份记录并迁移'}</Button>
        </>}
      </div>}
    </> : <p className="text-xs text-muted-foreground">{status.authority === 'nexus_registry' ? '此智能体要求统一注册中心，请恢复配置后继续注册。当前不能使用旧目录发布或执行。' : '统一注册中心尚未配置，当前继续使用已有版本目录。'}</p>)}
  </section>
}
