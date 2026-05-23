import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Eye,
  Loader2,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'

import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  type WikiBuildJob,
  type WikiBuildJobListItem,
  listWikiBuildJobs,
  retryWikiBuildJob,
} from '@/lib/api/document-center'

const STATUS_LABELS: Record<WikiBuildJob['status'], string> = {
  queued: '排队中',
  running: '构建中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
}

const STATUS_OPTIONS: Array<WikiBuildJob['status'] | 'all'> = [
  'all',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]

function formatTime(ts: number | null): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function formatDuration(job: WikiBuildJob): string {
  const start = job.startedAt ?? job.queuedAt
  const end = job.finishedAt ?? (job.status === 'running' ? Date.now() : null)
  if (!start || !end) return '-'
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m ${rest}s`
}

function statusBadge(job: WikiBuildJob) {
  if (job.status === 'succeeded') {
    return <Badge className="bg-emerald-500/90"><CheckCircle2 />成功</Badge>
  }
  if (job.status === 'failed') {
    return <Badge variant="destructive"><XCircle />失败</Badge>
  }
  if (job.status === 'running') {
    return <Badge className="bg-blue-500/90"><Loader2 className="animate-spin" />构建中</Badge>
  }
  if (job.status === 'queued') {
    return <Badge variant="secondary"><Clock3 />排队中</Badge>
  }
  return <Badge variant="outline">已取消</Badge>
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

export default function BuildJobsPage() {
  const [jobs, setJobs] = useState<WikiBuildJobListItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<WikiBuildJob['status'] | 'all'>('all')
  const [selectedJob, setSelectedJob] = useState<WikiBuildJobListItem | null>(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listWikiBuildJobs({ status, limit: 100 })
      setJobs(data.items)
      setTotal(data.total)
    } catch (err) {
      toast.error(`加载构建任务失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const hasActive = jobs.some((job) => job.status === 'queued' || job.status === 'running')
    if (!hasActive) return
    const timer = setInterval(() => {
      listWikiBuildJobs({ status, limit: 100 })
        .then((data) => {
          setJobs(data.items)
          setTotal(data.total)
        })
        .catch(() => undefined)
    }, 5000)
    return () => clearInterval(timer)
  }, [jobs, status])

  const stats = useMemo(() => {
    return {
      active: jobs.filter((job) => job.status === 'queued' || job.status === 'running').length,
      failed: jobs.filter((job) => job.status === 'failed').length,
      succeeded: jobs.filter((job) => job.status === 'succeeded').length,
    }
  }, [jobs])

  const handleRetry = async (job: WikiBuildJobListItem) => {
    setRetryingId(job.id)
    try {
      await retryWikiBuildJob(job.id)
      toast.success('已重新创建构建任务')
      await refresh()
    } catch (err) {
      toast.error(`重试失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRetryingId(null)
    }
  }

  return (
    <DashboardLayout
      title="构建任务"
      description="跟踪文档从原始格式构建为 Wiki 的每一次任务状态、进度和错误原因"
    >
      <div className="mb-4 grid gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">任务总数</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">排队 / 运行</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-blue-600">{stats.active}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">成功</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-emerald-600">{stats.succeeded}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">失败</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-red-600">{stats.failed}</div>
          </CardContent>
        </Card>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Select value={status} onValueChange={(value) => setStatus(value as WikiBuildJob['status'] | 'all')}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="任务状态" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {option === 'all' ? '全部状态' : STATUS_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <RefreshCw className="mr-1.5 size-4" />}
            刷新
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">显示最近 100 条任务</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : jobs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12 text-center">
            <PlayCircle className="mb-3 size-10 text-muted-foreground" />
            <p className="mb-1 text-base font-medium">还没有构建任务</p>
            <p className="text-sm text-muted-foreground">在知识树管理中创建 Wiki 并点击构建后，任务会出现在这里。</p>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="grid grid-cols-[1.2fr_1.8fr_1fr_1fr_1fr_1.2fr_1.4fr] gap-3 border-b bg-muted/50 px-4 py-2 text-xs font-medium text-muted-foreground">
            <span>任务</span>
            <span>Wiki</span>
            <span>状态</span>
            <span>进度</span>
            <span>耗时</span>
            <span>排队时间</span>
            <span className="text-right">操作</span>
          </div>
          {jobs.map((job) => (
            <div key={job.id} className="grid grid-cols-[1.2fr_1.8fr_1fr_1fr_1fr_1.2fr_1.4fr] gap-3 border-b px-4 py-3 text-sm last:border-b-0">
              <div className="min-w-0">
                <div className="font-mono text-xs" title={job.id}>{shortId(job.id)}</div>
                <div className="mt-1 text-xs text-muted-foreground">{job.triggeredBy}</div>
              </div>
              <div className="min-w-0">
                <div className="truncate font-medium" title={job.wikiName}>{job.wikiName}</div>
                {job.errorMessage && (
                  <div className="mt-1 flex items-center gap-1 truncate text-xs text-red-500" title={job.errorMessage}>
                    <AlertCircle className="size-3" />
                    {job.errorMessage}
                  </div>
                )}
              </div>
              <div>{statusBadge(job)}</div>
              <div>
                <div className="text-xs text-muted-foreground">{job.currentStep ?? '-'}</div>
                <div className="mt-1 h-1.5 rounded bg-muted">
                  <div className="h-1.5 rounded bg-primary" style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} />
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{job.progress}%</div>
              </div>
              <div className="text-muted-foreground">{formatDuration(job)}</div>
              <div className="text-xs text-muted-foreground">{formatTime(job.queuedAt)}</div>
              <div className="flex justify-end gap-1">
                <Button variant="outline" size="sm" onClick={() => setSelectedJob(job)}>
                  <Eye className="size-3.5" />
                  <span className="ml-1">详情</span>
                </Button>
                {job.status === 'failed' && (
                  <Button variant="outline" size="sm" onClick={() => void handleRetry(job)} disabled={retryingId === job.id}>
                    {retryingId === job.id ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                    <span className="ml-1">重试</span>
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!selectedJob} onOpenChange={(open) => !open && setSelectedJob(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>构建任务详情</DialogTitle>
            <DialogDescription>查看任务状态、执行时间、Runtime Session 和错误信息。</DialogDescription>
          </DialogHeader>
          {selectedJob && (
            <div className="space-y-4 text-sm">
              <div className="grid gap-3 md:grid-cols-2">
                <Info label="任务 ID" value={selectedJob.id} mono />
                <Info label="Wiki" value={selectedJob.wikiName} />
                <Info label="状态" value={STATUS_LABELS[selectedJob.status]} />
                <Info label="进度" value={`${selectedJob.progress}%`} />
                <Info label="当前步骤" value={selectedJob.currentStep ?? '-'} />
                <Info label="触发人" value={selectedJob.triggeredBy} />
                <Info label="排队时间" value={formatTime(selectedJob.queuedAt)} />
                <Info label="开始时间" value={formatTime(selectedJob.startedAt)} />
                <Info label="结束时间" value={formatTime(selectedJob.finishedAt)} />
                <Info label="耗时" value={formatDuration(selectedJob)} />
                <Info label="Session ID" value={selectedJob.sessionId ?? '-'} mono />
                <Info label="知识树节点" value={selectedJob.wikiNodeId ?? '-'} mono />
              </div>
              <div className="rounded-lg border p-3">
                <div className="mb-2 font-medium">流程状态</div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">创建任务</Badge>
                  <span>→</span>
                  <Badge variant={selectedJob.startedAt ? 'outline' : 'secondary'}>Worker 接收</Badge>
                  <span>→</span>
                  <Badge variant={selectedJob.status === 'succeeded' ? 'outline' : 'secondary'}>生成 Wiki</Badge>
                  <span>→</span>
                  {selectedJob.status === 'failed' ? (
                    <Badge variant="destructive">失败</Badge>
                  ) : selectedJob.status === 'succeeded' ? (
                    <Badge className="bg-emerald-500/90">完成</Badge>
                  ) : (
                    <Badge variant="secondary">等待完成</Badge>
                  )}
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="mb-2 font-medium">错误信息</div>
                <p className={selectedJob.errorMessage ? 'whitespace-pre-wrap text-red-500' : 'text-muted-foreground'}>
                  {selectedJob.errorMessage ?? '无错误'}
                </p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className={mono ? 'break-all font-mono text-xs' : 'break-all'}>{value}</div>
    </div>
  )
}
