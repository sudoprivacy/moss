import { useCallback, useEffect, useState } from 'react'
import { PublicationSubmitButton } from './publication-submit-button'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SourceEditor } from './external-agent-catalog'
import { createAgentCatalogApi, type CatalogSource, type ImportCandidate } from '@/lib/api/agent-catalog'
import { createExternalAgentsApi } from '@/lib/api/external-agents'
import { useAuth } from '@/lib/hooks/use-auth'

const api = createAgentCatalogApi()
const statusNames: Record<string, string> = { draft: '草稿', pending_approval: '待审核', approved: '待发布', rejected: '已驳回', published: '已发布', archived: '已归档' }

export function DepartmentServiceReviews() {
  const { activeOrgId } = useAuth()
  const [items, setItems] = useState<ImportCandidate[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    const controller = new AbortController(), scoped = createAgentCatalogApi(() => controller.signal)
    setItems([]); setError('')
    void (async () => {
      let after = ''; const rows: ImportCandidate[] = []
      do { const page = await scoped.candidates(after, '', { status: 'pending_approval' }); rows.push(...page.items); after = page.next_cursor || '' } while (after)
      if (!controller.signal.aborted) setItems(rows)
    })().catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取审核版本失败') })
    return () => controller.abort()
  }, [activeOrgId, generation])
  return <section className="space-y-3">
    <h3 className="font-semibold">服务专家审核</h3>
    <p className="text-sm text-muted-foreground">显示管理部门范围内的待审核版本，审核通过后由组织管理员发布。</p>
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    {items.map(item => <div key={item.id} className="space-y-2 rounded-lg border p-4">
      <div className="font-medium">{item.snapshot.name} · {item.snapshot.protocol}</div>
      {item.requested_version && <p className="text-sm">提交版本：{item.requested_version}</p>}
      {item.release_note && <p className="text-sm whitespace-pre-wrap">更新说明：{item.release_note}</p>}
      <p className="text-sm">授权范围：{item.snapshot.user_ids.join('、')}</p>
      {item.changes.map(change => <p key={change.field} className="text-sm">{change.field}：{change.before || '无'} → {change.after || '无'}</p>)}
      <div className="flex gap-2">{(['approve', 'reject'] as const).map(action => <Button key={action} disabled={busy} variant={action === 'approve' ? 'default' : 'outline'} onClick={async () => {
        setBusy(true); setError('')
        try { await api.decide(item, action, action === 'approve' ? '部门管理员审核通过，等待组织管理员正式发布' : '部门管理员驳回，请修改配置后重新提交'); setGeneration(value => value + 1) }
        catch (cause) { setError(cause instanceof Error ? cause.message : '审核失败') } finally { setBusy(false) }
      }}>{action === 'approve' ? '审核通过' : '驳回'}</Button>)}</div>
    </div>)}
    {!items.length ? <p className="text-sm text-muted-foreground">暂无待审核服务专家</p> : null}
  </section>
}
export function ServiceExpertEditor({ source, onClose, onSaved }: { source: CatalogSource; onClose: () => void; onSaved: () => void }) {
  const [endpoints, setEndpoints] = useState<string[]>([])
  useEffect(() => { let live = true; void createExternalAgentsApi().policy().then(policy => { if (live) setEndpoints(policy.endpoints) }).catch(() => {}); return () => { live = false } }, [])
  return <SourceEditor source={source} endpoints={endpoints} onClose={onClose} onSave={async change => {
    await api.update(source, change)
    onSaved()
    window.dispatchEvent(new Event('expert-library-changed'))
  }} />
}

/** Personal sources are separate from immutable, currently published versions. */
export function MyServiceExperts({ query, refreshKey }: { query: string; refreshKey: number }) {
  const { user, activeOrgId } = useAuth()
  const [sources, setSources] = useState<CatalogSource[]>([])
  const [candidates, setCandidates] = useState<ImportCandidate[]>([])
  const [editing, setEditing] = useState<CatalogSource | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [generation, setGeneration] = useState(0)
  const reload = useCallback(() => setGeneration(value => value + 1), [])
  useEffect(() => { window.addEventListener('expert-library-changed', reload); return () => window.removeEventListener('expert-library-changed', reload) }, [reload])
  useEffect(() => {
    const controller = new AbortController(), scoped = createAgentCatalogApi(() => controller.signal)
    setSources([]); setCandidates([]); setError('')
    void (async () => {
      const access = await createExternalAgentsApi(undefined, controller.signal).access()
      if (!access.can_manage && !access.can_create) return
      let after = ''; const rows: CatalogSource[] = []
      do { const page = await scoped.sources(after, { owner: user?.id }); rows.push(...page.items.filter(row => row.owner_id === user?.id)); after = page.next_cursor || '' } while (after)
      const versions = await Promise.all(rows.map(async row => {
        let cursor = ''; const result: ImportCandidate[] = []
        do { const page = await scoped.candidates(cursor, row.id); result.push(...page.items); cursor = page.next_cursor || '' } while (cursor)
        return result
      }))
      if (!controller.signal.aborted) { setSources(rows); setCandidates(versions.flat()) }
    })().catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取我的专家失败') })
    return () => controller.abort()
  }, [user?.id, activeOrgId, refreshKey, generation])
  async function submit(source: CatalogSource, version: string, note: string) {
    setBusy(true); setError('')
    try {
      const rejected = candidates.some(candidate => candidate.source_id === source.id && candidate.validation.source_revision === source.revision && candidate.status === 'rejected')
      const sync = await api.sync(source, rejected, rejected ? '修改或复核后重新提交专家版本审核' : '')
      if (sync.status !== 'succeeded' || !sync.candidate_id) throw new Error(sync.error || '服务校验失败，请检查接入配置')
      const page = await api.candidates('', source.id)
      const candidate = page.items.find(item => item.id === sync.candidate_id)
      if (!candidate) throw new Error('未找到待提交版本，请刷新后重试')
      if (candidate.status === 'draft') await api.decide(candidate, 'submit', note, 7, version)
      reload()
    } finally { setBusy(false) }
  }
  return <>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <div className="grid gap-4 md:grid-cols-2">{sources.filter(source => source.name.toLowerCase().includes(query.trim().toLowerCase())).map(source => {
      const latest = candidates.filter(item => item.source_id === source.id && item.validation.source_revision === source.revision).sort((a, b) => b.created_at - a.created_at)[0]
      return <div key={source.id} className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2"><span className="font-medium">{source.name}</span><Badge variant="outline">{source.protocol}</Badge><Badge variant="secondary">{latest ? statusNames[latest.status] || latest.status : '草稿'}</Badge></div>
        <p className="my-3 text-sm text-muted-foreground">个人服务配置 · 发布后更新可用专家</p>
        {latest?.requested_version ? <p className="text-sm">提交版本：{latest.requested_version}</p> : null}
        {latest?.release_note ? <p className="my-2 text-sm text-muted-foreground">更新说明：{latest.release_note}</p> : null}
        <div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing(source)}>编辑</Button>
          {(!latest || ['draft', 'rejected'].includes(latest.status)) ? <PublicationSubmitButton disabled={busy} loadPreview={() => api.publicationPreview(source.id)} onSubmit={(version, note) => submit(source, version, note)} /> : null}</div>
      </div>
    })}</div>
    {editing ? <ServiceExpertEditor key={editing.id} source={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload() }} /> : null}
  </>
}
