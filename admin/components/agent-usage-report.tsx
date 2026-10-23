import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AgentUsageReport as Report, AgentUsageWindow, createInventoryApi } from '@/lib/api/agent-inventory'
import type { AgentUsageGroup } from '../../src/server/agentFederation/usageViews'
import { inventoryError } from '@/lib/agent-inventory-labels'

type Dimension = 'department_id' | 'platform' | 'asset_id'
const number = (v: number) => v.toLocaleString('zh-CN')
const authorityLabel = (id: string | null) => id ? `Router ${id.slice(7, 19)}` : '历史 Router 归属缺失'
const date = (v: number) => new Date(v - new Date(v).getTimezoneOffset() * 60000).toISOString().slice(0, 16)
const selectClass = 'h-9 rounded-md border bg-background px-3 text-sm'
const dimensions: Record<Dimension, string> = { department_id: '部门', platform: '平台', asset_id: '智能体' }
function summarize(report: Report, by: Dimension) {
  const rows = new Map<string, { key: string; value: string | null; name: string; data: AgentUsageGroup }>()
  for (const group of report.groups) {
    const key = JSON.stringify([group.router_authority_id, group[by]]), existing = rows.get(key)
    if (existing) {
      for (const field of ['calls', 'pending_calls', 'unknown_calls', 'missing_attribution_calls', 'not_invoked_calls', 'verified_entries', 'verified_quota', 'input_tokens', 'output_tokens'] as const)
        existing.data[field] += group[field]
    } else rows.set(key, { key, value: group[by], name: by === 'department_id' ? group.department_name ?? group.department_id ?? '未分配部门'
      : by === 'platform' ? group.platform ?? '历史平台归属缺失' : group.asset_name ?? group.asset_id, data: { ...group } })
  }
  return [...rows.values()]
}

