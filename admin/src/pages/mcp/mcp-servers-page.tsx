'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Plus,
  RefreshCw,
  Loader2,
  Pencil,
  Power,
  PowerOff,
  Plug,
  FileText,
  Search,
  X,
  Upload,
  Image as ImageIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import { DashboardLayout } from '@/components/dashboard-layout'
import { JsonEditor } from '@/components/ui/json-editor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
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
import type { McpServer, McpServerFormData, McpConfigParseResult, UserConfigItem } from '@/lib/api/mcp'
import { fetchMcpServers, createMcpServer, updateMcpServer, testMcpConnection as testConnection, fetchMcpTemplate, subscribeMcpEvents, uploadMcpIcon, parseMcpConfig, fetchUserConfig, setUserConfigValue, deleteUserConfigValue } from '@/lib/api/mcp'
import { ApiRequestError } from '@/lib/api/client'
import { getUsers, getDepartments } from '@/lib/api/auth'
import { getInstalledAgents } from '@/lib/api/agent-hub'
import { getInstalledSkills } from '@/lib/api/skill-store'
import type { AuthUser, AuthDepartment } from '@/lib/api/types'
import { useAuth } from '@/lib/hooks/use-auth'

// ===== Helper components =====

function StatusBadge({ enabled, status }: { enabled: boolean; status: string }) {
  if (!enabled) return <Badge variant="secondary">已禁用</Badge>
  if (status === 'error') return <Badge variant="destructive">异常</Badge>
  if (status === 'pending') return <Badge className="bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/25">待测试</Badge>
  return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25">已启用</Badge>
}

function RiskBadge({ level }: { level: string }) {
  if (level === 'high') return <Badge variant="destructive">高</Badge>
  if (level === 'medium') return <Badge className="bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/25">中</Badge>
  return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25">低</Badge>
}

function ScopeBadge({ scope }: { scope: string }) {
  if (scope === 'org') return <Badge className="bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/25">企业级</Badge>
  if (scope === 'department') return <Badge className="bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/25">部门级</Badge>
  return <Badge variant="secondary">个人级</Badge>
}

function TypeBadge({ mcpType }: { mcpType: string }) {
  const labels: Record<string, string> = { http: 'HTTP', sse: 'SSE', stdio: 'STDIO' }
  return <Badge variant="outline">{labels[mcpType] || mcpType}</Badge>
}

function formatVisibleTo(visibleTo: McpServer['visible_to']): string {
  if (!visibleTo) return '全员'
  if (visibleTo.department_ids?.length && visibleTo.user_ids?.length) return `${visibleTo.department_ids.length} 个部门 + ${visibleTo.user_ids.length} 人`
  if (visibleTo.department_ids?.length) return `${visibleTo.department_ids.length} 个部门`
  if (visibleTo.user_ids?.length) return `${visibleTo.user_ids.length} 人`
  return '仅管理员'
}

function getCredentialSource(secretRef: string | null): string {
  if (!secretRef) return '未配置'
  if (secretRef.startsWith('system:')) return 'system'
  if (secretRef.startsWith('user:')) return 'user'
  return '未知'
}

function formatLastInvocation(ts: number | null): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ===== Args (TagInput) + Env (K-V) editors =====

interface TagInputProps {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}

function TagInput({ value, onChange, placeholder }: TagInputProps) {
  const [draft, setDraft] = useState('')
  const tags = value
  return (
    <div className="border rounded-md p-2 min-h-9 flex flex-wrap items-center gap-1.5">
      {tags.map((t, i) => (
        <Badge key={`${t}-${i}`} variant="secondary" className="gap-1">
          <span className="font-mono text-xs">{t}</span>
          <button
            type="button"
            onClick={() => onChange(tags.filter((_, idx) => idx !== i))}
            className="hover:bg-muted-foreground/20 rounded"
            aria-label="删除参数"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        className="flex-1 min-w-[120px] bg-transparent outline-none text-sm px-1 py-0.5"
        placeholder={placeholder || '输入后回车添加'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) {
            e.preventDefault()
            onChange([...tags, draft.trim()])
            setDraft('')
          } else if (e.key === 'Backspace' && !draft && tags.length > 0) {
            onChange(tags.slice(0, -1))
          }
        }}
      />
    </div>
  )
}

interface KVEditorProps {
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
}

function KVEditor({ value, onChange }: KVEditorProps) {
  const entries = Object.entries(value)
  function setKey(i: number, newKey: string) {
    const next: Record<string, string> = {}
    entries.forEach(([k, v], idx) => {
      if (idx === i) next[newKey] = v
      else next[k] = v
    })
    onChange(next)
  }
  function setVal(i: number, newVal: string) {
    const next: Record<string, string> = {}
    entries.forEach(([k, v], idx) => {
      next[k] = idx === i ? newVal : v
    })
    onChange(next)
  }
  function remove(i: number) {
    const next: Record<string, string> = {}
    entries.forEach(([k, v], idx) => {
      if (idx !== i) next[k] = v
    })
    onChange(next)
  }
  function add() {
    onChange({ ...value, '': '' })
  }
  return (
    <div className="space-y-2">
      {entries.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            placeholder="KEY"
            value={k}
            onChange={(e) => setKey(i, e.target.value)}
            className="flex-1 font-mono text-xs"
          />
          <span className="text-muted-foreground">=</span>
          <Input
            placeholder="value"
            value={v}
            onChange={(e) => setVal(i, e.target.value)}
            className="flex-1 font-mono text-xs"
          />
          <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => remove(i)}>
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus className="size-3.5 mr-1" />添加环境变量
      </Button>
    </div>
  )
}

// ===== Multi-select checkbox list =====

interface MultiSelectProps {
  options: { id: string; label: string; sub?: string }[]
  selected: string[]
  onChange: (next: string[]) => void
  emptyText?: string
}

function MultiSelectList({ options, selected, onChange, emptyText }: MultiSelectProps) {
  if (options.length === 0) {
    return <div className="text-sm text-muted-foreground py-2">{emptyText || '没有可选项'}</div>
  }
  function toggle(id: string) {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id))
    else onChange([...selected, id])
  }
  return (
    <div className="border rounded-md max-h-40 overflow-y-auto divide-y">
      {options.map((opt) => (
        <label
          key={opt.id}
          className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted/50 cursor-pointer text-sm"
        >
          <Checkbox checked={selected.includes(opt.id)} onCheckedChange={() => toggle(opt.id)} />
          <div className="flex-1 min-w-0">
            <div className="truncate">{opt.label}</div>
            {opt.sub && <div className="text-xs text-muted-foreground truncate">{opt.sub}</div>}
          </div>
        </label>
      ))}
    </div>
  )
}

