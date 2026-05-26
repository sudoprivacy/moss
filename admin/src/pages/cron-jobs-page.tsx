'use client'

import { useEffect, useState, useCallback } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getAdminCronJobs, getCronJobRuns, disableCronJob, type CronJob, type CronJobRun } from '@/lib/api/cron'
import { getUsers, type AuthUser } from '@/lib/api/auth'
import { Search, RefreshCw, Clock, Pause, History, Loader2, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { Link } from 'react-router-dom'

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  ok: { label: '成功', variant: 'default' },
  error: { label: '失败', variant: 'destructive' },
  skipped: { label: '跳过', variant: 'secondary' },
  missed: { label: '错过', variant: 'outline' },
  running: { label: '运行中', variant: 'default' },
  queued: { label: '队列中', variant: 'secondary' },
}

function CronJobsSkeleton() {
  return (
    <div className="space-y-4">
      {[...Array(10)].map((_, i) => (
        <div key={i} className="flex items-center gap-4 p-4 border rounded-lg">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-24" />
        </div>
      ))}
    </div>
  )
}

export default function CronJobsPage() {
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [users, setUsers] = useState<AuthUser[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [userFilter, setUserFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedJob, setSelectedJob] = useState<CronJob | null>(null)
  const [runs, setRuns] = useState<CronJobRun[]>([])
  const [runsLoading, setRunsLoading] = useState(false)
  const [togglingJobId, setTogglingJobId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const [jobsRes, usersRes] = await Promise.all([
        getAdminCronJobs(),
        getUsers().catch(() => ({ users: [] })),
      ])
      if (jobsRes.success && jobsRes.data) {
        setJobs(jobsRes.data)
      }
      setUsers(usersRes.users)
    } catch (error) {
      console.error('Failed to fetch cron jobs:', error)
      toast.error('获取定时任务列表失败')
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleRefresh = () => {
    setIsRefreshing(true)
    fetchData()
  }

  const handleViewRuns = async (job: CronJob) => {
    setSelectedJob(job)
    setRunsLoading(true)
    try {
      const res = await getCronJobRuns(job.id, 50)
      if (res.success && res.data) {
        setRuns(res.data)
      }
    } catch (error) {
      console.error('Failed to fetch runs:', error)
      toast.error('获取执行记录失败')
    } finally {
      setRunsLoading(false)
    }
  }

  const handleToggleJob = async (job: CronJob) => {
    if (!job.enabled) return
    setTogglingJobId(job.id)
    try {
      await disableCronJob(job.id)
      toast.success('任务已禁用')
      setJobs(jobs.map(j => j.id === job.id ? { ...j, enabled: false } : j))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setTogglingJobId(null)
    }
  }

  const filteredJobs = jobs
    .filter((job) => {
      const matchesSearch =
        job.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        job.id.toLowerCase().includes(searchQuery.toLowerCase())
      const matchesUser = userFilter === 'all' || job.userId === userFilter
      const matchesStatus = statusFilter === 'all' ||
        (statusFilter === 'enabled' && job.enabled) ||
        (statusFilter === 'disabled' && !job.enabled) ||
        (statusFilter === 'error' && job.lastStatus === 'error')
      return matchesSearch && matchesUser && matchesStatus
    })
    .sort((a, b) => b.createdAt - a.createdAt)

  const getUserName = (userId: string) => {
    const user = users.find((u) => u.id === userId)
    return user?.name || userId.slice(0, 8)
  }

  const formatSchedule = (job: CronJob) => {
    return job.schedule.description || job.schedule.value
  }

  const formatNextRun = (nextRunAt: number | null) => {
    if (!nextRunAt) return '-'
    return format(new Date(nextRunAt), 'MM-dd HH:mm')
  }

  if (isLoading) {
    return (
      <DashboardLayout title="定时任务管理">
        <CronJobsSkeleton />
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title="定时任务管理">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 flex-wrap gap-2">
            <div className="relative w-full max-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                placeholder="搜索任务..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={userFilter} onValueChange={setUserFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="筛选用户" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部用户</SelectItem>
                {users.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {user.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="筛选状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="enabled">已启用</SelectItem>
                <SelectItem value="disabled">已禁用</SelectItem>
                <SelectItem value="error">有错误</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div className="rounded-lg border p-4">
            <div className="text-sm text-muted-foreground">总任务数</div>
            <div className="text-2xl font-bold">{jobs.length}</div>
          </div>
          <div className="rounded-lg border p-4">
            <div className="text-sm text-muted-foreground">已启用</div>
            <div className="text-2xl font-bold text-green-600">{jobs.filter(j => j.enabled).length}</div>
          </div>
          <div className="rounded-lg border p-4">
            <div className="text-sm text-muted-foreground">已禁用</div>
            <div className="text-2xl font-bold text-gray-500">{jobs.filter(j => !j.enabled).length}</div>
          </div>
          <div className="rounded-lg border p-4">
            <div className="text-sm text-muted-foreground">错误数</div>
            <div className="text-2xl font-bold text-red-600">{jobs.filter(j => j.lastStatus === 'error').length}</div>
          </div>
        </div>

        {/* Table */}
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>任务名称</TableHead>
                <TableHead>用户</TableHead>
                <TableHead>调度</TableHead>
                <TableHead>下次执行</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>执行次数</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredJobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    暂无定时任务
                  </TableCell>
                </TableRow>
              ) : (
                filteredJobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      <div>
                        <div className="font-medium">{job.name}</div>
                        <div className="text-xs text-muted-foreground">{job.id.slice(0, 8)}</div>
                      </div>
                    </TableCell>
                    <TableCell>{getUserName(job.userId)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm">{formatSchedule(job)}</span>
                      </div>
                    </TableCell>
                    <TableCell>{formatNextRun(job.nextRunAt)}</TableCell>
                    <TableCell>
                      <Badge variant={job.enabled ? 'default' : 'secondary'}>
                        {job.enabled ? '已启用' : '已禁用'}
                      </Badge>
                      {job.lastStatus === 'error' && (
                        <Badge variant="destructive" className="ml-1">错误</Badge>
                      )}
                    </TableCell>
                    <TableCell>{job.runCount}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleViewRuns(job)}
                        >
                          <History className="mr-1 h-4 w-4" />
                          记录
                        </Button>
                        <Button
                          variant={job.enabled ? 'destructive' : 'secondary'}
                          size="sm"
                          onClick={() => handleToggleJob(job)}
                          disabled={!job.enabled || togglingJobId === job.id}
                        >
                          {togglingJobId === job.id ? (
                            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                          ) : (
                            <Pause className="mr-1 h-4 w-4" />
                          )}
                          {job.enabled ? '禁用' : '已禁用'}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Runs Dialog */}
      <Dialog open={!!selectedJob} onOpenChange={() => setSelectedJob(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              执行记录 - {selectedJob?.name}
            </DialogTitle>
          </DialogHeader>
          {runsLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : runs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              暂无执行记录
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>会话</TableHead>
                  <TableHead>错误</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <div className="text-sm">
                        {format(new Date(run.createdAt), 'MM-dd HH:mm:ss')}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusConfig[run.status]?.variant || 'secondary'}>
                        {statusConfig[run.status]?.label || run.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {run.sessionId ? (
                        <div className="flex flex-col gap-1">
                          {run.session?.deletedAt ? (
                            <span className="font-mono text-xs text-muted-foreground">{run.sessionId.slice(0, 8)}</span>
                          ) : (
                            <Button variant="link" size="sm" className="h-auto justify-start p-0 font-mono text-xs" asChild>
                              <Link to={`/sessions/${run.sessionId}`}>
                                {run.session?.title || run.sessionId.slice(0, 8)}
                                <ExternalLink className="ml-1 h-3 w-3" />
                              </Link>
                            </Button>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {run.session?.assistantName || run.session?.status || run.sessionId.slice(0, 8)}
                          </span>
                        </div>
                      ) : '-'}
                    </TableCell>
                    <TableCell>
                      {run.error ? (
                        <span className="block max-w-[280px] whitespace-pre-wrap break-words text-sm text-red-600" title={run.error}>
                          {run.error}
                        </span>
                      ) : run.summary ? (
                        <span className="block max-w-[280px] text-sm text-muted-foreground">{run.summary}</span>
                      ) : (
                        '-'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