/** Mounted under the organization-scoped inventory; never retains another organization's report. */
export function AgentUsageReport({ api }: { api: ReturnType<typeof createInventoryApi> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [from, setFrom] = useState(() => date(Date.now() - 86400_000)), [to, setTo] = useState(() => date(Date.now() + 60000))
  const [mode, setMode] = useState<AgentUsageWindow['mode']>('run'), [dimension, setDimension] = useState<Dimension>('department_id')
  const [report, setReport] = useState<Report | null>(null), [selected, setSelected] = useState<string | null>(null), [detailPage, setDetailPage] = useState(0)
  const generation = useRef(0), active = useRef(true), acting = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++ } }, [])
  async function load(event?: FormEvent) {
    event?.preventDefault()
    if (acting.current) return
    const fromMs = new Date(from).getTime(), toMs = new Date(to).getTime()
    if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs >= toMs || toMs - fromMs > 31 * 86400_000) {
      setError('请选择有效时间范围，单次最长 31 天。'); return
    }
    const current = ++generation.current
    acting.current = true; setBusy(true); setError(''); setReport(null); setSelected(null)
    try {
      const result = await api.usage({ from: fromMs, to: toMs, mode })
      if (active.current && current === generation.current) setReport(result)
    } catch (cause) { if (active.current && current === generation.current) setError(inventoryError(cause)) }
    finally { acting.current = false; if (active.current && current === generation.current) setBusy(false) }
  }
  const groups = report ? summarize(report, dimension) : []
  const selection = groups.find(g => g.key === selected)
  const details = report && selection ? report.calls.filter(c => c.router_authority_id === selection.data.router_authority_id && c[dimension] === selection.value) : []
  return <section className="space-y-3 rounded-md border p-3" aria-label="智能体成本与用量">
    <Button variant="outline" onClick={() => setOpen(v => !v)}>{open ? '收起成本与用量' : '查看成本与用量'}</Button>
    {open && <>
      <p className="text-sm text-muted-foreground">统计经过任务模型网关、已从 Router 核对的用量。额度单位不是人民币；不同 Router 分开汇总。原平台直连及尚未接入网关的消耗不在此报表内。</p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={event => void load(event)}>
        <label className="grid gap-1 text-sm">开始时间（本地）<Input type="datetime-local" value={from} disabled={busy} onChange={e => setFrom(e.target.value)} required /></label>
        <label className="grid gap-1 text-sm">结束时间（不含）<Input type="datetime-local" value={to} disabled={busy} onChange={e => setTo(e.target.value)} required /></label>
        <label className="grid gap-1 text-sm">运行范围<select className={selectClass} value={mode} disabled={busy} onChange={e => setMode(e.target.value as AgentUsageWindow['mode'])}><option value="run">正式任务</option><option value="evaluation">迁移评测</option></select></label>
        <Button type="submit" disabled={busy}>{busy ? '正在查询…' : '查询用量'}</Button>
      </form>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {report && <>
        <p className="text-sm">本次报表：{new Date(report.window.from).toLocaleString()} 至 {new Date(report.window.to).toLocaleString()}（不含） · {report.window.mode === 'run' ? '正式任务' : '迁移评测'} · {report.status === 'partial' ? '存在待核对或归属缺失的数据' : report.status === 'no_records' ? '此范围内没有网关记录，不代表企业没有消耗' : '返回的计量已核对'}</p>
        <p className="text-xs text-muted-foreground">归属使用调用时的资产、负责人和部门；部门名称显示当前名称。历史记录缺少平台或 Router 归属时保留“缺失”，不推测补齐。未核对部分不会记为零。</p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">汇总维度<select aria-label="汇总维度" className={selectClass} value={dimension} onChange={e => { setDimension(e.target.value as Dimension); setSelected(null); setDetailPage(0) }}>{Object.entries(dimensions).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
          <Button variant="outline" size="sm" onClick={() => {
            const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' }))
            const link = document.createElement('a'); link.href = url; link.download = `agent-usage-${report.captured_at}.json`; link.click()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
          }}>导出本次报表 JSON</Button>
        </div>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">按{dimensions[dimension]}和 Router 汇总的计量</caption><thead><tr>{['Router', dimensions[dimension], '已核对额度', '输入／输出 tokens', '调用数', '待核对', '结果未知／在途', '归属缺失', '明细'].map(h => <th className="p-2 font-medium" key={h}>{h}</th>)}</tr></thead>
          <tbody>{groups.map(row => <tr className="border-t" key={row.key}><td className="p-2">{authorityLabel(row.data.router_authority_id)}</td><td className="p-2">{row.name}</td>
            <td className="p-2">{row.data.verified_entries ? number(row.data.verified_quota) : '尚无核对额度'}</td><td className="p-2">{row.data.verified_entries ? `${number(row.data.input_tokens)} ／ ${number(row.data.output_tokens)}（已核对）` : '尚无核对用量'}</td>
            <td className="p-2">{row.data.calls}</td><td className="p-2">{row.data.pending_calls}</td><td className="p-2">{row.data.unknown_calls}</td><td className="p-2">{row.data.missing_attribution_calls}</td>
            <td className="p-2"><Button variant="outline" size="sm" aria-label={`查看${row.name}明细`} onClick={() => { setSelected(row.key); setDetailPage(0) }}>查看明细</Button></td></tr>)}</tbody></table></div>
        {selection && <div className="space-y-2 rounded border p-3 text-sm" aria-label="模型调用明细">
          <h3 className="font-medium">{selection.name} · {details.length} 条调用</h3>
          {details.slice(detailPage * 50, (detailPage + 1) * 50).map(call => <details className="border-t py-2" key={call.id}><summary className="cursor-pointer break-all">{new Date(call.created_at).toLocaleString()} · {call.model} · {call.ledger_status === 'verified' ? '计量已核对' : call.ledger_status === 'not_invoked' ? '未派发' : '计量待核对'} · {call.id}</summary>
            <dl className="grid gap-1 break-all pt-2"><dt>任务</dt><dd>{call.task_id}</dd><dt>资产／负责人</dt><dd>{call.asset_id} ／ {call.owner_user_id}</dd>
              <dt>运行状态／凭证回收</dt><dd>{({ completed: '已返回', rejected: '已拒绝', preparing: '准备中', dispatching: '已派发', unknown: '结果未知' } as Record<string, string>)[call.status] ?? '状态未知'} ／ {call.token_cleanup === 'confirmed' ? '已确认' : '待核对'}</dd>
              <dt>范围内账单</dt><dd>{call.entries.length ? call.entries.map(item => `账户 ${item.account_id} / 记录 ${item.id}：${item.quota} 额度`).join('；') : '无已核对账单条目'}</dd></dl>
          </details>)}
          <div className="flex items-center gap-3"><Button size="sm" variant="outline" disabled={detailPage === 0} onClick={() => setDetailPage(p => p - 1)}>上一页</Button><span>第 {detailPage + 1} 页</span><Button size="sm" variant="outline" disabled={(detailPage + 1) * 50 >= details.length} onClick={() => setDetailPage(p => p + 1)}>下一页</Button></div>
        </div>}
      </>}
    </>}
  </section>
}
