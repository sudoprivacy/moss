import { useEffect, useRef, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { createInventoryApi, HostedUnknownPage } from '@/lib/api/agent-inventory'
import { inventoryError } from '@/lib/agent-inventory-labels'

export function AgentHostedUnknownTasks({ api }: { api: ReturnType<typeof createInventoryApi> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [page, setPage] = useState<HostedUnknownPage | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const mounted = useRef(true), acting = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function load(more = false) {
    if (acting.current) return
    acting.current = true; setBusy(true); setError(''); setOpen(true)
    try {
      const next = await api.hostedUnknown(more ? page?.next_cursor ?? '' : '')
      if (mounted.current) setPage(previous => more && previous ? { ...next, items: [...previous.items, ...next.items] } : next)
    } catch (err) { if (mounted.current) setError(inventoryError(err)) }
    finally { acting.current = false; if (mounted.current) setBusy(false) }
  }
  async function action(id: string, command: 'reconcile' | 'close') {
    if (acting.current) return
    acting.current = true; setBusy(true); setError('')
    try {
      await api.hostedTaskAction(id, command, notes[id])
      const next = await api.hostedUnknown()
      if (mounted.current) { setPage(next); setNotes(previous => ({ ...previous, [id]: '' })) }
    } catch (err) { if (mounted.current) setError(inventoryError(err)) }
    finally { acting.current = false; if (mounted.current) setBusy(false) }
  }
  return <section className="rounded-md border p-3 space-y-3" aria-label="待核对的托管任务">
    <Button variant="outline" disabled={busy} onClick={() => open ? setOpen(false) : void load()}>{open ? '收起托管任务核对' : '查看待核对的托管任务'}</Button>
    {open && <>
      <p className="text-sm text-muted-foreground">组织管理员可以核对成员（包括已离职成员）的未知任务。核对仅回收凭证、确认容器清理和账单，不重发任务。关闭会话保留“结果未知”，不会改为成功。</p>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>刷新任务</Button>
      {page?.items.length === 0 && <p className="text-sm">当前没有待核对的托管任务。</p>}
      {page?.items.map(task => <article className="border rounded p-3 space-y-2 text-sm" key={task.task_id}>
        <p className="break-all">任务：{task.task_id}</p>
        <p className="break-all">发起成员：{task.user_id} · 智能体：{task.asset_id}</p>
        <p>{task.cleanup === 'confirmed' ? '运行环境已确认清理；任务结果仍未知。' : '运行环境尚未确认清理。'}</p>
        {task.error_code && <p className="text-muted-foreground">状态代码：{task.error_code}</p>}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(task.task_id, 'reconcile')}>核对并回收运行资源</Button>
        {task.cleanup === 'confirmed' && <>
          <Textarea aria-label={`核对结论 ${task.task_id}`} placeholder="填写核对结论（至少 10 个字符），并保留未知结果说明" value={notes[task.task_id] ?? ''} maxLength={2000} onChange={e => setNotes(previous => ({ ...previous, [task.task_id]: e.target.value }))} />
          <Button size="sm" disabled={busy || (notes[task.task_id]?.trim().length ?? 0) < 10} onClick={() => void action(task.task_id, 'close')}>记录结论并关闭会话</Button>
        </>}
      </article>)}
      {page?.next_cursor && <Button variant="outline" disabled={busy} onClick={() => void load(true)}>加载更多任务</Button>}
    </>}
  </section>
}
