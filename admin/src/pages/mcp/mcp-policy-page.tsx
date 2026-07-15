'use client'

import { useState, useEffect, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { DashboardLayout } from '@/components/dashboard-layout'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Shield, Settings2, X } from 'lucide-react'
import { fetchMcpPolicy, updateMcpPolicy, subscribeMcpEvents } from '@/lib/api/mcp'
import type { McpPolicy } from '@/lib/api/mcp'
import { ApiRequestError } from '@/lib/api/client'

interface PolicyState {
  allow_personal_mcp: boolean
  allow_stdio_mcp: boolean
  allow_http_sse_mcp: boolean
  allow_local_file_access: boolean
  allow_external_network: boolean
  domain_whitelist: string[]
  require_approval: boolean
  allow_auto_task_call_personal_mcp: boolean
  allow_enterprise_assistant_call_personal_mcp: boolean
  allow_enterprise_context_in_personal_mcp: boolean
  require_confirmation_for_high_risk: boolean
  require_confirmation_for_write: boolean
  audit_request_params: boolean
  audit_response_summary: boolean
  redact_audit_logs: boolean
  limit_concurrency_and_rate: boolean
  restrict_callable_models: boolean
}

const defaultPolicy: PolicyState = {
  allow_personal_mcp: false,
  allow_stdio_mcp: false,
  allow_http_sse_mcp: false,
  allow_local_file_access: false,
  allow_external_network: false,
  domain_whitelist: [],
  require_approval: false,
  allow_auto_task_call_personal_mcp: false,
  allow_enterprise_assistant_call_personal_mcp: false,
  allow_enterprise_context_in_personal_mcp: false,
  require_confirmation_for_high_risk: true,
  require_confirmation_for_write: true,
  audit_request_params: false,
  audit_response_summary: false,
  redact_audit_logs: false,
  limit_concurrency_and_rate: false,
  restrict_callable_models: false,
}

function SettingField({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)] md:items-start md:gap-6">
      <div className="space-y-1">
        <Label className="text-sm font-medium">{label}</Label>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex min-h-10 items-center">{children}</div>
    </div>
  )
}

