'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Search, Download, Loader2, Pencil, Trash2, Plus, Upload, Image as ImageIcon, X, Shield, Check } from 'lucide-react'
import { toast } from 'sonner'

import { DashboardLayout } from '@/components/dashboard-layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  fetchMcpTemplates,
  createMcpTemplate,
  updateMcpTemplate,
  deleteMcpTemplate,
  uploadMcpIcon,
  type McpTemplate,
  type McpTemplateFormData,
  type UserConfigItem,
} from '@/lib/api/mcp'
import { getUsers, getDepartments } from '@/lib/api/auth'
import { getInstalledAgents } from '@/lib/api/agent-hub'
import { getInstalledSkills } from '@/lib/api/skill-store'
import { getConfigItems, getDepartmentPolicies } from '@/lib/api/secrets'
import type { ConfigItem } from '@/lib/api/secrets'
import { ApiRequestError } from '@/lib/api/client'

// ============================================================
// Constants
// ============================================================

const CATEGORY_OPTIONS = [
  { value: 'business', label: '业务系统' },
  { value: 'knowledge', label: '知识管理' },
  { value: 'dev', label: '开发工具' },
  { value: 'finance', label: '财务' },
  { value: 'other', label: '其他' },
] as const

const AUTH_TYPE_OPTIONS = [
  { value: 'none', label: '无鉴权' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'basic', label: 'Basic Auth' },
  { value: 'api_key', label: 'API Key' },
  { value: 'oauth', label: 'OAuth' },
  { value: 'custom_header', label: '自定义 Header' },
  { value: 'secret_ref', label: 'Secret Center 引用' },
] as const

const SECURITY_POLICY_ITEMS = [
  { key: 'allow_read', label: '允许读操作', default: true },
  { key: 'allow_write', label: '允许写操作', default: true },
  { key: 'require_confirmation_for_write', label: '写操作需二次确认', default: false },
  { key: 'allow_read_sensitive_fields', label: '允许读取敏感字段', default: false },
  { key: 'allow_outbound_network', label: '允许出网', default: true },
  { key: 'allow_scheduled_task', label: '允许自动任务调用', default: false },
  { key: 'audit_request', label: '记录请求参数', default: false },
  { key: 'audit_response_summary', label: '记录响应摘要', default: false },
  { key: 'redact_sensitive_fields', label: '启用脱敏', default: false },
] as const

const STEPS = ['基础信息', '连接配置', '权限范围', '鉴权配置', '安全策略']

// ============================================================
// Types for auth config form state
// ============================================================

interface TemplateAuthConfigItem {
  name: string
  key: string
  description: string
  required: boolean
}

interface TemplateOauthField {
  label: string
  key: string
  default_value: string
}

interface TemplateAuthConfigState {
  auth_type: string
  pre_filled: Record<string, string>
  user_items: TemplateAuthConfigItem[]
  oauth_fields: TemplateOauthField[]
  custom_header_items: TemplateAuthConfigItem[]
  secret_ref: string | null
}

function defaultAuthConfigState(): TemplateAuthConfigState {
  return {
    auth_type: 'none',
    pre_filled: {},
    user_items: [],
    oauth_fields: [],
    custom_header_items: [],
    secret_ref: null,
  }
}

// ============================================================
// Helper components
// ============================================================

function TypeBadge({ mcpType }: { mcpType: string }) {
  const labels: Record<string, string> = { http: 'HTTP', sse: 'SSE', stdio: 'STDIO' }
  return <Badge variant="outline">{labels[mcpType] || mcpType}</Badge>
}

