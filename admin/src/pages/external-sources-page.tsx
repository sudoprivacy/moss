import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Loader2,
  Plus,
  Plug,
  RefreshCw,
  Trash2,
  Pencil,
  Power,
  PowerOff,
  CheckCircle2,
  XCircle,
  CircleDashed,
  PlayCircle,
} from 'lucide-react'
import { toast } from 'sonner'

import { DashboardLayout } from '@/components/dashboard-layout'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

import {
  type ExternalSource,
  createExternalSource,
  deleteExternalSource,
  listConnectorTypes,
  listExternalSources,
  syncExternalSource,
  testExternalSource,
  updateExternalSource,
} from '@/lib/api/external-sources'

const CONNECTOR_LABELS: Record<string, string> = {
  filesystem: '本地/挂载目录',
  wecom_drive: '企微微盘',
}

// Connector-specific config field hints. Filesystem only needs rootPath;
// wecom_drive needs CorpID/AgentID/AgentSecret in credentials. The form
// renders these dynamically.
type FieldSpec = {
  key: string
  label: string
  placeholder?: string
  type?: 'text' | 'password' | 'number'
  bucket: 'config' | 'credentials'
  optional?: boolean
}

const CONNECTOR_FIELDS: Record<string, FieldSpec[]> = {
  filesystem: [
    {
      key: 'rootPath',
      label: '根目录路径',
      placeholder: '/data/docs 或 /Volumes/share/docs',
      bucket: 'config',
    },
  ],
  wecom_drive: [
    { key: 'corpId', label: 'CorpID', bucket: 'credentials' },
    { key: 'agentId', label: 'AgentID', bucket: 'credentials' },
    { key: 'agentSecret', label: 'AgentSecret', type: 'password', bucket: 'credentials' },
    {
      key: 'rootPath',
      label: '微盘内根目录(可留空,默认根)',
      placeholder: '/',
      bucket: 'config',
      optional: true,
    },
  ],
}