// 列表列：把绑定的助手/技能 id 翻译成名称，单行省略号展示，hover 浮现全部。
// 映射里查不到的 id（如历史用 UUID 绑定的旧数据）按原样回退显示。
function BoundNamesCell({
  ids,
  nameById,
}: {
  ids: string[] | null | undefined
  nameById: Map<string, string>
}) {
  if (!ids || ids.length === 0) return <>-</>
  const names = ids.map((id) => nameById.get(id) ?? id)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="max-w-[160px] truncate cursor-default">{names.join(', ')}</div>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <div className="flex flex-col gap-0.5">
          {names.map((n, i) => (
            <span key={i}>{n}</span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

// ===== Form helpers =====

function parseArgsJson(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function parseEnvJson(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const result: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) {
        result[k] = typeof v === 'string' ? v : JSON.stringify(v)
      }
      return result
    }
    return {}
  } catch {
    return {}
  }
}

// 鉴权方式选项（Step 3 下拉，stdio 禁用态与正常态共用，避免重复）
const AUTH_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'none', label: '无鉴权' },
  { value: 'api_key', label: 'API Key' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'basic', label: 'Basic Auth' },
  { value: 'oauth', label: 'OAuth' },
  { value: 'custom_header', label: '自定义 Header' },
  { value: 'secret_ref', label: 'Secret Center 引用' },
]

// ===== Main page component =====

interface McpServersPageProps {
  fixedScope?: 'org' | 'department'
}

