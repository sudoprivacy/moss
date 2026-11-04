import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { confirmCall, listConfirmations, type A2ACallView } from '@/lib/api/agentify'

function fmt(ms: number | null | undefined): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

/**
 * Tasks one agent handed to another that wait for a person before they run.
 * Open to every signed-in employee: each sees only the tasks they may confirm
 * (administrators see all).
 */
export default function AgentifyConfirmationsPage() {
  const [loading, setLoading] = useState(true)
  const [calls, setCalls] = useState<A2ACallView[]>([])
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setCalls((await listConfirmations()).calls)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const decide = async (call: A2ACallView, approve: boolean) => {
    setBusy(call.id)
    try {
      await confirmCall(call.id, approve, notes[call.id]?.trim() || undefined)
      toast.success(approve ? '已确认，任务开始执行' : '已拒绝')
      await load()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <DashboardLayout title="待确认任务" description="智能体之间委派的、需要人工确认的任务（例如发送消息、通知供应商）。确认后才会执行，未处理的任务会自动过期。">
      <div className="p-6 space-y-4 max-w-4xl">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">只显示你可以确认的任务。</p>
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`size-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>
        {loading && calls.length === 0 ? (
          <Skeleton className="h-32" />
        ) : calls.length === 0 ? (
          <p className="text-sm text-muted-foreground border rounded-lg p-6 text-center">没有需要你确认的任务。</p>
        ) : (
          calls.map(call => (
            <div key={call.id} className="border rounded-lg p-4 space-y-3" data-testid="confirmation">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{call.caller.name} → {call.target.name}</span>
                <Badge variant="outline">{call.capability}</Badge>
                <span className="text-xs text-muted-foreground">发起员工：{call.actor?.name ?? '—'} · {fmt(call.createdAt)}</span>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">任务内容</div>
                <pre className="whitespace-pre-wrap text-sm bg-muted rounded p-3">{call.input}</pre>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="max-w-sm h-9"
                  placeholder="备注（可选，拒绝时会告知发起方）"
                  value={notes[call.id] ?? ''}
                  onChange={e => setNotes(n => ({ ...n, [call.id]: e.target.value }))}
                />
                <Button size="sm" disabled={busy === call.id} onClick={() => void decide(call, true)}>
                  <CheckCircle2 className="size-4 mr-1" />确认执行
                </Button>
                <Button size="sm" variant="outline" disabled={busy === call.id} onClick={() => void decide(call, false)}>
                  <XCircle className="size-4 mr-1" />拒绝
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </DashboardLayout>
  )
}
