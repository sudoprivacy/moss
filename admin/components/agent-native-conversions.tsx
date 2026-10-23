import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { createInventoryApi, type AssetRecord, type HostedArtifact, type NativeConversion, type NativeImage } from '@/lib/api/agent-inventory'
import { hostedArtifactAdmitted, inventoryError } from '@/lib/agent-inventory-labels'
import { AgentHostedReleases } from './agent-hosted-releases'
import { AgentHostedEvaluations } from './agent-hosted-evaluations'
import { AgentEvaluationDatasets } from './agent-evaluation-datasets'

export function AgentNativeConversions({ asset, canManage, onClose }: { asset: AssetRecord; canManage: boolean; onClose: () => void }) {
  const controller = useRef(new AbortController()), generation = useRef(0)
  const api = useMemo(() => createInventoryApi(undefined, () => controller.current.signal), [])
  const [records, setRecords] = useState<NativeConversion[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [sources, setSources] = useState<AssetRecord[]>([]), [sourceCursor, setSourceCursor] = useState<string | null>(null)
  const [sourceId, setSourceId] = useState(''), [artifacts, setArtifacts] = useState<HostedArtifact[]>([])
  const [artifactId, setArtifactId] = useState(''), [artifactCursor, setArtifactCursor] = useState<string | null>(null)
  const [image, setImage] = useState<NativeImage | null>(null), [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  useEffect(() => {
    const current = new AbortController(); controller.current = current
    setBusy(true)
    void Promise.all([api.nativeList(asset.id), canManage ? api.list() : Promise.resolve({ items: [], next_cursor: null })])
      .then(([native, source]) => { if (!current.signal.aborted) { setRecords(native.items); setCursor(native.next_cursor); setSources(source.items); setSourceCursor(source.next_cursor) } })
      .catch(cause => { if (!current.signal.aborted) setError(inventoryError(cause)) })
      .finally(() => { if (!current.signal.aborted) setBusy(false) })
    return () => current.abort()
  }, [api, asset.id, canManage])
  const editable = canManage && !['suspended', 'merged'].includes(asset.status)
  const availableSources = sources.filter(row => row.id !== asset.id && row.status === 'approved' && row.actual_level === 'L2' && row.metadata.hosting === 'internal_hosted' && row.metadata.source_platform === 'dify')
  const selectedSource = availableSources.find(row => row.id === sourceId)
  const sourceArtifacts = selectedSource ? artifacts.filter(row => hostedArtifactAdmitted(selectedSource, row)) : []
  async function perform(action: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (cause) { if (!controller.current.signal.aborted) setError(inventoryError(cause)) }
    finally { if (!controller.current.signal.aborted) setBusy(false) }
  }
  async function loadImage(file?: File) {
    const current = ++generation.current
    setImage(null); setRequestId(crypto.randomUUID()); setError('')
    if (!file) return
    if (file.size > 32000) { setError('镜像描述文件超过大小限制。'); return }
    try {
      const value = JSON.parse(await file.text())
      if (current !== generation.current || controller.current.signal.aborted) return
      if (!value || value.kind !== 'NativeImage' || value.profile !== 'sudocode-dify-independent-text-v1alpha1') throw new Error('INVALID_NATIVE_CONVERSION')
      setImage(value)
    } catch { if (current === generation.current && !controller.current.signal.aborted) setError('请选择构建流程输出的原生镜像描述文件。') }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader><DialogTitle>{asset.metadata.name} · 原生转换</DialogTitle><DialogDescription>关联已审核的 L2 源制品与原生候选，保留来源、版本和评测记录。源智能体继续按原有权限运行。</DialogDescription></DialogHeader>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {notice && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}
      {editable && <section className="grid gap-3 rounded border p-4">
        <h3 className="font-medium">登记原生候选</h3>
        <p className="text-sm text-muted-foreground">当前支持 Dify 单系统提示词的独立文本应用。原生运行关闭工具和自动记忆；包含其他角色、工具或历史记忆的源应用需先调整，不能自动转换。</p>
        <label className="grid gap-1 text-sm">已审核的 L2 源智能体<select className="rounded border bg-background p-2" value={sourceId} disabled={busy} onChange={event => {
          const id = event.target.value; setSourceId(id); setArtifactId(''); setArtifacts([]); setArtifactCursor(null); setRequestId(crypto.randomUUID())
          if (id) void perform(async () => { const page = await api.hostedList(id); setArtifacts(page.items); setArtifactCursor(page.next_cursor) })
        }}><option value="">请选择来源</option>{availableSources.map(row => <option key={row.id} value={row.id}>{row.metadata.name}</option>)}</select></label>
        {sourceCursor && <Button variant="outline" disabled={busy} onClick={() => void perform(async () => { const page = await api.list(sourceCursor); setSources(previous => [...previous, ...page.items]); setSourceCursor(page.next_cursor) })}>加载更多来源</Button>}
        <label className="grid gap-1 text-sm">有效源制品<select className="rounded border bg-background p-2" value={artifactId} disabled={busy || !selectedSource} onChange={event => { setArtifactId(event.target.value); setRequestId(crypto.randomUUID()) }}><option value="">请选择制品</option>{sourceArtifacts.map(row => <option key={row.id} value={row.id}>{row.image.model_name} · {new Date(row.created_at).toLocaleString()} · {row.id.slice(0, 8)}</option>)}</select></label>
        {artifactCursor && <Button variant="outline" disabled={busy} onClick={() => void perform(async () => { const page = await api.hostedList(sourceId, artifactCursor); setArtifacts(previous => [...previous, ...page.items]); setArtifactCursor(page.next_cursor) })}>加载更多源制品</Button>}
        <label className="grid gap-1 text-sm">原生镜像描述文件<Input type="file" accept=".json" disabled={busy} onChange={event => void loadImage(event.target.files?.[0])} /></label>
        <p className="text-xs text-muted-foreground">部署管理员先构建并预置固定原生镜像，再提供描述文件。登记会校验模型、源内容和构建摘要。</p>
        {image && <p className="break-all text-xs">模型：{image.model_name}<br />原生镜像：{image.image_id}</p>}
        <Button disabled={busy || !image || !sourceArtifacts.some(row => row.id === artifactId)} onClick={() => void perform(async () => {
          if (!image) return
          const converted = await api.nativeRegister({ request_id: requestId, asset_id: asset.id, metadata_digest: asset.metadata_digest, source_artifact_id: artifactId, image })
          setRecords(previous => [converted, ...previous.filter(row => row.id !== converted.id)])
          setNotice('原生候选已登记，当前等级保持不变。请完成台账审核、同集评测与原生验收。')
        })}>登记原生候选</Button>
      </section>}
      <section className="space-y-3" aria-label="已登记原生候选"><h3 className="font-medium">已登记原生候选</h3>
        {!records.length && <p className="text-sm text-muted-foreground">{busy ? '正在加载…' : '尚无原生候选。'}</p>}
        {records.map(record => <article className="space-y-2 rounded border p-3" key={record.id}>
          <p className="font-medium">{record.image.model_name} · {asset.actual_level === 'L3' && asset.acceptance?.native_binding?.conversion_id === record.id ? '原生验收有效' : '已登记，待原生验收'}</p>
          <p className="text-xs text-muted-foreground">{new Date(record.created_at).toLocaleString()} · 来源 L2 → 原生候选</p>
          {record.metadata_digest !== asset.metadata_digest && <p className="text-sm text-amber-700">台账已变更，此候选关联旧资料，需要重新登记。</p>}
          <details className="break-all text-xs"><summary>来源与构建信息</summary><p className="mt-2">源制品：{record.source_artifact_id}<br />源规格：{record.source_spec_digest}<br />原生候选：{record.id}<br />原生规格：{record.spec_digest}<br />镜像：{record.image.image_id}<br />SudoCode 提交：{record.image.runtime.commit}<br />执行文件：{record.image.runtime.executable_digest}</p></details>
        </article>)}
        {cursor && <Button variant="outline" disabled={busy} onClick={() => void perform(async () => { const page = await api.nativeList(asset.id, cursor); setRecords(previous => [...previous, ...page.items]); setCursor(page.next_cursor) })}>加载更多原生候选</Button>}
      </section>
      <AgentHostedReleases asset={asset} artifacts={records} canManage={canManage} />
      <AgentHostedEvaluations asset={asset} artifacts={records} canManage={canManage} />
      <AgentEvaluationDatasets asset={asset} canManage={editable} />
    </DialogContent>
  </Dialog>
}
