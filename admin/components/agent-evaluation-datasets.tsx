import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { createInventoryApi, type AssetRecord, type EvaluationDataset } from '@/lib/api/agent-inventory'
import { inventoryError } from '@/lib/agent-inventory-labels'
const newCase = () => ({ id: crypto.randomUUID(), query: '', expected: '' })

export function AgentEvaluationDatasets({ asset, canManage }: { asset: AssetRecord; canManage: boolean }) {
  const controller = useRef(new AbortController()), saving = useRef(false)
  const api = useMemo(() => createInventoryApi(undefined, () => controller.current.signal), [])
  const [records, setRecords] = useState<EvaluationDataset[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [name, setName] = useState(''), [version, setVersion] = useState('1')
  const [cases, setCases] = useState(() => [newCase()])
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  useEffect(() => {
    if (controller.current.signal.aborted) controller.current = new AbortController()
    const current = controller.current
    void api.datasetList(asset.id).then(page => { setRecords(page.items); setCursor(page.next_cursor) })
      .catch(cause => { if (!current.signal.aborted) setError(inventoryError(cause)) })
    return () => current.abort()
  }, [api, asset.id])
  const edited = () => { setRequestId(crypto.randomUUID()); setError(''); setNotice('') }
  const valid = !!name.trim() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version)
    && cases.every(row => row.query.trim() && row.expected.trim())
  async function perform(action: () => Promise<void>) {
    if (saving.current) return
    saving.current = true; setBusy(true); setError(''); setNotice('')
    try { await action() } catch (cause) { if (!controller.current.signal.aborted) setError(inventoryError(cause)) }
    finally { saving.current = false; if (!controller.current.signal.aborted) setBusy(false) }
  }
  async function register() {
    await api.datasetRegister({ request_id: requestId, asset_id: asset.id, metadata_digest: asset.metadata_digest,
      dataset: { name: name.trim(), version, input_scope: 'synthetic_text', rubric: 'exact-strip-v1', cases } })
    const page = await api.datasetList(asset.id); setRecords(page.items); setCursor(page.next_cursor)
    setNotice('评测集版本已保存。后续迁移评测须使用同一版本的输入和评分规则。')
  }
  return <section className="space-y-3 border-t pt-4" aria-label="迁移评测集">
    <h3 className="font-medium">迁移评测集</h3>
    <p className="text-sm text-muted-foreground">保存迁移前后共同使用的合成文本样本。评分按去除首尾空格和换行后的精确匹配计算；执行失败也计入总样本数。保存评测集不会运行智能体或改变纳管等级。</p>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {notice && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}
    {canManage && <details className="rounded-lg border p-3">
      <summary className="cursor-pointer text-sm font-medium">创建评测集版本</summary>
      <div className="mt-3 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">评测集名称<Input value={name} maxLength={200} disabled={busy} onChange={e => { setName(e.target.value); edited() }} /></label>
          <label className="grid gap-1 text-sm">版本号<Input value={version} maxLength={128} disabled={busy} onChange={e => { setVersion(e.target.value); edited() }} /></label>
        </div>
        {cases.map((row, index) => <fieldset className="space-y-2 rounded border p-3" key={row.id} disabled={busy}>
          <legend className="px-1 text-sm">样本 {index + 1}</legend>
          <label className="grid gap-1 text-sm">输入问题<Textarea value={row.query} maxLength={16000} onChange={e => { setCases(previous => previous.map(item => item.id === row.id ? { ...item, query: e.target.value } : item)); edited() }} /></label>
          <label className="grid gap-1 text-sm">预期结果<Textarea value={row.expected} maxLength={32000} onChange={e => { setCases(previous => previous.map(item => item.id === row.id ? { ...item, expected: e.target.value } : item)); edited() }} /></label>
          <Button variant="ghost" size="sm" disabled={busy || cases.length === 1} onClick={() => { setCases(previous => previous.filter(item => item.id !== row.id)); edited() }}>移除样本 {index + 1}</Button>
        </fieldset>)}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy || cases.length >= 100} onClick={() => { setCases(previous => [...previous, newCase()]); edited() }}>添加样本</Button>
          <Button disabled={busy || !valid} onClick={() => void perform(register)}>{busy ? '保存中…' : '保存评测集版本'}</Button>
        </div>
      </div>
    </details>}
    {!records.length && <p className="text-sm text-muted-foreground">尚无已保存的评测集。</p>}
    {records.map(record => <article key={record.id} className="space-y-1 rounded border p-3 text-sm">
      <p className="font-medium">{record.dataset.name} · {record.dataset.version}</p>
      <p className="text-muted-foreground">{record.dataset.cases.length} 个样本 · 精确匹配 · {new Date(record.created_at).toLocaleString()}</p>
      {record.metadata_digest !== asset.metadata_digest && <p className="text-amber-700">台账已变更，执行前需要重新确认此评测集的适用范围。</p>}
      <details><summary className="cursor-pointer">查看样本与版本信息</summary>
        <p className="mt-2 break-all text-xs">数据集摘要：{record.dataset_digest}<br />评分规则摘要：{record.rubric_digest}</p>
        {record.dataset.cases.map((row, i) => <div className="mt-2 border-t pt-2" key={row.id}><p>样本 {i + 1}</p><p className="whitespace-pre-wrap break-words">输入：{row.query}</p><p className="whitespace-pre-wrap break-words">预期：{row.expected}</p></div>)}
      </details>
    </article>)}
    {cursor && <Button variant="outline" disabled={busy} onClick={() => void perform(async () => {
      const page = await api.datasetList(asset.id, cursor); setRecords(previous => [...previous, ...page.items.filter(item => !previous.some(row => row.id === item.id))]); setCursor(page.next_cursor)
    })}>加载更多评测集</Button>}
  </section>
}