function formatTime(ts: number | null): string {
  if (!ts) return '从未'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function statusIcon(s: ExternalSource['lastSyncStatus']) {
  if (s === 'success') return <CheckCircle2 className="size-4 text-emerald-500" />
  if (s === 'failed') return <XCircle className="size-4 text-red-500" />
  if (s === 'running') return <Loader2 className="size-4 animate-spin text-blue-500" />
  return <CircleDashed className="size-4 text-muted-foreground" />
}

export default function ExternalSourcesPage() {
  const [sources, setSources] = useState<ExternalSource[]>([])
  const [connectorTypes, setConnectorTypes] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, 'sync' | 'test' | null>>({})

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [list, types] = await Promise.all([
        listExternalSources(),
        listConnectorTypes(),
      ])
      setSources(list)
      setConnectorTypes(types)
    } catch (err) {
      toast.error(`加载失败:${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Light-touch polling so running syncs flip to success/failed automatically.
  useEffect(() => {
    const id = setInterval(() => {
      listExternalSources()
        .then(setSources)
        .catch(() => undefined)
    }, 10_000)
    return () => clearInterval(id)
  }, [])

  const editingSource = useMemo(
    () => sources.find((s) => s.id === editingId) ?? null,
    [sources, editingId],
  )

  const handleSync = async (id: string) => {
    setBusy((m) => ({ ...m, [id]: 'sync' }))
    try {
      await syncExternalSource(id)
      toast.success('已触发同步,稍后刷新查看结果')
    } catch (err) {
      toast.error(`触发同步失败:${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy((m) => ({ ...m, [id]: null }))
    }
  }

  const handleTest = async (id: string) => {
    setBusy((m) => ({ ...m, [id]: 'test' }))
    try {
      const result = await testExternalSource(id)
      if (result.ok) {
        toast.success(`连接成功${result.message ? `:${result.message}` : ''}`)
      } else {
        toast.error(`连接失败:${result.message ?? '未知错误'}`)
      }
    } catch (err) {
      toast.error(`测试失败:${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy((m) => ({ ...m, [id]: null }))
    }
  }

  const handleToggleEnabled = async (s: ExternalSource) => {
    try {
      await updateExternalSource(s.id, { enabled: !s.enabled })
      await refresh()
    } catch (err) {
      toast.error(`更新失败:${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleDelete = async () => {
    if (!deletingId) return
    try {
      await deleteExternalSource(deletingId)
      toast.success('已删除')
      setDeletingId(null)
      await refresh()
    } catch (err) {
      toast.error(`删除失败:${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <DashboardLayout
      title="外部数据源"
      description="配置企微微盘 / 本地挂载目录等外部数据源,自动同步到文档中心"
    >
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          已配置 {sources.length} 个数据源
          {connectorTypes.length > 0 && (
            <>
              {' '}· 支持的连接器类型:
              {connectorTypes.map((t) => (
                <Badge key={t} variant="outline" className="mx-1">
                  {CONNECTOR_LABELS[t] ?? t}
                </Badge>
              ))}
            </>
          )}
        </p>
        <Button onClick={() => setCreating(true)} disabled={connectorTypes.length === 0}>
          <Plus className="mr-1.5 size-4" /> 新建数据源
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : sources.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12 text-center">
            <Plug className="size-10 text-muted-foreground mb-3" />
            <p className="text-base font-medium mb-1">还没有配置数据源</p>
            <p className="text-sm text-muted-foreground mb-4">
              支持企微微盘、本地挂载目录等。配置后系统会定时拉取并同步到文档中心。
            </p>
            <Button onClick={() => setCreating(true)} disabled={connectorTypes.length === 0}>
              <Plus className="mr-1.5 size-4" /> 新建第一个数据源
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {sources.map((s) => (
            <Card key={s.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <span className="truncate">{s.name}</span>
                      <Badge variant="outline">{CONNECTOR_LABELS[s.type] ?? s.type}</Badge>
                      {!s.enabled && <Badge variant="secondary">已停用</Badge>}
                      {s.autoBuildEnabled && (
                        <Badge variant="default" className="bg-amber-500/90">自动构建</Badge>
                      )}
                    </CardTitle>
                    <div className="mt-1 text-xs text-muted-foreground flex flex-wrap items-center gap-3">
                      <span className="flex items-center gap-1">
                        {statusIcon(s.lastSyncStatus)}
                        上次同步:{formatTime(s.lastSyncAt)}
                      </span>
                      <span>同步间隔:{Math.round(s.syncIntervalSec / 60)} 分钟</span>
                      {s.lastSyncError && (
                        <span className="text-red-500 truncate" title={s.lastSyncError}>
                          错误:{s.lastSyncError}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleTest(s.id)}
                      disabled={busy[s.id] === 'test'}
                    >
                      {busy[s.id] === 'test' ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <PlayCircle className="size-3.5" />
                      )}
                      <span className="ml-1">测试</span>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleSync(s.id)}
                      disabled={!s.enabled || busy[s.id] === 'sync'}
                    >
                      {busy[s.id] === 'sync' ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3.5" />
                      )}
                      <span className="ml-1">立即同步</span>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleToggleEnabled(s)}
                      title={s.enabled ? '停用' : '启用'}
                    >
                      {s.enabled ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditingId(s.id)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDeletingId(s.id)}
                    >
                      <Trash2 className="size-3.5 text-red-500" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="text-xs text-muted-foreground">
                  {Object.entries(s.config).length === 0 ? (
                    <span className="italic">无配置</span>
                  ) : (
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      {JSON.stringify(s.config)}
                    </code>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <SourceDialog
        open={creating}
        onOpenChange={(o) => {
          if (!o) setCreating(false)
        }}
        connectorTypes={connectorTypes}
        onSaved={() => {
          setCreating(false)
          refresh()
        }}
      />

      {/* Edit dialog */}
      <SourceDialog
        open={!!editingSource}
        existing={editingSource}
        onOpenChange={(o) => {
          if (!o) setEditingId(null)
        }}
        connectorTypes={connectorTypes}
        onSaved={() => {
          setEditingId(null)
          refresh()
        }}
      />

      {/* Delete confirm */}
      <AlertDialog open={!!deletingId} onOpenChange={(o) => !o && setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除数据源?</AlertDialogTitle>
            <AlertDialogDescription>
              删除后将不再同步,已同步进文档中心的内容将在下个同步周期被软删(保留 30 天)。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  )
}

// ============================================================
// Create / Edit dialog
// ============================================================

function SourceDialog({
  open,
  existing,
  connectorTypes,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  existing?: ExternalSource | null
  connectorTypes: string[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [type, setType] = useState<string>(existing?.type ?? connectorTypes[0] ?? '')
  const [name, setName] = useState(existing?.name ?? '')
  const [syncMinutes, setSyncMinutes] = useState<number>(
    existing ? Math.max(1, Math.round(existing.syncIntervalSec / 60)) : 60,
  )
  const [autoBuild, setAutoBuild] = useState<boolean>(existing?.autoBuildEnabled ?? false)
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setType(existing?.type ?? connectorTypes[0] ?? '')
    setName(existing?.name ?? '')
    setSyncMinutes(existing ? Math.max(1, Math.round(existing.syncIntervalSec / 60)) : 60)
    setAutoBuild(existing?.autoBuildEnabled ?? false)
    // Prefill config (rootPath etc.) from existing. Credentials are NEVER
    // returned from the server, so they stay blank — leaving them blank
    // on edit means "keep current creds", typing a value rotates.
    const prefill: Record<string, string> = {}
    if (existing) {
      for (const [k, v] of Object.entries(existing.config ?? {})) {
        if (typeof v === 'string') prefill[k] = v
      }
    }
    setFieldValues(prefill)
  }, [open, existing, connectorTypes])

  const fields = CONNECTOR_FIELDS[type] ?? []

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error('请填写数据源名称')
      return
    }
    if (!type) {
      toast.error('请选择连接器类型')
      return
    }
    const config: Record<string, string> = {}
    const credentials: Record<string, string> = {}
    for (const f of fields) {
      const v = fieldValues[f.key] ?? ''
      if (!v && !f.optional && f.bucket === 'config') {
        toast.error(`请填写:${f.label}`)
        return
      }
      if (!v) continue
      if (f.bucket === 'config') config[f.key] = v
      else credentials[f.key] = v
    }
    setSaving(true)
    try {
      if (existing) {
        await updateExternalSource(existing.id, {
          name: name.trim(),
          config,
          // Only send credentials if user actually typed any — empty object
          // means "keep current credentials".
          credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
          sync_interval_sec: syncMinutes * 60,
          auto_build_enabled: autoBuild,
        })
        toast.success('已更新')
      } else {
        await createExternalSource({
          type,
          name: name.trim(),
          config,
          credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
          sync_interval_sec: syncMinutes * 60,
          auto_build_enabled: autoBuild,
        })
        toast.success('已创建')
      }
      onSaved()
    } catch (err) {
      toast.error(`保存失败:${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? '编辑数据源' : '新建数据源'}</DialogTitle>
          <DialogDescription>
            数据源会按设定间隔轮询并把内容同步到文档中心的自动管理节点。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <Label>连接器类型</Label>
            <Select
              value={type}
              onValueChange={setType}
              disabled={!!existing}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {connectorTypes.map((t) => (
                  <SelectItem key={t} value={t}>
                    {CONNECTOR_LABELS[t] ?? t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {existing && (
              <p className="text-xs text-muted-foreground">
                连接器类型创建后不可更改。
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label>名称</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如:锐锢企微微盘"
            />
          </div>
          {fields.map((f) => (
            <div key={f.key} className="grid gap-1.5">
              <Label>
                {f.label}
                {f.bucket === 'credentials' && existing && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    (留空表示保持原凭据不变)
                  </span>
                )}
              </Label>
              <Input
                type={f.type ?? 'text'}
                value={fieldValues[f.key] ?? ''}
                onChange={(e) =>
                  setFieldValues((m) => ({ ...m, [f.key]: e.target.value }))
                }
                placeholder={f.placeholder}
              />
            </div>
          ))}
          <div className="grid gap-1.5">
            <Label>同步间隔(分钟)</Label>
            <Input
              type="number"
              min={1}
              value={syncMinutes}
              onChange={(e) => setSyncMinutes(Number(e.target.value || 60))}
            />
            <p className="text-xs text-muted-foreground">
              默认 60 分钟。频繁同步会增加外部 API 调用,建议每小时一次。
            </p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>自动构建 Wiki</Label>
              <p className="text-xs text-muted-foreground">
                源内容变化导致 Wiki 需要重建时,自动入队构建。默认关闭以避免烧 token。
              </p>
            </div>
            <Switch checked={autoBuild} onCheckedChange={setAutoBuild} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            {existing ? '保存' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
