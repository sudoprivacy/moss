import { ServiceExpertEditor } from './my-service-experts'
import { createAgentCatalogApi, type CatalogSource } from '@/lib/api/agent-catalog'
import { createExternalAgentsApi } from '@/lib/api/external-agents'
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { dcClient } from '@/lib/api/client'
import { useAuth } from '@/lib/hooks/use-auth'
import type { ExternalAgent, ExternalAgentPage } from '../../contracts/external-provider/v1/contract'

type VersionedExternalAgent = ExternalAgent & { publishedVersion?: string | null }

/** Published service experts share the available catalog without exposing governance controls. */
export function AvailableServiceExperts({ query, refreshKey }: { query: string; refreshKey: number }) {
  const { user, activeOrgId } = useAuth()
  const canEdit = ['admin', 'super_admin', 'dept_admin'].includes(user?.role || '')
  const [items, setItems] = useState<VersionedExternalAgent[]>([])
  const [editing, setEditing] = useState<CatalogSource | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<VersionedExternalAgent | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setItems([])
    setSelected(null)
    setError('')
    void (async () => {
      const management = createExternalAgentsApi(undefined, controller.signal)
      const access = await management.access()
      let cursor = ''
      const result: VersionedExternalAgent[] = []
      do {
        if (access.can_manage) {
          const page = await management.listPage(cursor)
          const catalog = await createAgentCatalogApi(() => controller.signal).summaries(page.items.map(item => item.id))
          const published = new Map(catalog.filter(item => item.status === 'active').map(item => [item.catalog_id, item.published_version]))
          result.push(...page.items.filter(item => published.has(item.id)).map(item => ({ ...item, publishedVersion: published.get(item.id) })))
          cursor = page.next_cursor || ''
          continue
        }
        const response = await dcClient.get<{ success: boolean; data: ExternalAgentPage }>(`/api/v1/external-agents?paged=1&after=${encodeURIComponent(cursor)}`, { signal: controller.signal })
        if (!response.success) throw new Error('读取服务专家失败')
        result.push(...await Promise.all(response.data.items.map(async item => {
          try {
            const versions = await dcClient.get<{ success: boolean; data: { channels: { name: string; enabled: boolean; version: string }[] } }>(`/api/v1/external-agents/${encodeURIComponent(item.id)}/versions`, { signal: controller.signal })
            return { ...item, publishedVersion: versions.success ? versions.data.channels.find(channel => channel.name === 'stable' && channel.enabled)?.version : undefined }
          } catch { return item }
        })))
        cursor = response.data.next_cursor || ''
      } while (cursor && !controller.signal.aborted)
      if (!controller.signal.aborted) setItems(result)
    })().catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取服务专家失败') })
    return () => controller.abort()
  }, [user?.id, activeOrgId, refreshKey])
  const visible = items.filter(item => item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  if (!visible.length && !error) return null
  return <>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <div className="grid gap-4 md:grid-cols-2">
      {visible.map(item => <button key={item.id} type="button" className="rounded-xl border bg-card p-4 text-left hover:bg-accent/30" onClick={() => setSelected(item)}>
        <div className="flex items-center gap-2"><span className="font-medium">{item.name}</span><Badge variant="outline">{item.protocol || (item.provider === 'dify' ? 'Dify' : '外部 API')}</Badge></div>
        {item.publishedVersion ? <Badge variant="outline" className="mt-2">版本 {item.publishedVersion}</Badge> : null}
        <p className="mt-2 text-sm text-muted-foreground">已发布 · 服务专家</p>
      </button>)}
    </div>
    <Dialog open={selected !== null} onOpenChange={open => { if (!open) setSelected(null) }}>
      <DialogContent><DialogHeader><DialogTitle>{selected?.name}</DialogTitle><DialogDescription>已发布的服务专家</DialogDescription></DialogHeader>
        {selected?.publishedVersion ? <p className="text-sm">版本：{selected.publishedVersion}</p> : null}
        <p className="text-sm">类型：{selected?.protocol || selected?.provider}</p>
        {canEdit ? <p className="text-sm text-muted-foreground">编辑后保存到我的专家，提交审核并发布后更新可用版本。</p> : null}
        {canEdit ? <Button disabled={busy} onClick={async () => {
          if (!selected) return
          setBusy(true)
          try {
            const detail = await createAgentCatalogApi().agent(selected.id)
            if (!detail.source) throw new Error('此专家尚未建立版本来源，请先在审核与发布中接管来源')
            const draft = await createAgentCatalogApi().draft(selected.id)
            setEditing(draft); setSelected(null)
          } catch (cause) { setError(cause instanceof Error ? cause.message : '读取专家失败') } finally { setBusy(false) }
        }}>编辑</Button> : null}
        <Button variant="outline" onClick={() => setSelected(null)}>关闭</Button>
      </DialogContent>
    </Dialog>
    {editing ? <ServiceExpertEditor source={editing} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} /> : null}
  </>
}
