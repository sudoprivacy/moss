'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Save } from 'lucide-react'
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
      toast.success('Sudowork 客户端策略已保存')
    } catch (error) { toast.error(error instanceof Error ? error.message : '保存失败') }
    finally { setSaving(false) }
  }

  if (loading || !config) return <DashboardLayout title="Sudowork 客户端策略"><div className="space-y-3">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-20" />)}</div></DashboardLayout>

  const logReport = object(config.log_report)
  const versionUpdate = object(config.version_update)
  const productImprovement = object(config.product_improvement)
  const credit = object(config.credit_application)
  const thirdParty = object(config.third_party_auth)

  return (
    <DashboardLayout title="Sudowork 客户端策略" description="统一管理本地模式客户端的登录、上报、更新与充值策略">
      <div className="space-y-5">
        <Card><CardHeader><CardTitle className="text-base">登录方式</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="默认登录方式"><Select value={String(config.login_method ?? 1)} onValueChange={value => patch({ login_method: Number(value) })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{SUDOWORK_LOGIN_METHODS.map(method => <SelectItem key={method.value} value={method.value}>{method.label}</SelectItem>)}</SelectContent></Select></Field>
          <Field label="自动模型"><Input value={String(config.scode_auto_model ?? '')} onChange={event => patch({ scode_auto_model: event.target.value })} placeholder="留空使用 Moss 默认模型" /></Field>
          <Field label="CAS 配置（JSON）" wide><Textarea rows={10} value={JSON.stringify(thirdParty, null, 2)} onChange={event => { try { patch({ third_party_auth: JSON.parse(event.target.value) as JsonObject }) } catch { /* keep last valid value */ } }} /></Field>
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
