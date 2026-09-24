'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { DashboardLayout } from '@/components/dashboard-layout'
import { ConfigScopeSelect } from '@/components/settings/config-scope-select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { operationsApi } from '@/lib/api/operations'
import type { ConfigScope } from '@/lib/api/types'
import { useAuth } from '@/lib/hooks/use-auth'
import { useSettingsNavigationGuard } from '@/lib/hooks/use-settings-navigation-guard'
import { buildSudoworkConfigPatch, SUDOWORK_LOGIN_METHODS } from '../sudowork-settings'

type Config = Record<string, unknown>
type JsonObject = Record<string, unknown>

export default function SudoworkSettingsPage() {
  const { user, activeOrgId } = useAuth()
  const [selectedScope, setScope] = useState<ConfigScope>('organization')
  const allowPlatform = user?.role === 'super_admin'
  const scope = allowPlatform ? selectedScope : 'organization'
  return <ScopedSudoworkSettings key={`${activeOrgId}:${scope}`} scope={scope} organizationId={activeOrgId} allowPlatform={allowPlatform} onScopeChange={setScope} />
}

function ScopedSudoworkSettings({ scope, organizationId, allowPlatform, onScopeChange }: {
  scope: ConfigScope
  organizationId: string | null
  allowPlatform: boolean
  onScopeChange(scope: ConfigScope): void
}) {
  const [config, setConfig] = useState<Config | null>(null)
  const [baseline, setBaseline] = useState<Config | null>(null)
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const loadVersion = useRef(0)
  const saveInFlight = useRef(false)
  const discard = useCallback(() => {
    setConfig(baseline)
    setDirtyKeys(new Set())
  }, [baseline])
  const confirmDiscard = useSettingsNavigationGuard(dirtyKeys.size > 0, saving, discard)

  async function changeScope(next: ConfigScope) {
    if (next === scope || saveInFlight.current || !(await confirmDiscard())) return
    onScopeChange(next)
  }

  const readConfig = useCallback(async () => {
    const response = await operationsApi.getSudoworkSystemConfig(scope)
    if (!response.success || !response.data) throw new Error(response.msg || '获取 Sudowork 策略失败')
    if (response.data.scope_type !== scope || (scope === 'organization' && organizationId && response.data.organization_id !== organizationId)) {
      throw new Error('服务器返回的配置范围不匹配，请重新加载。')
    }
    return response.data
  }, [scope, organizationId])

  const load = useCallback(async () => {
    const version = ++loadVersion.current
    setLoading(true)
    setLoadError('')
    setConfig(null)
    setBaseline(null)
    setDirtyKeys(new Set())
    try {
      const data = await readConfig()
      if (version !== loadVersion.current) return
      setConfig(data)
      setBaseline(data)
    }
    catch (error) { if (version === loadVersion.current) setLoadError(error instanceof Error ? error.message : '获取 Sudowork 策略失败') }
    finally { if (version === loadVersion.current) setLoading(false) }
  }, [readConfig])

  useEffect(() => {
    void load()
    return () => { loadVersion.current += 1 }
  }, [load])

  const patch = (value: Config) => {
    setDirtyKeys(current => {
      const next = new Set(current)
      for (const key of Object.keys(value)) {
        if (JSON.stringify(value[key]) === JSON.stringify(baseline?.[key])) next.delete(key)
        else next.add(key)
      }
      return next
    })
    setConfig(current => ({ ...(current ?? {}), ...value }))
  }
  const nested = (key: string, value: JsonObject) => patch({ [key]: { ...object(config?.[key]), ...value } })

  const save = async () => {
    if (!config || !dirtyKeys.size || saveInFlight.current) return
    saveInFlight.current = true
    setSaving(true)
    const version = loadVersion.current
    try {
      const payload = buildSudoworkConfigPatch(config, dirtyKeys, scope)
      const response = await operationsApi.updateSudoworkSystemConfig(payload, scope)
      if (!response.success) throw new Error(response.msg || '保存失败')
      if (version !== loadVersion.current) return
      const data = await readConfig()
      if (version !== loadVersion.current) return
      setConfig(data)
      setBaseline(data)
      setDirtyKeys(new Set())
      toast.success(scope === 'organization'
        ? 'Sudowork 组织策略已保存'
        : 'Sudowork 平台默认策略已保存')
    } catch (error) { if (version === loadVersion.current) toast.error(error instanceof Error ? error.message : '保存失败') }
    finally {
      saveInFlight.current = false
      if (version === loadVersion.current) setSaving(false)
    }
  }

  const scopeControl = <ConfigScopeSelect scope={scope} allowPlatform={allowPlatform} disabled={saving} onChange={next => void changeScope(next)} />
  if (loading || !config) return <DashboardLayout title="Sudowork 系统设置"><div className="space-y-5">{scopeControl}{loadError ? <Alert variant="destructive"><AlertTitle>无法加载 Sudowork 策略</AlertTitle><AlertDescription><p>{loadError}</p><Button variant="outline" size="sm" onClick={() => void load()}>重试</Button></AlertDescription></Alert> : <div className="space-y-3" role="status" aria-label="正在加载 Sudowork 策略">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-20" />)}</div>}</div></DashboardLayout>

  const logReport = object(config.log_report)
  const versionUpdate = object(config.version_update)
  const productImprovement = object(config.product_improvement)
  const credit = object(config.credit_application)
  const thirdParty = object(config.third_party_auth)
  const isPlatformScope = scope === 'platform'
  const smsStatus = object(config.sms_status)

  return (
    <DashboardLayout title="Sudowork 系统设置" description={isPlatformScope ? '平台客户端默认策略' : '当前组织的登录、客户端与充值策略'}>
      <div className="space-y-5">
        {scopeControl}
        <fieldset disabled={saving} className="space-y-5"><legend className="sr-only">{isPlatformScope ? '平台' : '当前组织'} Sudowork 策略</legend>
        <Card><CardHeader><CardTitle className="text-base">登录方式</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="默认登录方式"><Select value={!isPlatformScope && (config.inherit_login_method === true || (config.inherit_login_method === undefined && config.login_method_inherited === true)) ? 'inherit' : String(config.login_method ?? 1)} onValueChange={value => patch(value === 'inherit' ? { inherit_login_method: true } : { inherit_login_method: false, login_method: Number(value) })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{!isPlatformScope ? <SelectItem value="inherit">跟随平台默认</SelectItem> : null}{SUDOWORK_LOGIN_METHODS.map(method => <SelectItem key={method.value} value={method.value}>{method.label}</SelectItem>)}</SelectContent></Select></Field>
          <Field label="自动模型"><Input value={String(config.scode_auto_model ?? '')} onChange={event => patch({ scode_auto_model: event.target.value })} placeholder="留空使用 Moss 默认模型" /></Field>
          <Field label="CAS 配置（JSON）" wide><Textarea rows={10} value={JSON.stringify(thirdParty, null, 2)} onChange={event => { try { patch({ third_party_auth: JSON.parse(event.target.value) as JsonObject }) } catch { /* keep last valid value */ } }} /></Field>
        </CardContent></Card>

        <Alert><AlertTitle>公共平台服务</AlertTitle><AlertDescription><p>{config.sms_configured ? '短信服务已就绪。' : String(smsStatus.reason || '短信服务尚未就绪，请联系平台管理员配置。')} Moss 管理平台始终使用账户密码登录。</p>{allowPlatform ? <Link className="underline underline-offset-4" to="/settings/platform-config">管理短信、Sudorouter、富友支付、Dify 和 QMS</Link> : null}</AlertDescription></Alert>

        <Card><CardHeader><CardTitle className="text-base">客户端上报与更新</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-2">
          <Toggle label="日志上报" checked={Number(logReport.enabled) === 1} onChange={checked => nested('log_report', { enabled: checked ? 1 : 0 })} />
          <Field label="日志协议"><Select value={String(logReport.protocol ?? 'https')} onValueChange={value => nested('log_report', { protocol: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="https">HTTPS</SelectItem><SelectItem value="http">HTTP</SelectItem></SelectContent></Select></Field>
          <Field label="日志域名"><Input value={String(logReport.domain ?? '')} onChange={event => nested('log_report', { domain: event.target.value })} /></Field>
          {isPlatformScope ? <Field label="新的日志密钥"><Input type="password" value={String(logReport.key ?? '')} onChange={event => nested('log_report', { key: event.target.value })} placeholder="留空表示不修改" /></Field> : null}
          <Toggle label="版本更新" checked={Number(versionUpdate.enabled) === 1} onChange={checked => nested('version_update', { enabled: checked ? 1 : 0 })} />
          <Field label="版本资源域名"><Input value={String(versionUpdate.cos_domain ?? '')} onChange={event => nested('version_update', { cos_domain: event.target.value })} /></Field>
          <Toggle label="产品改进数据" checked={Number(productImprovement.enabled) === 1} onChange={checked => nested('product_improvement', { enabled: checked ? 1 : 0 })} />
        </CardContent></Card>

        <Card><CardHeader><CardTitle className="text-base">充值与授信</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="客户端充值模式"><Select value={String(config.recharge_mode ?? 'disabled')} onValueChange={value => patch({ recharge_mode: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="pay">在线支付</SelectItem><SelectItem value="approve">积分申请审批</SelectItem><SelectItem value="disabled">关闭充值入口</SelectItem></SelectContent></Select></Field>
          <Field label="最低申请积分"><Input inputMode="numeric" value={String(credit.min_points ?? '')} onChange={event => nested('credit_application', { min_points: Number(event.target.value) })} /></Field>
          <Field label="最高申请积分"><Input inputMode="numeric" value={String(credit.max_points ?? '')} onChange={event => nested('credit_application', { max_points: Number(event.target.value) })} /></Field>
          <Toggle label="允许重复待审批申请" checked={credit.allow_duplicate_pending === true} onChange={checked => nested('credit_application', { allow_duplicate_pending: checked })} />
        </CardContent></Card>

        </fieldset>
        <div className="flex justify-end gap-2"><Button variant="ghost" disabled={saving || !dirtyKeys.size} onClick={() => void confirmDiscard()}>取消</Button><Button onClick={() => void save()} disabled={saving || !dirtyKeys.size}>{saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}保存策略</Button></div>
      </div>
    </DashboardLayout>
  )
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function Field({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <div className={`space-y-2 ${wide ? 'md:col-span-2' : ''}`}><Label>{label}</Label>{children}</div>
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(checked: boolean): void }) {
  return <div className="flex min-h-9 items-center justify-between gap-4 rounded-md border px-3"><Label>{label}</Label><Switch checked={checked} onCheckedChange={onChange} /></div>
}
