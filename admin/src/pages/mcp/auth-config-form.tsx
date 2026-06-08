/**
 * MCP 鉴权配置表单组件
 *
 * 从 mcp-servers-page.tsx 中抽出，实现：
 * 1. 按 auth_type 渲染差异化表单（bearer/basic/api_key/custom_header/secret_ref）
 * 2. header 名和前缀有默认值但可修改（不写死）
 * 3. Secret Center 下拉框（企业级/部门级联动）
 * 4. 旧 flat KV 格式的脏检测（未修改时透传原始值）
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Plus, X } from 'lucide-react'
import { getConfigItems, getDepartmentPolicies } from '@/lib/api/secrets'
import type { ConfigItem } from '@/lib/api/secrets'

// ============================================================
// 常量
// ============================================================

const AUTH_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'none', label: '无鉴权' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'basic', label: 'Basic Auth' },
  { value: 'api_key', label: 'API Key' },
  { value: 'oauth', label: 'OAuth' },
  { value: 'custom_header', label: '自定义 Header' },
  { value: 'secret_ref', label: 'Secret Center 引用' },
]

const DEFAULTS: Record<string, Record<string, string>> = {
  bearer: { header_name: 'Authorization', prefix: 'Bearer', token: '' },
  basic: { header_name: 'Authorization', username: '', password: '' },
  api_key: { header_name: 'X-API-Key', api_key: '' },
  oauth: {},
  custom_header: {},
  none: {},
  secret_ref: {},
}

// ============================================================
// Props
// ============================================================

export interface AuthConfigFormProps {
  authType?: string
  authConfigJson: string | null
  secretRef: string | null
  scope?: string
  departmentId?: string
  isStdio?: boolean
  onChange: (authType: string, authConfigJson: string | null, secretRef: string | null) => void
}

// ============================================================
// 旧格式检测
// ============================================================

function parseAuthConfig(authType: string, authConfigJson: string | null): {
  config: Record<string, string>
  isLegacy: boolean
} {
  if (!authConfigJson) return { config: { ...(DEFAULTS[authType] ?? {}) }, isLegacy: false }
  try {
    const parsed = JSON.parse(authConfigJson)
    if (typeof parsed !== 'object' || !parsed || Array.isArray(parsed)) {
      return { config: { ...(DEFAULTS[authType] ?? {}) }, isLegacy: true }
    }
    // bearer/basic/api_key 新格式必须有 header_name
    if (['bearer', 'basic', 'api_key'].includes(authType) && !('header_name' in parsed)) {
      return { config: { ...(DEFAULTS[authType] ?? {}) }, isLegacy: true }
    }
    return { config: parsed as Record<string, string>, isLegacy: false }
  } catch {
    return { config: { ...(DEFAULTS[authType] ?? {}) }, isLegacy: true }
  }
}

/** 兼容旧格式 system:xxx 和新格式纯 pinyin */
function normalizeSecretRef(secretRef: string | null): string | null {
  if (!secretRef) return null
  return secretRef.includes(':') ? secretRef.split(':').slice(-1)[0] : secretRef
}

// ============================================================
// KVEditor（从 mcp-servers-page.tsx 内联，用于 custom_header）
// ============================================================

function KVEditor({ value, onChange }: { value: Record<string, string>; onChange: (next: Record<string, string>) => void }) {
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
        <Plus className="size-3.5 mr-1" />添加
      </Button>
    </div>
  )
}

// ============================================================
// 子表单组件
// ============================================================

