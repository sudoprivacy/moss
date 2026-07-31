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
  DialogDescription,
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
import {
  getEventTriggers,
  createEventTrigger,
  updateEventTrigger,
  deleteEventTrigger,
  setEventTriggerEnabled,
  rotateEventTriggerSecret,
  getEventTriggerRuns,
  type EventTrigger,
  type EventTriggerRun,
  type EventTriggerFormInput,
} from '@/lib/api/event-triggers'
import { getInstalledAgents, type InstalledAgentInfo } from '@/lib/api/agent-hub'
import {
  Search,
  RefreshCw,
  Webhook,
  Pause,
  Play,
  History,
  Loader2,
  ExternalLink,
  Plus,
  Pencil,
  Trash2,
  Copy,
  KeyRound,
} from 'lucide-react'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { Link } from 'react-router-dom'

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  ok: { label: '成功', variant: 'default' },
  error: { label: '失败', variant: 'destructive' },
  skipped: { label: '跳过', variant: 'secondary' },
  running: { label: '运行中', variant: 'outline' },
  queued: { label: '排队中', variant: 'outline' },
}

const emptyForm: EventTriggerFormInput = {
  name: '',
  promptTemplate: '',
  assistantName: '',
  conversationMode: 'new',
  workspace: '',
  timeoutMs: null,
  rateLimitPerMin: null,
}

function fmt(ts: number | null): string {
  if (!ts) return '-'
  return format(new Date(ts), 'yyyy-MM-dd HH:mm:ss')
}

