'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '@/lib/hooks/use-auth'
import { hasScope } from '@/lib/api/client'
import { ListEmptyState, ListError, ListPagination, ListSkeleton, ListStatusBadge, ListSurface, ListToolbar } from '@/components/list-page'
import { pinyin as pinyinPro } from 'pinyin-pro'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import {
  Search, Plus, Pencil, Trash2, RefreshCw, Loader2, X, GripVertical, Shield,
} from 'lucide-react'
import {
  getConfigItems, createConfigItem, updateConfigItem, deleteConfigItem, updateConfigItemStatus, uploadConfigItemIcon,
  type ConfigItem, type ConfigEntry,
} from '@/lib/api/secrets'
import { getSystemSettings } from '@/lib/api/settings'

// Fallback shown before system settings load (and matches the server default).
const DEFAULT_MINT_SCRIPTS_DIR = '/app/scripts'

const schemeLabels: Record<string, string> = {
  bearer: 'Bearer Token',
  basic: 'Basic Auth',
  header: '自定义 Header',
  query: 'Query 参数',
}

const PAGE_SIZE = 20

const scopeLabels: Record<string, string> = {
  system: '企业凭据',
  department: '部门凭据',
  user: '用户凭据',
}

interface EntryForm {
  config_key: string
  name: string
  config_desc: string
  required: boolean
}

// 认证方式: 'static' = 注入已存密钥 (scheme)；'login' = 用已存凭据换取 access_token
type AuthMode = 'static' | 'login'
// login 子类型映射到后端 auth_type
type LoginAuthType = 'oauth2_password' | 'script'

interface ConfigItemForm {
  name: string
  pinyin: string
  description: string
  icon: string
  scope: 'system' | 'department' | 'user'
  url_pattern: string
  authMode: AuthMode
  scheme: '' | 'bearer' | 'basic' | 'header' | 'query'
  bearer_prefix: string
  // login-type fields
  loginAuthType: LoginAuthType
  token_url: string
  token_request_json: string
  // Opt-in body-level 401 detection recipe (JSON). Empty = HTTP-status-only.
  body_auth_check: string
  entries: EntryForm[]
}

const emptyEntry: EntryForm = { config_key: '', name: '', config_desc: '', required: true }

const emptyForm: ConfigItemForm = {
  name: '', pinyin: '', description: '', icon: '', scope: 'system',
  url_pattern: '', authMode: 'static', scheme: '', bearer_prefix: '',
  loginAuthType: 'oauth2_password', token_url: '', token_request_json: '',
  body_auth_check: '',
  entries: [{ ...emptyEntry }],
}

function nameToPinyin(name: string): string {
  if (!name.trim()) return ''
  return pinyinPro(name, { toneType: 'none', type: 'array' }).join('').toLowerCase()
}

