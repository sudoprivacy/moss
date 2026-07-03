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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { getAdminCronJobs, getCronJobRuns, disableCronJob, enableCronJob, createCronJob, updateCronJob, deleteCronJob, triggerCronJob, type CronJob, type CronJobRun, type CronJobFormInput } from '@/lib/api/cron'
import { getUsers } from '@/lib/api/auth'
import { getInstalledAgents, type InstalledAgentInfo } from '@/lib/api/agent-hub'
import type { AuthUser } from '@/lib/api/types'
import { Search, RefreshCw, Clock, Pause, Play, History, Loader2, ExternalLink, Plus, Pencil, Trash2, Zap } from 'lucide-react'
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
  const [triggeringJobId, setTriggeringJobId] = useState<string | null>(null)

  // Create/edit form dialog
  const emptyForm: CronJobFormInput = { name: '', scheduleValue: '', scheduleDescription: '', payloadMessage: '', conversationMode: 'new', boundSessionId: '', assistantName: '' }
  const [agents, setAgents] = useState<InstalledAgentInfo[]>([])
  const [formOpen, setFormOpen] = useState(false)
  const [editingJob, setEditingJob] = useState<CronJob | null>(null)
  const [form, setForm] = useState<CronJobFormInput>(emptyForm)
  const [saving, setSaving] = useState(false)

  // Delete confirmation
  const [deletingJob, setDeletingJob] = useState<CronJob | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const [jobsRes, usersRes, agentsRes] = await Promise.all([
        getAdminCronJobs(),
        getUsers().catch(() => ({ users: [] })),
        getInstalledAgents().catch(() => [] as InstalledAgentInfo[]),
      ])
      if (jobsRes.success && jobsRes.data) {
        setJobs(jobsRes.data)
      }
      setUsers(usersRes.users)
      setAgents(agentsRes)
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
    setTogglingJobId(job.id)
    try {
      if (job.enabled) {
        await disableCronJob(job.id)
        toast.success('任务已禁用')
        setJobs(jobs.map(j => j.id === job.id ? { ...j, enabled: false } : j))
      } else {
        await enableCronJob(job.id)
        toast.success('任务已启用')
        setJobs(jobs.map(j => j.id === job.id ? { ...j, enabled: true } : j))
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setTogglingJobId(null)
    }
  }

  const handleTriggerJob = async (job: CronJob) => {
    setTriggeringJobId(job.id)
    try {
      const res = await triggerCronJob(job.id)
      if (res.success) {
        toast.success('已手动触发任务')
      } else {
        toast.error(res.message || '触发失败')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '触发失败')
    } finally {
      setTriggeringJobId(null)
    }
  }

  const openCreateForm = () => {
    setEditingJob(null)
    setForm(emptyForm)
    setFormOpen(true)
  }

  const openEditForm = (job: CronJob) => {
    setEditingJob(job)
    setForm({
      name: job.name,
      scheduleValue: job.schedule.value,
      scheduleDescription: job.schedule.description || '',
      payloadMessage: job.payloadMessage,
      conversationMode: job.conversationMode,
      boundSessionId: job.boundSessionId || '',
      assistantName: job.assistantName || '',
    })
    setFormOpen(true)
  }

  const handleSaveForm = async () => {
    if (!form.name.trim() || !form.scheduleValue.trim() || !form.payloadMessage.trim()) {
      toast.error('请填写任务名称、调度表达式和消息内容')
      return
    }
    setSaving(true)
    try {
      const res = editingJob ? await updateCronJob(editingJob.id, form) : await createCronJob(form)
      if (res.success) {
        toast.success(editingJob ? '任务已更新' : '任务已创建')
        setFormOpen(false)
        fetchData()
      } else {
        toast.error(res.message || '保存失败')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleConfirmDelete = async () => {
    if (!deletingJob) return
    setDeleteBusy(true)
    try {
      const res = await deleteCronJob(deletingJob.id)
      if (res.success) {
        toast.success('任务已删除')
        setJobs(jobs.filter(j => j.id !== deletingJob.id))
        setDeletingJob(null)
      } else {
        toast.error(res.message || '删除失败')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败')
    } finally {
      setDeleteBusy(false)
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

  const getUserName = (job: CronJob) => {
    // Prefer the server-resolved name: the owner may not be in this org's
    // roster (e.g. a super_admin who created the job while switched into it).
    if (job.userName) return job.userName
    const user = users.find((u) => u.id === job.userId)
    return user?.name || job.userId.slice(0, 8)
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
                {/* Job owners outside this org's roster (e.g. a super_admin
                    who created jobs while switched into this org) */}
                {[...new Map(jobs
                  .filter((job) => !users.some((u) => u.id === job.userId))
                  .map((job) => [job.userId, job])).values()]
                  .map((job) => (
                    <SelectItem key={job.userId} value={job.userId}>
                      {getUserName(job)}
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
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleRefresh} disabled={isRefreshing}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              刷新
            </Button>
            <Button onClick={openCreateForm}>
              <Plus className="mr-2 h-4 w-4" />
              新建任务
            </Button>
          </div>
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
                    <TableCell>{getUserName(job)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm">{formatSchedule(job)}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {(job.assistantName || '默认智能体')} · {job.conversationMode === 'reuse' ? '复用会话' : '新建会话'}
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
                          onClick={() => handleTriggerJob(job)}
                          disabled={triggeringJobId === job.id}
                          title="立即触发"
                        >
                          {triggeringJobId === job.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Zap className="h-4 w-4" />
                          )}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => openEditForm(job)} title="编辑">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleViewRuns(job)}
                          title="执行记录"
                        >
                          <History className="h-4 w-4" />
                        </Button>
                        <Button
                          variant={job.enabled ? 'secondary' : 'default'}
                          size="sm"
                          onClick={() => handleToggleJob(job)}
                          disabled={togglingJobId === job.id}
                          title={job.enabled ? '禁用' : '启用'}
                        >
                          {togglingJobId === job.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : job.enabled ? (
                            <Pause className="h-4 w-4" />
                          ) : (
                            <Play className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setDeletingJob(job)}
                          title="删除"
                        >
                          <Trash2 className="h-4 w-4" />
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
                  <TableHead>详情</TableHead>
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

      {/* Create / Edit Dialog */}
      <Dialog open={formOpen} onOpenChange={(open) => !saving && setFormOpen(open)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingJob ? '编辑定时任务' : '新建定时任务'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="cron-name">任务名称</Label>
              <Input
                id="cron-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：每日早报"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cron-expr">调度表达式 (Cron)</Label>
              <Input
                id="cron-expr"
                value={form.scheduleValue}
                onChange={(e) => setForm({ ...form, scheduleValue: e.target.value })}
                placeholder="0 9 * * *"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">分 时 日 月 周，例如 0 9 * * * 表示每天 9:00</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cron-desc">调度说明（可选）</Label>
              <Input
                id="cron-desc"
                value={form.scheduleDescription}
                onChange={(e) => setForm({ ...form, scheduleDescription: e.target.value })}
                placeholder="每天 9:00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cron-msg">消息内容</Label>
              <Textarea
                id="cron-msg"
                value={form.payloadMessage}
                onChange={(e) => setForm({ ...form, payloadMessage: e.target.value })}
                placeholder="任务触发时发送给智能体的消息"
                rows={4}
              />
            </div>
            <div className="space-y-2">
              <Label>智能体</Label>
              <Select
                value={form.assistantName || '__default__'}
                onValueChange={(v) => setForm({ ...form, assistantName: v === '__default__' ? '' : v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="默认智能体" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">默认智能体</SelectItem>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.name}>
                      {a.displayName || a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>运行模式</Label>
              <Select
                value={form.conversationMode}
                onValueChange={(v) => setForm({ ...form, conversationMode: v as 'new' | 'reuse' })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">每次新建会话</SelectItem>
                  <SelectItem value="reuse">复用已有会话</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {form.conversationMode === 'new' ? '每次触发都会创建一个新的会话' : '将消息追加到绑定的会话中'}
              </p>
            </div>
            {form.conversationMode === 'reuse' && (
              <div className="space-y-2">
                <Label htmlFor="cron-session">绑定会话 ID（可选）</Label>
                <Input
                  id="cron-session"
                  value={form.boundSessionId}
                  onChange={(e) => setForm({ ...form, boundSessionId: e.target.value })}
                  placeholder="留空则首次运行时自动创建并绑定"
                  className="font-mono"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={handleSaveForm} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editingJob ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deletingJob} onOpenChange={(open) => !deleteBusy && !open && setDeletingJob(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除定时任务</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除任务「{deletingJob?.name}」吗？此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleConfirmDelete()
              }}
              disabled={deleteBusy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  )
}