export default function McpPolicyPage() {
  const [isLoading, setIsLoading] = useState(true)
  const [policy, setPolicy] = useState<PolicyState>(defaultPolicy)
  const [isSaving, setIsSaving] = useState(false)
  const [newDomain, setNewDomain] = useState('')

  const loadPolicy = useCallback(async () => {
    try {
      setIsLoading(true)
      const data = await fetchMcpPolicy()
      setPolicy({
        ...defaultPolicy,
        ...data,
        domain_whitelist: Array.isArray(data.domain_whitelist_json) ? data.domain_whitelist_json : [],
      })
    } catch (err) {
      if (err instanceof ApiRequestError) {
        toast.error(`加载策略失败: ${err.message}`)
      }
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPolicy()
  }, [loadPolicy])

  // Plan §2.5: subscribe to live policy events and re-fetch on change.
  useEffect(() => {
    const unsubscribe = subscribeMcpEvents({
      onPolicyChanged: () => { loadPolicy() },
    })
    return () => { unsubscribe() }
  }, [loadPolicy])

  if (isLoading) {
    return (
      <DashboardLayout title="MCP 策略配置" description="配置企业级 MCP 策略和个人 MCP 使用规则">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  function toggle(key: keyof PolicyState) {
    setPolicy((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  function addDomain() {
    const domain = newDomain.trim()
    if (!domain) return
    if (policy.domain_whitelist.includes(domain)) {
      toast.error('域名已存在')
      return
    }
    setPolicy((prev) => ({ ...prev, domain_whitelist: [...prev.domain_whitelist, domain] }))
    setNewDomain('')
  }

  function removeDomain(domain: string) {
    setPolicy((prev) => ({ ...prev, domain_whitelist: prev.domain_whitelist.filter((d) => d !== domain) }))
  }

  async function handleSave() {
    setIsSaving(true)
    try {
      const { domain_whitelist, ...rest } = policy
      const payload: Partial<McpPolicy> = {
        ...rest,
        domain_whitelist_json: domain_whitelist,
      }
      await updateMcpPolicy(payload)
      toast.success('策略已保存')
      await loadPolicy()
    } catch (err) {
      if (err instanceof ApiRequestError) {
        toast.error(err.message)
      }
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <DashboardLayout title="MCP 策略配置" description="配置企业级 MCP 策略和个人 MCP 使用规则">
      <div className="space-y-6 max-w-3xl">
        {/* Card 1: 个人 MCP 策略 */}
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <Shield className="size-4 text-muted-foreground" />
              <span>个人 MCP 策略</span>
            </CardTitle>
            <CardDescription>控制用户是否可以创建和管理个人 MCP 服务</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 pt-6">
            <SettingField label="允许用户创建个人 MCP" description="开启后，用户可在客户端创建个人 MCP 服务">
              <Switch checked={policy.allow_personal_mcp} onCheckedChange={() => toggle('allow_personal_mcp')} />
            </SettingField>
            <SettingField label="允许本地 STDIO MCP" description="允许用户配置本地 STDIO 类型的 MCP">
              <Switch checked={policy.allow_stdio_mcp} onCheckedChange={() => toggle('allow_stdio_mcp')} />
            </SettingField>
            <SettingField label="允许远程 HTTP/SSE MCP" description="允许用户配置远程 HTTP 或 SSE 类型的 MCP">
              <Switch checked={policy.allow_http_sse_mcp} onCheckedChange={() => toggle('allow_http_sse_mcp')} />
            </SettingField>
            <SettingField label="允许访问本地文件" description="允许个人 MCP 访问用户本地文件系统">
              <Switch checked={policy.allow_local_file_access} onCheckedChange={() => toggle('allow_local_file_access')} />
            </SettingField>
            <SettingField label="允许访问外网域名" description="允许个人 MCP 访问外部网络域名">
              <Switch checked={policy.allow_external_network} onCheckedChange={() => toggle('allow_external_network')} />
            </SettingField>
            <SettingField label="外网域名白名单" description="当允许访问外网时，限制可访问的域名列表">
              <div className="space-y-2 w-full">
                <div className="flex gap-2">
                  <Input
                    placeholder="example.com"
                    value={newDomain}
                    onChange={(e) => setNewDomain(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addDomain()}
                  />
                  <Button variant="outline" size="sm" onClick={addDomain}>添加</Button>
                </div>
                {policy.domain_whitelist.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {policy.domain_whitelist.map((domain) => (
                      <span key={domain} className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-xs">
                        {domain}
                        <button onClick={() => removeDomain(domain)} className="text-muted-foreground hover:text-foreground">
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </SettingField>
            <SettingField label="需要管理员审批" description="用户创建的个人 MCP 需要管理员审批后才能使用">
              <Switch checked={policy.require_approval} onCheckedChange={() => toggle('require_approval')} />
            </SettingField>
            <SettingField label="允许自动任务调用个人 MCP" description="允许自动任务（如定时任务）调用用户的个人 MCP">
              <Switch checked={policy.allow_auto_task_call_personal_mcp} onCheckedChange={() => toggle('allow_auto_task_call_personal_mcp')} />
            </SettingField>
            <SettingField label="允许企业智能体调用个人 MCP" description="允许企业级智能体调用用户的个人 MCP">
              <Switch checked={policy.allow_enterprise_assistant_call_personal_mcp} onCheckedChange={() => toggle('allow_enterprise_assistant_call_personal_mcp')} />
            </SettingField>
            <SettingField label="允许携带企业上下文调用" description="允许在调用个人 MCP 时携带企业上下文信息">
              <Switch checked={policy.allow_enterprise_context_in_personal_mcp} onCheckedChange={() => toggle('allow_enterprise_context_in_personal_mcp')} />
            </SettingField>
          </CardContent>
        </Card>

        {/* Card 2: 调用安全策略 */}
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <Settings2 className="size-4 text-muted-foreground" />
              <span>调用安全策略</span>
            </CardTitle>
            <CardDescription>控制所有 MCP 工具调用的安全策略</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 pt-6">
            <SettingField label="高风险工具需用户确认" description="高风险级别的工具调用前需要用户确认">
              <Switch checked={policy.require_confirmation_for_high_risk} onCheckedChange={() => toggle('require_confirmation_for_high_risk')} />
            </SettingField>
            <SettingField label="写操作需二次确认" description="执行写操作的 MCP 工具需要二次确认">
              <Switch checked={policy.require_confirmation_for_write} onCheckedChange={() => toggle('require_confirmation_for_write')} />
            </SettingField>
            <SettingField label="记录调用参数" description="记录 MCP 工具调用的请求参数">
              <Switch checked={policy.audit_request_params} onCheckedChange={() => toggle('audit_request_params')} />
            </SettingField>
            <SettingField label="记录响应摘要" description="记录 MCP 工具调用的响应摘要">
              <Switch checked={policy.audit_response_summary} onCheckedChange={() => toggle('audit_response_summary')} />
            </SettingField>
            <SettingField label="脱敏日志" description="对审计日志中的敏感信息进行脱敏处理">
              <Switch checked={policy.redact_audit_logs} onCheckedChange={() => toggle('redact_audit_logs')} />
            </SettingField>
            <SettingField label="限制并发和频率" description="限制 MCP 工具调用的并发数和调用频率">
              <Switch checked={policy.limit_concurrency_and_rate} onCheckedChange={() => toggle('limit_concurrency_and_rate')} />
            </SettingField>
            <SettingField label="限制可调用模型/智能体" description="限制哪些模型和智能体可以调用 MCP 工具">
              <Switch checked={policy.restrict_callable_models} onCheckedChange={() => toggle('restrict_callable_models')} />
            </SettingField>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="mr-2 size-4 animate-spin" />}
            保存策略
          </Button>
        </div>
      </div>
    </DashboardLayout>
  )
}
