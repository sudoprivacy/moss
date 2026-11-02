import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { DashboardLayout } from '@/components/dashboard-layout'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  getRuntimeRollout, listOwnerRuntimes, recoverOwnerRuntimeLock, retireOwnerRuntime, startRuntimeRollout, upgradeOwnerRuntime,
  type OwnerRuntime, type RuntimeRollout,
} from '@/lib/api/runtimes'
import { useAuth } from '@/lib/hooks/use-auth'

const ownerStatusLabels: Record<string, string> = {
  active: '正常', disabled: '已停用', locked: '已锁定', pending: '待激活', unknown: '无账号',
}
const phaseLabels: Record<string, string> = {
  Running: '运行中', Pending: '启动中', Succeeded: '已退出', Failed: '异常退出', absent: '未运行', mixed: '状态不一', Unknown: '未知',
}
const outcomeLabels: Record<RuntimeRollout['owners'][number]['outcome'], string> = {
  pending: '等待中', upgraded: '已升级', busy: '稍后重试', failed: '失败',
}

type ActionKind = 'upgrade' | 'retire' | 'recover'
const actionCopy: Record<ActionKind, { title: string; description: string; confirm: string }> = {
  upgrade: {
    title: '升级运行环境',
    description: '替换为当前发布版本，保留数据卷，完成后恢复该用户的会话。该用户有执行中的工作时会拒绝升级。',
    confirm: '升级',
  },
  retire: {
    title: '停止运行环境',
    description: '该用户已无法使用运行环境。停止后保留数据卷和会话记录；账号重新启用后，下次对话会在原数据卷上重新启动。',
    confirm: '停止',
  },
  recover: {
    title: '清除升级锁',
    description: '仅清除控制器重启前中断的升级遗留的锁；正在进行的升级持有的锁会被拒绝。清除后可重新升级。',
    confirm: '清除',
  },
}

function ownerLabel(runtime: Pick<OwnerRuntime, 'ownerName' | 'ownerId'>): string {
  return runtime.ownerName || runtime.ownerId
}