function RiskBadge({ level }: { level: string }) {
  const config: Record<string, { label: string; className: string }> = {
    low: { label: '低', className: 'bg-green-100 text-green-800 border-green-200' },
    medium: { label: '中', className: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
    high: { label: '高', className: 'bg-red-100 text-red-800 border-red-200' },
  }
  const c = config[level] ?? config.low
  return <Badge variant="outline" className={c.className}>{c.label}</Badge>
}

function CategoryBadge({ category }: { category: string | null }) {
  if (!category) return null
  const label = CATEGORY_OPTIONS.find(o => o.value === category)?.label ?? category
  return <Badge variant="secondary">{label}</Badge>
}

function AuthTypeBadge({ authType }: { authType: string }) {
  const label = AUTH_TYPE_OPTIONS.find(o => o.value === authType)?.label ?? authType
  return <Badge variant="outline" className="text-xs">{label}</Badge>
}

function MultiSelectList({ options, selected, onChange, emptyText }: {
  options: { id: string; label: string; sub?: string }[]
  selected: string[]
  onChange: (next: string[]) => void
  emptyText?: string
}) {
  function toggle(id: string) {
    if (selected.includes(id)) onChange(selected.filter(x => x !== id))
    else onChange([...selected, id])
  }
  return (
    <div className="border rounded-md max-h-40 overflow-y-auto divide-y">
      {options.length === 0 && emptyText && (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">{emptyText}</div>
      )}
      {options.map(opt => (
        <label key={opt.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted/50 cursor-pointer text-sm">
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

// ============================================================
// Main page component
// ============================================================

export default function McpTemplatesPage() {
  const [isLoading, setIsLoading] = useState(true)
  const [templates, setTemplates] = useState<McpTemplate[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<McpTemplate | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Wizard state
  const [currentStep, setCurrentStep] = useState(0)
  const [formData, setFormData] = useState<McpTemplateFormData>({})
  const [userConfigItems, setUserConfigItems] = useState<UserConfigItem[]>([])
  const [isUploadingIcon, setIsUploadingIcon] = useState(false)

  // Step 2: Permission scope
  const [selectedDepartments, setSelectedDepartments] = useState<string[]>([])
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [boundAssistants, setBoundAssistants] = useState<string[]>([])
  const [boundSkills, setBoundSkills] = useState<string[]>([])
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([])
  const [users, setUsers] = useState<{ id: string; name: string; email?: string }[]>([])
  const [assistants, setAssistants] = useState<{ id: string; name: string; displayName?: string }[]>([])
  const [skills, setSkills] = useState<{ id: string; name: string; displayName?: string }[]>([])
  const [optionsLoaded, setOptionsLoaded] = useState(false)
  const [isLoadingOptions, setIsLoadingOptions] = useState(false)

  // Step 3: Auth config
  const [authConfigState, setAuthConfigState] = useState<TemplateAuthConfigState>(defaultAuthConfigState())

  // Step 4: Security policy
  const [securityPolicy, setSecurityPolicy] = useState<Record<string, boolean>>(() => {
    const sp: Record<string, boolean> = {}
    SECURITY_POLICY_ITEMS.forEach(item => { sp[item.key] = item.default })
    return sp
  })

  // ============================================================
  // Data loading
  // ============================================================

  const loadTemplates = useCallback(async () => {
    try {
      setIsLoading(true)
      const params: Record<string, string> = {}
      if (categoryFilter !== 'all') params.category = categoryFilter
      if (searchQuery.trim()) params.search = searchQuery.trim()
      const result = await fetchMcpTemplates(params)
      setTemplates(result.items)
    } catch (err) {
      if (err instanceof ApiRequestError) {
        toast.error(`加载模板列表失败: ${err.message}`)
      }
    } finally {
      setIsLoading(false)
    }
  }, [categoryFilter, searchQuery])

  useEffect(() => { loadTemplates() }, [loadTemplates])

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
      setAssistants((asts || []).filter(a => a.id && a.id.trim()))
      setSkills((skls || []).filter(s => s.id && s.id.trim()))
      setOptionsLoaded(true)
    } catch (err) {
      if (err instanceof ApiRequestError) toast.error(`加载选项失败: ${err.message}`)
    } finally {
      setIsLoadingOptions(false)
    }
  }, [optionsLoaded, isLoadingOptions])

  // Load options when dialog opens
  useEffect(() => {
    if (isCreateDialogOpen) loadOptions()
  }, [isCreateDialogOpen, loadOptions])

  // ============================================================
  // Icon upload
  // ============================================================

  async function handleIconUpload(file: File) {
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml']
    const maxSize = 2 * 1024 * 1024
    if (!validTypes.includes(file.type)) { toast.error('仅支持 PNG/JPEG/WebP/SVG 格式'); return }
    if (file.size > maxSize) { toast.error('图片大小不能超过 2MB'); return }
    setIsUploadingIcon(true)
    try {
      const response = await uploadMcpIcon(file)
      if (response.success) {
        setFormData(prev => ({ ...prev, icon: response.data.url }))
        toast.success('图标上传成功')
      } else { toast.error('图标上传失败') }
    } catch { toast.error('图标上传失败') }
    finally { setIsUploadingIcon(false) }
  }

  // ============================================================
  // Create / Edit / Save
  // ============================================================

  function resetWizardState() {
    setCurrentStep(0)
    setFormData({})
    setUserConfigItems([])
    setSelectedDepartments([])
    setSelectedUsers([])
    setBoundAssistants([])
    setBoundSkills([])
    setAuthConfigState(defaultAuthConfigState())
    setSecurityPolicy(() => {
      const sp: Record<string, boolean> = {}
      SECURITY_POLICY_ITEMS.forEach(item => { sp[item.key] = item.default })
      return sp
    })
  }

  function handleCreate() {
    setEditingTemplate(null)
    resetWizardState()
    setFormData({ mcp_type: 'http', scope: 'org' })
    setIsCreateDialogOpen(true)
  }

  function handleEdit(template: McpTemplate) {
    setEditingTemplate(template)
    resetWizardState()

    // Step 0: Basic info
    setFormData({
      name: template.name,
      description: template.description,
      icon: template.icon,
      category: template.category,
      mcp_type: template.mcp_type,
      auth_type: template.auth_type,
      scope: template.scope,
      risk_level: template.risk_level,
      responsible_person: template.responsible_person,
    })

    // Step 1: Connection config
    if (template.config_json) {
      try {
        const parsed = JSON.parse(template.config_json)
        setUserConfigItems(parsed.user_config_items ?? [])
      } catch { setUserConfigItems([]) }
    }

    // Step 2: Permission scope
    if (template.visible_to_json) {
      try {
        const vt = JSON.parse(template.visible_to_json)
        setSelectedDepartments(vt.department_ids ?? [])
        setSelectedUsers(vt.user_ids ?? [])
      } catch { /* ignore */ }
    }
    if (template.bound_assistants_json) {
      try { setBoundAssistants(JSON.parse(template.bound_assistants_json)) } catch { /* ignore */ }
    }
    if (template.bound_skills_json) {
      try { setBoundSkills(JSON.parse(template.bound_skills_json)) } catch { /* ignore */ }
    }

    // Step 3: Auth config
    if (template.auth_config_json) {
      try {
        const ac = JSON.parse(template.auth_config_json)
        setAuthConfigState({
          auth_type: ac.auth_type ?? template.auth_type ?? 'none',
          pre_filled: ac.pre_filled ?? {},
          user_items: ac.user_items ?? [],
          oauth_fields: ac.oauth_fields ?? [
            { label: '授权地址', key: 'authorization_url', default_value: '' },
            { label: 'Token 地址', key: 'token_url', default_value: '' },
          ],
          custom_header_items: ac.custom_header_items ?? [],
          secret_ref: ac.secret_ref ?? null,
        })
      } catch { /* ignore */ }
    } else if (template.auth_type && template.auth_type !== 'none') {
      // Old template with null auth_config_json: initialize defaults based on auth_type
      const defaults = defaultAuthConfigState()
      defaults.auth_type = template.auth_type
      switch (template.auth_type) {
        case 'bearer':
          defaults.pre_filled = { header_name: 'Authorization', prefix: 'Bearer' }
          defaults.user_items = [{ name: '鉴权 Token', key: 'token', description: '服务器访问 Token', required: true }]
          break
        case 'basic':
          defaults.pre_filled = { header_name: 'Authorization' }
          defaults.user_items = [
            { name: '用户名', key: 'username', description: 'Basic 认证用户名', required: true },
            { name: '密码', key: 'password', description: 'Basic 认证密码', required: true },
          ]
          break
        case 'api_key':
          defaults.pre_filled = { header_name: 'X-API-Key' }
          defaults.user_items = [{ name: 'API 密钥', key: 'api_key', description: 'API 访问密钥', required: true }]
          break
        case 'oauth':
          defaults.oauth_fields = [
            { label: '授权地址', key: 'authorization_url', default_value: '' },
            { label: 'Token 地址', key: 'token_url', default_value: '' },
          ]
          defaults.user_items = [
            { name: '客户端 ID', key: 'client_id', description: 'OAuth 客户端标识', required: true },
            { name: '客户端密钥', key: 'client_secret', description: 'OAuth 客户端密钥', required: true },
            { name: '授权范围', key: 'scopes', description: 'OAuth 授权范围', required: false },
          ]
          break
      }
      setAuthConfigState(defaults)
    }

    // Step 4: Security policy
    if (template.security_policy_json) {
      try {
        const sp = JSON.parse(template.security_policy_json)
        setSecurityPolicy(prev => {
          const next = { ...prev }
          for (const [k, v] of Object.entries(sp)) {
            if (typeof v === 'boolean') next[k] = v
          }
          return next
        })
      } catch { /* ignore */ }
    }

    setIsCreateDialogOpen(true)
  }

  async function handleSave() {
    // Validation
    if (!formData.name?.trim()) { toast.error('模板名称不能为空'); setCurrentStep(0); return }
    if (!formData.icon?.trim()) { toast.error('模板图标不能为空'); setCurrentStep(0); return }

    // Validate user config items (Step 1, stdio only)
    const keyRegex = /^[A-Za-z0-9_-]+$/
    for (let i = 0; i < userConfigItems.length; i++) {
      const item = userConfigItems[i]
      if (!item.name?.trim()) { toast.error(`配置项第 ${i + 1} 行：名称不能为空`); setCurrentStep(1); return }
      if (!item.key?.trim()) { toast.error(`配置项第 ${i + 1} 行：Key 不能为空`); setCurrentStep(1); return }
      if (!keyRegex.test(item.key)) { toast.error(`配置项第 ${i + 1} 行：Key 只允许字母、数字、下划线和中划线`); setCurrentStep(1); return }
    }

    // Validate secret_ref (Step 3)
    if (authConfigState.auth_type === 'secret_ref' && !authConfigState.secret_ref) {
      toast.error('请选择凭据引用'); setCurrentStep(3); return
    }

    // Build visible_to_json with null/omit-empty-array semantics
    let visibleToJson: string | null = null
    if (selectedDepartments.length > 0 || selectedUsers.length > 0) {
      const vt: Record<string, string[]> = {}
      if (selectedDepartments.length > 0) vt.department_ids = selectedDepartments
      if (selectedUsers.length > 0) vt.user_ids = selectedUsers
      visibleToJson = JSON.stringify(vt)
    }

    // Build config_json (connection config items, stdio only)
    const configItems = formData.mcp_type === 'stdio' && userConfigItems.length > 0
      ? JSON.stringify({ user_config_items: userConfigItems.map(item => ({ ...item, target: 'env' as const })) })
      : null

    // Build auth_config_json
    let authConfigJson: string | null = null
    if (authConfigState.auth_type !== 'none') {
      const ac: Record<string, unknown> = { auth_type: authConfigState.auth_type }
      if (Object.keys(authConfigState.pre_filled).length > 0) ac.pre_filled = authConfigState.pre_filled
      if (authConfigState.user_items.length > 0) ac.user_items = authConfigState.user_items
      if (authConfigState.oauth_fields.length > 0) ac.oauth_fields = authConfigState.oauth_fields
      if (authConfigState.custom_header_items.length > 0) ac.custom_header_items = authConfigState.custom_header_items
      if (authConfigState.secret_ref) ac.secret_ref = authConfigState.secret_ref
      authConfigJson = JSON.stringify(ac)
    }

    // Build security_policy_json
    const securityPolicyJson = JSON.stringify(securityPolicy)

    const payload = {
      ...formData,
      scope: 'org' as const,
      auth_type: authConfigState.auth_type,  // Dual-write sync: always from authConfigState
      config_json: configItems,
      visible_to_json: visibleToJson,
      bound_assistants_json: boundAssistants.length > 0 ? JSON.stringify(boundAssistants) : null,
      bound_skills_json: boundSkills.length > 0 ? JSON.stringify(boundSkills) : null,
      auth_config_json: authConfigJson,
      security_policy_json: securityPolicyJson,
      // url/command/args_json/env_json: set to null for new template flow
      url: null as string | null,
      command: null as string | null,
      args_json: null as string | null,
      env_json: null as string | null,
    }
    // Preserve old field values when editing (backward compat for existing templates)
    if (editingTemplate) {
      payload.url = formData.url ?? editingTemplate.url
      payload.command = formData.command ?? editingTemplate.command
    }

    setIsSubmitting(true)
    try {
      if (editingTemplate) {
        await updateMcpTemplate(editingTemplate.id, payload)
        toast.success('模板已更新')
      } else {
        await createMcpTemplate(payload)
        toast.success('模板已创建')
      }
      setIsCreateDialogOpen(false)
      loadTemplates()
    } catch (err) {
      toast.error(editingTemplate ? '更新失败' : '创建失败')
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleDelete(template: McpTemplate) {
    if (!confirm(`确定删除模板 "${template.name}"？`)) return
    try {
      await deleteMcpTemplate(template.id)
      toast.success('模板已删除')
      loadTemplates()
    } catch { toast.error('删除失败') }
  }

  const isStdio = formData.mcp_type === 'stdio'

  // ============================================================
  // Render
  // ============================================================

  if (isLoading && templates.length === 0) {
    return (
      <DashboardLayout title="MCP 模板市场" description="浏览和安装预配置的 MCP 模板">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title="MCP 模板市场" description="浏览和安装预配置的 MCP 模板">
      {/* Search & Filter */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input placeholder="搜索模板..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
        </div>
        <div className="flex items-center gap-2">
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-[140px]"><SelectValue placeholder="分类" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部分类</SelectItem>
              {CATEGORY_OPTIONS.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={loadTemplates} disabled={isLoading}>
            {isLoading ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : null}刷新
          </Button>
          <Button size="sm" onClick={handleCreate}><Plus className="size-3.5 mr-1" />新建模板</Button>
        </div>
      </div>

      {/* Template grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {templates.length === 0 ? (
          <div className="col-span-full text-center py-12 text-muted-foreground">没有找到匹配的模板</div>
        ) : (
          templates.map((template) => (
            <Card key={template.id} className="flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg border bg-muted/20 flex items-center justify-center overflow-hidden shrink-0">
                    <img src={template.icon} alt="" className="h-full w-full object-cover" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-base truncate">{template.name}</CardTitle>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <CategoryBadge category={template.category} />
                      <RiskBadge level={template.risk_level} />
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <TypeBadge mcpType={template.mcp_type} />
                    <AuthTypeBadge authType={template.auth_type} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col">
                {template.description && (
                  <p className="text-sm text-muted-foreground mb-1 line-clamp-2">{template.description}</p>
                )}
                {template.responsible_person && (
                  <p className="text-xs text-muted-foreground mb-2">负责人: {template.responsible_person}</p>
                )}
                <div className="flex items-center gap-2 mt-auto pt-3 border-t">
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><Download className="size-3" />{template.downloads}</span>
                  </div>
                  <div className="flex items-center gap-1 ml-auto">
                    <Button variant="ghost" size="icon" className="size-8" onClick={() => handleEdit(template)} title="编辑"><Pencil className="size-3.5" /></Button>
                    <Button variant="ghost" size="icon" className="size-8 text-destructive" onClick={() => handleDelete(template)} title="删除"><Trash2 className="size-3.5" /></Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* ==================== 5-Step Wizard Dialog ==================== */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingTemplate ? '编辑模板' : '新建模板'}</DialogTitle>
          </DialogHeader>

          {/* Step indicator */}
          <div className="flex items-center gap-2 py-2">
            {STEPS.map((step, i) => (
              <div key={step} className="flex items-center gap-2">
                <button
                  type="button"
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
                    {i < currentStep ? <Check className="size-3" /> : i + 1}
                  </span>
                  <span className="hidden sm:inline">{step}</span>
                </button>
                {i < STEPS.length - 1 && <div className="w-4 h-px bg-border" />}
              </div>
            ))}
          </div>

          {/* Step content */}
          <div className="space-y-4 min-h-[200px]">

            {/* Step 0: Basic Info */}
            {currentStep === 0 && (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>名称 <span className="text-destructive">*</span></Label>
                  <Input value={formData.name ?? ''} onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))} placeholder="请输入名称" />
                </div>
                <div className="space-y-1.5">
                  <Label>图标 <span className="text-destructive">*</span></Label>
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg border bg-muted/20 flex items-center justify-center overflow-hidden shrink-0">
                      {formData.icon ? <img src={formData.icon} alt="" className="h-full w-full object-cover" /> : <ImageIcon className="size-4 text-muted-foreground" />}
                    </div>
                    <Button type="button" variant="outline" size="sm" className="relative" disabled={isUploadingIcon}>
                      {isUploadingIcon ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Upload className="mr-2 size-4" />}
                      {isUploadingIcon ? '上传中...' : '上传图标'}
                      <input type="file" accept="image/png,image/jpeg,image/jpg,image/webp,image/svg+xml" className="absolute inset-0 opacity-0 cursor-pointer" onChange={(e) => { const file = e.target.files?.[0]; if (file) void handleIconUpload(file); e.target.value = '' }} />
                    </Button>
                  </div>
                </div>
                <div className="col-span-2 space-y-1.5">
                  <Label>描述</Label>
                  <Input value={formData.description ?? ''} onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))} placeholder="请输入描述" />
                </div>
                <div className="space-y-1.5">
                  <Label>分类</Label>
                  <Select value={formData.category ?? ''} onValueChange={(v) => setFormData(prev => ({ ...prev, category: v }))}>
                    <SelectTrigger><SelectValue placeholder="请选择分类" /></SelectTrigger>
                    <SelectContent>
                      {CATEGORY_OPTIONS.map(opt => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>风险等级</Label>
                  <Select value={formData.risk_level ?? 'low'} onValueChange={(v) => setFormData(prev => ({ ...prev, risk_level: v as 'low' | 'medium' | 'high' }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">低</SelectItem>
                      <SelectItem value="medium">中</SelectItem>
                      <SelectItem value="high">高</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2 space-y-1.5">
                  <Label>负责人</Label>
                  <Input value={formData.responsible_person ?? ''} onChange={(e) => setFormData(prev => ({ ...prev, responsible_person: e.target.value }))} placeholder="请输入负责人" />
                </div>
              </div>
            )}

            {/* Step 1: Connection Config */}
            {currentStep === 1 && (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label>MCP 类型</Label>
                  <Select value={formData.mcp_type ?? 'http'} onValueChange={(v) => setFormData(prev => ({ ...prev, mcp_type: v as 'http' | 'sse' | 'stdio' }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="http">HTTP</SelectItem>
                      <SelectItem value="sse">SSE</SelectItem>
                      <SelectItem value="stdio">STDIO</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {isStdio && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">用户配置项</Label>
                      <Button type="button" variant="outline" size="sm" onClick={() => setUserConfigItems(prev => [...prev, { name: '', target: 'env', key: '', description: '', required: true }])}>
                        <Plus className="size-3 mr-1" />添加
                      </Button>
                    </div>
                    {userConfigItems.length > 0 && (
                      <div className="space-y-2">
                        {userConfigItems.map((item, idx) => (
                          <div key={idx} className="flex items-start gap-2 p-2 border rounded-md">
                            <div className="flex-1 space-y-1">
                              <div className="flex gap-2">
                                <Input className="flex-1" placeholder="名称 *" value={item.name} onChange={(e) => { const next = [...userConfigItems]; next[idx] = { ...next[idx], name: e.target.value }; setUserConfigItems(next) }} />
                                <Input className="flex-1" placeholder="Key *" value={item.key} onChange={(e) => { const next = [...userConfigItems]; next[idx] = { ...next[idx], key: e.target.value }; setUserConfigItems(next) }} />
                              </div>
                              <div className="flex gap-2">
                                <Input className="flex-1" placeholder="说明(可选)" value={item.description ?? ''} onChange={(e) => { const next = [...userConfigItems]; next[idx] = { ...next[idx], description: e.target.value }; setUserConfigItems(next) }} />
                                <label className="flex items-center gap-1 text-xs whitespace-nowrap">
                                  <input type="checkbox" checked={item.required ?? true} onChange={(e) => { const next = [...userConfigItems]; next[idx] = { ...next[idx], required: e.target.checked }; setUserConfigItems(next) }} />必填
                                </label>
                              </div>
                            </div>
                            <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => setUserConfigItems(prev => prev.filter((_, i) => i !== idx))}>
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {!isStdio && (
                  <p className="text-sm text-muted-foreground">HTTP/SSE 类型的连接配置在安装时由用户提供，模板中不需要设置。</p>
                )}
              </div>
            )}

            {/* Step 2: Permission Scope */}
            {currentStep === 2 && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">作用域固定为企业级（org），不选择部门则全企业可见。</p>
                <div className="space-y-2">
                  <Label>可见部门</Label>
                  <MultiSelectList
                    options={departments.map(d => ({ id: d.id, label: d.name }))}
                    selected={selectedDepartments}
                    onChange={setSelectedDepartments}
                    emptyText="暂无部门数据"
                  />
                </div>
                <div className="space-y-2">
                  <Label>可见用户</Label>
                  <MultiSelectList
                    options={users.map(u => ({ id: u.id, label: u.name, sub: u.email }))}
                    selected={selectedUsers}
                    onChange={setSelectedUsers}
                    emptyText="暂无用户数据"
                  />
                </div>
                <div className="space-y-2">
                  <Label>绑定智能体</Label>
                  <MultiSelectList
                    options={assistants.map(a => ({ id: a.id, label: a.displayName || a.name, sub: a.name }))}
                    selected={boundAssistants}
                    onChange={setBoundAssistants}
                    emptyText="暂无智能体数据"
                  />
                </div>
                <div className="space-y-2">
                  <Label>绑定技能</Label>
                  <MultiSelectList
                    options={skills.map(s => ({ id: s.id, label: s.displayName || s.name, sub: s.name }))}
                    selected={boundSkills}
                    onChange={setBoundSkills}
                    emptyText="暂无技能数据"
                  />
                </div>
              </div>
            )}

            {/* Step 3: Auth Config */}
            {currentStep === 3 && (
              <TemplateAuthConfigStep
                isStdio={isStdio}
                state={authConfigState}
                onChange={setAuthConfigState}
                selectedDepartmentIds={selectedDepartments}
              />
            )}

            {/* Step 4: Security Policy */}
            {currentStep === 4 && (
              <div className="space-y-3">
                {SECURITY_POLICY_ITEMS.map(item => (
                  <div key={item.key} className="flex items-center justify-between py-1">
                    <Label>{item.label}</Label>
                    <Switch
                      checked={securityPolicy[item.key] ?? item.default}
                      onCheckedChange={(v) => setSecurityPolicy(prev => ({ ...prev, [item.key]: v }))}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>取消</Button>
            {currentStep > 0 && (
              <Button variant="outline" onClick={() => setCurrentStep(currentStep - 1)}>上一步</Button>
            )}
            {currentStep < 4 ? (
              <Button onClick={() => setCurrentStep(currentStep + 1)}>下一步</Button>
            ) : (
              <Button onClick={handleSave} disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="mr-2 size-4 animate-spin" />}
                {editingTemplate ? '保存' : '创建'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </DashboardLayout>
  )
}

// ============================================================
// Template Auth Config Step Component (Step 3)
// ============================================================

function TemplateAuthConfigStep({
  isStdio,
  state,
  onChange,
  selectedDepartmentIds,
}: {
  isStdio: boolean
  state: TemplateAuthConfigState
  onChange: (s: TemplateAuthConfigState) => void
  selectedDepartmentIds: string[]
}) {
  // Secret ref loading
  const [configItems, setConfigItems] = useState<ConfigItem[]>([])
  const [loadingSecrets, setLoadingSecrets] = useState(false)
  const [secretRefCleared, setSecretRefCleared] = useState(false)

  // Load secret ref config items when auth_type changes to secret_ref or departments change
  useEffect(() => {
    if (state.auth_type !== 'secret_ref') return
    let cancelled = false
    async function load() {
      setLoadingSecrets(true)
      try {
        const res = await getConfigItems({ scope: 'system', status: '1', page_size: 999 })
        let items = res.items

        // Department intersection filter
        if (selectedDepartmentIds.length > 0) {
          const allPolicyItemIds: Set<number>[] = []
          for (const deptId of selectedDepartmentIds) {
            const policy = await getDepartmentPolicies(deptId)
            if (policy?.config_item_ids) {
              allPolicyItemIds.push(new Set(policy.config_item_ids))
            } else {
              allPolicyItemIds.push(new Set())
            }
          }
          // Intersection of all department config_item_ids
          if (allPolicyItemIds.length > 0) {
            let intersection = allPolicyItemIds[0]
            for (let i = 1; i < allPolicyItemIds.length; i++) {
              intersection = new Set([...intersection].filter(id => allPolicyItemIds[i].has(id)))
            }
            items = items.filter(item => intersection.has(item.id))
          }
        }

        if (!cancelled) {
          setConfigItems(items)
          // Clear selection if current secret_ref is no longer available
          if (state.secret_ref && !items.find(i => i.pinyin === state.secret_ref)) {
            onChange({ ...state, secret_ref: null })
            setSecretRefCleared(true)
          }
        }
      } catch {
        if (!cancelled) setConfigItems([])
      } finally {
        if (!cancelled) setLoadingSecrets(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [state.auth_type, selectedDepartmentIds.join(',')])

  function handleAuthTypeChange(authType: string) {
    const newState: TemplateAuthConfigState = {
      auth_type: authType,
      pre_filled: {},
      user_items: [],
      oauth_fields: [],
      custom_header_items: [],
      secret_ref: null,
    }
    // Pre-populate defaults per type
    switch (authType) {
      case 'bearer':
        newState.pre_filled = { header_name: 'Authorization', prefix: 'Bearer' }
        newState.user_items = [{ name: '鉴权 Token', key: 'token', description: '服务器访问 Token', required: true }]
        break
      case 'basic':
        newState.pre_filled = { header_name: 'Authorization' }
        newState.user_items = [
          { name: '用户名', key: 'username', description: 'Basic 认证用户名', required: true },
          { name: '密码', key: 'password', description: 'Basic 认证密码', required: true },
        ]
        break
      case 'api_key':
        newState.pre_filled = { header_name: 'X-API-Key' }
        newState.user_items = [{ name: 'API 密钥', key: 'api_key', description: 'API 访问密钥', required: true }]
        break
      case 'oauth':
        newState.oauth_fields = [
          { label: '授权地址', key: 'authorization_url', default_value: '' },
          { label: 'Token 地址', key: 'token_url', default_value: '' },
        ]
        newState.user_items = [
          { name: '客户端 ID', key: 'client_id', description: 'OAuth 客户端标识', required: true },
          { name: '客户端密钥', key: 'client_secret', description: 'OAuth 客户端密钥', required: true },
          { name: '授权范围', key: 'scopes', description: 'OAuth 授权范围', required: false },
        ]
        break
      case 'custom_header':
        newState.custom_header_items = []
        break
    }
    onChange(newState)
  }

  const RESERVED_OAUTH_KEYS = new Set(['authorization_url', 'token_url'])

  // stdio: greyed out
  if (isStdio) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="cursor-not-allowed opacity-60">
            <Label>鉴权方式</Label>
            <Select value="none" disabled>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {AUTH_TYPE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </TooltipTrigger>
        <TooltipContent>STDIO 通过环境变量鉴权，请在「连接配置」的用户配置项中传入密钥</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>鉴权方式</Label>
        <Select value={state.auth_type} onValueChange={handleAuthTypeChange}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {AUTH_TYPE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* none */}
      {state.auth_type === 'none' && (
        <p className="text-sm text-muted-foreground">无需鉴权配置。</p>
      )}

      {/* bearer */}
      {state.auth_type === 'bearer' && (
        <div className="space-y-4">
          <div className="space-y-3 border rounded-md p-3">
            <Label className="text-sm font-medium">管理员预填</Label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Header 名称 <span className="text-destructive">*</span></Label>
                <Input value={state.pre_filled.header_name ?? ''} onChange={(e) => onChange({ ...state, pre_filled: { ...state.pre_filled, header_name: e.target.value } })} placeholder="请输入 Header 名称" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">前缀</Label>
                <Input value={state.pre_filled.prefix ?? ''} onChange={(e) => onChange({ ...state, pre_filled: { ...state.pre_filled, prefix: e.target.value } })} placeholder="请输入前缀" />
              </div>
            </div>
          </div>
          <AuthUserItemsEditor items={state.user_items} onChange={(items) => onChange({ ...state, user_items: items })} />
        </div>
      )}

      {/* basic */}
      {state.auth_type === 'basic' && (
        <div className="space-y-4">
          <div className="space-y-3 border rounded-md p-3">
            <Label className="text-sm font-medium">管理员预填</Label>
            <div className="space-y-1">
              <Label className="text-xs">Header 名称 <span className="text-destructive">*</span></Label>
              <Input value={state.pre_filled.header_name ?? ''} onChange={(e) => onChange({ ...state, pre_filled: { ...state.pre_filled, header_name: e.target.value } })} placeholder="请输入 Header 名称" />
            </div>
          </div>
          <AuthUserItemsEditor items={state.user_items} onChange={(items) => onChange({ ...state, user_items: items })} />
        </div>
      )}

      {/* api_key */}
      {state.auth_type === 'api_key' && (
        <div className="space-y-4">
          <div className="space-y-3 border rounded-md p-3">
            <Label className="text-sm font-medium">管理员预填</Label>
            <div className="space-y-1">
              <Label className="text-xs">Header 名称 <span className="text-destructive">*</span></Label>
              <Input value={state.pre_filled.header_name ?? ''} onChange={(e) => onChange({ ...state, pre_filled: { ...state.pre_filled, header_name: e.target.value } })} placeholder="请输入 Header 名称" />
            </div>
          </div>
          <AuthUserItemsEditor items={state.user_items} onChange={(items) => onChange({ ...state, user_items: items })} />
        </div>
      )}

      {/* oauth */}
      {state.auth_type === 'oauth' && (
        <div className="space-y-4">
          <div className="space-y-3 border rounded-md p-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">OAuth 字段配置</Label>
              <Button type="button" variant="outline" size="sm" onClick={() => {
                onChange({
                  ...state,
                  oauth_fields: [...state.oauth_fields, { label: '', key: '', default_value: '' }],
                })
              }}><Plus className="size-3 mr-1" />添加字段</Button>
            </div>
            {state.oauth_fields.map((field, idx) => {
              const isReserved = RESERVED_OAUTH_KEYS.has(field.key)
              return (
                <div key={idx} className="flex items-start gap-2 p-2 border rounded-md bg-muted/20">
                  <div className="flex-1 space-y-1">
                    <div className="flex gap-2">
                      <Input className="flex-1" placeholder="字段标签" value={field.label} onChange={(e) => {
                        const next = [...state.oauth_fields]; next[idx] = { ...next[idx], label: e.target.value }
                        onChange({ ...state, oauth_fields: next })
                      }} />
                      <Input className="flex-1" placeholder="Key" value={field.key} disabled={isReserved} onChange={(e) => {
                        const next = [...state.oauth_fields]; next[idx] = { ...next[idx], key: e.target.value }
                        onChange({ ...state, oauth_fields: next })
                      }} />
                      <Input className="flex-1" placeholder="默认值" value={field.default_value} onChange={(e) => {
                        const next = [...state.oauth_fields]; next[idx] = { ...next[idx], default_value: e.target.value }
                        onChange({ ...state, oauth_fields: next })
                      }} />
                    </div>
                    {isReserved && <p className="text-xs text-muted-foreground">保留 Key，不可修改</p>}
                  </div>
                  {!isReserved && (
                    <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => {
                      onChange({ ...state, oauth_fields: state.oauth_fields.filter((_, i) => i !== idx) })
                    }}><Trash2 className="size-3.5" /></Button>
                  )}
                </div>
              )
            })}
          </div>
          <AuthUserItemsEditor items={state.user_items} onChange={(items) => onChange({ ...state, user_items: items })} />
        </div>
      )}

      {/* custom_header */}
      {state.auth_type === 'custom_header' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">用户配置项</Label>
            <Button type="button" variant="outline" size="sm" onClick={() => {
              onChange({ ...state, custom_header_items: [...state.custom_header_items, { name: '', key: '', description: '', required: true }] })
            }}><Plus className="size-3 mr-1" />添加</Button>
          </div>
          {state.custom_header_items.map((item, idx) => (
            <div key={idx} className="flex items-start gap-2 p-2 border rounded-md">
              <div className="flex-1 space-y-1">
                <div className="flex gap-2">
                  <Input className="flex-1" placeholder="名称 *" value={item.name} onChange={(e) => {
                    const next = [...state.custom_header_items]; next[idx] = { ...next[idx], name: e.target.value }
                    onChange({ ...state, custom_header_items: next })
                  }} />
                  <Input className="flex-1" placeholder="Key *" value={item.key} onChange={(e) => {
                    const next = [...state.custom_header_items]; next[idx] = { ...next[idx], key: e.target.value }
                    onChange({ ...state, custom_header_items: next })
                  }} />
                </div>
                <div className="flex gap-2">
                  <Input className="flex-1" placeholder="说明(可选)" value={item.description} onChange={(e) => {
                    const next = [...state.custom_header_items]; next[idx] = { ...next[idx], description: e.target.value }
                    onChange({ ...state, custom_header_items: next })
                  }} />
                  <label className="flex items-center gap-1 text-xs whitespace-nowrap">
                    <input type="checkbox" checked={item.required} onChange={(e) => {
                      const next = [...state.custom_header_items]; next[idx] = { ...next[idx], required: e.target.checked }
                      onChange({ ...state, custom_header_items: next })
                    }} />必填
                  </label>
                </div>
              </div>
              <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => {
                onChange({ ...state, custom_header_items: state.custom_header_items.filter((_, i) => i !== idx) })
              }}><Trash2 className="size-3.5" /></Button>
            </div>
          ))}
          {state.custom_header_items.length === 0 && (
            <p className="text-sm text-muted-foreground">点击「添加」创建用户配置项。</p>
          )}
        </div>
      )}

      {/* secret_ref */}
      {state.auth_type === 'secret_ref' && (
        <div className="space-y-2">
          <Label>凭据引用 <span className="text-destructive">*</span></Label>
          {loadingSecrets ? (
            <p className="text-sm text-muted-foreground">加载凭据列表…</p>
          ) : configItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无可用凭据</p>
          ) : (
            <Select value={state.secret_ref ?? ''} onValueChange={(v) => { onChange({ ...state, secret_ref: v || null }); setSecretRefCleared(false) }
            }>
              <SelectTrigger><SelectValue placeholder="选择凭据" /></SelectTrigger>
              <SelectContent>
                {configItems.map(item => (
                  <SelectItem key={item.pinyin} value={item.pinyin}>{item.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {selectedDepartmentIds.length > 0 && (
            <p className="text-xs text-muted-foreground">已选择 {selectedDepartmentIds.length} 个部门，仅显示所有选中部门共有的凭据。</p>
          )}
          {secretRefCleared && !state.secret_ref && (
            <p className="text-xs text-yellow-600">凭据引用已因权限范围变更而失效，请重新选择</p>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================================
// Auth User Items Editor (shared sub-component for bearer/basic/api_key/oauth)
// ============================================================

function AuthUserItemsEditor({
  items,
  onChange,
}: {
  items: TemplateAuthConfigItem[]
  onChange: (items: TemplateAuthConfigItem[]) => void
}) {
  return (
    <div className="space-y-2 border rounded-md p-3">
      <Label className="text-sm font-medium">用户配置项（安装时由用户填写）</Label>
      {items.map((item, idx) => (
        <div key={idx} className="flex items-center gap-2 p-2 border rounded-md bg-muted/20">
          <div className="flex-1 flex items-center gap-2">
            <Input className="flex-1 text-sm" placeholder="名称" value={item.name} onChange={(e) => {
              const next = [...items]; next[idx] = { ...next[idx], name: e.target.value }; onChange(next)
            }} />
            <Input className="w-24 text-sm font-mono" value={item.key} disabled title="Key 不可编辑" />
            <Input className="flex-1 text-sm" placeholder="说明" value={item.description} onChange={(e) => {
              const next = [...items]; next[idx] = { ...next[idx], description: e.target.value }; onChange(next)
            }} />
            <label className="flex items-center gap-1 text-xs whitespace-nowrap">
              <input type="checkbox" checked={item.required} onChange={(e) => {
                const next = [...items]; next[idx] = { ...next[idx], required: e.target.checked }; onChange(next)
              }} />必填
            </label>
          </div>
        </div>
      ))}
    </div>
  )
}
