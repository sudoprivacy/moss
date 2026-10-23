import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { createAgentToolsApi, type AgentToolCall, type AgentToolDescriptor, type AgentToolReview } from '@/lib/api/agent-tools'

const statuses: Record<AgentToolCall['status'], string> = { preparing: '校验中', dispatching: '已派发', completed: '已返回', tool_error: '工具报告错误', rejected: '已拒绝', unknown: '结果未知' }
const errors: Record<string, string> = {
  TOOL_SERVER_UNAVAILABLE: '请先启用并测试此 HTTP MCP 服务，同时启用组织 HTTP MCP 策略。',
  TOOL_DESTINATION_DENIED: '请在组织 MCP 策略中允许网络访问，并将服务的精确主机名加入白名单。',
  TOOL_DESCRIPTOR_CHANGED: '工具定义已变化，请重新读取并审核。', TOOL_REVIEW_CONFLICT: '审核记录已被修改，请刷新后重试。',
  TOOL_SCHEMA_UNSUPPORTED: '此工具的输入结构暂不受支持，目前支持明确禁止额外字段的简单参数对象。',
  TOOL_GATEWAY_NOT_CONFIGURED: '当前服务尚未配置 Registry 任务身份权威。', ADMIN_REQUIRED: '仅组织管理员可管理 Agent 工具授权。',
}
const errorText = (error: unknown) => { const message = error instanceof Error ? error.message : '操作未完成'; return errors[message] ?? message }

