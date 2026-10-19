import { ExternalAgentRegistryStatus } from './external-agent-registry-status'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { createExternalAgentsApi, type ExternalAgentAdmin, type AgentVersionsPage } from '@/lib/api/external-agents'
import { externalAgentError } from '@/lib/external-agent-errors'

export function ExternalAgentVersions({ agent, onClose }: { agent: ExternalAgentAdmin; onClose: () => void }) {
  const controller = useRef(new AbortController())
  const api = useMemo(() => createExternalAgentsApi(undefined, () => controller.current.signal), [])
  const busy = useRef(false)
  const [page, setPage] = useState<AgentVersionsPage | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const [revoke, setRevoke] = useState<string | null>(null)
  const reload = useCallback(async (after = '') => {
    const data = await api.versions(agent.id, after)
    if (!controller.current.signal.aborted) setPage(current => after && current ? { ...data, items: [...current.items, ...data.items] } : data)
  }, [api, agent.id])
  useEffect(() => {
    if (controller.current.signal.aborted) controller.current = new AbortController()
    const current = controller.current
    void reload().catch(cause => { if (!current.signal.aborted) setError(externalAgentError(cause)) })
    return () => current.abort()
  }, [reload])
  async function run(action: () => Promise<unknown>, message: string, refresh = true) {
    if (busy.current) return
    busy.current = true; setIsBusy(true); setError(''); setNotice('')
    try {
      await action(); if (refresh) await reload()
      if (!controller.current.signal.aborted) { setNotice(message); setRevoke(null) }
    } catch (cause) {
      if (!controller.current.signal.aborted) setError(externalAgentError(cause))
    } finally { busy.current = false; if (!controller.current.signal.aborted) setIsBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy.current) onClose() }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{agent.name} · 版本与频道</DialogTitle>
        <DialogDescription>发布固定来源版本，再将 stable 或 canary 指向该版本。新会话默认使用当前频道；已有会话保持首次使用的版本，切换版本需新建会话。</DialogDescription>
      </DialogHeader>
      <ExternalAgentRegistryStatus agentId={agent.id} onMigrated={() => { void run(() => reload(), '迁移已完成，版本目录已刷新。') }} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {!page ? error ? <Button variant="outline" disabled={isBusy} onClick={() => void run(() => reload(), '', false)}>重新加载</Button> : <p role="status" className="text-sm text-muted-foreground">正在加载版本…</p> : <>
        <p className="break-all text-xs text-muted-foreground">身份：nexus://{page.principal.trust_domain}/agent/{page.principal.agent_name}</p>
        <div className="space-y-2 rounded-md border p-3">
          {(['stable', 'canary'] as const).map(name => {
            const channel = page.channels.find(c => c.name === name)
            return <p key={name} className="break-all text-sm"><strong>{name}</strong>：{channel ? `${channel.version}${channel.enabled ? '' : '（已停用）'}` : '未发布'}</p>
          })}
        </div>
        <form className="space-y-3 rounded-md border p-3" onSubmit={event => {
          event.preventDefault()
          void run(() => api.publishVersion(agent.id, { revision: agent.revision, version: label.trim(), note: note.trim() }), '版本已发布，可在下方选择发布频道。')
        }}>
          <Label htmlFor="external-version-label">为当前已审核配置发布版本</Label>
          <Input id="external-version-label" value={label} onChange={e => setLabel(e.target.value)} maxLength={128} placeholder="例如 1.0.0 或 1.1.0-rc.1" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" disabled={isBusy || !agent.approved} />
          <Label htmlFor="external-version-note">发布或撤销说明</Label>
          <Textarea id="external-version-note" value={note} onChange={e => setNote(e.target.value)} maxLength={2000} required placeholder="说明版本变化、审核依据或撤销原因" disabled={isBusy} />
          <Button type="submit" disabled={isBusy || !agent.approved || !label.trim() || !note.trim()}>发布不可变版本</Button>
          {!agent.approved && <p className="text-xs text-muted-foreground">当前配置尚未审核，请先完成审核发布。</p>}
        </form>
        <div className="space-y-3">
          {!page.items.length && <p className="text-sm text-muted-foreground">尚未发布版本。完成当前配置审核后即可发布。</p>}
          {page.items.map(version => {
            const revoked = version.decisions.some(d => d.decision === 'revoked')
            const approved = !revoked && version.decisions.some(d => d.decision === 'approved' && d.expires_at > Date.now())
            return <article key={version.version} className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2"><strong className="break-all text-sm">{version.version}</strong><Badge variant="outline">{revoked ? '已撤销' : version.decisions[0]?.decision === 'withdrawn' ? '已撤回批准' : approved ? '已批准' : '未批准或已过期'}</Badge><Badge variant="secondary">{version.snapshot.sourceManifest?.execution_revision ? '执行版本锁定' : '来源快照'}</Badge></div>
              <p className="break-all text-xs text-muted-foreground">来源：{version.snapshot.source_digest}</p>
              {version.registry && <div className="space-y-1 text-xs text-muted-foreground">
                <Badge variant="outline">Nexus 登记签名已验证</Badge>
                <p className="break-all">登记摘要：{version.registry.registration_digest}</p>
                <p>登记签名证明版本登记信息；远端执行版本保证仍取决于 Provider。</p>
              </div>}
              <p className="text-xs text-muted-foreground">发布于 {new Date(version.created_at).toLocaleString()} · {version.created_by}</p>
              {!version.snapshot.sourceManifest?.execution_revision && <p className="text-xs text-muted-foreground">此来源未提供远端不可变执行保证；运行前仍需核对来源。</p>}
              <div className="flex flex-wrap gap-2">
                {(['stable', 'canary'] as const).map(name => <Button key={name} size="sm" variant="outline" disabled={isBusy || !approved || agent.archived} onClick={() => void run(() => api.moveChannel(agent.id, { name, version: version.version, revision: page.channels.find(c => c.name === name)?.revision ?? 0 }), `${name} 已切换到 ${version.version}。`)}>设为 {name}</Button>)}
                <Button size="sm" variant="ghost" disabled={isBusy || revoked} onClick={() => setRevoke(version.version)}>撤销版本</Button>
              </div>
            </article>
          })}
        </div>
        {page.next_cursor && <Button variant="outline" disabled={isBusy} onClick={() => { void run(() => reload(page.next_cursor!), '已加载更多版本。', false) }}>加载更多版本</Button>}
        {revoke && <div className="space-y-3 rounded-md border border-destructive p-3">
          <p className="break-all text-sm">确认撤销 {revoke}？此版本将禁止新任务，指向它的频道会停用。已经派发的远端任务不保证被取消。</p>
          <p className="text-xs text-muted-foreground">请在上方填写撤销说明；撤销后不能重新批准同一版本。</p>
          <Button variant="destructive" disabled={isBusy || !note.trim()} onClick={() => void run(() => api.revokeVersion(agent.id, { version: revoke, note: note.trim() }), '版本已撤销。')}>确认撤销</Button>
          <Button variant="ghost" disabled={isBusy} onClick={() => setRevoke(null)}>返回</Button>
        </div>}
      </>}
    </DialogContent>
  </Dialog>
}