export default function McpServersPage({ fixedScope }: McpServersPageProps) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const [servers, setServers] = useState<McpServer[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [scopeFilter, setScopeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [riskFilter, setRiskFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [auditFilter, setAuditFilter] = useState('all')
  const [departmentFilter, setDepartmentFilter] = useState('all')
  const [assistantFilter, setAssistantFilter] = useState('all')
  const [creatorFilter, setCreatorFilter] = useState('all')
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [editingServer, setEditingServer] = useState<McpServer | null>(null)
  const [currentStep, setCurrentStep] = useState(0)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [isUploadingIcon, setIsUploadingIcon] = useState(false)

  // Form state for create/edit dialog
  const [formData, setFormData] = useState<McpServerFormData>({})
  const [argsList, setArgsList] = useState<string[]>([])
  const [envMap, setEnvMap] = useState<Record<string, string>>({})
  // Plan §9 Step 3: auth_config_json — Key-Value pairs for non secret_ref auth types
  const [authConfigMap, setAuthConfigMap] = useState<Record<string, string>>({})
  // JSON 配置模式相关状态
  const [configMode, setConfigMode] = useState<'json' | 'form'>('json')
  const [jsonConfig, setJsonConfig] = useState<string>('{}')
  const [parseResult, setParseResult] = useState<McpConfigParseResult | null>(null)
  const [parseError, setParseError] = useState<string>('')
  // Plan §4.1 line 452: enable/disable requires AlertDialog confirmation
  const [pendingToggle, setPendingToggle] = useState<McpServer | null>(null)

  // User config dialog state
  const [configServerId, setConfigServerId] = useState<string | null>(null)
  const [configSchema, setConfigSchema] = useState<UserConfigItem[]>([])
  const [configValues, setConfigValues] = useState<Record<string, string>>({})
  const [configLoading, setConfigLoading] = useState(false)
  const [showConfigValues, setShowConfigValues] = useState<Record<string, boolean>>({})

  // Options for visible_to / bound_assistants / bound_skills (loaded once for dialog)
  const [departments, setDepartments] = useState<AuthDepartment[]>([])
  const [users, setUsers] = useState<AuthUser[]>([])
  const [assistants, setAssistants] = useState<{ id: string; name: string; displayName?: string }[]>([])
  const [skills, setSkills] = useState<{ id: string; name: string; displayName?: string }[]>([])
  const [optionsLoaded, setOptionsLoaded] = useState(false)
  const [isLoadingOptions, setIsLoadingOptions] = useState(false)

  const assistantNameById = useMemo(
    () => new Map(assistants.map((a) => [a.id, a.displayName || a.name])),
    [assistants],
  )
  const skillNameById = useMemo(
    () => new Map(skills.map((s) => [s.id, s.displayName || s.name])),
    [skills],
  )

  const loadOptions = useCallback(async () => {
    if (optionsLoaded || isLoadingOptions) return
    setIsLoadingOptions(true)
    try {
      const [depts, usrs, asts, skls] = await Promise.all([
        getDepartments().catch(() => ({ departments: [] })),
        getUsers().catch(() => ({ users: [] })),
        getInstalledAgents().catch(() => [] as { id: string; name: string; displayName?: string }[]),
        getInstalledSkills().catch(() => [] as { id: string; name: string; displayName?: string }[]),
      ])
      setDepartments(depts.departments || [])
      setUsers(usrs.users || [])
      setAssistants((asts || []).filter((a) => a.id && a.id.trim()))
      setSkills((skls || []).filter((s) => s.id && s.id.trim()))
      setOptionsLoaded(true)
    } catch (err) {
      if (err instanceof ApiRequestError) {
        toast.error(`加载选项失败: ${err.message}`)
      }
    } finally {
      setIsLoadingOptions(false)
    }
  }, [optionsLoaded, isLoadingOptions])

  const loadServers = useCallback(async () => {
    try {
      setIsLoading(true)
      // Plan §8.2: 通过后端筛选参数下发，避免分页与多 org 场景下漏匹配；
      // 文本搜索 backend 暂未实现 q/search 参数，沿用客户端 includes 过滤。
      const params: Record<string, string> = {}
      if (fixedScope) params.scope = fixedScope
      else if (scopeFilter !== 'all') params.scope = scopeFilter
      if (statusFilter !== 'all') params.status = statusFilter
      if (riskFilter !== 'all') params.risk_level = riskFilter
      if (typeFilter !== 'all') params.mcp_type = typeFilter
      if (auditFilter !== 'all') params.audit_enabled = auditFilter === 'yes' ? 'true' : 'false'
      if (departmentFilter !== 'all') params.department_id = departmentFilter
      if (assistantFilter !== 'all') params.bound_assistant = assistantFilter
      if (creatorFilter !== 'all') params.created_by = creatorFilter
      const result = await fetchMcpServers(params)
      setServers(result.items)
    } catch (err) {
      if (err instanceof ApiRequestError) {
        toast.error(`加载失败: ${err.message}`)
      }
    } finally {
      setIsLoading(false)
    }
  }, [scopeFilter, statusFilter, riskFilter, typeFilter, auditFilter, departmentFilter, assistantFilter, creatorFilter])

  useEffect(() => {
    loadServers()
  }, [loadServers])

  // Filter bar dropdowns (department / assistant / creator) need their option
  // lists available before any dialog is opened, so load them on mount too.
  useEffect(() => {
    loadOptions()
  }, [loadOptions])

  // Plan §2.5: subscribe to live MCP events and re-fetch the list when any
  // admin/user makes a change in this org.
  useEffect(() => {
    const unsubscribe = subscribeMcpEvents({
      onMcpChanged: () => { loadServers() },
    })
    return () => { unsubscribe() }
  }, [loadServers])

  // Per plan §4.6: 从模板市场跳转过来时，预填模板配置并打开 5 步向导。
  // 处理一次即清掉 query param，避免再次进入页面又触发。
  useEffect(() => {
    const templateId = searchParams.get('install_template')
    if (!templateId) return
    let cancelled = false
    ;(async () => {
      try {
        const template = await fetchMcpTemplate(templateId)
        if (cancelled) return
        setEditingServer(null)
        setFormData({
          name: template.name,
          display_name: template.name,
          description: template.description || '',
          category: template.category || '',
          risk_level: template.risk_level,
          mcp_type: template.mcp_type,
          template_id: templateId,
          url: template.url || '',
          command: template.command || '',
          timeout_ms: template.timeout_ms,
          auth_type: template.auth_type,
          scope: template.scope === 'department' ? 'department' : 'org',
          owner_type: template.scope === 'department' ? 'department' : 'system',
        })
        setArgsList(parseArgsJson(template.args_json))
        setEnvMap(parseEnvJson(template.env_json))
        setCurrentStep(0)
        setIsCreateDialogOpen(true)
        loadOptions()
      } catch (err) {
        if (err instanceof ApiRequestError) {
          toast.error(`加载模板失败: ${err.message}`)
        }
      } finally {
        const next = new URLSearchParams(searchParams)
        next.delete('install_template')
        setSearchParams(next, { replace: true })
      }
    })()
    return () => { cancelled = true }
  }, [searchParams, setSearchParams, loadOptions])

  // Filter logic
  const filteredServers = servers.filter((s) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      const displayName = s.display_name || s.name
      if (!(displayName.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q))) return false
    }
    if (scopeFilter !== 'all' && s.scope !== scopeFilter) return false
    if (typeFilter !== 'all' && s.mcp_type !== typeFilter) return false
    if (riskFilter !== 'all' && s.risk_level !== riskFilter) return false
    if (statusFilter !== 'all') {
      if (statusFilter === 'enabled' && !(s.enabled && s.status === 'enabled')) return false
      if (statusFilter === 'disabled' && s.enabled) return false
      if (statusFilter === 'error' && !(s.enabled && s.status === 'error')) return false
      if (statusFilter === 'pending' && !(s.enabled && s.status === 'pending')) return false
    }
    if (auditFilter !== 'all') {
      if (auditFilter === 'yes' && !s.audit_request && !s.audit_response_summary) return false
      if (auditFilter === 'no' && (s.audit_request || s.audit_response_summary)) return false
    }
    return true
  })

  // Stats
  const stats = {
    total: servers.length,
    org: servers.filter((s) => s.scope === 'org').length,
    dept: servers.filter((s) => s.scope === 'department').length,
    error: servers.filter((s) => s.enabled && s.status === 'error').length,
  }

  const pageTitle = fixedScope === 'org' ? '企业服务' : fixedScope === 'department' ? '部门服务' : 'MCP 服务'
  const pageDesc = fixedScope === 'org' ? '管理企业级 MCP 服务配置' : fixedScope === 'department' ? '管理部门级 MCP 服务配置' : '管理企业级和部门级 MCP 服务配置'

  const steps = ['基础信息', '连接配置', '鉴权配置', '权限范围', '安全策略']

  // 有效传输类型：JSON 模式以解析结果为准，表单模式以 formData 为准（JSON 模式下 formData.mcp_type 是过期默认值）
  const effectiveType = configMode === 'json' ? parseResult?.mcp_type : formData.mcp_type
  const isStdio = effectiveType === 'stdio'

  // JSON/表单 模式转换函数
  const formToJson = useCallback(() => {
    const config: Record<string, unknown> = {}
    if (formData.mcp_type === 'stdio') {
      config.command = formData.command || ''
      if (argsList.length > 0) config.args = argsList
      if (Object.keys(envMap).length > 0) config.env = envMap
    } else {
      config.url = formData.url || ''
    }
    return JSON.stringify({ [formData.name || 'server']: config }, null, 2)
  }, [formData, argsList, envMap])

  const jsonToForm = useCallback((result: McpConfigParseResult['data']) => {
    if (!result) return
    setFormData(prev => ({
      ...prev,
      ...result,
      name: prev.name,
      display_name: prev.display_name,
    }))
    if (result.args_json) setArgsList(parseArgsJson(result.args_json))
    if (result.env_json) setEnvMap(parseEnvJson(result.env_json))
    if (result.auth_config_json) setAuthConfigMap(parseEnvJson(result.auth_config_json))
  }, [])

  const handleModeSwitch = useCallback((mode: 'json' | 'form') => {
    if (mode === 'json') {
      setJsonConfig(formToJson())
    } else {
      if (parseResult?.data) jsonToForm(parseResult.data)
    }
    setConfigMode(mode)
  }, [formToJson, parseResult, jsonToForm])

  // JSON 模式实时解析
  useEffect(() => {
    if (configMode !== 'json') return
    const timer = setTimeout(async () => {
      try {
        JSON.parse(jsonConfig)
        const result = await parseMcpConfig(jsonConfig)
        setParseResult(result.success ? result : null)
        setParseError(result.success ? '' : result.error || '')
      } catch {
        setParseError('无效的 JSON 格式')
        setParseResult(null)
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [jsonConfig, configMode])

  function openCreateDialog() {
    setEditingServer(null)
    const scope = fixedScope ?? 'org'
    const ownerType = scope === 'org' ? 'system' : 'department'
    const ownerId = scope === 'department' && user?.role === 'dept_admin' ? (user.departmentId ?? '') : undefined
    setFormData({
      mcp_type: 'http',
      scope,
      owner_type: ownerType,
      ...(ownerId ? { owner_id: ownerId } : {}),
      risk_level: 'low',
      auth_type: 'none',
      timeout_ms: 30000,
    })
    setArgsList([])
    setEnvMap({})
    setAuthConfigMap({})
    setConfigMode('json')
    setJsonConfig('{}')
    setParseResult(null)
    setParseError('')
    setCurrentStep(0)
    setIsCreateDialogOpen(true)
    loadOptions()
  }

  function openEditDialog(server: McpServer) {
    setEditingServer(server)
    setFormData({
      name: server.display_name || server.name,
      display_name: server.display_name || server.name,
      icon: server.icon || '',
      description: server.description || '',
      category: server.category || '',
      risk_level: server.risk_level,
      responsible_person: server.responsible_person || '',
      mcp_type: server.mcp_type,
      url: server.url || '',
      command: server.command || '',
      timeout_ms: server.timeout_ms,
      health_check_url: server.health_check_url || '',
      use_proxy: server.use_proxy,
      auth_type: server.auth_type,
      secret_ref: server.secret_ref || '',
      scope: fixedScope ?? server.scope,
      owner_type: server.owner_type,
      owner_id: server.owner_id,
      visible_to: server.visible_to,
      bound_assistants: server.bound_assistants || [],
      bound_skills: server.bound_skills || [],
      allow_read: server.allow_read,
      allow_write: server.allow_write,
      require_confirmation_for_write: server.require_confirmation_for_write,
      allow_read_sensitive_fields: server.allow_read_sensitive_fields,
      allow_outbound_network: server.allow_outbound_network,
      allow_scheduled_task: server.allow_scheduled_task,
      audit_request: server.audit_request,
      audit_response_summary: server.audit_response_summary,
      redact_sensitive_fields: server.redact_sensitive_fields,
      allow_user_disable: server.allow_user_disable,
    })
    setArgsList(parseArgsJson(server.args_json))
    setEnvMap(parseEnvJson(server.env_json))
    setAuthConfigMap(parseEnvJson(server.auth_config_json))
    // 编辑场景：用表单模式（已有数据），用户可切换到 JSON 模式查看/编辑
    setConfigMode('form')
    setJsonConfig('{}')
    setParseResult(null)
    setParseError('')
    setCurrentStep(0)
    setIsCreateDialogOpen(true)
    loadOptions()
  }

  async function handleSubmit() {
    // 部门服务：校验 owner_id 必填
    if (fixedScope === 'department' && user?.role !== 'dept_admin' && !formData.owner_id) {
      toast.error('请选择所属部门')
      return
    }
    if (!formData.name?.trim()) {
      toast.error('请输入名称')
      return
    }
    setIsSubmitting(true)
    try {
      let payload: McpServerFormData

      if (configMode === 'json') {
        // JSON 模式下必须有有效的解析结果才能提交
        if (!parseResult?.success || !parseResult.data) {
          toast.error('JSON 配置解析失败，请检查格式')
          setIsSubmitting(false)
          return
        }
        // 直接从 parseResult 构建提交数据，绕过 React 异步状态更新
        const parsed = parseResult.data
        const parsedArgs = parsed.args_json ? JSON.parse(parsed.args_json) : []
        const parsedEnv = parsed.env_json ? JSON.parse(parsed.env_json) : {}
        const parsedAuth = parsed.auth_config_json ? JSON.parse(parsed.auth_config_json) : {}
        payload = {
          ...formData,
          name: formData.name,
          display_name: formData.name || formData.display_name,
          mcp_type: parsed.mcp_type,
          url: parsed.url || null,
          command: parsed.command || null,
          timeout_ms: parsed.timeout_ms,
          args_json: parsedArgs.length > 0 ? JSON.stringify(parsedArgs) : null,
          env_json: Object.keys(parsedEnv).length > 0 ? JSON.stringify(parsedEnv) : null,
          auth_config_json: Object.keys(parsedAuth).length > 0 ? JSON.stringify(parsedAuth) : null,
        }
      } else {
        // 表单模式：原有逻辑
        const cleanedEnv: Record<string, string> = {}
        for (const [k, v] of Object.entries(envMap)) {
          if (k.trim()) cleanedEnv[k.trim()] = v
        }
        const cleanedAuth: Record<string, string> = {}
        for (const [k, v] of Object.entries(authConfigMap)) {
          if (k.trim()) cleanedAuth[k.trim()] = v
        }
        payload = {
          ...formData,
          display_name: formData.name || formData.display_name,
          args_json: argsList.length > 0 ? JSON.stringify(argsList) : null,
          env_json: Object.keys(cleanedEnv).length > 0 ? JSON.stringify(cleanedEnv) : null,
          auth_config_json: Object.keys(cleanedAuth).length > 0 ? JSON.stringify(cleanedAuth) : null,
        }
      }

      // 按传输类型剔除无关字段：stdio 只走环境变量，http/sse 只走 header 鉴权，杜绝死配置
      if (payload.mcp_type === 'stdio') {
        payload.auth_config_json = null
        payload.auth_type = 'none'
        payload.secret_ref = null
      } else {
        payload.env_json = null
      }

      if (editingServer) {
        await updateMcpServer(editingServer.id, payload)
        toast.success('MCP 服务已更新')
      } else {
        await createMcpServer(payload)
        toast.success('MCP 服务已创建')
      }
      setIsCreateDialogOpen(false)
      setEditingServer(null)
      await loadServers()
    } catch (err) {
      if (err instanceof ApiRequestError) {
        toast.error(err.message)
      } else {
        toast.error('操作失败')
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  function requestToggleEnabled(server: McpServer) {
    // Plan §4.1 line 452: 禁用/启用 需二次确认 Dialog
    setPendingToggle(server)
  }

  async function confirmToggleEnabled() {
    const server = pendingToggle
    if (!server) return
    setPendingToggle(null)
    try {
      await updateMcpServer(server.id, { enabled: !server.enabled })
      toast.success(server.enabled ? `已禁用 ${server.display_name || server.name}` : `已启用 ${server.display_name || server.name}`)
      await loadServers()
    } catch (err) {
      if (err instanceof ApiRequestError) {
        toast.error(err.message)
      }
    }
  }

  async function handleTestConnection(server: McpServer) {
    setTestingId(server.id)
    try {
      const result = await testConnection(server.id)
      if (result.success) {
        toast.success(`${server.display_name || server.name} 连接测试成功 (${result.latency_ms}ms)`)
      } else {
        toast.error(`${server.display_name || server.name} 连接测试失败: ${result.message}`)
      }
      await loadServers()
    } catch (err) {
      if (err instanceof ApiRequestError) {
        toast.error(err.message)
      }
    } finally {
      setTestingId(null)
    }
  }

  async function handleIconUpload(file: File) {
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml']
    const maxSize = 2 * 1024 * 1024 // 2MB

    if (!validTypes.includes(file.type)) {
      toast.error('仅支持 PNG、JPG、JPEG、WebP、SVG 格式的图片')
      return
    }
    if (file.size > maxSize) {
      toast.error('图片大小不能超过 2MB')
      return
    }

    setIsUploadingIcon(true)
    try {
      const response = await uploadMcpIcon(file)
      if (response.success) {
        setFormData({ ...formData, icon: response.data.url })
        toast.success('图标上传成功')
      } else {
        toast.error('图标上传失败')
      }
    } catch (err) {
      if (err instanceof ApiRequestError) {
        toast.error(err.message)
      } else {
        toast.error('图标上传失败')
      }
    } finally {
      setIsUploadingIcon(false)
    }
  }

  function resetFilters() {
    setSearchQuery('')
    setScopeFilter('all')
    setStatusFilter('all')
    setRiskFilter('all')
    setTypeFilter('all')
    setAuditFilter('all')
    setDepartmentFilter('all')
    setAssistantFilter('all')
    setCreatorFilter('all')
  }

  async function handleOpenConfig(server: McpServer) {
    if (!server.template_id) return
    setConfigServerId(server.id)
    setConfigLoading(true)
    try {
      const result = await fetchUserConfig(server.id)
      setConfigSchema(result.schema)
      setConfigValues(result.values)
      setShowConfigValues({})
    } catch {
      toast.error('加载用户配置失败')
    } finally {
      setConfigLoading(false)
    }
  }

  if (isLoading) {
    return (
      <DashboardLayout title={pageTitle} description={pageDesc}>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title={pageTitle} description={pageDesc}>
      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-2xl font-bold">{stats.total}</div>
          <div className="text-sm text-muted-foreground">总数</div>
        </div>
        {!fixedScope && (
          <div className="rounded-lg border bg-card p-4">
            <div className="text-2xl font-bold">{stats.org}</div>
            <div className="text-sm text-muted-foreground">企业级</div>
          </div>
        )}
        {!fixedScope && (
          <div className="rounded-lg border bg-card p-4">
            <div className="text-2xl font-bold">{stats.dept}</div>
            <div className="text-sm text-muted-foreground">部门级</div>
          </div>
        )}
        {fixedScope === 'org' && (
          <div className="rounded-lg border bg-card p-4">
            <div className="text-2xl font-bold">{stats.org}</div>
            <div className="text-sm text-muted-foreground">企业级</div>
          </div>
        )}
        {fixedScope === 'department' && (
          <div className="rounded-lg border bg-card p-4">
            <div className="text-2xl font-bold">{stats.dept}</div>
            <div className="text-sm text-muted-foreground">部门级</div>
          </div>
        )}
        <div className="rounded-lg border bg-card p-4">
          <div className="text-2xl font-bold text-red-600">{stats.error}</div>
          <div className="text-sm text-muted-foreground">异常</div>
        </div>
      </div>

      {/* Action bar */}
      <div className="flex items-center justify-between mb-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="搜索 MCP 服务..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadServers}>
            <RefreshCw className="size-4 mr-1" />刷新
          </Button>
          <Button size="sm" onClick={openCreateDialog}>
            <Plus className="size-4 mr-1" />创建 MCP
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        {!fixedScope && (
          <Select value={scopeFilter} onValueChange={setScopeFilter}>
            <SelectTrigger className="w-[120px]"><SelectValue placeholder="作用域" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部作用域</SelectItem>
              <SelectItem value="org">企业级</SelectItem>
              <SelectItem value="department">部门级</SelectItem>
            </SelectContent>
          </Select>
        )}
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[120px]"><SelectValue placeholder="状态" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="enabled">已启用</SelectItem>
            <SelectItem value="disabled">已禁用</SelectItem>
            <SelectItem value="error">异常</SelectItem>
            <SelectItem value="pending">待测试</SelectItem>
          </SelectContent>
        </Select>
        <Select value={riskFilter} onValueChange={setRiskFilter}>
          <SelectTrigger className="w-[100px]"><SelectValue placeholder="风险" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部风险</SelectItem>
            <SelectItem value="low">低</SelectItem>
            <SelectItem value="medium">中</SelectItem>
            <SelectItem value="high">高</SelectItem>
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[100px]"><SelectValue placeholder="类型" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            <SelectItem value="http">HTTP</SelectItem>
            <SelectItem value="sse">SSE</SelectItem>
            <SelectItem value="stdio">STDIO</SelectItem>
          </SelectContent>
        </Select>
        <Select value={auditFilter} onValueChange={setAuditFilter}>
          <SelectTrigger className="w-[120px]"><SelectValue placeholder="审计" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部审计</SelectItem>
            <SelectItem value="yes">已开启</SelectItem>
            <SelectItem value="no">未开启</SelectItem>
          </SelectContent>
        </Select>
        <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="部门" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部部门</SelectItem>
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={assistantFilter} onValueChange={setAssistantFilter}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="助手" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部助手</SelectItem>
            {assistants.map((a) => (
              <SelectItem key={a.id} value={a.id}>{a.displayName || a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={creatorFilter} onValueChange={setCreatorFilter}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="创建人" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部创建人</SelectItem>
            {users.map((u) => (
              <SelectItem key={u.id} value={u.id}>{u.name || u.id}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" onClick={resetFilters}>
          <X className="size-3 mr-1" />重置
        </Button>
      </div>

      {/* Table */}
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>类型</TableHead>
              {!fixedScope && <TableHead>作用域</TableHead>}
              <TableHead>状态</TableHead>
              <TableHead>可见范围</TableHead>
              <TableHead>绑定助手</TableHead>
              <TableHead>绑定技能</TableHead>
              <TableHead>凭据来源</TableHead>
              <TableHead>风险等级</TableHead>
              <TableHead>最近调用</TableHead>
              <TableHead>审计</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredServers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={fixedScope ? 11 : 12} className="text-center py-8 text-muted-foreground">
                  没有找到匹配的数据
                </TableCell>
              </TableRow>
            ) : (
              filteredServers.map((server) => (
                <TableRow key={server.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {server.icon && <img src={server.icon} className="size-5 rounded" alt="" />}
                      <div className="font-medium">{server.display_name || server.name}</div>
                    </div>
                  </TableCell>
                  <TableCell><TypeBadge mcpType={server.mcp_type} /></TableCell>
                  {!fixedScope && <TableCell><ScopeBadge scope={server.scope} /></TableCell>}
                  <TableCell><StatusBadge enabled={server.enabled} status={server.status} /></TableCell>
                  <TableCell className="text-sm">{formatVisibleTo(server.visible_to)}</TableCell>
                  <TableCell className="text-sm">
                    <BoundNamesCell ids={server.bound_assistants} nameById={assistantNameById} />
                  </TableCell>
                  <TableCell className="text-sm">
                    <BoundNamesCell ids={server.bound_skills} nameById={skillNameById} />
                  </TableCell>
                  <TableCell className="text-sm">{getCredentialSource(server.secret_ref)}</TableCell>
                  <TableCell><RiskBadge level={server.risk_level} /></TableCell>
                  <TableCell className="text-sm whitespace-nowrap">
                    {formatLastInvocation(server.last_invocation_at)}
                  </TableCell>
                  <TableCell>
                    {(server.audit_request || server.audit_response_summary) ? '是' : '否'}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {server.template_id && (
                        <Button variant="outline" size="sm" onClick={() => handleOpenConfig(server)}>配置</Button>
                      )}
                      <Button variant="ghost" size="icon" className="size-8" title="编辑" onClick={() => openEditDialog(server)}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-8" title={server.enabled ? '禁用' : '启用'} onClick={() => requestToggleEnabled(server)}>
                        {server.enabled ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
                      </Button>
                      <Button variant="ghost" size="icon" className="size-8" title="测试连接" onClick={() => handleTestConnection(server)} disabled={testingId === server.id}>
                        {testingId === server.id ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                      </Button>
                      <Button variant="ghost" size="icon" className="size-8" title="查看日志" onClick={() => navigate(`/mcp/audit-log?mcp_server_id=${encodeURIComponent(server.id)}`)}>
                        <FileText className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create/Edit Dialog with 5-step wizard */}
      <Dialog open={isCreateDialogOpen} onOpenChange={(open) => { setIsCreateDialogOpen(open); if (!open) setEditingServer(null) }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingServer ? '编辑 MCP 服务' : '创建 MCP 服务'}</DialogTitle>
            <DialogDescription>
              {editingServer ? '修改 MCP 服务配置' : '按步骤配置新的 MCP 服务'}
            </DialogDescription>
          </DialogHeader>

          {/* Step indicator */}
          <div className="flex items-center gap-2 py-2">
            {steps.map((step, i) => (
              <div key={step} className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentStep(i)}
                  className={`flex items-center gap-1.5 text-sm px-2 py-1 rounded-md transition-colors ${
                    i === currentStep
                      ? 'bg-primary text-primary-foreground font-medium'
                      : i < currentStep
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground'
                  }`}
                >
                  <span className="size-5 flex items-center justify-center rounded-full text-xs border current:border-0">
                    {i < currentStep ? '✓' : i + 1}
                  </span>
                  <span className="hidden sm:inline">{step}</span>
                </button>
                {i < steps.length - 1 && <div className="w-4 h-px bg-border" />}
              </div>
            ))}
          </div>

          <div className="border-t pt-4">
            {/* Step 1: 基础信息 */}
            {currentStep === 0 && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>图标 <span className="text-red-500">*</span></Label>
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg border bg-muted/20 flex items-center justify-center overflow-hidden shrink-0">
                      {formData.icon ? (
                        <img src={formData.icon} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <ImageIcon className="size-4 text-muted-foreground" />
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="relative"
                      disabled={isUploadingIcon}
                    >
                      {isUploadingIcon ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <Upload className="mr-2 size-4" />
                      )}
                      {isUploadingIcon ? '上传中...' : '上传图标'}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/jpg,image/webp,image/svg+xml"
                        className="absolute inset-0 opacity-0 cursor-pointer"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file) {
                            void handleIconUpload(file)
                          }
                          e.target.value = ''
                        }}
                      />
                    </Button>
                    <p className="text-xs text-muted-foreground">支持 PNG、JPG、WebP、SVG 格式，最大 2MB</p>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>名称 <span className="text-red-500">*</span></Label>
                  <Input placeholder="CRM MCP" value={formData.name || ''} onChange={(e) => setFormData({ ...formData, name: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>描述</Label>
                  <Textarea placeholder="MCP 服务描述..." value={formData.description || ''} onChange={(e) => setFormData({ ...formData, description: e.target.value })} />
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>分类</Label>
                    <Select value={formData.category || ''} onValueChange={(v) => setFormData({ ...formData, category: v })}>
                      <SelectTrigger><SelectValue placeholder="选择分类" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="business">业务系统</SelectItem>
                        <SelectItem value="knowledge">知识管理</SelectItem>
                        <SelectItem value="dev">开发工具</SelectItem>
                        <SelectItem value="finance">财务</SelectItem>
                        <SelectItem value="other">其他</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>风险等级</Label>
                    <Select value={formData.risk_level || 'low'} onValueChange={(v) => setFormData({ ...formData, risk_level: v as any })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">低</SelectItem>
                        <SelectItem value="medium">中</SelectItem>
                        <SelectItem value="high">高</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>负责人</Label>
                    <Input placeholder="负责人姓名" value={formData.responsible_person || ''} onChange={(e) => setFormData({ ...formData, responsible_person: e.target.value })} />
                  </div>
                </div>
              </div>
            )}

            {/* Step 2: 连接配置 */}
            {currentStep === 1 && (
              <div className="space-y-4">
                {/* 模式切换 - JSON 默认在前 */}
                <div className="flex items-center gap-2 border-b pb-2">
                  <Button
                    variant={configMode === 'json' ? 'default' : 'ghost'}
                    onClick={() => handleModeSwitch('json')}
                  >
                    JSON 模式
                  </Button>
                  <Button
                    variant={configMode === 'form' ? 'default' : 'ghost'}
                    onClick={() => handleModeSwitch('form')}
                  >
                    表单模式
                  </Button>
                </div>

                {/* JSON 模式（默认显示） */}
                {configMode === 'json' && (
                  <div className="space-y-4">
                    <div className="flex justify-between items-center">
                      <Label>连接配置 (JSON)</Label>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => {
                          try {
                            setJsonConfig(JSON.stringify(JSON.parse(jsonConfig), null, 2))
                          } catch {
                            toast.error('JSON 格式无效')
                          }
                        }}>
                          格式化
                        </Button>
                      </div>
                    </div>

                    <JsonEditor
                      value={jsonConfig}
                      onChange={setJsonConfig}
                      height="300px"
                      language="json"
                    />

                    {/* 解析结果/错误 */}
                    {parseError && (
                      <div className="text-sm text-destructive">⚠ {parseError}</div>
                    )}
                    {parseResult?.success && (
                      <div className="text-sm text-muted-foreground">
                        ✓ 已识别为 {parseResult.mcp_type} 类型
                        {parseResult.data?.command && `，命令: ${parseResult.data.command}`}
                        {parseResult.data?.url && `，URL: ${parseResult.data.url}`}
                        {parseResult.warnings?.length && (
                          <div className="text-yellow-600 mt-1">
                            警告: {parseResult.warnings.join(', ')}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 超时时间等补充字段 */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>超时时间 (ms)</Label>
                        <Input type="number" value={formData.timeout_ms || 30000} onChange={(e) => setFormData({ ...formData, timeout_ms: Number(e.target.value) })} />
                      </div>
                      <div className="space-y-2">
                        <Label>健康检查地址</Label>
                        <Input placeholder="https://example.com/health" value={formData.health_check_url || ''} onChange={(e) => setFormData({ ...formData, health_check_url: e.target.value })} />
                      </div>
                    </div>
                  </div>
                )}

                {/* 表单模式（现有逻辑） */}
                {configMode === 'form' && (
                  <>
                    <div className="space-y-2">
                      <Label>类型 <span className="text-red-500">*</span></Label>
                      <Select value={formData.mcp_type || 'http'} onValueChange={(v) => {
                        const next = v as 'http' | 'sse' | 'stdio'
                        // 按传输类型隔离：切到 stdio 清空鉴权并重置鉴权方式；切到 http/sse 清空环境变量
                        if (next === 'stdio') {
                          setAuthConfigMap({})
                          setFormData({ ...formData, mcp_type: next, auth_type: 'none', secret_ref: '' })
                        } else {
                          setEnvMap({})
                          setFormData({ ...formData, mcp_type: next })
                        }
                      }}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="http">HTTP</SelectItem>
                          <SelectItem value="sse">SSE</SelectItem>
                          <SelectItem value="stdio">STDIO</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {(formData.mcp_type === 'http' || formData.mcp_type === 'sse' || !formData.mcp_type) && (
                      <div className="space-y-2">
                        <Label>URL (HTTP/SSE)</Label>
                        <Input placeholder="https://example.com/mcp" value={formData.url || ''} onChange={(e) => setFormData({ ...formData, url: e.target.value })} />
                      </div>
                    )}
                    {formData.mcp_type === 'stdio' && (
                      <>
                        <div className="space-y-2">
                          <Label>启动命令 <span className="text-red-500">*</span></Label>
                          <Input placeholder="npx" value={formData.command || ''} onChange={(e) => setFormData({ ...formData, command: e.target.value })} />
                        </div>
                        <div className="space-y-2">
                          <Label>命令参数</Label>
                          <TagInput value={argsList} onChange={setArgsList} placeholder="输入参数后回车，如 -y、@modelcontextprotocol/server-fs" />
                          <p className="text-xs text-muted-foreground">每行一个参数。提交时序列化为 JSON 数组。</p>
                        </div>
                        <div className="space-y-2">
                          <Label>环境变量</Label>
                          <KVEditor value={envMap} onChange={setEnvMap} />
                          <p className="text-xs text-muted-foreground">敏感值请改用 Secret Center 引用，避免明文落库。</p>
                        </div>
                      </>
                    )}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>超时时间 (ms)</Label>
                        <Input type="number" value={formData.timeout_ms || 30000} onChange={(e) => setFormData({ ...formData, timeout_ms: Number(e.target.value) })} />
                      </div>
                      <div className="space-y-2">
                        <Label>健康检查地址</Label>
                        <Input placeholder="https://example.com/health" value={formData.health_check_url || ''} onChange={(e) => setFormData({ ...formData, health_check_url: e.target.value })} />
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Step 3: 鉴权配置 */}
            {currentStep === 2 && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>鉴权方式</Label>
                  {isStdio ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="cursor-not-allowed">
                          <Select value={formData.auth_type || 'none'} disabled>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {AUTH_TYPE_OPTIONS.map((o) => (
                                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>STDIO 通过环境变量鉴权，请在「连接配置」的环境变量中传入密钥</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Select value={formData.auth_type || 'none'} onValueChange={(v) => setFormData({ ...formData, auth_type: v as any })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {AUTH_TYPE_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                {!isStdio && formData.auth_type === 'secret_ref' && (
                  <div className="space-y-2">
                    <Label>Secret Center 凭据引用</Label>
                    <Input placeholder="system:secret_name" value={formData.secret_ref || ''} onChange={(e) => setFormData({ ...formData, secret_ref: e.target.value })} />
                  </div>
                )}
                {!isStdio && formData.auth_type && formData.auth_type !== 'none' && formData.auth_type !== 'secret_ref' && (
                  <div className="space-y-2">
                    <Label>额外配置</Label>
                    <KVEditor value={authConfigMap} onChange={setAuthConfigMap} />
                    <p className="text-xs text-muted-foreground">Key-Value 形式，例如 header_name=X-API-Key 等。敏感值请改用 Secret Center 引用。</p>
                  </div>
                )}
                <div className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
                  MCP 配置不直接保存明文密钥，只保存 Secret 引用。
                </div>
              </div>
            )}

            {/* Step 4: 权限范围 */}
            {currentStep === 3 && (
              <div className="space-y-4">
                {!fixedScope && (
                  <div className="space-y-2">
                    <Label>作用域 <span className="text-red-500">*</span></Label>
                    <Select value={formData.scope || 'org'} onValueChange={(v) => setFormData({ ...formData, scope: v as any, owner_type: v === 'org' ? 'system' : 'department' })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="org">企业级</SelectItem>
                        <SelectItem value="department">部门级</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* 部门服务：所属部门选择（必填） */}
                {fixedScope === 'department' && (
                  <div className="space-y-2">
                    <Label>所属部门 <span className="text-red-500">*</span></Label>
                    {user?.role === 'dept_admin' ? (
                      <Input
                        value={departments.find((d) => d.id === user.departmentId)?.name || user.departmentId || ''}
                        disabled
                        readOnly
                      />
                    ) : (
                      <>
                        <Select
                          value={formData.owner_id || ''}
                          onValueChange={(v) => setFormData({ ...formData, owner_id: v, owner_type: 'department' })}
                        >
                          <SelectTrigger><SelectValue placeholder="请选择部门" /></SelectTrigger>
                          <SelectContent>
                            {departments.map((d) => (
                              <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">请选择所属部门（必填）</p>
                      </>
                    )}
                  </div>
                )}

                {isLoadingOptions ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />加载选项中…
                  </div>
                ) : (
                  <>
                    {fixedScope !== 'department' && (
                      <div className="space-y-2">
                        <Label>可见部门</Label>
                        <p className="text-xs text-muted-foreground">不勾选任何项则默认全员可见；勾选后仅所选部门可见。</p>
                        <MultiSelectList
                          options={departments.map((d) => ({ id: d.id, label: d.name }))}
                          selected={formData.visible_to?.department_ids || []}
                          onChange={(ids) => setFormData({
                            ...formData,
                            visible_to: {
                              ...formData.visible_to,
                              department_ids: ids,
                              user_ids: formData.visible_to?.user_ids,
                            },
                          })}
                          emptyText="没有部门"
                        />
                      </div>
                    )}

                    {fixedScope !== 'department' && (
                      <div className="space-y-2">
                        <Label>可见用户</Label>
                        <p className="text-xs text-muted-foreground">额外把权限授予指定用户（与部门并集生效）。</p>
                        <MultiSelectList
                          options={users.map((u) => ({ id: u.id, label: u.name, sub: u.email || undefined }))}
                          selected={formData.visible_to?.user_ids || []}
                          onChange={(ids) => setFormData({
                            ...formData,
                            visible_to: {
                              ...formData.visible_to,
                              department_ids: formData.visible_to?.department_ids,
                              user_ids: ids,
                            },
                          })}
                          emptyText="没有用户"
                        />
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label>绑定助手</Label>
                      <p className="text-xs text-muted-foreground">仅勾选的助手可以调用本 MCP；为空表示不限。</p>
                      <MultiSelectList
                        options={assistants.map((a) => ({ id: a.id, label: a.displayName || a.name, sub: a.name }))}
                        selected={formData.bound_assistants || []}
                        onChange={(ids) => setFormData({ ...formData, bound_assistants: ids })}
                        emptyText="没有可绑定的助手"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>绑定技能</Label>
                      <p className="text-xs text-muted-foreground">仅勾选的技能可以调用本 MCP；为空表示不限。</p>
                      <MultiSelectList
                        options={skills.map((s) => ({ id: s.id, label: s.displayName || s.name, sub: s.name }))}
                        selected={formData.bound_skills || []}
                        onChange={(ids) => setFormData({ ...formData, bound_skills: ids })}
                        emptyText="没有可绑定的技能"
                      />
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Step 5: 安全策略 */}
            {currentStep === 4 && (
              <div className="space-y-3">
                {[
                  { key: 'allow_read' as const, label: '允许读操作', default: true },
                  { key: 'allow_write' as const, label: '允许写操作', default: true },
                  { key: 'require_confirmation_for_write' as const, label: '写操作需二次确认', default: false },
                  { key: 'allow_read_sensitive_fields' as const, label: '允许读取敏感字段', default: false },
                  { key: 'allow_outbound_network' as const, label: '允许出网', default: true },
                  { key: 'allow_scheduled_task' as const, label: '允许自动任务调用', default: false },
                  { key: 'audit_request' as const, label: '记录请求参数', default: false },
                  { key: 'audit_response_summary' as const, label: '记录响应摘要', default: false },
                  { key: 'redact_sensitive_fields' as const, label: '启用脱敏', default: false },
                  { key: 'allow_user_disable' as const, label: '允许员工禁用', default: true },
                ].map((item) => (
                  <div key={item.key} className="flex items-center justify-between py-1">
                    <Label>{item.label}</Label>
                    <Switch checked={(formData[item.key] as boolean) ?? item.default} onCheckedChange={(v) => setFormData({ ...formData, [item.key]: v })} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            {currentStep > 0 && (
              <Button variant="outline" onClick={() => setCurrentStep(currentStep - 1)}>上一步</Button>
            )}
            {currentStep < 4 ? (
              <Button onClick={() => setCurrentStep(currentStep + 1)}>下一步</Button>
            ) : (
              <Button onClick={handleSubmit} disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="mr-2 size-4 animate-spin" />}
                {editingServer ? '保存' : '创建'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Plan §4.1 line 452: 禁用/启用二次确认 */}
      <AlertDialog open={pendingToggle != null} onOpenChange={(open) => { if (!open) setPendingToggle(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingToggle?.enabled ? '禁用 MCP 服务' : '启用 MCP 服务'}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingToggle?.enabled
                ? `确认禁用「${pendingToggle?.display_name || pendingToggle?.name}」？禁用后该 MCP 将无法被调用。`
                : `确认启用「${pendingToggle?.display_name || pendingToggle?.name}」？启用后该 MCP 将立即可被调用。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={confirmToggleEnabled}>确认</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* User config dialog for template-based servers */}
      <Dialog open={!!configServerId} onOpenChange={(open) => { if (!open) setConfigServerId(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>用户配置</DialogTitle>
          </DialogHeader>
          {configLoading ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="size-6 animate-spin" /></div>
          ) : configSchema.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">该服务暂无可配置项</p>
          ) : (
            <div className="space-y-4">
              {configSchema.map((item) => (
                <div key={item.key} className="space-y-1.5">
                  <Label className="text-sm font-medium">{item.name} {item.required !== false && <span className="text-destructive">*</span>}</Label>
                  {item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}
                  <div className="flex gap-2">
                    <Input
                      type={showConfigValues[item.key] ? 'text' : 'password'}
                      value={configValues[item.key] ?? ''}
                      onChange={(e) => setConfigValues(prev => ({ ...prev, [item.key]: e.target.value }))}
                      placeholder={item.required !== false ? '必填' : '可选'}
                    />
                    <Button variant="ghost" size="sm" onClick={() => setShowConfigValues(prev => ({ ...prev, [item.key]: !prev[item.key] }))}>
                      {showConfigValues[item.key] ? '隐藏' : '显示'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {configSchema.length > 0 && (
            <DialogFooter>
              <Button onClick={async () => {
                try {
                  for (const item of configSchema) {
                    const val = configValues[item.key]
                    if (val !== undefined && val !== '') {
                      await setUserConfigValue(configServerId!, item.key, val)
                    }
                  }
                  toast.success('配置已保存')
                  setConfigServerId(null)
                } catch { toast.error('保存失败') }
              }}>保存</Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