export function AgentToolManagement({ serverId, name, onClose }: { serverId: string; name: string; onClose(): void }) {
  const controller = useRef<AbortController | null>(null)
  const api = useMemo(() => createAgentToolsApi(undefined, () => controller.current?.signal), [serverId])
  const [reviews, setReviews] = useState<AgentToolReview[]>([]), [descriptors, setDescriptors] = useState<AgentToolDescriptor[]>([])
  const [calls, setCalls] = useState<AgentToolCall[]>([]), [selected, setSelected] = useState<AgentToolDescriptor | null>(null)
  const [action, setAction] = useState<'read' | 'write'>('write'), [sensitive, setSensitive] = useState(true), [outbound, setOutbound] = useState(true)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), acting = useRef(false)
  async function refresh() { const [r, c] = await Promise.all([api.reviews(serverId), api.calls(serverId)]); setReviews(r); setCalls(c) }
  useEffect(() => {
    const current = new AbortController(); controller.current = current
    void refresh().catch(err => { if (!controller.current?.signal.aborted) setError(errorText(err)) })
    return () => current.abort()
  }, [api, serverId])
  async function run(work: () => Promise<void>) {
    if (acting.current || controller.current?.signal.aborted) return
    acting.current = true; setBusy(true); setError('')
    try { await work() } catch (err) { if (!controller.current?.signal.aborted) setError(errorText(err)) }
    finally { acting.current = false; if (!controller.current?.signal.aborted) setBusy(false) }
  }
  function select(tool: AgentToolDescriptor) {
    const previous = reviews.find(r => r.tool.name === tool.tool.name)
    setSelected(tool); setAction(previous?.action ?? 'write'); setSensitive(previous?.sensitive ?? true); setOutbound(previous?.outbound ?? true)
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
      <DialogHeader><DialogTitle>Agent 工具授权 · {name}</DialogTitle><DialogDescription>逐项审核此服务可供 Agent 调用的工具。资产台账和任务身份也必须授予同一工具资源。</DialogDescription></DialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2"><Button disabled={busy} onClick={() => void run(async () => setDescriptors(await api.discover(serverId)))}>读取工具定义</Button><Button variant="outline" disabled={busy} onClick={() => void run(refresh)}>刷新授权与记录</Button></div>
      <p className="text-sm text-muted-foreground">读取定义不会执行工具。授权仅约束经此网关的调用；原平台直连工具不在控制范围内。工具要求确认时，未经确认的写操作会被拒绝。</p>
      <section aria-label="工具授权" className="space-y-2">
        <h3 className="font-medium">已审核工具</h3>
        {!reviews.length && <p className="text-sm text-muted-foreground">尚无已审核工具。</p>}
        {reviews.map(review => <div key={review.resource} className="rounded border p-3 text-sm space-y-1">
          <div className="flex justify-between gap-2"><span>{review.tool.name} · {review.action === 'read' ? '读取' : '写入'} · {review.enabled ? '已授权' : '已停用'}</span><Button variant="outline" size="sm" disabled={busy || !review.enabled} onClick={() => void run(async () => { await api.disable(serverId, review); await refresh() })}>停用工具授权</Button></div>
          <p className="break-all">资源标识：<code>{review.resource}</code></p>
          <p className="text-muted-foreground">{review.sensitive ? '涉及敏感字段' : '不涉及敏感字段'} · {review.outbound ? '允许工具外联' : '不需要工具外联'} · {new Date(review.reviewedAt).toLocaleString()}</p>
        </div>)}
      </section>
      {descriptors.length > 0 && <section aria-label="读取到的工具" className="space-y-2"><h3 className="font-medium">选择待审核工具</h3><div className="flex gap-2 flex-wrap">{descriptors.map(d => <Button key={d.tool.name} variant="outline" disabled={busy} onClick={() => select(d)}>{d.tool.name}</Button>)}</div></section>}
      {selected && <section aria-label="审核工具定义" className="rounded border p-3 space-y-3 text-sm">
        <h3 className="font-medium">审核 {selected.tool.name}</h3><p>{selected.tool.description}</p>
        <details><summary>查看输入定义</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(selected.tool.inputSchema, null, 2)}</pre></details>
        <label className="flex gap-3 items-center">操作性质<select aria-label="操作性质" className="rounded border p-1 bg-background" value={action} onChange={e => setAction(e.target.value as 'read' | 'write')} disabled={busy}><option value="write">写入／有副作用</option><option value="read">仅仅读取</option></select></label>
        <label className="flex gap-2"><input type="checkbox" checked={sensitive} disabled={busy} onChange={e => setSensitive(e.target.checked)} />涉及敏感字段</label>
        <label className="flex gap-2"><input type="checkbox" checked={outbound} disabled={busy} onChange={e => setOutbound(e.target.checked)} />工具需要访问外部网络</label>
        <p className="text-muted-foreground">请依据实际工具行为填写。平台自报的“只读”提示不会自动获得权限。</p>
        <Button disabled={busy} onClick={() => void run(async () => {
          await api.review(serverId, { tool: selected.tool.name, digest: selected.digest, action, sensitive, outbound, enabled: true, expected_revision: reviews.find(r => r.tool.name === selected.tool.name)?.revision ?? null })
          setSelected(null); await refresh()
        })}>确认审核并授权</Button>
      </section>}
      <section aria-label="Agent 工具调用记录" className="space-y-2"><h3 className="font-medium">最近调用记录（最多 100 条）</h3>
        <p className="text-sm text-muted-foreground">结果未知的调用不会自动重发。停用授权可阻止后续派发，无法确认取消工具服务已受理的操作。</p>
        {!calls.length && <p className="text-sm">暂无调用记录。</p>}
        {calls.map(call => <details key={call.id} className="rounded border p-2 text-sm"><summary>{call.tool} · {statuses[call.status]} · {new Date(call.updatedAt).toLocaleString()}</summary><dl className="mt-2 space-y-1 break-all"><dt>任务</dt><dd>{call.taskId}</dd><dt>资产</dt><dd>{call.assetId}</dd><dt>发起用户／执行身份</dt><dd>{call.initiatedBy} / {call.workerId}</dd><dt>目标</dt><dd>{call.resource}</dd>{call.errorCode && <><dt>状态代码</dt><dd>{call.errorCode}</dd></>}</dl></details>)}
      </section>
    </DialogContent>
  </Dialog>
}