function isValidUrlPattern(value: string): boolean {
  if (!value || !value.trim()) return true
  const t = value.trim()
  if (t.length > 256 || !/^https?:\/\//.test(t)) return false
  const after = t.replace(/^https?:\/\//, '')
  const si = after.indexOf('/')
  const host = si === -1 ? after : after.slice(0, si)
  const path = si === -1 ? '' : after.slice(si)
  if (!host) return false
  const ci = host.lastIndexOf(':')
  const hnp = ci > 0 ? host.slice(0, ci) : host
  const port = ci > 0 ? host.slice(ci + 1) : null
  if (port !== null && (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535)) return false
  if (hnp !== '*' && !hnp.startsWith('*.') && hnp !== 'localhost' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(hnp)) {
    const labels = hnp.split('.')
    if (labels.length < 2) return false
    for (const l of labels) { if (!l || l.length > 63 || !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(l)) return false }
  }
  if (path && (!path.startsWith('/') || path.includes('**') || /[\[\]{}]/.test(path) || !/^[a-zA-Z0-9\-._~!$&'()*+,;=:%@?/]+$/.test(path))) return false
  return true
}

export default function ConfigItemsPage() {
  const { scopes, activeOrgId } = useAuth()
  const canWrite = hasScope(scopes, 'admin:secrets:write')
  const [result, setResult] = useState<{ query: string; items: ConfigItem[]; total: number } | null>(null)
  const [load, setLoad] = useState<{ query: string; busy: boolean; error: boolean }>({ query: '', busy: true, error: false })
  const [page, setPage] = useState(1)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [pendingId, setPendingId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [scopeFilter, setScopeFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  // Create/Edit dialog
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<ConfigItem | null>(null)
  const [form, setForm] = useState<ConfigItemForm>({ ...emptyForm })
  const [isSaving, setIsSaving] = useState(false)
  const [isUploadingIcon, setIsUploadingIcon] = useState(false)

  // Delete dialog
  const [deleteTarget, setDeleteTarget] = useState<ConfigItem | null>(null)

  // Scripts dir for the script-login help text: the server runs
  // `<mintScriptsDir>/<pinyin>_mint.sh`. Fetched once so the shown path is real.
  const [mintScriptsDir, setMintScriptsDir] = useState(DEFAULT_MINT_SCRIPTS_DIR)
  useEffect(() => {
    getSystemSettings()
      .then(s => { if (s.mintScriptsDir) setMintScriptsDir(s.mintScriptsDir) })
      .catch(() => { /* keep the default on failure */ })
  }, [])

  const query = JSON.stringify([activeOrgId, searchQuery, scopeFilter, statusFilter, page])
  const hasData = result?.query === query
  const items = hasData ? result.items : []
  const total = hasData ? result.total : 0
  const isLoading = load.query !== query || load.busy
  const loadError = load.query === query && load.error
  const fetchData = useCallback(() => setRefreshVersion(value => value + 1), [])

  useEffect(() => {
    let active = true
    setLoad({ query, busy: true, error: false })
    getConfigItems({
      page,
      page_size: PAGE_SIZE,
      name: searchQuery || undefined,
      scope: scopeFilter !== 'all' ? scopeFilter : undefined,
      status: statusFilter !== 'all' ? statusFilter : undefined,
    }).then(res => {
      if (!active) return
      const lastPage = Math.max(1, Math.ceil(res.total / PAGE_SIZE))
      if (page > lastPage) { setPage(lastPage); return }
      setResult({ query, items: res.items, total: res.total })
    }).catch(() => {
      if (active) setLoad({ query, busy: true, error: true })
    }).finally(() => {
      if (active) setLoad(state => ({ ...state, busy: false }))
    })
    return () => { active = false }
  }, [query, page, searchQuery, scopeFilter, statusFilter, refreshVersion])

  const handleCreate = () => {
    setEditingItem(null)
    setForm({ ...emptyForm })
    setDialogOpen(true)
  }

  const handleEdit = (item: ConfigItem) => {
    setEditingItem(item)
    const isLogin = !!item.auth_type && item.auth_type !== 'static'
    const loginAuthType: LoginAuthType = item.auth_type === 'script' ? 'script' : 'oauth2_password'
    setForm({
      name: item.name,
      pinyin: item.pinyin || '',
      description: item.description || '',
      icon: item.icon || '',
      scope: item.scope,
      url_pattern: item.url_pattern || '',
      authMode: isLogin ? 'login' : 'static',
      scheme: item.scheme || '',
      bearer_prefix: item.bearer_prefix || '',
      loginAuthType,
      token_url: item.token_url || '',
      token_request_json: item.token_request_json || '',
      body_auth_check: item.body_auth_check || '',
      entries: item.entries.length > 0
        ? item.entries.map(e => ({ config_key: e.config_key, name: e.name, config_desc: e.config_desc || '', required: !!e.required }))
        : [{ ...emptyEntry }],
    })
    setDialogOpen(true)
  }

  const handleSave = async () => {
    if (!canWrite || isSaving || isUploadingIcon) return
    if (!form.name.trim()) { toast.error('请输入配置项名称'); return }
    if (!form.pinyin.trim()) { toast.error('请输入拼音标识'); return }
    const isLogin = form.authMode === 'login'
    // URL 和认证方式联动校验：有 URL 时必须选择静态方案或登录换取令牌
    if (form.url_pattern.trim() && !isLogin && !form.scheme) {
      toast.error('URL 模式已填写，请选择认证方案')
      return
    }
    if (form.url_pattern.trim() && !isValidUrlPattern(form.url_pattern)) {
      toast.error('URL 模式格式不正确，需以 http:// 或 https:// 开头，路径中可使用 * 和 ? 通配符')
      return
    }
    if (!isLogin && form.scheme && form.scheme !== 'bearer' && form.bearer_prefix.trim()) {
      toast.error('仅 Bearer 方案可以设置 Bearer 前缀')
      return
    }
    if (form.entries.some(e => !e.config_key.trim() || !e.name.trim())) {
      toast.error('请填写所有字段的标识和名称')
      return
    }
    if (!isLogin && ['bearer', 'basic'].includes(form.scheme) && form.entries.length > 1) {
      toast.error('Bearer/Basic 方案只允许 1 个字段')
      return
    }
    // 登录换取令牌的校验
    if (isLogin) {
      if (form.loginAuthType === 'oauth2_password' && !form.token_url.trim()) {
        toast.error('请填写令牌端点 URL (token_url)')
        return
      }
      if (form.token_request_json.trim()) {
        try { JSON.parse(form.token_request_json) } catch { toast.error('请求配方 (token_request_json) 不是合法 JSON'); return }
      }
      if (form.body_auth_check.trim()) {
        try {
          const parsed = JSON.parse(form.body_auth_check)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            toast.error('响应体 401 检测 (body_auth_check) 必须是 JSON 对象'); return
          }
        } catch { toast.error('响应体 401 检测 (body_auth_check) 不是合法 JSON'); return }
      }
    }
    // login-type 与 static 二选一：互斥地清空对侧字段
    const authPayload = isLogin
      ? {
          auth_type: form.loginAuthType,
          token_url: form.loginAuthType === 'oauth2_password' ? (form.token_url.trim() || undefined) : undefined,
          token_request_json: form.token_request_json.trim() || undefined,
          // Empty string clears the recipe server-side; a value opts in.
          body_auth_check: form.body_auth_check.trim() || '',
          scheme: undefined,
          bearer_prefix: undefined,
        }
      : {
          auth_type: 'static',
          token_url: undefined,
          token_request_json: undefined,
          body_auth_check: '',
          scheme: form.scheme || undefined,
          bearer_prefix: form.bearer_prefix.trim() || undefined,
        }
    setIsSaving(true)
    try {
      const apiEntries = form.entries.map(e => ({ ...e, required: e.required ? 1 : 0 }))
      if (editingItem) {
        await updateConfigItem(editingItem.id, {
          name: form.name.trim(),
          description: form.description.trim() || undefined,
          icon: form.icon || undefined,
          pinyin: form.pinyin.trim() || undefined,
          scope: form.scope,
          url_pattern: form.url_pattern.trim() || undefined,
          ...authPayload,
          entries: apiEntries,
        })
      } else {
        await createConfigItem({
          name: form.name.trim(),
          description: form.description.trim() || undefined,
          icon: form.icon || undefined,
          pinyin: form.pinyin.trim() || undefined,
          scope: form.scope,
          url_pattern: form.url_pattern.trim() || undefined,
          ...authPayload,
          entries: apiEntries,
        })
      }
      toast.success(editingItem ? '配置项已更新' : '配置项已创建')
      setDialogOpen(false)
      fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!canWrite || !deleteTarget || pendingId !== null) return
    setPendingId(deleteTarget.id)
    try {
      await deleteConfigItem(deleteTarget.id)
      toast.success(`已删除配置项「${deleteTarget.name}」`)
      setDeleteTarget(null)
      fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setPendingId(null)
    }
  }

  const handleToggleStatus = async (item: ConfigItem) => {
    if (!canWrite || pendingId !== null) return
    setPendingId(item.id)
    try {
      await updateConfigItemStatus(item.id, item.status === 1 ? 0 : 1)
      toast.success(`已${item.status === 1 ? '禁用' : '启用'}配置项「${item.name}」`)
      fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setPendingId(null)
    }
  }

  const addEntry = () => setForm(f => ({ ...f, entries: [...f.entries, { ...emptyEntry }] }))
  const removeEntry = (idx: number) => setForm(f => ({ ...f, entries: f.entries.filter((_, i) => i !== idx) }))
  const updateEntry = (idx: number, field: keyof EntryForm, value: string | boolean) => {
    setForm(f => ({
      ...f,
      entries: f.entries.map((e, i) => i === idx ? { ...e, [field]: value } : e),
    }))
  }

  return (
    <DashboardLayout title="配置项列表" description="定义凭据字段、作用范围与认证方式">
      <div className="space-y-4">
        <ListToolbar actions={<>
          <Button variant="outline" size="sm" onClick={fetchData} disabled={isLoading}>
            <RefreshCw className={`size-3.5 ${isLoading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />刷新
          </Button>
          {canWrite && <Button size="sm" onClick={handleCreate}><Plus className="size-3.5" aria-hidden="true" />创建配置项</Button>}
        </>}>
          <div className="relative w-full sm:w-60">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input aria-label="搜索配置项名称或拼音" placeholder="搜索名称或拼音…" value={searchQuery} onChange={e => { setSearchQuery(e.target.value); setPage(1) }} className="h-9 pl-9" />
          </div>
          <Select value={scopeFilter} onValueChange={value => { setScopeFilter(value); setPage(1) }}>
            <SelectTrigger aria-label="凭据分类" className="h-9 w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部分类</SelectItem>
              {Object.entries(scopeLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={value => { setStatusFilter(value); setPage(1) }}>
            <SelectTrigger aria-label="配置项状态" className="h-9 w-[120px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="1">已启用</SelectItem>
              <SelectItem value="0">已禁用</SelectItem>
            </SelectContent>
          </Select>
        </ListToolbar>
        {loadError && <ListError title={hasData ? '刷新配置项失败' : '无法加载配置项'} description={hasData ? '当前显示上次加载的结果，请重新加载。' : '请检查连接及访问权限后重试。'} onRetry={fetchData} retrying={isLoading} />}
        {!hasData && isLoading ? <ListSkeleton label="正在加载配置项" /> : hasData && (
          <ListSurface aria-label="配置项列表" aria-busy={isLoading} footer={<ListPagination page={page} pageSize={PAGE_SIZE} total={total} busy={isLoading} onPageChange={setPage} />}>
            {items.length > 0 ? <Table className="min-w-[880px]">
              <TableHeader><TableRow>
                <TableHead>名称</TableHead><TableHead>分类</TableHead><TableHead>认证方式</TableHead>
                <TableHead>URL 模式</TableHead><TableHead>字段</TableHead><TableHead>状态</TableHead>
                {canWrite && <TableHead className="text-right">操作</TableHead>}
              </TableRow></TableHeader>
              <TableBody>{items.map(item => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                        {item.icon ? <img src={item.icon} alt="" className="size-5 rounded" /> : <Shield className="size-4 text-muted-foreground" aria-hidden="true" />}
                      </div>
                      <div className="min-w-0 max-w-64">
                        <p className="truncate font-medium" title={item.name}>{item.name}</p>
                        <p className="truncate text-xs text-muted-foreground" title={item.description || item.pinyin}>{item.description || item.pinyin}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell><Badge variant="outline" className="font-normal">{scopeLabels[item.scope] ?? item.scope}</Badge></TableCell>
                  <TableCell><span className="text-[13px]">{item.auth_type && item.auth_type !== 'static'
                    ? item.auth_type === 'script' ? '登录脚本' : '登录换取令牌'
                    : item.scheme ? schemeLabels[item.scheme] ?? item.scheme : '未设置'}</span></TableCell>
                  <TableCell><span className="block max-w-52 truncate font-mono text-xs text-muted-foreground" title={item.url_pattern || undefined}>{item.url_pattern || '—'}</span></TableCell>
                  <TableCell className="text-muted-foreground">{item.entries.length} 个</TableCell>
                  <TableCell><div className="flex items-center gap-2">
                    {canWrite && <Switch aria-label={`${item.status === 1 ? '禁用' : '启用'}配置项 ${item.name}`} checked={item.status === 1} disabled={pendingId !== null || isLoading} onCheckedChange={() => handleToggleStatus(item)} />}
                    <ListStatusBadge tone={item.status === 1 ? 'positive' : 'neutral'}>{item.status === 1 ? '已启用' : '已禁用'}</ListStatusBadge>
                  </div></TableCell>
                  {canWrite && <TableCell className="text-right"><div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" disabled={pendingId !== null || isLoading} onClick={() => handleEdit(item)} aria-label={`编辑 ${item.name}`} title="编辑"><Pencil className="size-4" /></Button>
                    <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" disabled={pendingId !== null || isLoading} onClick={() => setDeleteTarget(item)} aria-label={`删除 ${item.name}`} title="删除"><Trash2 className="size-4" /></Button>
                  </div></TableCell>}
                </TableRow>
              ))}</TableBody>
            </Table> : <ListEmptyState title={searchQuery || scopeFilter !== 'all' || statusFilter !== 'all' ? '没有匹配的配置项' : '暂无配置项'} description={searchQuery || scopeFilter !== 'all' || statusFilter !== 'all' ? '调整名称、分类或状态筛选后重试。' : canWrite ? '创建配置项，定义需要保存的凭据字段。' : '管理员创建配置项后，将显示在这里。'} />}
          </ListSurface>
        )}
      </div>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={open => { if (!isSaving && !isUploadingIcon) setDialogOpen(open) }}>
        <DialogContent className="min-w-0 sm:max-w-[600px] max-h-[85vh] overflow-y-auto [&_input]:min-w-0 [&_textarea]:min-w-0 [&_[data-slot=select-trigger]]:max-w-full [&_code]:break-all">
          <DialogHeader>
            <DialogTitle>{editingItem ? '编辑配置项' : '创建配置项'}</DialogTitle>
            <DialogDescription>{editingItem ? '修改配置项信息和字段定义' : '定义新的凭据服务模板'}</DialogDescription>
          </DialogHeader>
          <fieldset disabled={isSaving} className="min-w-0 space-y-4 py-2">
            <div className="space-y-2">
              <Label>名称 <span className="text-destructive">*</span></Label>
              <Input value={form.name} onChange={e => {
                const name = e.target.value
                const autoPinyin = nameToPinyin(name)
                setForm(f => ({ ...f, name, pinyin: autoPinyin }))
              }} placeholder="如：禅道" />
            </div>
            <div className="space-y-2">
              <Label>拼音标识 <span className="text-destructive">*</span> <span className="text-xs text-muted-foreground font-normal">（密钥存储时使用）</span></Label>
              <Input value={form.pinyin} onChange={e => setForm(f => ({ ...f, pinyin: e.target.value }))} placeholder="自动根据名称生成，可手动修改" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>分类 <span className="text-destructive">*</span></Label>
                <Select value={form.scope} onValueChange={v => setForm(f => ({ ...f, scope: v as 'system' | 'department' | 'user' }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">企业凭据</SelectItem>
                    <SelectItem value="department">部门凭据</SelectItem>
                    <SelectItem value="user">用户凭据</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>图标</Label>
              <div className="flex items-center gap-3">
                <div className="flex size-12 items-center justify-center rounded-lg border bg-muted shrink-0 overflow-hidden">
                  {form.icon ? (
                    <img src={form.icon} alt="预览" className="size-full object-cover" />
                  ) : (
                    <Shield className="size-5 text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1 flex items-center gap-2">
                  <Input
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml"
                    className="flex-1 text-sm"
                    disabled={isUploadingIcon}
                    onChange={async e => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      if (file.size > 500 * 1024) {
                        toast.error('图标文件不能超过 500KB')
                        return
                      }
                      setIsUploadingIcon(true)
                      try {
                        const response = await uploadConfigItemIcon(file)
                        setForm(f => ({ ...f, icon: response.url }))
                        toast.success('图标上传成功')
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : '图标上传失败')
                      } finally {
                        setIsUploadingIcon(false)
                      }
                    }}
                  />
                  {form.icon && (
                    <Button variant="ghost" size="icon" className="shrink-0" onClick={() => setForm(f => ({ ...f, icon: '' }))}>
                      <X className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">支持 PNG、JPG、SVG，不超过 500KB</p>
            </div>
            <div className="space-y-2">
              <Label>描述</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="配置项说明" rows={2} />
            </div>
            <div className="space-y-2">
              <Label>URL 模式</Label>
              <Input value={form.url_pattern} onChange={e => setForm(f => ({ ...f, url_pattern: e.target.value }))} placeholder="https://api.example.com/*" />
              {form.url_pattern.trim() && !isValidUrlPattern(form.url_pattern) && (
                <p className="text-xs text-destructive">URL 格式不正确，需以 http:// 或 https:// 开头，路径中可使用 * 和 ? 通配符</p>
              )}
            </div>

            {/* 认证方式: 静态注入 vs 登录换取令牌 */}
            <div className="space-y-2">
              <Label>认证方式 {form.url_pattern.trim() ? <span className="text-destructive">*</span> : ''}</Label>
              <Select
                value={form.authMode}
                onValueChange={v => setForm(f => ({ ...f, authMode: v as AuthMode }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="static">静态注入（直接使用已存密钥/令牌）</SelectItem>
                  <SelectItem value="login">登录换取令牌（用已存凭据登录，获取短期 access_token）</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {form.authMode === 'static'
                  ? '把用户已保存的密钥按所选方案直接注入到外部请求。'
                  : '代理用已保存的凭据（如用户名/密码）登录目标服务，换取短期 access_token 并注入；令牌过期自动重新登录（cron 等无人值守场景也可用）。'}
              </p>
            </div>

            {form.authMode === 'static' && (
              <>
                <div className="space-y-2">
                  <Label>认证方案 {form.url_pattern.trim() ? <span className="text-destructive">*</span> : ''}</Label>
                  <div className="flex gap-2">
                    <Select
                      value={form.scheme || undefined}
                      onValueChange={v => setForm(f => ({ ...f, scheme: v as ConfigItemForm['scheme'] }))}
                    >
                      <SelectTrigger className="flex-1"><SelectValue placeholder="不设置（可选）" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="bearer">Bearer Token</SelectItem>
                        <SelectItem value="basic">Basic Auth</SelectItem>
                        <SelectItem value="header">自定义 Header</SelectItem>
                        <SelectItem value="query">Query 参数</SelectItem>
                      </SelectContent>
                    </Select>
                    {form.scheme && (
                      <Button variant="ghost" size="icon" className="shrink-0" onClick={() => setForm(f => ({ ...f, scheme: '', bearer_prefix: '' }))} title="清除">
                        <X className="size-4" />
                      </Button>
                    )}
                  </div>
                  {form.url_pattern.trim() && !form.scheme && (
                    <p className="text-xs text-destructive">填写了 URL 模式后，认证方案为必填项</p>
                  )}
                </div>
                {form.scheme === 'bearer' && (
                  <div className="space-y-2">
                    <Label>Bearer 前缀</Label>
                    <Input value={form.bearer_prefix} onChange={e => setForm(f => ({ ...f, bearer_prefix: e.target.value }))} placeholder="Bearer" />
                  </div>
                )}
              </>
            )}

            {form.authMode === 'login' && (
              <div className="space-y-3 rounded-lg border p-3">
                <div className="space-y-2">
                  <Label>登录方式</Label>
                  <Select
                    value={form.loginAuthType}
                    onValueChange={v => setForm(f => ({ ...f, loginAuthType: v as LoginAuthType }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="oauth2_password">声明式令牌端点（单次 POST 换取令牌）</SelectItem>
                      <SelectItem value="script">登录脚本（多步/加签等复杂流程）</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {form.loginAuthType === 'oauth2_password' && (
                  <>
                    <div className="space-y-2">
                      <Label>令牌端点 URL <span className="text-destructive">*</span></Label>
                      <Input value={form.token_url} onChange={e => setForm(f => ({ ...f, token_url: e.target.value }))} placeholder="https://idp.example.com/oauth/token" />
                    </div>
                    <div className="space-y-2">
                      <Label>请求配方（token_request_json，可选）</Label>
                      <Textarea
                        value={form.token_request_json}
                        onChange={e => setForm(f => ({ ...f, token_request_json: e.target.value }))}
                        placeholder={'{\n  "placement": "form",\n  "params": { "grant_type": "password", "client_id": "..." },\n  "cred_map": { "username": "username", "password": "password" },\n  "token_path": "access_token",\n  "expiry_path": "expires_in"\n}'}
                        rows={6}
                        className="font-mono text-xs"
                      />
                      <p className="text-xs text-muted-foreground">
                        描述如何构造登录请求：placement(form/json/basic)、静态 params、把已存字段映射到请求参数的 cred_map、以及响应里令牌/有效期的取值路径。留空则按默认（form 提交，读取 access_token / expires_in）。
                      </p>
                    </div>
                  </>
                )}

                {form.loginAuthType === 'script' && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      服务端可执行脚本（在 moss-server 容器内）<code>{`${mintScriptsDir.replace(/\/+$/, '')}/${form.pinyin.trim() || '<pinyin>'}_mint.sh`}</code>，请联系系统管理员进行配置。脚本从环境变量 <code>MINT_CREDS</code>(JSON) 读取已存凭据，向标准输出打印一行 <code>{'{"access_token":"...","expiresIn":<秒>}'}</code>。下方“字段定义”是用户需要在「我的凭据」中填写的登录凭据字段（如 username、password），脚本/请求配方会用到它们。
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  <Label>响应体 401 检测（body_auth_check，可选）</Label>
                  <Textarea
                    value={form.body_auth_check}
                    onChange={e => setForm(f => ({ ...f, body_auth_check: e.target.value }))}
                    placeholder={'{\n  "field": "code",\n  "unauthorizedValues": [401, "401"]\n}'}
                    rows={4}
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    某些接口在会话失效时仍返回 HTTP 200，但响应体里带有 <code>{'{"code":401,...}'}</code>。填写此项后，代理会在响应体命中该值时也自动重新登录并重试一次（与 HTTP 401 一样）。<code>field</code> 支持点号路径（如 <code>data.code</code>），默认 <code>code</code>；<code>unauthorizedValues</code> 默认 <code>[401, "401"]</code>。留空则仅按 HTTP 状态码判断。
                  </p>
                </div>

                <p className="text-xs text-muted-foreground">
                  下方“字段定义”是用户需要在「我的凭据」中填写的登录凭据字段（如 username、password），脚本/请求配方会用到它们。
                </p>
              </div>
            )}

            {/* Entries */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>字段定义</Label>
                <Button variant="outline" size="sm" onClick={addEntry} disabled={form.authMode === 'static' && !!form.scheme && ['bearer', 'basic'].includes(form.scheme) && form.entries.length >= 1}>
                  <Plus className="size-3 mr-1" />添加字段
                </Button>
              </div>
              {form.authMode === 'static' && form.scheme && ['bearer', 'basic'].includes(form.scheme) && form.entries.length >= 1 && (
                <p className="text-xs text-muted-foreground">{schemeLabels[form.scheme]} 方案仅支持 1 个字段</p>
              )}
              {form.entries.map((entry, idx) => (
                <div key={idx} className="border rounded-lg p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">字段 {idx + 1}</span>
                    {form.entries.length > 1 && (
                      <Button variant="ghost" size="icon" className="size-7" onClick={() => removeEntry(idx)}><X className="size-3" /></Button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">字段标识 <span className="text-destructive">*</span></Label>
                      <Input value={entry.config_key} onChange={e => updateEntry(idx, 'config_key', e.target.value)} placeholder="access_token" className="h-8 text-sm" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">显示名称 <span className="text-destructive">*</span></Label>
                      <Input value={entry.name} onChange={e => updateEntry(idx, 'name', e.target.value)} placeholder="Access Token" className="h-8 text-sm" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">说明</Label>
                    <Input value={entry.config_desc} onChange={e => updateEntry(idx, 'config_desc', e.target.value)} placeholder="字段用途说明" className="h-8 text-sm" />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={entry.required} onChange={e => updateEntry(idx, 'required', e.target.checked)} className="rounded" />
                    必填
                  </label>
                </div>
              ))}
            </div>
          </fieldset>
          <DialogFooter>
            <Button variant="outline" disabled={isSaving || isUploadingIcon} onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={handleSave} disabled={!canWrite || isSaving || isUploadingIcon}>
              {isSaving && <Loader2 className="size-4 mr-1 animate-spin" />}
              {editingItem ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={open => { if (!open && pendingId === null) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除配置项「{deleteTarget?.name}」吗？关联的字段定义将被一并删除。Nexus 中的凭据数据不会被删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingId !== null}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={!canWrite || pendingId !== null} onClick={event => { event.preventDefault(); handleDelete() }} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {pendingId !== null ? '正在删除' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  )
}
