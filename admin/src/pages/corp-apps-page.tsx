import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Loader2,
  Plus,
  Building2,
  Trash2,
  Pencil,
  Power,
  PowerOff,
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

import {
  type CorpApp,
  type CorpAppType,
  createCorpApp,
  deleteCorpApp,
  listCorpAppTypes,
  listCorpApps,
  testCorpApp,
  updateCorpApp,
} from '@/lib/api/corp-apps'

const TYPE_LABELS: Record<string, string> = {
  wecomapp: '企微自建应用',
}

// Per-type field specs. config fields are non-secret (used to derive the
// instance key); credentials fields are encrypted server-side and never
// returned (blank on edit = keep current).
type FieldSpec = {
  key: string
  label: string
  placeholder?: string
  type?: 'text' | 'password'
  bucket: 'config' | 'credentials'
  optional?: boolean
  /** Longer explanation rendered under the input, for settings whose effect is
   *  not obvious from the label alone. */
  hint?: string
}

const TYPE_FIELDS: Record<string, FieldSpec[]> = {
  wecomapp: [
    { key: 'corpId', label: 'CorpID(企业ID)', bucket: 'config' },
    { key: 'agentId', label: 'AgentID(应用ID)', bucket: 'config' },
    { key: 'secret', label: 'Secret(应用密钥)', type: 'password', bucket: 'credentials' },
    {
      key: 'callbackToken',
      label: '接收消息 Token(可选,接收消息时必填)',
      bucket: 'credentials',
      optional: true,
    },
    {
      key: 'encodingAesKey',
      label: '接收消息 EncodingAESKey(可选,接收消息时必填)',
      type: 'password',
      bucket: 'credentials',
      optional: true,
    },
    {
      key: 'queueEntryTtlHours',
      label: '群发队列条目有效期/小时(可选,默认 72)',
      placeholder: '72',
      bucket: 'config',
      optional: true,
      hint:
        '入队时未指定 --expires-at 的条目多久后自动回收。企微的每群每日名额是在' +
        '「人工点确认」时才扣除,审批可能几分钟、也可能跨天甚至一直不来 —— 这个值' +
        '是兜底,防止一条迟迟未确认的消息长期占住该群名额。审批快的租户可以调短,' +
        '让客户更早收到下一条。范围 1~720 小时。',
    },
  ],
}

