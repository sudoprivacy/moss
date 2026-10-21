import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { createInventoryApi, type AssetRecord, type HostedArtifact, type EvaluationDataset } from '@/lib/api/agent-inventory'
import { inventoryError } from '@/lib/agent-inventory-labels'
import type { HostedEvaluationRun, HostedEvaluationCase } from '../../contracts/agent-registry/v1alpha1/contract.gen'

const labels = { queued: '待执行', running: '执行中', finished: '已结束', succeeded: '已返回', failed: '失败', unknown: '结果未知' }
export function AgentHostedEvaluations({ asset, artifacts, canManage }: { asset: AssetRecord; artifacts: HostedArtifact[]; canManage: boolean }) {
  const controller = useRef(new AbortController())
  const api = useMemo(() => createInventoryApi(undefined, () => controller.current.signal), [])
  const [runs, setRuns] = useState<HostedEvaluationRun[]>([])
  const [datasets, setDatasets] = useState<EvaluationDataset[]>([])
  const [datasetCursor, setDatasetCursor] = useState<string | null>(null)
  const [runCursor, setRunCursor] = useState<string | null>(null)
  const [artifactId, setArtifactId] = useState(''), [datasetId, setDatasetId] = useState('')
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [results, setResults] = useState<HostedEvaluationCase[]>([]), [caseCursor, setCaseCursor] = useState<string | null>(null)
  const generation = useRef(0)
  const pollingIds = runs.filter(run => run.status !== 'finished').map(run => run.id).sort().join(',')
  const putRun = (run: HostedEvaluationRun) => setRuns(previous => [run, ...previous.filter(row => row.id !== run.id)])
  async function refresh() {
    const [r, d] = await Promise.all([api.evaluationList(asset.id), api.datasetList(asset.id)])
    setRuns(previous => [...r.items, ...previous.filter(row => !r.items.some(x => x.id === row.id))])
    setRunCursor(r.next_cursor); setDatasets(d.items); setDatasetCursor(d.next_cursor)
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError('')
    try { await action() } catch (cause) { if (!controller.current.signal.aborted) setError(inventoryError(cause)) }
    finally { if (!controller.current.signal.aborted) setBusy(false) }
  }
  useEffect(() => {
    if (controller.current.signal.aborted) controller.current = new AbortController()
    const current = controller.current
    void perform(refresh)
    return () => { current.abort(); generation.current++ }
  }, [api, asset.id])
  useEffect(() => {
    if (busy || !pollingIds) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const updated = await Promise.all(pollingIds.split(',').map(id => api.evaluationGet(id)))
        let page: { items: HostedEvaluationCase[]; next_cursor: string | null } | undefined
        if (selected && updated.some(run => run.id === selected)) {
          page = await api.evaluationCases(selected)
          // Preserve the user's loaded page depth while updating every visible case.
          while (page.next_cursor && page.items.length < results.length) {
            const next = await api.evaluationCases(selected, page.next_cursor)
            page = { items: [...page.items, ...next.items], next_cursor: next.next_cursor }
          }
        }
        if (disposed) return
        setRuns(previous => previous.map(run => updated.find(row => row.id === run.id) ?? run))
        if (page) { setResults(page.items); setCaseCursor(page.next_cursor) }
      } catch (cause) {
        if (!disposed && !controller.current.signal.aborted) setError(inventoryError(cause))
      } finally { if (!disposed) timer = setTimeout(() => void poll(), 2000) }
    }
    timer = setTimeout(() => void poll(), 2000)
    return () => { disposed = true; clearTimeout(timer) }
  }, [api, busy, pollingIds, selected, results.length])
  async function show(runId: string) {
    const current = ++generation.current
    setSelected(runId); setResults([]); setCaseCursor(null)
    const page = await api.evaluationCases(runId)
    if (current === generation.current) { setResults(page.items); setCaseCursor(page.next_cursor) }
  }
  async function action(runId: string, command: 'resume' | 'stop' | 'reconcile') {
    putRun(await api.evaluationAction(runId, command))
    if (selected === runId) await show(runId)
  }
  const available = artifacts.filter(row => row.metadata_digest === asset.metadata_digest)
  const validDatasets = datasets.filter(row => row.metadata_digest === asset.metadata_digest)
  return <section className="space-y-3 border-t pt-4">
    <div className="flex items-center justify-between gap-3"><h3 className="font-medium">托管运行评测</h3><Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(async () => { await refresh(); if (selected) await show(selected) })}>刷新评测记录</Button></div>
    <p className="text-sm text-muted-foreground">选择已登记的运行制品与已保存的评测集，执行合成文本样本。结果按全部样本计分。此处记录迁移后的运行结果；L2 准入还需要迁移前基线、对比和权限验证。</p>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {canManage && <div className="grid gap-3 rounded border p-3">
      <label className="grid gap-1 text-sm">运行制品<select className="rounded border bg-background p-2" value={artifactId} disabled={busy} onChange={e => { setArtifactId(e.target.value); setRequestId(crypto.randomUUID()) }}><option value="">请选择制品</option>{available.map(row => <option key={row.id} value={row.id}>{row.image.profile} · {new Date(row.created_at).toLocaleString()} · {row.id.slice(0, 8)}</option>)}</select></label>
      <label className="grid gap-1 text-sm">评测集版本<select className="rounded border bg-background p-2" value={datasetId} disabled={busy} onChange={e => { setDatasetId(e.target.value); setRequestId(crypto.randomUUID()) }}><option value="">请选择评测集</option>{validDatasets.map(row => <option key={row.id} value={row.id}>{row.dataset.name} · {row.dataset.version} · {row.dataset.cases.length} 个样本</option>)}</select></label>
      {datasetCursor && <Button variant="outline" disabled={busy} onClick={() => void perform(async () => { const page = await api.datasetList(asset.id, datasetCursor); setDatasets(previous => [...previous, ...page.items]); setDatasetCursor(page.next_cursor) })}>加载更多可选评测集</Button>}
      <Button disabled={busy || asset.status !== 'approved' || !available.some(row => row.id === artifactId) || !validDatasets.some(row => row.id === datasetId)} onClick={() => void perform(async () => {
        const run = await api.evaluationStart({ request_id: requestId, asset_id: asset.id, metadata_digest: asset.metadata_digest, artifact_id: artifactId, dataset_id: datasetId, timeout_seconds: 120, max_model_calls: 1 })
        putRun(run); setRequestId(crypto.randomUUID()); await show(run.id)
      })}>开始评测</Button>
    </div>}
    {!runs.length && <p className="text-sm text-muted-foreground">尚无评测记录。</p>}
    {runs.map(run => <article key={run.id} className="space-y-2 rounded border p-3 text-sm">
      <p className="font-medium">{new Date(run.created_at).toLocaleString()} · {run.status === 'running' && run.running_cases === 0 ? '等待继续或核对' : labels[run.status]} · 通过 {run.passed_cases} / {run.total_cases}</p>
      <p>待执行 {run.queued_cases} · 执行中 {run.running_cases} · 已结束 {run.finished_cases}</p>
      <details><summary className="cursor-pointer">运行版本与评测依据</summary><p className="mt-1 break-all text-xs">运行制品：{run.artifact_id}<br />制品摘要：{run.spec_digest}<br />评测集摘要：{run.dataset_digest}<br />评分规则摘要：{run.rubric_digest}</p></details>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(() => show(run.id))}>查看用例结果</Button>
        {canManage && <>
          {run.queued_cases > 0 && run.running_cases === 0 && <Button variant="outline" size="sm" disabled={busy || asset.status !== 'approved'} onClick={() => void perform(() => action(run.id, 'resume'))}>继续未开始的用例</Button>}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(() => action(run.id, 'reconcile'))}>核对超时与凭证回收</Button>
          {run.status !== 'finished' && <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(() => action(run.id, 'stop'))}>停止评测</Button>}
        </>}
      </div>
      {selected === run.id && <div className="space-y-2 border-t pt-2">
        <p className="text-xs text-muted-foreground">结果未知的用例不会自动重发。停止评测会阻止新用例并撤销执行授权；容器清理未确认时仍需核对。</p>
        {results.map(row => <div key={row.id} className="rounded bg-muted p-2">
          <p>{row.sample_id} · {labels[row.status]} · {row.passed ? '匹配预期' : '未计为通过'}</p>
          {row.answer != null && <p className="whitespace-pre-wrap break-words">返回：{row.answer}</p>}
          {row.error_code && <p>原因：{inventoryError(new Error(row.error_code))}</p>}
          {row.status !== 'queued' && <p className="text-xs">运行与模型凭证清理：{row.cleanup_confirmed ? '已确认' : '待核对'} · IAM 凭证回收：{row.iam_cleanup_confirmed ? '已确认' : '待核对'}</p>}
          {!!row.trace?.length && <details><summary className="cursor-pointer">执行节点（运行制品上报）</summary>{row.trace.map((frame, i) => <p key={i}>{frame.node} · {frame.phase === 'started' ? '开始' : '完成'}</p>)}</details>}
          {!!row.model_call_ids?.length && <details><summary className="cursor-pointer">模型调用关联</summary><p className="break-all text-xs">{row.model_call_ids.join('、')}</p><p className="text-xs">关联由执行服务记录，费用以 Router 账单核验结果为准。</p></details>}
        </div>)}
        {caseCursor && <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(async () => { const page = await api.evaluationCases(run.id, caseCursor); setResults(previous => [...previous, ...page.items]); setCaseCursor(page.next_cursor) })}>加载更多用例</Button>}
      </div>}
    </article>)}
    {runCursor && <Button variant="outline" disabled={busy} onClick={() => void perform(async () => { const page = await api.evaluationList(asset.id, runCursor); setRuns(previous => [...previous, ...page.items.filter(row => !previous.some(x => x.id === row.id))]); setRunCursor(page.next_cursor) })}>加载更多评测记录</Button>}
  </section>
}
