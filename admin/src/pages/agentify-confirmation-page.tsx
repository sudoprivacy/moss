import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/lib/hooks/use-auth'
import { ApiRequestError } from '@/lib/api/client'
import { confirmCall, getConfirmation, type A2ACallView } from '@/lib/api/agentify'
import { loginPath } from '../layouts/dashboard-shell'

const STATUS: Record<string, string> = {
  pending_confirmation: '待确认',
  queued: '已确认，等待执行',
  running: '执行中',
  done: '已完成',
  failed: '执行失败',
  rejected: '已拒绝',
  expired: '已过期',
  cancelled: '已取消',
}

function fmt(ms: number | null | undefined): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

/** What happened to a task that no longer waits. */
function outcome(call: A2ACallView): string {
  const by = call.confirmedByName ?? call.confirmedBy
  if (call.status === 'rejected') return by ? `已由 ${by} 拒绝。` : '已拒绝。'
  if (call.status === 'expired') return '未在规定时间内确认，任务已过期，不会执行。'
  if (call.status === 'cancelled') return '发起方已取消此任务。'
  if (by) return `已由 ${by} 确认。当前状态：${STATUS[call.status] ?? call.status}。`
  return `当前状态：${STATUS[call.status] ?? call.status}。`
}

/**
 * One task's approval page: the link in the confirmation notice. Full width
 * without the sidebar so it works in an in-app browser on a phone; signing in returns
 * here. Only the target agent's confirmers and administrators can open it.
 */
export default function AgentifyConfirmationPage() {
  const { id = '' } = useParams<{ id: string }>()
  const location = useLocation()
  const { isAuthenticated, isLoading: checkingAuth } = useAuth()
  const [call, setCall] = useState<A2ACallView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setCall((await getConfirmation(id)).call)
      setProblem(null)
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 403) setProblem('你不是此任务的确认人，无法查看或处理。')
      else if (err instanceof ApiRequestError && err.status === 404) setProblem('任务不存在，或不需要人工确认。')
      else setProblem(err instanceof Error && err.message ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    if (isAuthenticated) void load()
  }, [isAuthenticated, load])

  if (checkingAuth) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (!isAuthenticated) return <Navigate to={loginPath(location.pathname + location.search)} replace />

  const decide = async (approve: boolean) => {
    if (!call) return
    setBusy(true)
    try {
      setCall((await confirmCall(call.id, approve, note.trim() || undefined)).call)
      toast.success(approve ? '已确认，任务开始执行' : '已拒绝')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : '操作失败')
      // Someone else may have decided meanwhile: show the current state.
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="mx-auto max-w-2xl px-4 py-6 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold">协作任务确认</h1>
          <Link to="/agentify/confirmations" className="text-sm text-primary hover:underline shrink-0">
            全部待确认任务
          </Link>
        </div>

        {loading && !call ? (
          <div className="flex justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : problem ? (
          <p className="rounded-lg border bg-background p-6 text-center text-sm text-muted-foreground" data-testid="confirmation-problem">
            {problem}
          </p>
        ) : call ? (
          <div className="rounded-lg border bg-background p-4 space-y-4" data-testid="confirmation-detail">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{call.caller.name} → {call.target.name}</span>
                <Badge variant={call.status === 'pending_confirmation' ? 'default' : 'outline'}>{STATUS[call.status] ?? call.status}</Badge>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">任务编号</dt>
                <dd className="font-mono">{call.id.slice(0, 8)}</dd>
                <dt className="text-muted-foreground">能力</dt>
                <dd>{call.capability}</dd>
                <dt className="text-muted-foreground">发起员工</dt>
                <dd>{call.actor?.name ?? '—'}</dd>
                <dt className="text-muted-foreground">发起时间</dt>
                <dd>{fmt(call.createdAt)}</dd>
              </dl>
            </div>
            {call.runAs ? (
              <p className="text-xs text-amber-600">
                将以员工 {call.runAs.name ?? call.runAs.id} 的凭据执行（能力指定），不是发起员工本人的凭据。
              </p>
            ) : null}
            <div>
              <div className="text-xs text-muted-foreground mb-1">任务内容</div>
              <pre className="whitespace-pre-wrap break-words text-sm bg-muted rounded p-3">{call.input}</pre>
            </div>
            {call.status === 'pending_confirmation' ? (
              <div className="space-y-2">
                <Input placeholder="备注（可选，拒绝时会告知发起方）" value={note} onChange={e => setNote(e.target.value)} />
                <div className="grid grid-cols-2 gap-2 sm:flex">
                  <Button disabled={busy} onClick={() => void decide(true)}>
                    <CheckCircle2 className="size-4 mr-1" />确认执行
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>
                    <XCircle className="size-4 mr-1" />拒绝
                  </Button>
                </div>
              </div>
            ) : (
              <p className="rounded bg-muted p-3 text-sm" data-testid="confirmation-outcome">{outcome(call)}</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