export default function CorpAppsPage() {
  const [apps, setApps] = useState<CorpApp[]>([])
  const [types, setTypes] = useState<CorpAppType[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, 'test' | null>>({})

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [list, t] = await Promise.all([listCorpApps(), listCorpAppTypes()])
      setApps(list)
      setTypes(t)
    } catch (err) {
      toast.error(`加载失败:${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const typeNames = useMemo(() => types.map((t) => t.type), [types])

  const editingApp = useMemo(
    () => apps.find((a) => a.id === editingId) ?? null,
    [apps, editingId],
  )

  const handleTest = async (id: string) => {
    setBusy((m) => ({ ...m, [id]: 'test' }))
    try {
      const result = await testCorpApp(id)
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

  const handleToggleEnabled = async (a: CorpApp) => {
    try {
      await updateCorpApp(a.id, { enabled: !a.enabled })
      await refresh()
    } catch (err) {
      toast.error(`更新失败:${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleDelete = async () => {
    if (!deletingId) return
    try {
      await deleteCorpApp(deletingId)
      toast.success('已删除')
      setDeletingId(null)
      await refresh()
    } catch (err) {
      toast.error(`删除失败:${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <DashboardLayout
      title="企业应用管理"
      description="配置企微自建应用等企业应用连接,供智能体收发消息与文件"
    >
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          已配置 {apps.length} 个企业应用
          {typeNames.length > 0 && (
            <>
              {' '}· 支持的类型:
              {typeNames.map((t) => (
                <Badge key={t} variant="outline" className="mx-1">
                  {TYPE_LABELS[t] ?? t}
                </Badge>
              ))}
            </>
          )}
        </p>
        <Button onClick={() => setCreating(true)} disabled={typeNames.length === 0}>
          <Plus className="mr-1.5 size-4" /> 新建企业应用
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : apps.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12 text-center">
            <Building2 className="size-10 text-muted-foreground mb-3" />
            <p className="text-base font-medium mb-1">还没有配置企业应用</p>
            <p className="text-sm text-muted-foreground mb-4">
              配置企微自建应用后,智能体可通过 corpapp CLI 向企业应用发送消息和文件,并接收企业应用的消息。
            </p>
            <Button onClick={() => setCreating(true)} disabled={typeNames.length === 0}>
              <Plus className="mr-1.5 size-4" /> 新建第一个企业应用
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {apps.map((a) => (
            <Card key={a.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <span className="truncate">{a.name}</span>
                      <Badge variant="outline">{TYPE_LABELS[a.type] ?? a.type}</Badge>
                      {!a.enabled && <Badge variant="secondary">已停用</Badge>}
                      {!a.hasCredentials && <Badge variant="destructive">未配置密钥</Badge>}
                    </CardTitle>
                    <div className="mt-1 text-xs text-muted-foreground flex flex-wrap items-center gap-3">
                      <span>
                        Key:{' '}
                        <code className="bg-muted px-1.5 py-0.5 rounded">{a.appKey}</code>
                      </span>
                      {a.capabilities && a.capabilities.length > 0 && (
                        <span>能力:{a.capabilities.join('、')}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleTest(a.id)}
                      disabled={busy[a.id] === 'test'}
                    >
                      {busy[a.id] === 'test' ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <PlayCircle className="size-3.5" />
                      )}
                      <span className="ml-1">测试</span>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleToggleEnabled(a)}
                      title={a.enabled ? '停用' : '启用'}
                    >
                      {a.enabled ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setEditingId(a.id)}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => setDeletingId(a.id)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0 space-y-1">
                <CallbackUrlHint app={a} />
                <ApprovalSetupHint app={a} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CorpAppDialog
        open={creating}
        onOpenChange={(o) => {
          if (!o) setCreating(false)
        }}
        types={typeNames}
        onSaved={() => {
          setCreating(false)
          refresh()
        }}
      />

      <CorpAppDialog
        open={!!editingApp}
        existing={editingApp}
        onOpenChange={(o) => {
          if (!o) setEditingId(null)
        }}
        types={typeNames}
        onSaved={() => {
          setEditingId(null)
          refresh()
        }}
      />

      <AlertDialog open={!!deletingId} onOpenChange={(o) => !o && setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除企业应用?</AlertDialogTitle>
            <AlertDialogDescription>
              删除后已授权使用该应用的智能体将无法再收发消息。此操作不可撤销。
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

// Shows the receive-callback URL for an instance so the admin can paste it
// into the WeCom console. The host is the current page origin; the public
// callback listener typically runs on a different port behind a proxy, so
// we show a path template the admin completes with their public host/port.
function CallbackUrlHint({ app }: { app: CorpApp }) {
  if (!app.capabilities?.includes('receive')) return null
  const path = `/api/v1/corp-apps/callback/${app.id}`
  return (
    <div className="text-xs text-muted-foreground">
      接收消息回调 URL(配置到企业微信后台,需指向公网回调端口):
      <code className="ml-1 bg-muted px-1.5 py-0.5 rounded">{`https://<公网域名:回调端口>${path}`}</code>
    </div>
  )
}

// Reminds the admin that approval (审批流) reads require the app to be
// authorised in the WeCom console — a step that can't be done from moss.
// Only shown for instances that declare the approval capabilities.
function ApprovalSetupHint({ app }: { app: CorpApp }) {
  if (!app.capabilities?.includes('getApproval') && !app.capabilities?.includes('listApprovals'))
    return null
  return (
    <div className="text-xs text-muted-foreground">
      读取审批流(审批单),需在企业微信后台将本应用添加到
      <code className="mx-1 bg-muted px-1.5 py-0.5 rounded">审批 → 「可调用接口的应用」</code>
      ,否则接口返回无权限错误。
    </div>
  )
}

// ============================================================
// Create / Edit dialog
// ============================================================

function CorpAppDialog({
  open,
  existing,
  types,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  existing?: CorpApp | null
  types: string[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [type, setType] = useState<string>(existing?.type ?? types[0] ?? '')
  const [name, setName] = useState(existing?.name ?? '')
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setType(existing?.type ?? types[0] ?? '')
    setName(existing?.name ?? '')
    // Prefill config (corpId/agentId) from existing. Credentials are never
    // returned, so they stay blank — blank on edit means "keep current".
    const prefill: Record<string, string> = {}
    if (existing) {
      for (const [k, v] of Object.entries(existing.config ?? {})) {
        if (typeof v === 'string') prefill[k] = v
      }
    }
    setFieldValues(prefill)
  }, [open, existing, types])

  const fields = TYPE_FIELDS[type] ?? []

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error('请填写应用名称')
      return
    }
    if (!type) {
      toast.error('请选择应用类型')
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
        await updateCorpApp(existing.id, {
          name: name.trim(),
          config,
          credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
        })
        toast.success('已更新')
      } else {
        await createCorpApp({
          type,
          name: name.trim(),
          config,
          credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
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
          <DialogTitle>{existing ? '编辑企业应用' : '新建企业应用'}</DialogTitle>
          <DialogDescription>
            智能体被授权后,可通过 corpapp CLI 使用该应用收发消息与文件。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <Label>应用类型</Label>
            <Select value={type} onValueChange={setType} disabled={!!existing}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {types.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TYPE_LABELS[t] ?? t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {existing && (
              <p className="text-xs text-muted-foreground">应用类型创建后不可更改。</p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label>名称(智能体按此名称调用,需唯一)</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如:财务企微"
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
              {f.hint && (
                <p className="text-xs text-muted-foreground leading-relaxed">{f.hint}</p>
              )}
            </div>
          ))}
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
