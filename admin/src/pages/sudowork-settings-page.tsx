'use client'

import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Loader2, Save } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { operationsApi } from '@/lib/api/operations'
import { SUDOWORK_LOGIN_METHODS } from '../sudowork-settings'

type Config = Record<string, unknown>
type JsonObject = Record<string, unknown>

export default function SudoworkSettingsPage() {
  const [config, setConfig] = useState<Config | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try { setConfig((await operationsApi.getSudoworkSystemConfig()).data) }
    catch (error) { toast.error(error instanceof Error ? error.message : '获取 Sudowork 策略失败') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const patch = (value: Config) => setConfig(current => ({ ...(current ?? {}), ...value }))
  const nested = (key: string, value: JsonObject) => patch({ [key]: { ...object(config?.[key]), ...value } })

  const save = async () => {
    if (!config) return
    setSaving(true)
    try {
      await operationsApi.updateSudoworkSystemConfig(config)
      setConfig((await operationsApi.getSudoworkSystemConfig()).data)
      toast.success('Sudowork 配置已保存；短信和支付基础设施变更需重启 Moss')
    } catch (error) { toast.error(error instanceof Error ? error.message : '保存失败') }
    finally { setSaving(false) }
  }

  if (loading || !config) return <DashboardLayout title="Sudowork 系统设置"><div className="space-y-3">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-20" />)}</div></DashboardLayout>

  const logReport = object(config.log_report)
  const versionUpdate = object(config.version_update)
  const productImprovement = object(config.product_improvement)
  const credit = object(config.credit_application)
  const thirdParty = object(config.third_party_auth)
  const sms = object(config.sms)
  const billing = object(config.billing)
  const fuiou = object(billing.fuiou)
  const sudorouter = object(billing.sudorouter)
  const nestedChild = (key: string, childKey: string, value: JsonObject) => {
    const parent = object(config[key])
    nested(key, { [childKey]: { ...object(parent[childKey]), ...value } })
  }

  return (
    <DashboardLayout title="Sudowork 系统设置" description="统一管理客户端策略以及短信、支付和额度服务参数">
      <div className="space-y-5">
        <Card><CardHeader><CardTitle className="text-base">登录方式</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="默认登录方式"><Select value={String(config.login_method ?? 1)} onValueChange={value => patch({ login_method: Number(value) })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{SUDOWORK_LOGIN_METHODS.map(method => <SelectItem key={method.value} value={method.value}>{method.label}</SelectItem>)}</SelectContent></Select></Field>
          <Field label="自动模型"><Input value={String(config.scode_auto_model ?? '')} onChange={event => patch({ scode_auto_model: event.target.value })} placeholder="留空使用 Moss 默认模型" /></Field>
          <Field label="CAS 配置（JSON）" wide><Textarea rows={10} value={JSON.stringify(thirdParty, null, 2)} onChange={event => { try { patch({ third_party_auth: JSON.parse(event.target.value) as JsonObject }) } catch { /* keep last valid value */ } }} /></Field>
        </CardContent></Card>

        <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle className="text-base">短信服务</CardTitle><span className="text-xs text-muted-foreground">保存后需重启</span></div></CardHeader><CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="短信服务商"><Select value={String(sms.provider ?? 'disabled')} onValueChange={value => nested('sms', { provider: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="disabled">关闭</SelectItem><SelectItem value="tencent">腾讯云短信</SelectItem></SelectContent></Select></Field>
          <Field label="地域"><Input value={String(sms.region ?? 'ap-beijing')} onChange={event => nested('sms', { region: event.target.value })} /></Field>
          <Field label="SDK App ID"><Input value={String(sms.sdk_app_id ?? '')} onChange={event => nested('sms', { sdk_app_id: event.target.value })} /></Field>
          <Field label="短信签名"><Input value={String(sms.sign_name ?? '')} onChange={event => nested('sms', { sign_name: event.target.value })} /></Field>
          <Field label="模板 ID"><Input value={String(sms.template_id ?? '')} onChange={event => nested('sms', { template_id: event.target.value })} /></Field>
          <Field label="签名 ID"><Input value={String(sms.sign_id ?? '')} onChange={event => nested('sms', { sign_id: event.target.value })} /></Field>
          <Field label="验证码长度"><Input type="number" min={4} max={8} value={String(sms.code_length ?? 6)} onChange={event => nested('sms', { code_length: Number(event.target.value) })} /></Field>
          <Field label="有效期（分钟）"><Input type="number" min={1} value={String(sms.expire_minutes ?? 5)} onChange={event => nested('sms', { expire_minutes: Number(event.target.value) })} /></Field>
          <Field label="发送间隔（秒）"><Input type="number" min={1} value={String(sms.send_interval_seconds ?? 60)} onChange={event => nested('sms', { send_interval_seconds: Number(event.target.value) })} /></Field>
          <Field label="每日发送上限"><Input type="number" min={1} value={String(sms.max_per_day ?? 10)} onChange={event => nested('sms', { max_per_day: Number(event.target.value) })} /></Field>
        </CardContent></Card>

        <Card><CardHeader><CardTitle className="text-base">客户端上报与更新</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-2">
          <Toggle label="日志上报" checked={Number(logReport.enabled) === 1} onChange={checked => nested('log_report', { enabled: checked ? 1 : 0 })} />
          <Field label="日志协议"><Select value={String(logReport.protocol ?? 'https')} onValueChange={value => nested('log_report', { protocol: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="https">HTTPS</SelectItem><SelectItem value="http">HTTP</SelectItem></SelectContent></Select></Field>
          <Field label="日志域名"><Input value={String(logReport.domain ?? '')} onChange={event => nested('log_report', { domain: event.target.value })} /></Field>
          <Field label="新的日志密钥"><Input type="password" value={String(logReport.key ?? '')} onChange={event => nested('log_report', { key: event.target.value })} placeholder="留空表示不修改" /></Field>
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

        <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle className="text-base">富友支付与 Sudorouter</CardTitle><Button asChild variant="outline" size="sm"><Link to="/settings/server-credentials"><KeyRound className="mr-2 size-4" />配置敏感凭据</Link></Button></div></CardHeader><CardContent className="grid gap-4 md:grid-cols-2">
          <Toggle label="启用在线计费" checked={billing.enabled === true} onChange={checked => nested('billing', { enabled: checked })} />
          <Toggle label="富友测试模式" checked={fuiou.test_mode === true} onChange={checked => nestedChild('billing', 'fuiou', { test_mode: checked })} />
          <Field label="富友商户号"><Input value={String(fuiou.merchant_code ?? '')} onChange={event => nestedChild('billing', 'fuiou', { merchant_code: event.target.value })} /></Field>
          <Field label="富友超时（毫秒）"><Input type="number" min={1} value={String(fuiou.timeout_ms ?? 10000)} onChange={event => nestedChild('billing', 'fuiou', { timeout_ms: Number(event.target.value) })} /></Field>
          <Field label="测试支付地址"><Input type="url" value={String(fuiou.test_api_url ?? '')} onChange={event => nestedChild('billing', 'fuiou', { test_api_url: event.target.value })} /></Field>
          <Field label="测试退款地址"><Input type="url" value={String(fuiou.test_refund_url ?? '')} onChange={event => nestedChild('billing', 'fuiou', { test_refund_url: event.target.value })} /></Field>
          <Field label="生产支付地址"><Input type="url" value={String(fuiou.prod_api_url ?? '')} onChange={event => nestedChild('billing', 'fuiou', { prod_api_url: event.target.value })} /></Field>
          <Field label="生产退款地址"><Input type="url" value={String(fuiou.prod_refund_url ?? '')} onChange={event => nestedChild('billing', 'fuiou', { prod_refund_url: event.target.value })} /></Field>
          <Field label="Sudorouter 地址"><Input type="url" value={String(sudorouter.base_url ?? '')} onChange={event => nestedChild('billing', 'sudorouter', { base_url: event.target.value })} /></Field>
          <Field label="Sudorouter 管理员 ID"><Input value={String(sudorouter.admin_user_id ?? '13')} onChange={event => nestedChild('billing', 'sudorouter', { admin_user_id: event.target.value })} /></Field>
          <Field label="Sudorouter 超时（毫秒）"><Input type="number" min={1} value={String(sudorouter.timeout_ms ?? 10000)} onChange={event => nestedChild('billing', 'sudorouter', { timeout_ms: Number(event.target.value) })} /></Field>
          <Field label="新用户初始模型额度"><Input type="number" min={0} value={String(sudorouter.initial_quota ?? 100000)} onChange={event => nestedChild('billing', 'sudorouter', { initial_quota: Number(event.target.value) })} /></Field>
          <Field label="客户端模型服务地址"><Input type="url" value={String(sudorouter.model_service_url ?? '')} onChange={event => nestedChild('billing', 'sudorouter', { model_service_url: event.target.value })} placeholder="https://router.example.com/v1" /></Field>
          <Field label="可用模型列表地址" wide><Input type="url" value={String(sudorouter.models_api_url ?? '')} onChange={event => nestedChild('billing', 'sudorouter', { models_api_url: event.target.value })} placeholder="https://router.example.com/api/specific_pricing" /></Field>
        </CardContent></Card>

        <div className="flex justify-end"><Button onClick={() => void save()} disabled={saving}>{saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}保存策略</Button></div>
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
