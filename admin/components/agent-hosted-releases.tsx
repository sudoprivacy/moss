import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { createInventoryApi, type AssetRecord, type HostedArtifact, type NativeConversion, type HostedReleaseAction, type HostedReleaseView, type InventoryMember } from '@/lib/api/agent-inventory'
import { hostedArtifactAdmitted, inventoryError } from '@/lib/agent-inventory-labels'

export function AgentHostedReleases({ asset, artifacts, canManage }: { asset: AssetRecord; artifacts: (HostedArtifact | NativeConversion)[]; canManage: boolean }) {
  const controller = useRef(new AbortController())
  const api = useMemo(() => createInventoryApi(undefined, () => controller.current.signal), [])
  const [view, setView] = useState<HostedReleaseView | null>(null)
  const [busy, setBusy] = useState(false), gate = useRef(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [version, setVersion] = useState(''), [artifactId, setArtifactId] = useState(''), [reason, setReason] = useState('')
  const [users, setUsers] = useState<string[]>([]), [members, setMembers] = useState<InventoryMember[]>([])
  const [search, setSearch] = useState(''), [memberCursor, setMemberCursor] = useState<string | null>(null)
  const admitted = asset.status === 'approved' && ['L2', 'L3'].includes(asset.actual_level)
  const candidates = artifacts.filter(item => hostedArtifactAdmitted(asset, item))
  useEffect(() => {
    if (controller.current.signal.aborted) controller.current = new AbortController()
    const current = controller.current
    void api.hostedReleases(asset.id).then(result => { setView(result); setUsers(result.catalog?.visible_to?.user_ids ?? []) })
      .catch(cause => { if (!current.signal.aborted) setError(inventoryError(cause)) })
    return () => current.abort()
  }, [api, asset.id])
  async function perform(work: () => Promise<void>) {
    if (gate.current) return
    gate.current = true; setBusy(true); setError(''); setNotice('')
    try { await work() } catch (cause) { if (!controller.current.signal.aborted) setError(inventoryError(cause)) }
    finally { gate.current = false; if (!controller.current.signal.aborted) setBusy(false) }
  }
  async function action(body: HostedReleaseAction) {
    await api.hostedReleaseAction(asset.id, body)
    const result = await api.hostedReleases(asset.id)
    setView(result); setUsers(result.catalog?.visible_to?.user_ids ?? [])
    setNotice(body.action === 'visibility' ? body.enabled ? '已保存使用权限。' : '已关闭目录入口。' : '操作已保存，版本和频道状态已刷新。')
  }
  async function loadMembers(after = '') {
    const page = await api.members(search, after)
    setMembers(page.items); setMemberCursor(page.next_cursor)
  }
  return <section className="space-y-3 rounded-lg border p-4" aria-label="内部托管发布与授权">
    <h3 className="font-medium">发布与授权</h3>
    <p className="text-sm text-muted-foreground">固定制品版本经审核并切换到 stable 频道后，可授权成员从专属智能体使用。登记目录不改变纳管等级。</p>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {!admitted && <p className="text-sm text-amber-700">当前等级 {asset.actual_level}。须完成 {asset.metadata.source_platform === 'native' ? 'L3 原生' : 'L2 运行'}验收和台账审核后，才能发布及开放使用。</p>}
    {canManage && (!view?.linked || !view?.registry) && <Button disabled={busy || !view} variant="outline" onClick={() => void perform(() => action({ action: 'enroll' }))}>登记托管目录</Button>}
    {view?.catalog && <>
      <p className="text-sm">目录入口：{view.catalog.enabled ? '已开启' : '已关闭'} · 注册身份：{view.registry?.principal.status === 'active' ? '有效' : '不可用'}</p>
      {view.registry?.channels.map(item => <p key={item.name} className="text-sm">{item.name} → {item.version}（{item.enabled ? '已启用' : '已停用'}）</p>)}
      {canManage && <div className="grid gap-3">
        <label className="grid gap-1 text-sm">发布制品<select aria-label="发布制品" className="rounded-md border bg-background p-2" value={artifactId} disabled={busy} onChange={e => setArtifactId(e.target.value)}>
          <option value="">请选择已验收制品</option>{candidates.map(item => <option key={item.id} value={item.id}>{item.image.model_name} · {new Date(item.created_at).toLocaleString()} · {item.id.slice(0, 8)}</option>)}
        </select></label>
        <label className="grid gap-1 text-sm">新版本号<Input value={version} maxLength={128} disabled={busy} onChange={e => setVersion(e.target.value)} placeholder="例如 v1.0.0" /></label>
        <Button className="justify-self-start" disabled={busy || !admitted || !artifactId || !version.trim()} onClick={() => void perform(() => action({ action: 'publish', artifact_id: artifactId, version: version.trim() }))}>发布待审版本</Button>
        <label className="grid gap-1 text-sm">审核或切换理由<Input value={reason} maxLength={2000} disabled={busy} onChange={e => setReason(e.target.value)} /></label>
      </div>}
      {!view.registry?.items.length && <p className="text-sm text-muted-foreground">尚无已发布版本。</p>}
      {view.registry?.items.map(item => <article key={item.version.digest} className="space-y-2 rounded-md border p-3">
        <p className="text-sm font-medium">{item.version.manifest.version} · {item.decision?.decision === 'approved' ? (item.decision.expires_at ?? 0) > Date.now() ? '已审核' : '审核已过期' : item.decision?.decision === 'revoked' ? '已撤销' : '待审核'}</p>
        {item.decision?.expires_at && <p className="text-xs text-muted-foreground">审核有效期至 {new Date(item.decision.expires_at).toLocaleString()}</p>}
        {canManage && <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy || !admitted || !reason.trim() || item.decision?.decision === 'revoked'} onClick={() => void perform(() => action({ action: 'decide', version: item.version.manifest.version, decision: 'approved', reason, expires_at: Date.now() + 86400000 }))}>审核通过（1 天）</Button>
          <Button size="sm" variant="outline" disabled={busy || !admitted || !reason.trim() || item.decision?.decision !== 'approved'} onClick={() => void perform(() => action({ action: 'channel', version: item.version.manifest.version, channel: 'stable', revision: view.registry?.channels.find(c => c.name === 'stable')?.revision ?? 0, reason }))}>切换到 stable</Button>
          <Button size="sm" variant="outline" disabled={busy || !reason.trim() || item.decision?.decision === 'revoked'} onClick={() => void perform(() => action({ action: 'decide', version: item.version.manifest.version, decision: 'revoked', reason }))}>撤销版本</Button>
        </div>}
      </article>)}
      {view.registry?.next_cursor && <Button variant="outline" disabled={busy} onClick={() => void perform(async () => {
        const next = await api.hostedReleases(asset.id, view.registry!.next_cursor!)
        setView(previous => ({ ...next, registry: next.registry && { ...next.registry, items: [...(previous?.registry?.items ?? []), ...next.registry.items] } }))
      })}>加载更多版本</Button>}
      {canManage && <fieldset className="space-y-2 border-t pt-3" disabled={busy}>
        <legend className="text-sm font-medium">组织成员使用权限</legend>
        <div className="flex gap-2"><Input aria-label="查找授权成员" placeholder="姓名或邮箱" maxLength={100} value={search} onChange={e => setSearch(e.target.value)} /><Button variant="outline" onClick={() => void perform(() => loadMembers())}>查找成员</Button></div>
        <p className="text-xs text-muted-foreground">已选择 {users.length} 位成员；翻页和查找会保留选择。</p>
        <div className="max-h-40 space-y-2 overflow-y-auto">{members.map(member => <label key={member.id} className="flex items-center gap-2 text-sm"><Checkbox checked={users.includes(member.id)} onCheckedChange={checked => setUsers(previous => checked === true ? [...new Set([...previous, member.id])] : previous.filter(id => id !== member.id))} />{member.name}</label>)}</div>
        {users.filter(id => !members.some(m => m.id === id)).map(id => <Button key={id} size="sm" variant="outline" onClick={() => setUsers(previous => previous.filter(value => value !== id))}>移除 {id}</Button>)}
        {memberCursor && <Button variant="outline" onClick={() => void perform(() => loadMembers(memberCursor))}>下一页成员</Button>}
        <div className="flex gap-2"><Button disabled={busy || !admitted || !users.length} onClick={() => void perform(() => action({ action: 'visibility', enabled: true, user_ids: users }))}>保存授权并开放入口</Button><Button variant="outline" onClick={() => void perform(() => action({ action: 'visibility', enabled: false, user_ids: users }))}>关闭目录入口</Button></div>
      </fieldset>}
    </>}
  </section>
}