export default function RuntimesPage() {
  const { user } = useAuth()
  const isPlatformAdmin = user?.role === 'super_admin'
  const [scope, setScope] = useState<'org' | 'all'>('org')
  const [runtimes, setRuntimes] = useState<OwnerRuntime[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [action, setAction] = useState<{ kind: ActionKind; runtime: OwnerRuntime } | null>(null)
  const [busyOwnerId, setBusyOwnerId] = useState<string | null>(null)
  const [rollout, setRollout] = useState<RuntimeRollout | null>(null)
  const [plan, setPlan] = useState<OwnerRuntime[] | null>(null)
  const [confirmation, setConfirmation] = useState('')

  const refresh = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try { setRuntimes((await listOwnerRuntimes(scope)).runtimes) }
    catch (failure) { setError(failure instanceof Error ? failure.message : '无法加载运行环境') }
    finally { setIsLoading(false) }
  }, [scope])
  useEffect(() => { void refresh() }, [refresh])

  const refreshRollout = useCallback(async () => {
    const current = await getRuntimeRollout()
    setRollout(current.rollout)
    return current
  }, [])
  useEffect(() => {
    if (isPlatformAdmin) void refreshRollout().catch(() => undefined)
  }, [isPlatformAdmin, refreshRollout])
  const isRolloutRunning = Boolean(rollout && rollout.finishedAt === null)
  useEffect(() => {
    if (!isRolloutRunning) return
    const timer = setInterval(() => {
      void refreshRollout().then(current => { if (current.rollout?.finishedAt) void refresh() }).catch(() => undefined)
    }, 3000)
    return () => clearInterval(timer)
  }, [isRolloutRunning, refreshRollout, refresh])

  const onConfirmAction = async () => {
    if (!action) return
    const { kind, runtime } = action
    setAction(null)
    setBusyOwnerId(runtime.ownerId)
    try {
      if (kind === 'upgrade') {
        await upgradeOwnerRuntime(runtime.ownerId)
        toast.success(`${ownerLabel(runtime)} 的运行环境已升级，会话正在恢复。`)
      } else if (kind === 'retire') {
        const { isRetired } = await retireOwnerRuntime(runtime.ownerId)
        toast.success(isRetired ? `${ownerLabel(runtime)} 的运行环境已停止。` : '该用户没有运行中的环境。')
      } else {
        const { isRecovered } = await recoverOwnerRuntimeLock(runtime.ownerId)
        toast.success(isRecovered ? '升级锁已清除，可以重新升级。' : '没有需要清除的升级锁。')
      }
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : '操作失败')
    } finally {
      setBusyOwnerId(null)
      void refresh()
    }
  }

  const onReviewRollout = async () => {
    try {
      const current = await refreshRollout()
      setConfirmation('')
      setPlan(current.plan)
    } catch (failure) { toast.error(failure instanceof Error ? failure.message : '无法读取升级计划') }
  }
  const onStartRollout = async () => {
    const reviewed = plan
    setPlan(null)
    if (!reviewed?.length) return
    try {
      setRollout((await startRuntimeRollout(reviewed.map(row => row.ownerId))).rollout)
      toast.success('批量升级已开始，会逐个升级并在控制器内存充足时继续。')
    } catch (failure) { toast.error(failure instanceof Error ? failure.message : '无法开始批量升级') }
  }

  const query = search.trim().toLowerCase()
  const visible = (runtimes ?? []).filter(runtime =>
    `${runtime.ownerName ?? ''} ${runtime.ownerId} ${runtime.orgName ?? ''}`.toLowerCase().includes(query))
  const driftedCount = (runtimes ?? []).filter(runtime => runtime.isDrifted).length

  return (
    <DashboardLayout title="运行环境" description="每位用户的 Agent 运行环境：版本、状态和维护操作。"
      headerActions={<>
        {isPlatformAdmin && <Button variant="outline" onClick={() => setScope(scope === 'org' ? 'all' : 'org')}>
          {scope === 'org' ? '查看所有企业' : '仅看当前企业'}
        </Button>}
        {isPlatformAdmin && <Button variant="outline" disabled={isRolloutRunning} onClick={() => void onReviewRollout()}>批量升级</Button>}
        <Button variant="outline" disabled={isLoading} onClick={() => void refresh()}>刷新</Button>
      </>}>
      <div className="space-y-4">
        {rollout && <RolloutPanel rollout={rollout} />}
        <div className="flex flex-wrap items-center gap-3">
          <Input className="max-w-sm" aria-label="搜索用户或企业" placeholder="搜索用户或企业" value={search}
            onChange={event => setSearch(event.target.value)} />
          {runtimes && <span className="text-sm text-muted-foreground">
            {runtimes.length} 个运行环境{driftedCount ? ` · ${driftedCount} 个待升级` : ''}
          </span>}
        </div>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {isLoading && !runtimes ? <p role="status">正在加载运行环境…</p> : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader><TableRow>
                <TableHead>用户</TableHead>
                {scope === 'all' && <TableHead>企业</TableHead>}
                <TableHead>账号</TableHead>
                <TableHead>运行状态</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>操作</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {visible.map(runtime => (
                  <TableRow key={runtime.ownerId}>
                    <TableCell>
                      <div>{ownerLabel(runtime)}</div>
                      <div className="text-xs text-muted-foreground break-all">{runtime.ownerId}</div>
                    </TableCell>
                    {scope === 'all' && <TableCell>{runtime.orgName ?? '—'}</TableCell>}
                    <TableCell>
                      <Badge variant={runtime.ownerStatus === 'active' ? 'secondary' : 'destructive'}>
                        {ownerStatusLabels[runtime.ownerStatus] ?? runtime.ownerStatus}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div>{phaseLabels[runtime.phase] ?? runtime.phase}</div>
                      {runtime.allocations > 1 && <div className="text-xs text-muted-foreground">{runtime.allocations} 个分配</div>}
                      {runtime.upgradeLock && <div className="text-xs text-amber-600">
                        升级锁{runtime.upgradeLock.createdAt ? ` · ${new Date(runtime.upgradeLock.createdAt).toLocaleString()}` : ''}
                      </div>}
                    </TableCell>
                    <TableCell>
                      {runtime.isDrifted ? <Badge variant="outline" className="border-amber-500 text-amber-600">待升级</Badge> : <span>当前版本</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        {runtime.canUpgrade && <Button size="sm" variant="outline" disabled={busyOwnerId === runtime.ownerId || isRolloutRunning}
                          onClick={() => setAction({ kind: 'upgrade', runtime })}>{runtime.isDrifted ? '升级' : '重载'}</Button>}
                        {runtime.canRetire && <Button size="sm" variant="outline" disabled={busyOwnerId === runtime.ownerId}
                          onClick={() => setAction({ kind: 'retire', runtime })}>停止</Button>}
                        {runtime.canRecoverLock && <Button size="sm" variant="outline" disabled={busyOwnerId === runtime.ownerId}
                          onClick={() => setAction({ kind: 'recover', runtime })}>清除升级锁</Button>}
                        {busyOwnerId === runtime.ownerId && <span role="status" className="text-sm text-muted-foreground">处理中…</span>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {!visible.length && !error && <TableRow><TableCell colSpan={scope === 'all' ? 6 : 5}>没有运行环境。</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <AlertDialog open={Boolean(action)} onOpenChange={open => { if (!open) setAction(null) }}>
        <AlertDialogContent>
          {action && <>
            <AlertDialogHeader>
              <AlertDialogTitle>{actionCopy[action.kind].title}：{ownerLabel(action.runtime)}</AlertDialogTitle>
              <AlertDialogDescription>{actionCopy[action.kind].description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={() => void onConfirmAction()}>{actionCopy[action.kind].confirm}</AlertDialogAction>
            </AlertDialogFooter>
          </>}
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={plan !== null} onOpenChange={open => { if (!open) setPlan(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>批量升级所有企业的运行环境</AlertDialogTitle>
            <AlertDialogDescription>
              {plan?.length
                ? `将逐个升级以下 ${plan.length} 位用户的运行环境。每次升级前等待控制器内存回落；内存过高时自动停止。有执行中工作的用户会被跳过，稍后可重试。`
                : '所有运行环境都已是当前版本。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {Boolean(plan?.length) && <div className="space-y-3">
            <ul className="max-h-60 overflow-y-auto rounded-md border p-2 text-sm">
              {plan!.map(row => <li key={row.ownerId}>{ownerLabel(row)} · {row.orgName ?? row.orgId}</li>)}
            </ul>
            <label className="block space-y-1 text-sm">
              <span>输入用户数量 {plan!.length} 以确认</span>
              <Input aria-label="确认升级的用户数量" inputMode="numeric" value={confirmation} onChange={event => setConfirmation(event.target.value)} />
            </label>
          </div>}
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            {Boolean(plan?.length) && <AlertDialogAction disabled={confirmation.trim() !== String(plan!.length)}
              onClick={() => void onStartRollout()}>开始升级</AlertDialogAction>}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  )
}

function RolloutPanel({ rollout }: { rollout: RuntimeRollout }) {
  const done = rollout.owners.filter(owner => owner.outcome !== 'pending').length
  return (
    <section aria-label="批量升级进度" className="space-y-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">
          {rollout.finishedAt === null ? `批量升级进行中 · ${done}/${rollout.owners.length}` : `最近一次批量升级 · ${new Date(rollout.finishedAt).toLocaleString()}`}
        </h2>
        {rollout.stopped && <span className="text-sm text-destructive">
          控制器内存{rollout.stopped.controllerMemory !== null ? `达到 ${Math.round(rollout.stopped.controllerMemory * 100)}%` : '未回落'}，已停止；稍后可重新开始。
        </span>}
      </div>
      <ul className="grid gap-1 text-sm sm:grid-cols-2">
        {rollout.owners.map(owner => (
          <li key={owner.ownerId} className="flex flex-wrap gap-2">
            <span>{owner.ownerName}</span>
            <span className={owner.outcome === 'failed' ? 'text-destructive' : owner.outcome === 'upgraded' ? 'text-emerald-600' : 'text-muted-foreground'}>
              {outcomeLabels[owner.outcome]}
            </span>
            {owner.error && <span className="text-xs text-muted-foreground">{owner.error}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}