function BearerForm({ config, onFieldChange }: { config: Record<string, string>; onFieldChange: (field: string, value: string) => void }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>Header 名称 <span className="text-red-500">*</span></Label>
        <Input placeholder="Authorization" value={config.header_name ?? ''} onChange={(e) => onFieldChange('header_name', e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>前缀</Label>
        <Input placeholder="Bearer" value={config.prefix ?? ''} onChange={(e) => onFieldChange('prefix', e.target.value)} />
        <p className="text-xs text-muted-foreground">可为空。常见值：Bearer、Token</p>
      </div>
      <div className="space-y-1.5">
        <Label>Token <span className="text-red-500">*</span></Label>
        <Input type="password" placeholder="输入 Token" value={config.token ?? ''} onChange={(e) => onFieldChange('token', e.target.value)} />
      </div>
    </div>
  )
}

function BasicForm({ config, onFieldChange }: { config: Record<string, string>; onFieldChange: (field: string, value: string) => void }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>Header 名称 <span className="text-red-500">*</span></Label>
        <Input placeholder="Authorization" value={config.header_name ?? ''} onChange={(e) => onFieldChange('header_name', e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>用户名 <span className="text-red-500">*</span></Label>
        <Input placeholder="用户名" value={config.username ?? ''} onChange={(e) => onFieldChange('username', e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>密码 <span className="text-red-500">*</span></Label>
        <Input type="password" placeholder="密码" value={config.password ?? ''} onChange={(e) => onFieldChange('password', e.target.value)} />
      </div>
    </div>
  )
}

function ApiKeyForm({ config, onFieldChange }: { config: Record<string, string>; onFieldChange: (field: string, value: string) => void }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>Header 名称 <span className="text-red-500">*</span></Label>
        <Input placeholder="X-API-Key" value={config.header_name ?? ''} onChange={(e) => onFieldChange('header_name', e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>API Key <span className="text-red-500">*</span></Label>
        <Input type="password" placeholder="输入 API Key" value={config.api_key ?? ''} onChange={(e) => onFieldChange('api_key', e.target.value)} />
      </div>
    </div>
  )
}

function SecretRefSelect({
  scope,
  departmentId,
  selectedPinyin,
  onChange,
}: {
  scope?: string
  departmentId?: string
  selectedPinyin: string | null
  onChange: (pinyin: string | null) => void
}) {
  const [configItems, setConfigItems] = useState<ConfigItem[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        // 获取企业 + 部门 ConfigItem
        const [systemRes, deptRes] = await Promise.all([
          getConfigItems({ scope: 'system', status: '1', page_size: 999 }),
          getConfigItems({ scope: 'department', status: '1', page_size: 999 }),
        ])
        let items = [...systemRes.items, ...deptRes.items]

        // 部门级：按部门策略过滤
        if (scope === 'department' && departmentId) {
          const policies = await getDepartmentPolicies(departmentId)
          if (policies?.config_item_ids) {
            const authorizedIds = new Set(policies.config_item_ids)
            items = items.filter((item) => item.scope === 'system' || authorizedIds.has(item.id))
          } else {
            items = items.filter((item) => item.scope === 'system')
          }
        }

        if (!cancelled) setConfigItems(items)
      } catch {
        if (!cancelled) setConfigItems([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [scope, departmentId])

  if (scope === 'department' && !departmentId) {
    return <p className="text-sm text-muted-foreground">请先在「权限范围」中选择所属部门</p>
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">加载凭据列表…</p>
  }

  return (
    <Select value={selectedPinyin ?? ''} onValueChange={(v) => onChange(v || null)}>
      <SelectTrigger>
        <SelectValue placeholder="选择凭据" />
      </SelectTrigger>
      <SelectContent>
        {configItems.length === 0 && (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">暂无可用凭据</div>
        )}
        {configItems.map((item) => (
          <SelectItem key={item.pinyin} value={item.pinyin}>
            {item.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ============================================================
// 主组件
// ============================================================

export function AuthConfigForm({
  authType: authTypeProp,
  authConfigJson,
  secretRef: secretRefProp,
  scope,
  departmentId,
  isStdio,
  onChange,
}: AuthConfigFormProps) {
  const [authType, setAuthType] = useState(authTypeProp ?? 'none')
  const [secretRef, setSecretRef] = useState<string | null>(secretRefProp ?? null)

  // 解析初始 auth_config_json
  const initialParse = useMemo(() => parseAuthConfig(authTypeProp ?? 'none', authConfigJson), [authTypeProp, authConfigJson])
  const [authConfig, setAuthConfig] = useState<Record<string, string>>(initialParse.config)
  const [isLegacy, setIsLegacy] = useState(initialParse.isLegacy)
  const [isDirty, setIsDirty] = useState(false)
  const originalJsonRef = useRef<string | null>(authConfigJson)

  // 用 ref 保存最新的 state 和 onChange，避免闭包陷阱
  const stateRef = useRef({ authType: authTypeProp ?? 'none', authConfig: initialParse.config, isLegacy: initialParse.isLegacy, isDirty: false, secretRef: secretRefProp ?? null })
  stateRef.current = { authType, authConfig, isLegacy, isDirty, secretRef }
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // 当 auth_type prop 改变时重置内部状态
  const prevAuthTypeProp = useRef(authTypeProp)
  useEffect(() => {
    if (authTypeProp !== prevAuthTypeProp.current) {
      prevAuthTypeProp.current = authTypeProp
      const newType = authTypeProp ?? 'none'
      const defaults = DEFAULTS[newType] ?? {}
      setAuthType(newType)
      setAuthConfig({ ...defaults })
      setIsLegacy(false)
      setIsDirty(false)
      originalJsonRef.current = null
    }
  }, [authTypeProp])

  // 当外部 authConfigJson 改变时重新解析（编辑模式初始化）
  const prevAuthConfigJson = useRef(authConfigJson)
  useEffect(() => {
    if (authConfigJson !== prevAuthConfigJson.current) {
      prevAuthConfigJson.current = authConfigJson
      const parse = parseAuthConfig(authType, authConfigJson)
      setAuthConfig(parse.config)
      setIsLegacy(parse.isLegacy)
      setIsDirty(false)
      originalJsonRef.current = authConfigJson
    }
  }, [authType, authConfigJson])

  // 当外部 secretRef 改变时
  useEffect(() => {
    setSecretRef(secretRefProp ?? null)
  }, [secretRefProp])

  // 计算当前输出并通知父组件（仅在用户操作时调用，不在 useEffect 中自动调用）
  function emitChange(newState: {
    authType?: string
    authConfig?: Record<string, string>
    isLegacy?: boolean
    isDirty?: boolean
    secretRef?: string | null
  }) {
    const s = { ...stateRef.current, ...newState }
    let outputJson: string | null = null
    if (s.authType !== 'none' && s.authType !== 'secret_ref') {
      if (s.isLegacy && !s.isDirty) {
        outputJson = originalJsonRef.current
      } else {
        const cleaned: Record<string, string> = {}
        for (const [k, v] of Object.entries(s.authConfig)) {
          if (k.trim() && v !== undefined) cleaned[k.trim()] = v
        }
        outputJson = Object.keys(cleaned).length > 0 ? JSON.stringify(cleaned) : null
      }
    }
    onChangeRef.current(s.authType, outputJson, s.authType === 'secret_ref' ? (newState.secretRef ?? s.secretRef) : null)
  }

  function handleAuthTypeChange(newType: string) {
    const defaults = DEFAULTS[newType] ?? {}
    setAuthType(newType)
    setAuthConfig({ ...defaults })
    setIsLegacy(false)
    setIsDirty(false)
    originalJsonRef.current = null
    if (newType !== 'secret_ref') {
      setSecretRef(null)
    }
    emitChange({ authType: newType, authConfig: { ...defaults }, isLegacy: false, isDirty: false, secretRef: newType === 'secret_ref' ? secretRef : null })
  }

  function handleFieldChange(field: string, value: string) {
    const newConfig = { ...stateRef.current.authConfig, [field]: value }
    setAuthConfig(newConfig)
    setIsDirty(true)
    emitChange({ authConfig: newConfig, isDirty: true })
  }

  function handleSecretRefChange(pinyin: string | null) {
    setSecretRef(pinyin)
    setIsDirty(true)
    emitChange({ secretRef: pinyin, isDirty: true })
  }

  function handleCustomHeaderChange(next: Record<string, string>) {
    setAuthConfig(next)
    setIsDirty(true)
    emitChange({ authConfig: next, isDirty: true })
  }

  const normalizedSecretRef = useMemo(() => normalizeSecretRef(secretRef), [secretRef])

  // 渲染
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>鉴权方式</Label>
        {isStdio ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="cursor-not-allowed">
                <Select value={authType} disabled>
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
          <Select value={authType} onValueChange={handleAuthTypeChange}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {AUTH_TYPE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {!isStdio && authType === 'secret_ref' && (
        <div className="space-y-2">
          <Label>Secret Center 凭据引用</Label>
          <SecretRefSelect
            scope={scope}
            departmentId={departmentId}
            selectedPinyin={normalizedSecretRef}
            onChange={handleSecretRefChange}
          />
        </div>
      )}

      {!isStdio && authType === 'bearer' && (
        <BearerForm config={authConfig} onFieldChange={handleFieldChange} />
      )}

      {!isStdio && authType === 'basic' && (
        <BasicForm config={authConfig} onFieldChange={handleFieldChange} />
      )}

      {!isStdio && authType === 'api_key' && (
        <ApiKeyForm config={authConfig} onFieldChange={handleFieldChange} />
      )}

      {!isStdio && authType === 'custom_header' && (
        <div className="space-y-2">
          <Label>自定义 Headers</Label>
          <KVEditor value={authConfig} onChange={handleCustomHeaderChange} />
          <p className="text-xs text-muted-foreground">Key-Value 形式，例如 X-Custom-Header = value</p>
        </div>
      )}

      {!isStdio && authType === 'oauth' && (
        <div className="space-y-2">
          <Label>OAuth 配置</Label>
          <KVEditor value={authConfig} onChange={handleCustomHeaderChange} />
          <p className="text-xs text-muted-foreground">Key-Value 形式填写 OAuth 参数。OAuth token 获取流程后续支持。</p>
        </div>
      )}

      {isLegacy && !isDirty && (
        <div className="rounded-md bg-yellow-50 border border-yellow-200 p-3 text-sm text-yellow-800">
          当前鉴权配置使用旧格式，建议重新配置。
        </div>
      )}

      <div className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
        {authType === 'secret_ref'
          ? '从 Secret Center 选择凭据，运行时自动解析并注入。'
          : 'MCP 配置不直接保存明文密钥，只保存 Secret 引用。'}
      </div>
    </div>
  )
}
