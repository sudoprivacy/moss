import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, KeyRound, Loader2, RefreshCw, ServerCog, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/lib/hooks/use-auth'
import { useSettingsNavigationGuard } from '@/lib/hooks/use-settings-navigation-guard'
import { getPlatformConfig, savePlatformConfig, checkPlatformConfig, previewPhonePasswords, applyPhonePasswords,
  type PlatformConfigItem, type PlatformConfigResponse, type PasswordMigrationPreview } from '@/lib/api/platform-config'

export default function PlatformConfigPage() {
  const { user } = useAuth()
  const [data, setData] = useState<PlatformConfigResponse | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('sms')
  const [draft, setDraft] = useState<PlatformConfigItem['config']>({})
  const [secrets, setSecrets] = useState<Record<string, string | null>>({})
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [preview, setPreview] = useState<PasswordMigrationPreview | null>(null)
  const inFlight = useRef(false)
  const item = data?.items.find(value => value.id === selected)
  const mockSms = item?.id === 'sms' && draft.mockDelivery === true
  const dirty = Boolean(item && (JSON.stringify(draft) !== JSON.stringify(item.config) || Object.keys(secrets).length))
  const discard = useCallback(() => { setDraft(item?.config ?? {}); setSecrets({}) }, [item])
  const confirmDiscard = useSettingsNavigationGuard(dirty, saving, discard)
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { const response = await getPlatformConfig(); setData(response); return response }
    catch (e) { setError(e instanceof Error ? e.message : '加载失败'); return null }
    finally { setLoading(false) }
  }, [])
  useEffect(() => {
    if (user?.role !== 'super_admin') return
    let cancelled = false
    void load().then(response => { if (!cancelled && response) setDraft(response.items.find(value => value.id === 'sms')?.config ?? {}) })
    return () => { cancelled = true }
  }, [load, user?.role])

  const choose = async (next: string) => {
    if (next === selected || !await confirmDiscard()) return
    setSelected(next); setDraft(data?.items.find(value => value.id === next)?.config ?? {}); setSecrets({})
  }
  const submit = async (checkOnly = false) => {
    if (!item || inFlight.current) return
    inFlight.current = true; setSaving(true)
    try {
      const input = { expectedVersion: item.version, config: draft, secrets }
      if (checkOnly) {
        const result = await checkPlatformConfig(item.id, input)
        if (result.ready) toast.success('配置检查通过；未发送短信或创建支付订单')
        else toast.error(result.issues.join('；'))
      } else {
        await savePlatformConfig(item.id, input)
        setSecrets({})
        const response = await load()
        if (response) setDraft(response.items.find(value => value.id === selected)?.config ?? {})
        toast.success('配置已保存，重启 Moss 后生效')
      }
    } catch (e) { toast.error(e instanceof Error ? e.message : '操作失败') }
    finally { inFlight.current = false; setSaving(false) }
  }
  if (user?.role !== 'super_admin') return <DashboardLayout title="平台配置"><Alert><AlertTitle>仅平台超级管理员可访问</AlertTitle><AlertDescription>组织登录策略请在 Sudowork 系统设置中管理。</AlertDescription></Alert></DashboardLayout>
  return <DashboardLayout title="平台配置" description="所有组织共享的平台服务连接与凭据">
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 px-5 py-4">
        <div className="flex items-center gap-3"><ShieldCheck className="size-5 text-muted-foreground" /><div><p className="font-medium">平台全局配置</p><p className="text-sm text-muted-foreground">切换组织不会改变这里的配置。保存后需重启服务。</p></div></div>
        <Button variant="outline" disabled={saving || loading} onClick={async () => { if (await confirmDiscard()) { const response = await load(); if (response) setDraft(response.items.find(value => value.id === selected)?.config ?? {}) } }}><RefreshCw className="mr-2 size-4" />刷新状态</Button>
      </div>
      {error ? <Alert variant="destructive"><AlertTitle>无法读取配置</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {loading && !data ? <div role="status" className="flex items-center gap-2 py-12"><Loader2 className="size-5 animate-spin" />正在读取平台配置…</div> : null}
      {data && item ? <div className="grid items-start gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="平台服务" className="space-y-1 rounded-xl border p-2">
          {data.items.map(provider => <button key={provider.id} type="button" aria-current={selected === provider.id ? 'page' : undefined} disabled={saving} onClick={() => void choose(provider.id)} className={`flex w-full items-center justify-between rounded-lg px-3 py-3 text-left text-sm transition-colors ${selected === provider.id ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}>
            <span>{provider.label}</span>{provider.restartRequired ? <span className="size-2 rounded-full bg-amber-500" aria-label="待重启" /> : null}
          </button>)}
          <div className="border-t px-3 pt-3 pb-2 text-xs leading-relaxed text-muted-foreground">管理其他服务器凭据<br /><Link className="underline underline-offset-4" to="/settings/server-credentials">打开服务器凭据</Link></div>
        </nav>
        <Card>
          <CardHeader className="border-b"><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle className="flex items-center gap-2"><ServerCog className="size-5" />{item.label}</CardTitle><Badge variant={item.restartRequired ? 'secondary' : 'outline'}>{item.restartRequired ? '已保存 · 待重启' : item.managed ? item.id === 'sms' && item.config.enabled === true && item.config.mockDelivery === true ? '模拟发送已生效' : '平台配置已生效' : '使用现有部署配置'}</Badge></div><CardDescription>{item.description}</CardDescription></CardHeader>
          <CardContent className="space-y-6 pt-6">
            {!item.managed ? <Alert><AlertTitle>接管现有配置</AlertTitle><AlertDescription>参数已从现有配置导入。首次保存后，该服务由平台页面管理，旧环境变量不再覆盖它。未修改的凭据会在服务端保留。</AlertDescription></Alert> : null}
            {item.conflicts.length ? <Alert variant="destructive"><AlertTitle>历史配置存在冲突</AlertTitle><AlertDescription>请重新填写这些字段，明确选择要使用的值：{item.conflicts.join('、')}</AlertDescription></Alert> : null}
            {item.issues.length ? <p className="text-sm text-amber-700 dark:text-amber-400">当前检查：{item.issues.join('；')}</p> : null}
            {mockSms ? <Alert><AlertTitle>模拟发送（仅测试）</AlertTitle><AlertDescription>保存并重启 Moss 后，验证码仅写入启动服务的终端日志，不会调用腾讯短信。无需填写腾讯参数和凭据；已有凭据会保留。登录和注册仍校验验证码及组织策略，注册仍需有效邀请码。关闭模拟发送后，需配置有效的腾讯短信参数和凭据。</AlertDescription></Alert> : null}
            <fieldset disabled={saving} className="grid gap-x-5 gap-y-6 lg:grid-cols-2"><legend className="sr-only">{item.label}配置</legend>
              {item.fields.map(field => {
                if (mockSms && (field.required || field.key === 'templateParams')) return null
                const id = `${item.id}-${field.key}`
                const value = draft[field.key]
                if (field.type === 'boolean') return <div key={id} className="flex items-center justify-between gap-4 rounded-lg border p-3"><Label htmlFor={id}>{field.label}</Label><Switch id={id} checked={value === true} onCheckedChange={checked => setDraft(current => ({ ...current, [field.key]: checked }))} /></div>
                return <div key={id} className={`space-y-2 ${field.type === 'secret' || field.type === 'lines' ? 'lg:col-span-2' : ''}`}>
                  <div className="flex items-center justify-between gap-2"><Label htmlFor={id}>{field.label}{field.required ? <span className="ml-1 text-muted-foreground">*</span> : null}</Label>{field.type === 'secret' ? <span className="text-xs text-muted-foreground">{secrets[field.key] === null ? '保存时清除' : item.secrets[field.key] ? '已设置' : '未设置'}</span> : null}</div>
                  {field.type === 'secret' ? <div className="flex gap-2">{['merchantPrivateKey', 'publicKey', 'privateKeyPem', 'publicKeyPem'].includes(field.key) ? <Textarea id={id} rows={4} autoComplete="off" value={secrets[field.key] ?? ''} placeholder="粘贴新 PEM 密钥；留空保留现有凭据" onChange={event => setSecrets(current => { const next = { ...current }; if (event.target.value) next[field.key] = event.target.value; else delete next[field.key]; return next })} /> : <Input id={id} type="password" autoComplete="new-password" value={secrets[field.key] ?? ''} placeholder="留空保留现有凭据" onChange={event => setSecrets(current => { const next = { ...current }; if (event.target.value) next[field.key] = event.target.value; else delete next[field.key]; return next })} />}<Button type="button" variant="outline" onClick={() => setSecrets(current => { const next = { ...current }; if (current[field.key] === null) delete next[field.key]; else next[field.key] = null; return next })}>{secrets[field.key] === null ? '撤销清除' : '清除'}</Button></div>
                    : field.type === 'lines' ? <Textarea id={id} rows={3} value={Array.isArray(value) ? value.join('\n') : ''} onChange={event => setDraft(current => ({ ...current, [field.key]: event.target.value.split('\n') }))} />
                    : <Input id={id} type={field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text'} min={field.min} max={field.max} value={String(value ?? '')} onChange={event => setDraft(current => ({ ...current, [field.key]: field.type === 'number' ? Number(event.target.value) : event.target.value }))} />}
                  <p className="text-xs text-muted-foreground">来源：{item.sources[field.key] === 'platform' ? '平台配置' : item.sources[field.key] || '默认值'}</p>
                </div>
              })}
            </fieldset>
            <div className="flex flex-wrap justify-end gap-2 border-t pt-5"><Button variant="outline" disabled={saving} onClick={() => void submit(true)}><CheckCircle2 className="mr-2 size-4" />检查配置</Button><Button disabled={saving || (item.managed && !dirty)} onClick={() => void submit()}>{saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <KeyRound className="mr-2 size-4" />}{item.managed ? '保存配置' : '保存并接管'}</Button></div>
          </CardContent>
        </Card>
      </div> : null}
      {data?.instances.length ? <details className="rounded-lg border p-4 text-sm"><summary className="cursor-pointer font-medium">实例生效状态</summary><div className="mt-3 space-y-2">{data.instances.map(instance => <div key={instance.instanceId}><span className="font-mono">{instance.instanceId}</span> · {Date.now() - instance.seenAt > 90_000 ? '状态已过期' : '在线'} · {data.items.filter(provider => provider.version !== (instance.versions[provider.id] ?? null)).map(provider => provider.label).join('、') || '全部已应用'}{data.items.some(provider => provider.version !== (instance.versions[provider.id] ?? null)) ? '待重启' : ''}</div>)}</div></details> : null}
      <Card><CardHeader><CardTitle className="text-base">补齐历史 Sudowork 用户密码</CardTitle><CardDescription>仅为具有手机身份、尚未设置密码的正常普通用户初始化手机号密码；已有密码保持不变。</CardDescription></CardHeader><CardContent className="flex flex-wrap items-center gap-3"><Button variant="outline" disabled={saving} onClick={async () => { try { setPreview(await previewPhonePasswords()) } catch (e) { toast.error(e instanceof Error ? e.message : '预览失败') } }}>预览待处理用户</Button>{preview ? <><span className="text-sm text-muted-foreground">待补齐 {preview.eligible} 人，跳过 {preview.skipped} 人</span><Button disabled={saving || !preview.eligible} onClick={async () => { setSaving(true); try { const result = await applyPhonePasswords(preview.fingerprint); setPreview(null); toast.success(`已补齐 ${result.updated} 个用户`) } catch (e) { toast.error(e instanceof Error ? e.message : '补齐失败') } finally { setSaving(false) } }}>补齐这 {preview.eligible} 个用户</Button></> : null}</CardContent></Card>
    </div>
  </DashboardLayout>
}
