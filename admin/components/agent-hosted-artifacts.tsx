import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { createInventoryApi, type AssetRecord, type HostedArtifact, type HostedImage, type DifyTextPlan } from '@/lib/api/agent-inventory'
import { AgentHostedEvaluations } from './agent-hosted-evaluations'
import { AgentEvaluationDatasets } from './agent-evaluation-datasets'
import { inventoryError } from '@/lib/agent-inventory-labels'

export function AgentHostedArtifacts({ asset, canManage, onClose }: { asset: AssetRecord; canManage: boolean; onClose: () => void }) {
  const controller = useRef(new AbortController())
  const api = useMemo(() => createInventoryApi(undefined, () => controller.current.signal), [])
  const [records, setRecords] = useState<HostedArtifact[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [source, setSource] = useState('')
  const [image, setImage] = useState<HostedImage | null>(null)
  const [plan, setPlan] = useState<DifyTextPlan | null>(null)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const fileGeneration = useRef({ source: 0, image: 0 })
  const isDify = asset.metadata.source_platform === 'dify'
  const editable = canManage && !['suspended', 'merged'].includes(asset.status)
  useEffect(() => {
    if (controller.current.signal.aborted) controller.current = new AbortController()
    const current = controller.current
    setBusy(true)
    void api.hostedList(asset.id).then(page => { setRecords(page.items); setCursor(page.next_cursor) })
      .catch(cause => { if (!current.signal.aborted) setError(inventoryError(cause)) })
      .finally(() => { if (!current.signal.aborted) setBusy(false) })
    return () => current.abort()
  }, [api, asset.id])

  async function loadFile(file: File | undefined, kind: 'source' | 'image') {
    const generation = ++fileGeneration.current[kind]
    setRequestId(crypto.randomUUID()); setError(''); setNotice('')
    if (kind === 'source') { setSource(''); setPlan(null) } else setImage(null)
    if (!file) return
    if (file.size > (kind === 'source' ? 256000 : 16000)) { setError('文件过大，请检查导出的制品文件。'); return }
    try {
      const text = await file.text()
      if (generation !== fileGeneration.current[kind] || controller.current.signal.aborted) return
      if (kind === 'source') setSource(text)
      else {
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.kind !== 'HostedImage'
          || parsed.profile !== (isDify ? 'dify-0.6.0-linear-text-v1' : 'langgraph-stdio-v1')) throw new Error('descriptor')
        setImage(parsed)
      }
    } catch { setError('文件格式不正确，或制品类型与台账来源不一致。') }
  }
  async function perform(action: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (cause) { if (!controller.current.signal.aborted) setError(inventoryError(cause)) }
    finally { if (!controller.current.signal.aborted) setBusy(false) }
  }
  async function register() {
    if (!image) return
    const result = await api.hostedRegister({ request_id: requestId, asset_id: asset.id, metadata_digest: asset.metadata_digest, image, dify_source: isDify ? source : null })
    setRecords(previous => [result, ...previous.filter(item => item.id !== result.id)])
    setNotice('制品已登记。纳管等级保持不变，运行评测和审核发布需单独完成。')
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{asset.metadata.name} · 托管制品</DialogTitle>
        <DialogDescription>将已构建并预置到执行节点的制品关联到当前台账。登记不会启动任务或发布智能体。</DialogDescription>
      </DialogHeader>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {notice && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}
      {editable && <section className="space-y-4 rounded-lg border p-4">
        <h3 className="font-medium">登记已构建制品</h3>
        <p className="text-sm text-muted-foreground">由部署管理员提供镜像描述文件。{isDify ? 'Dify 当前支持开始、单个模型节点、回复的独立纯文本对话；导入时会核对原始 DSL。' : 'LangGraph 工程须已构建为符合托管接口的固定镜像。'}</p>
        <label className="grid gap-2 text-sm">镜像描述文件（JSON）<Input type="file" accept=".json" disabled={busy} onChange={e => void loadFile(e.target.files?.[0], 'image')} /></label>
        {isDify && <label className="grid gap-2 text-sm">Dify 导出的 DSL 文件<Input type="file" accept=".yaml,.yml" disabled={busy} onChange={e => void loadFile(e.target.files?.[0], 'source')} /></label>}
        {image && <p className="break-all text-sm">模型：{image.model_name} · 资源：{image.model_resource}<br />镜像：{image.image_id}</p>}
        {plan && <p className="text-sm">DSL 校验通过：{plan.source_model}，独立纯文本对话。不支持历史会话和工具节点。</p>}
        <div className="flex flex-wrap gap-2">
          {isDify && <Button variant="outline" disabled={busy || !source} onClick={() => void perform(async () => setPlan(await api.hostedInspect(source)))}>校验 DSL</Button>}
          <Button disabled={busy || !image || (isDify && !source)} onClick={() => void perform(register)}>登记制品</Button>
        </div>
      </section>}
      <section className="space-y-3" aria-label="已登记托管制品">
        <h3 className="font-medium">已登记制品</h3>
        {!records.length && <p className="text-sm text-muted-foreground">{busy ? '正在加载…' : '尚无托管制品。'}</p>}
        {records.map(record => <article className="space-y-2 rounded-lg border p-3" key={record.id}>
          <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{record.image.model_name}</span><Badge variant="outline">已登记 · 待运行验收</Badge></div>
          <p className="text-xs text-muted-foreground">{new Date(record.created_at).toLocaleString()} · {record.image.profile}</p>
          {record.metadata_digest !== asset.metadata_digest && <p className="text-sm text-amber-700">台账已变更，此制品对应旧版资料，执行前需要重新核对。</p>}
          <details className="text-xs"><summary className="cursor-pointer">版本与镜像信息</summary><dl className="mt-2 space-y-1 break-all"><dt>制品 ID</dt><dd>{record.id}</dd><dt>规格摘要</dt><dd>{record.spec_digest}</dd><dt>镜像摘要</dt><dd>{record.image.image_id}</dd><dt>模型资源</dt><dd>{record.image.model_resource}</dd></dl></details>
        </article>)}
        {cursor && <Button variant="outline" disabled={busy} onClick={() => void perform(async () => { const page = await api.hostedList(asset.id, cursor); setRecords(previous => [...previous, ...page.items.filter(item => !previous.some(row => row.id === item.id))]); setCursor(page.next_cursor) })}>加载更多</Button>}
      </section>
      <AgentHostedEvaluations key={`evaluations-${asset.id}-${asset.metadata_digest}`} asset={asset} artifacts={records} canManage={canManage} />
      <AgentEvaluationDatasets key={asset.id} asset={asset} canManage={editable} />
    </DialogContent>
  </Dialog>
}