export default function EventTriggersPage() {
  const [triggers, setTriggers] = useState<EventTrigger[]>([])
  const [agents, setAgents] = useState<InstalledAgentInfo[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  // Create / edit dialog
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<EventTrigger | null>(null)
  const [form, setForm] = useState<EventTriggerFormInput>(emptyForm)
  const [submitting, setSubmitting] = useState(false)

  // One-time secret reveal (create + rotate share this)
  const [newSecret, setNewSecret] = useState<{ secret: string; trigger: EventTrigger } | null>(null)
  const [copied, setCopied] = useState(false)

  // Run history
  const [runsFor, setRunsFor] = useState<EventTrigger | null>(null)
  const [runs, setRuns] = useState<EventTriggerRun[]>([])
  const [runsLoading, setRunsLoading] = useState(false)

  // Destructive confirms
  const [deleteTarget, setDeleteTarget] = useState<EventTrigger | null>(null)
  const [rotateTarget, setRotateTarget] = useState<EventTrigger | null>(null)

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true)
    try {
      const res = await getEventTriggers()
      setTriggers(res.triggers || [])
    } catch (err) {
      console.error('Failed to load event triggers:', err)
      toast.error(err instanceof Error ? err.message : '获取事件触发器失败')
    } finally {
      setLoading(false)
      if (showSpinner) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load()
    // getInstalledAgents resolves to InstalledAgentInfo[] directly (not wrapped).
    getInstalledAgents()
      .then((list) => setAgents(Array.isArray(list) ? list : []))
      .catch(() => setAgents([]))
  }, [load])

  // Poll while any run is in flight so the history panel reflects progress
  // without the user re-opening it (runs settle in seconds, not minutes).
  useEffect(() => {
    if (!runsFor) return
    const hasActive = runs.some((r) => r.status === 'queued' || r.status === 'running')
    if (!hasActive) return
    const t = setTimeout(() => {
      getEventTriggerRuns(runsFor.id, 50)
        .then((res) => setRuns(res.runs || []))
        .catch(() => {})
    }, 2000)
    return () => clearTimeout(t)
  }, [runsFor, runs])

  const filtered = triggers.filter((t) => {
    const q = search.toLowerCase()
    return (
      !q ||
      t.name.toLowerCase().includes(q) ||
      (t.assistant_name || '').toLowerCase().includes(q) ||
      t.secret_prefix.toLowerCase().includes(q)
    )
  })

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm)
    setFormOpen(true)
  }

  const openEdit = (t: EventTrigger) => {
    setEditing(t)
    setForm({
      name: t.name,
      promptTemplate: t.prompt_template,
      assistantName: t.assistant_name || '',
      conversationMode: t.conversation_mode,
      workspace: t.workspace || '',
      timeoutMs: t.timeout_ms,
      rateLimitPerMin: t.rate_limit_per_min,
    })
    setFormOpen(true)
  }

  const submit = async () => {
    if (!form.name.trim()) return toast.error('请填写名称')
    if (!form.promptTemplate.trim()) return toast.error('请填写提示词模板')
    setSubmitting(true)
    try {
      if (editing) {
        const res = await updateEventTrigger(editing.id, form)
        if (res.success === false) throw new Error(res.message || '更新失败')
        toast.success('触发器已更新')
        setFormOpen(false)
        load()
      } else {
        const res = await createEventTrigger(form)
        if (!res.success || !res.secret || !res.trigger) {
          throw new Error(res.message || '创建失败')
        }
        setFormOpen(false)
        // Secret is returned exactly once — surface it immediately.
        setNewSecret({ secret: res.secret, trigger: res.trigger })
        load()
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setSubmitting(false)
    }
  }

  const toggleEnabled = async (t: EventTrigger) => {
    try {
      await setEventTriggerEnabled(t.id, !t.enabled)
      toast.success(t.enabled ? '已停用' : '已启用')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  const doDelete = async () => {
    if (!deleteTarget) return
    try {
      await deleteEventTrigger(deleteTarget.id)
      toast.success('触发器已删除')
      setDeleteTarget(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  const doRotate = async () => {
    if (!rotateTarget) return
    try {
      const res = await rotateEventTriggerSecret(rotateTarget.id)
      if (!res.success || !res.secret || !res.trigger) {
        throw new Error(res.message || '轮换失败')
      }
      setRotateTarget(null)
      setNewSecret({ secret: res.secret, trigger: res.trigger })
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '轮换失败')
    }
  }

  const openRuns = async (t: EventTrigger) => {
    setRunsFor(t)
    setRunsLoading(true)
    try {
      const res = await getEventTriggerRuns(t.id, 50)
      setRuns(res.runs || [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '获取运行记录失败')
      setRuns([])
    } finally {
      setRunsLoading(false)
    }
  }

  const copy = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const fullEventsUrl = (t: EventTrigger) => `${window.location.origin}${t.events_url}`

  if (loading) {
    return (
      <DashboardLayout title="事件触发器">
        <div className="space-y-4">
          <Skeleton className="h-10 w-full max-w-md" />
          <Skeleton className="h-64 w-full" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title="事件触发器">
      <div className="space-y-6">
        {/* Intro: this surface is unusual enough to warrant a one-liner. */}
        <p className="text-sm text-muted-foreground">
          外部系统通过 HTTP POST 事件到指定地址，即可近实时触发智能体执行分析任务。
          报告的投递由智能体自身的提示词/技能决定（调用客户 API 或通过企业应用发送）。
        </p>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="搜索名称、智能体或密钥前缀..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => load(true)} disabled={refreshing}>
              <RefreshCw className={`size-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
              刷新
            </Button>
            <Button onClick={openCreate}>
              <Plus className="size-4 mr-2" />
              新建触发器
            </Button>
          </div>
        </div>

        <div className="border rounded-lg">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>智能体</TableHead>
                <TableHead>密钥</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>最后调用</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <div className="font-medium">{t.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {t.conversation_mode === 'reuse' ? '复用会话' : '每次新建会话'}
                      {t.rate_limit_per_min ? ` · ${t.rate_limit_per_min}/分钟` : ''}
                    </div>
                  </TableCell>
                  <TableCell>{t.assistant_name || '默认智能体'}</TableCell>
                  <TableCell>
                    <code className="text-xs bg-muted px-2 py-1 rounded">{t.secret_prefix}...</code>
                  </TableCell>
                  <TableCell>
                    <Badge variant={t.enabled ? 'default' : 'secondary'}>
                      {t.enabled ? '启用' : '已停用'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {t.last_used_at ? fmt(t.last_used_at) : '从未调用'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{fmt(t.created_at)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" title="调用地址" onClick={() => copy(fullEventsUrl(t))}>
                        <Copy className="size-4" />
                      </Button>
                      <Button variant="ghost" size="sm" title="运行记录" onClick={() => openRuns(t)}>
                        <History className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title={t.enabled ? '停用' : '启用'}
                        onClick={() => toggleEnabled(t)}
                      >
                        {t.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
                      </Button>
                      <Button variant="ghost" size="sm" title="编辑" onClick={() => openEdit(t)}>
                        <Pencil className="size-4" />
                      </Button>
                      <Button variant="ghost" size="sm" title="轮换密钥" onClick={() => setRotateTarget(t)}>
                        <KeyRound className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="删除"
                        onClick={() => setDeleteTarget(t)}
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                    <Webhook className="size-8 mx-auto mb-2 opacity-40" />
                    {triggers.length === 0 ? '还没有事件触发器' : '没有匹配的触发器'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Create / Edit */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        {/* DialogContent's base class includes `sm:max-w-lg`; a plain
            `max-w-*` loses to it on specificity, so widen with the sm: variant. */}
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? '编辑触发器' : '新建触发器'}</DialogTitle>
            <DialogDescription>
              提示词模板保存在服务端，事件数据会以 JSON 代码块追加其后 —— 调用方只能提供数据，不能注入指令。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="et-name">名称</Label>
              <Input
                id="et-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="如：订单风险审核"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="et-prompt">提示词模板</Label>
              <Textarea
                id="et-prompt"
                value={form.promptTemplate}
                onChange={(e) => setForm({ ...form, promptTemplate: e.target.value })}
                placeholder="有新订单提交。请分析该订单并判断是否需要人工复核。"
                rows={5}
              />
              <p className="text-xs text-muted-foreground">
                事件 payload 属于不可信输入，建议在此明确要求智能体将其视为数据而非指令，并绑定权限收敛的智能体。
              </p>
            </div>
            <div className="space-y-2">
              <Label>智能体</Label>
              <Select
                value={form.assistantName || '__default__'}
                onValueChange={(v) =>
                  setForm({ ...form, assistantName: v === '__default__' ? '' : v })
                }
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
                onValueChange={(v) =>
                  setForm({ ...form, conversationMode: v as 'new' | 'reuse' })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">每次新建会话（结束后自动回收）</SelectItem>
                  <SelectItem value="reuse">复用已有会话</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="et-rate">每分钟调用上限</Label>
                <Input
                  id="et-rate"
                  type="number"
                  value={form.rateLimitPerMin ?? ''}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      rateLimitPerMin: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                  placeholder="默认 120"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="et-timeout">单次运行超时（毫秒）</Label>
                <Input
                  id="et-timeout"
                  type="number"
                  value={form.timeoutMs ?? ''}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      timeoutMs: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                  placeholder="默认 900000（15 分钟）"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="et-workspace">工作目录（可选）</Label>
              <Input
                id="et-workspace"
                value={form.workspace || ''}
                onChange={(e) => setForm({ ...form, workspace: e.target.value })}
                placeholder="留空使用默认目录"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              取消
            </Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              {editing ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time secret reveal (create + rotate) */}
      <Dialog
        open={!!newSecret}
        onOpenChange={(open) => {
          if (!open) setNewSecret(null)
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>密钥已生成</DialogTitle>
            <DialogDescription>请立即保存，此密钥只显示这一次，之后无法找回。</DialogDescription>
          </DialogHeader>
          {newSecret && (
            <div className="space-y-4">
              <div className="p-4 bg-muted rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-muted-foreground">调用密钥</span>
                  <Button variant="ghost" size="sm" onClick={() => copy(newSecret.secret)}>
                    <Copy className="size-4 mr-1" />
                    {copied ? '已复制' : '复制'}
                  </Button>
                </div>
                <code className="text-sm break-all">{newSecret.secret}</code>
              </div>
              <div className="p-4 bg-muted rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-muted-foreground">调用地址</span>
                  <Button variant="ghost" size="sm" onClick={() => copy(fullEventsUrl(newSecret.trigger))}>
                    <Copy className="size-4 mr-1" />
                    复制
                  </Button>
                </div>
                <code className="text-xs break-all block">{fullEventsUrl(newSecret.trigger)}</code>
              </div>
              <div className="space-y-2">
                <span className="text-sm text-muted-foreground">调用示例</span>
                <pre className="p-3 bg-muted rounded-lg text-xs whitespace-pre-wrap break-all">
{`curl -X POST ${fullEventsUrl(newSecret.trigger)} \\
  -H "Authorization: Bearer ${newSecret.secret}" \\
  -H "Content-Type: application/json" \\
  -d '{"order_id":"SO-8812","amount":240000}'`}
                </pre>
              </div>
              <Button className="w-full" onClick={() => setNewSecret(null)}>
                我已保存
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Run history */}
      <Dialog
        open={!!runsFor}
        onOpenChange={(open) => {
          if (!open) {
            setRunsFor(null)
            setRuns([])
          }
        }}
      >
        <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>运行记录 · {runsFor?.name}</DialogTitle>
            <DialogDescription>最近 50 次调用，运行中的记录会自动刷新。</DialogDescription>
          </DialogHeader>
          {runsLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>状态</TableHead>
                  <TableHead>事件数据</TableHead>
                  <TableHead>开始</TableHead>
                  <TableHead>结束</TableHead>
                  <TableHead>会话</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => {
                  const cfg = statusConfig[r.status] || { label: r.status, variant: 'outline' as const }
                  return (
                    <TableRow key={r.id}>
                      <TableCell>
                        <Badge variant={cfg.variant}>{cfg.label}</Badge>
                        {r.error && (
                          <div className="text-xs text-destructive mt-1 max-w-[220px] break-words">
                            {r.error}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <code className="text-xs block max-w-[260px] truncate">
                          {r.payload ? JSON.stringify(r.payload) : '-'}
                        </code>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{fmt(r.started_at)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{fmt(r.finished_at)}</TableCell>
                      <TableCell>
                        {r.session_id ? (
                          <Link
                            to={`/sessions/${r.session_id}`}
                            className="text-primary hover:underline inline-flex items-center gap-1 text-sm"
                          >
                            查看
                            <ExternalLink className="size-3" />
                          </Link>
                        ) : (
                          <span className="text-muted-foreground text-sm">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
                {runs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      还没有运行记录
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除触发器？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.name}」将被删除，其调用地址立即失效。运行记录会保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rotate confirm */}
      <AlertDialog open={!!rotateTarget} onOpenChange={(open) => !open && setRotateTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>轮换密钥？</AlertDialogTitle>
            <AlertDialogDescription>
              「{rotateTarget?.name}」将生成新密钥，旧密钥立即失效 —— 正在使用旧密钥的外部系统会立刻收到 401。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={doRotate}>轮换</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  )
}
