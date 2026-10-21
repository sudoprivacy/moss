import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { createInventoryApi, type AssetRecord, type HostedArtifact, type EvaluationDataset } from '@/lib/api/agent-inventory'
import { inventoryError } from '@/lib/agent-inventory-labels'
import type { HostedEvaluationRun, HostedEvaluationCase, MigrationPolicy, MigrationComparison } from '../../contracts/agent-registry/v1alpha1/contract.gen'

const percent = (bps: number) => `${(bps / 100).toFixed(2)}%`
function threshold(value: string): number {
  if (!/^(?:100(?:\.0{1,2})?|[0-9]{1,2}(?:\.[0-9]{1,2})?)$/.test(value)) throw new Error('EVALUATION_THRESHOLD_INVALID')
  const [whole, decimals = ''] = value.split('.')
  return Number(whole) * 100 + Number(decimals.padEnd(2, '0'))
}
const labels = { queued: '待执行', running: '执行中', finished: '已结束', succeeded: '已返回', failed: '失败', unknown: '结果未知' }
export function AgentHostedEvaluations({ asset, artifacts, canManage }: { asset: AssetRecord; artifacts: HostedArtifact[]; canManage: boolean }) {
  const controller = useRef(new AbortController())
  const api = useMemo(() => createInventoryApi(undefined, () => controller.current.signal), [])
  const [runs, setRuns] = useState<HostedEvaluationRun[]>([])
  const [datasets, setDatasets] = useState<EvaluationDataset[]>([])
  const [datasetCursor, setDatasetCursor] = useState<string | null>(null)
  const [runCursor, setRunCursor] = useState<string | null>(null)
  const [artifactId, setArtifactId] = useState(''), [datasetId, setDatasetId] = useState('')
  const [role, setRole] = useState<'hosted' | 'source_baseline'>('source_baseline')
  const [policies, setPolicies] = useState<MigrationPolicy[]>([]), [policyCursor, setPolicyCursor] = useState<string | null>(null)
  const [policyId, setPolicyId] = useState(''), [baselineId, setBaselineId] = useState('')
  const [minimum, setMinimum] = useState(''), [drop, setDrop] = useState('')
  const [policyRequestId, setPolicyRequestId] = useState(() => crypto.randomUUID())
  const [comparisons, setComparisons] = useState<Record<string, MigrationComparison>>({})
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [results, setResults] = useState<HostedEvaluationCase[]>([]), [caseCursor, setCaseCursor] = useState<string | null>(null)
  const generation = useRef(0)
  const pollingIds = runs.filter(run => run.status !== 'finished').map(run => run.id).sort().join(',')
  const putRun = (run: HostedEvaluationRun) => setRuns(previous => [run, ...previous.filter(row => row.id !== run.id)])
  async function refresh() {
    const [r, d, p] = await Promise.all([api.evaluationList(asset.id), api.datasetList(asset.id), api.migrationPolicies(asset.id)])
    setRuns(previous => [...r.items, ...previous.filter(row => !r.items.some(x => x.id === row.id))])
    setPolicies(p.items); setPolicyCursor(p.next_cursor)
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
  const matchingPolicies = policies.filter(row => row.metadata_digest === asset.metadata_digest && row.artifact_id === artifactId && row.dataset_id === datasetId)
  const baseline = runs.find(row => row.id === baselineId)
  return <section className="space-y-3 border-t pt-4">
    <div className="flex items-center justify-between gap-3"><h3 className="font-medium">迁移基线与托管评测</h3><Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(async () => { await refresh(); if (selected) await show(selected) })}>刷新评测记录</Button></div>
    <p className="text-sm text-muted-foreground">选择已登记的运行制品与已保存的评测集，执行合成文本样本。结果按全部样本计分。先运行原平台基线，再固定阈值并运行托管候选。迁移对比通过后仍需独立的权限、隔离与准入审核。</p>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {canManage && <div className="grid gap-3 rounded border p-3">
      <label className="grid gap-1 text-sm">评测阶段<select className="rounded border bg-background p-2" value={role} disabled={busy} onChange={e => { setRole(e.target.value as 'hosted' | 'source_baseline'); setRequestId(crypto.randomUUID()) }}><option value="source_baseline">原平台基线</option><option value="hosted">托管运行</option></select></label>
      {role === 'source_baseline' && <p className="text-xs text-muted-foreground">{asset.metadata.source_platform === 'langgraph' ? '运行已关联的原始 LangGraph 工程，核对源码、依赖版本和运行器摘要。' : '调用部署管理员已关联的原平台运行器。Dify 在执行前后核对已发布内容，记录观察到的版本；不保证远端版本不可变。'}</p>}
      <label className="grid gap-1 text-sm">运行制品<select className="rounded border bg-background p-2" value={artifactId} disabled={busy} onChange={e => { setArtifactId(e.target.value); setPolicyId(''); setRequestId(crypto.randomUUID()) }}><option value="">请选择制品</option>{available.map(row => <option key={row.id} value={row.id}>{row.image.profile} · {new Date(row.created_at).toLocaleString()} · {row.id.slice(0, 8)}</option>)}</select></label>
      <label className="grid gap-1 text-sm">评测集版本<select className="rounded border bg-background p-2" value={datasetId} disabled={busy} onChange={e => { setDatasetId(e.target.value); setPolicyId(''); setRequestId(crypto.randomUUID()) }}><option value="">请选择评测集</option>{validDatasets.map(row => <option key={row.id} value={row.id}>{row.dataset.name} · {row.dataset.version} · {row.dataset.cases.length} 个样本</option>)}</select></label>
      {datasetCursor && <Button variant="outline" disabled={busy} onClick={() => void perform(async () => { const page = await api.datasetList(asset.id, datasetCursor); setDatasets(previous => [...previous, ...page.items]); setDatasetCursor(page.next_cursor) })}>加载更多可选评测集</Button>}
      {role === 'hosted' && <label className="grid gap-1 text-sm">迁移验收阈值<select className="rounded border bg-background p-2" value={policyId} disabled={busy} onChange={e => { setPolicyId(e.target.value); setRequestId(crypto.randomUUID()) }}><option value="">独立托管评测（不形成迁移对比）</option>{matchingPolicies.map(p => <option key={p.id} value={p.id}>基线 {p.baseline_passed}/{p.total_cases} · 至少 {percent(p.minimum_pass_bps)} · 最多下降 {percent(p.maximum_drop_bps)} · {p.id.slice(0, 8)}</option>)}</select></label>}
      {policyCursor && <Button variant="outline" disabled={busy} onClick={() => void perform(async () => { const page = await api.migrationPolicies(asset.id, policyCursor); setPolicies(previous => [...previous, ...page.items]); setPolicyCursor(page.next_cursor) })}>加载更多阈值</Button>}
      <Button disabled={busy || asset.status !== 'approved' || !available.some(row => row.id === artifactId) || !validDatasets.some(row => row.id === datasetId)} onClick={() => void perform(async () => {
        const run = await api.evaluationStart({ request_id: requestId, asset_id: asset.id, metadata_digest: asset.metadata_digest, artifact_id: artifactId, dataset_id: datasetId, timeout_seconds: 120, max_model_calls: 1, role, comparison_policy_id: role === 'hosted' && policyId ? policyId : null })
        putRun(run); setRequestId(crypto.randomUUID()); await show(run.id)
      })}>{role === 'source_baseline' ? '运行原平台基线' : policyId ? '按固定阈值运行托管候选' : '开始托管评测'}</Button>
    </div>}
    {canManage && baseline && <form className="grid gap-3 rounded border p-3" onSubmit={e => { e.preventDefault(); void perform(async () => {
      const policy = await api.migrationPolicyCreate({ request_id: policyRequestId, baseline_run_id: baseline.id, minimum_pass_bps: threshold(minimum), maximum_drop_bps: threshold(drop) })
      setPolicies(previous => [policy, ...previous.filter(row => row.id !== policy.id)])
      setRole('hosted'); setArtifactId(policy.artifact_id); setDatasetId(policy.dataset_id); setPolicyId(policy.id); setRequestId(crypto.randomUUID()); setBaselineId(''); setPolicyRequestId(crypto.randomUUID())
    }) }}>
      <p className="font-medium">固定迁移阈值 · 基线通过 {baseline.passed_cases}/{baseline.total_cases}</p>
      <p className="text-xs text-muted-foreground">请输入本次验收标准。保存后不可修改；后续候选绑定此阈值与同一评测集，不能在查看候选结果后补挂或修改。</p>
      <label className="grid gap-1 text-sm">最低通过率（%）<input required inputMode="decimal" className="rounded border bg-background p-2" placeholder="0–100，最多两位小数" value={minimum} disabled={busy} onChange={e => { setMinimum(e.target.value); setPolicyRequestId(crypto.randomUUID()) }} /></label>
      <label className="grid gap-1 text-sm">最大允许下降（百分点）<input required inputMode="decimal" className="rounded border bg-background p-2" placeholder="0–100，最多两位小数" value={drop} disabled={busy} onChange={e => { setDrop(e.target.value); setPolicyRequestId(crypto.randomUUID()) }} /></label>
      <div className="flex gap-2"><Button type="submit" disabled={busy}>保存不可变阈值</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setBaselineId('')}>取消</Button></div>
    </form>}
    {!runs.length && <p className="text-sm text-muted-foreground">尚无评测记录。</p>}
    {runs.map(run => <article key={run.id} className="space-y-2 rounded border p-3 text-sm">
      <p className="font-medium">{run.role === 'source_baseline' ? '原平台基线' : run.comparison_policy_id ? '托管候选' : '独立托管评测'} · {new Date(run.created_at).toLocaleString()} · {run.status === 'running' && run.running_cases === 0 ? '等待继续或核对' : labels[run.status]} · 通过 {run.passed_cases} / {run.total_cases}</p>
      <p>待执行 {run.queued_cases} · 执行中 {run.running_cases} · 已结束 {run.finished_cases}</p>
      <details><summary className="cursor-pointer">运行版本与评测依据</summary><p className="mt-1 break-all text-xs">运行制品：{run.artifact_id}<br />制品摘要：{run.spec_digest}<br />评测集摘要：{run.dataset_digest}<br />评分规则摘要：{run.rubric_digest}{run.source_runtime && <><br />原平台快照：{run.source_runtime.runtime_digest}<br />模型：{run.source_runtime.model_name} · {run.source_runtime.revision_strength === 'observed_source_snapshot' ? '观察到的发布内容' : '固定本地源码摘要'}</>}{run.comparison_policy_id && <><br />固定阈值：{run.comparison_policy_id}</>}</p></details>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(() => show(run.id))}>查看用例结果</Button>
        {canManage && <>
          {run.role === 'source_baseline' && run.status === 'finished' && <Button variant="outline" size="sm" disabled={busy || run.metadata_digest !== asset.metadata_digest} onClick={() => { setBaselineId(run.id); setMinimum(''); setDrop(''); setPolicyRequestId(crypto.randomUUID()) }}>基于此基线固定阈值</Button>}
          {run.comparison_policy_id && run.status === 'finished' && <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(async () => { const result = await api.migrationCompare(run.id); setComparisons(previous => ({ ...previous, [run.id]: result })) })}>生成／读取迁移对比</Button>}
          {run.queued_cases > 0 && run.running_cases === 0 && <Button variant="outline" size="sm" disabled={busy || asset.status !== 'approved'} onClick={() => void perform(() => action(run.id, 'resume'))}>继续未开始的用例</Button>}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(() => action(run.id, 'reconcile'))}>核对超时与凭证回收</Button>
          {run.status !== 'finished' && <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(() => action(run.id, 'stop'))}>停止评测</Button>}
        </>}
      </div>
      {comparisons[run.id] && <div className="rounded bg-muted p-2"><p className="font-medium">迁移对比：{comparisons[run.id].passed ? '满足本次固定阈值' : '未满足固定阈值'}</p><p>原平台 {comparisons[run.id].baseline_passed}/{comparisons[run.id].total_cases} → 托管 {comparisons[run.id].candidate_passed}/{comparisons[run.id].total_cases}</p><p>至少 {percent(comparisons[run.id].minimum_pass_bps)} · 最多下降 {percent(comparisons[run.id].maximum_drop_bps)}</p><p className="break-all text-xs">对比记录：{comparisons[run.id].id}</p><p className="text-xs">仅证明此合成评测集的结果，不自动授予 L2。</p></div>}
      {selected === run.id && <div className="space-y-2 border-t pt-2">
        <p className="text-xs text-muted-foreground">结果未知的用例不会自动重发。停止评测会阻止新用例并撤销执行授权；容器清理未确认时仍需核对。</p>
        {results.map(row => <div key={row.id} className="rounded bg-muted p-2">
          <p>{datasets.find(d => d.id === run.dataset_id)?.dataset.cases.find(sample => sample.id === row.sample_id)?.query ?? row.sample_id} · {labels[row.status]} · {row.passed ? '匹配预期' : '未计为通过'}</p>
          {row.answer != null && <p className="whitespace-pre-wrap break-words">返回：{row.answer}</p>}
          {row.error_code && <p>原因：{inventoryError(new Error(row.error_code))}</p>}
          {row.status !== 'queued' && <p className="text-xs">本次运行收尾：{row.cleanup_confirmed ? '已确认' : '待核对'} · IAM 凭证回收：{row.iam_cleanup_confirmed ? '已确认' : '待核对'}</p>}
          {!!row.trace?.length && <details><summary className="cursor-pointer">执行节点（运行器上报）</summary>{row.trace.map((frame, i) => <p key={i}>{frame.node} · {frame.phase === 'started' ? '开始' : '完成'}</p>)}</details>}
          {row.source_execution && <details><summary className="cursor-pointer">原平台调用关联</summary><p className="break-all text-xs">请求：{row.source_execution.request_id}{row.source_execution.profile === 'dify-service-api-v1' && <><br />工作流运行：{row.source_execution.workflow_run_id ?? '未返回'}<br />任务：{row.source_execution.task_id ?? '未返回'}<br />消息：{row.source_execution.message_id ?? '未返回'}<br />会话：{row.source_execution.conversation_id ?? '未返回'}</>}</p><p className="text-xs">{row.source_execution.profile === 'dify-service-api-v1' ? '编号由原平台返回，用于核对运行记录；不代表 Router 已核验费用。' : '此编号关联独立原工程运行；模型调用与费用仍以实际 Router 核验记录为准。'}</p></details>}
          {!!row.model_call_ids?.length && <details><summary className="cursor-pointer">模型调用关联</summary><p className="break-all text-xs">{row.model_call_ids.join('、')}</p><p className="text-xs">关联由执行服务记录，费用以 Router 账单核验结果为准。</p></details>}
        </div>)}
        {caseCursor && <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(async () => { const page = await api.evaluationCases(run.id, caseCursor); setResults(previous => [...previous, ...page.items]); setCaseCursor(page.next_cursor) })}>加载更多用例</Button>}
      </div>}
    </article>)}
    {runCursor && <Button variant="outline" disabled={busy} onClick={() => void perform(async () => { const page = await api.evaluationList(asset.id, runCursor); setRuns(previous => [...previous, ...page.items.filter(row => !previous.some(x => x.id === row.id))]); setRunCursor(page.next_cursor) })}>加载更多评测记录</Button>}
  </section>
}
