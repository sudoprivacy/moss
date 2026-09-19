import { useState, type ComponentType, type ReactNode } from 'react'
import { Building2, Eye, EyeOff, Image, KeyRound, MonitorSmartphone, ShieldCheck, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { TabsContent } from '@/components/ui/tabs'
import type { SystemSettings, ThinkingMode } from '@/lib/api/types'
import { FIELD_LABELS, type SecretDraft, type SettingsDraft, type SettingsErrors, type SettingsField } from '@/lib/system-settings'

type FieldsProps = {
  settings: SystemSettings
  draft: SettingsDraft
  errors: SettingsErrors
  update: <K extends SettingsField>(field: K, value: SettingsDraft[K]) => void
}

function Section({ icon: Icon, title, description, children }: { icon: ComponentType<{ size?: number }>; title: string; description: string; children: ReactNode }) {
  return <section className="system-settings-section">
    <header><span className="system-settings-section-icon"><Icon size={18} /></span><div><h2>{title}</h2><p>{description}</p></div></header>
    <div className="system-settings-section-body">{children}</div>
  </section>
}

function Field({ field, description, error, children }: { field: SettingsField; description?: ReactNode; error?: string; children: ReactNode }) {
  return <div className="system-settings-field">
    <div className="system-settings-label"><label htmlFor={`setting-${field}`}>{FIELD_LABELS[field]}</label>{description && <p id={`setting-${field}-hint`}>{description}</p>}</div>
    <div className="system-settings-control">{children}{error && <p className="system-settings-error" id={`setting-${field}-error`} role="alert">{error}</p>}</div>
  </div>
}

function SecretField({ field, configured, value, error, onChange }: { field: 'apiKey' | 'imageApiKey'; configured: boolean; value: SecretDraft; error?: string; onChange: (value: SecretDraft) => void }) {
  const [visible, setVisible] = useState(false)
  return <Field field={field} description="密钥存储于 Nexus，不会写入 settings.json。" error={error}>
    <select id={`setting-${field}`} className="system-settings-select" value={value.action} aria-describedby={`setting-${field}-hint`} onChange={event => { setVisible(false); onChange({ action: event.target.value as SecretDraft['action'], value: '' }) }}>
      <option value="keep">保持不变 · {configured ? '已配置' : '未配置'}</option>
      <option value="replace">{configured ? '替换为新密钥' : '设置新密钥'}</option>
      <option value="clear" disabled={!configured}>清除已保存的密钥</option>
    </select>
    {value.action === 'replace' && <div className="system-settings-secret-input">
      <Input id={`setting-${field}-value`} aria-label={`${FIELD_LABELS[field]} 新密钥`} type={visible ? 'text' : 'password'} value={value.value} autoComplete="new-password" spellCheck={false} aria-invalid={Boolean(error)} aria-describedby={error ? `setting-${field}-error` : undefined} onChange={event => onChange({ ...value, value: event.target.value })} placeholder="输入新密钥，不会展示已有密钥" />
      <Button type="button" size="icon" variant="ghost" aria-label={visible ? '隐藏新密钥' : '显示新密钥'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</Button>
    </div>}
    {value.action === 'clear' && <p className="system-settings-warning">保存后将删除当前密钥，依赖此密钥的模型调用可能不可用。</p>}
  </Field>
}

export function SystemSettingsFields({ settings, draft, errors, update }: FieldsProps) {
  const textField = (field: Exclude<SettingsField, 'apiKey' | 'imageApiKey'>, description: ReactNode, options: { placeholder?: string; min?: number; max?: number; number?: boolean; step?: string } = {}) => (
    <Field field={field} description={description} error={errors[field]}>
      <div className={field === 'uploadLimitMiB' ? 'system-settings-unit-input' : undefined}>
        <Input id={`setting-${field}`} name={field} value={String(draft[field])} type={options.number ? 'number' : 'text'} min={options.min} max={options.max} step={options.step ?? (options.number ? '1' : undefined)} placeholder={options.placeholder} spellCheck={false} autoComplete="off" aria-invalid={Boolean(errors[field])} aria-describedby={`setting-${field}-hint${errors[field] ? ` setting-${field}-error` : ''}`} onChange={event => update(field, event.target.value)} />
        {field === 'uploadLimitMiB' && <span>MiB</span>}
      </div>
    </Field>
  )
  const toggle = (field: 'bypassPermissions' | 'clientCronEnabled' | 'clientShowToolCalls' | 'oauthEnabled' | 'oauthRequireState', description: string) => (
    <Field field={field} description={description}>
      <div className="system-settings-toggle"><Switch id={`setting-${field}`} checked={draft[field]} onCheckedChange={checked => update(field, checked)} aria-describedby={`setting-${field}-hint`} /><span>{draft[field] ? '已开启' : '已关闭'}</span></div>
    </Field>
  )
  return <>
    <TabsContent value="models" className="system-settings-tab-content">
      <Section icon={Sparkles} title="文本模型" description="配置默认模型、服务地址与调用凭据。">
        {textField('model', '填写服务支持的模型名称，仅对新的会话生效。', { placeholder: '例如 claude-sonnet-4-6' })}
        {textField('url', '留空使用默认服务地址，也可填写兼容的代理地址。', { placeholder: 'https://api.anthropic.com' })}
        <SecretField field="apiKey" configured={Boolean(settings.apiKey)} value={draft.apiKey} error={errors.apiKey} onChange={value => update('apiKey', value)} />
      </Section>
      <Section icon={Image} title="图片模型" description="供图片生成相关工具调用的提供商与模型配置。">
        <Field field="imageProvider" description="选择图片模型的 API 协议。">
          <select id="setting-imageProvider" className="system-settings-select" value={draft.imageProvider} onChange={event => update('imageProvider', event.target.value)}>
            {!['openai', 'google'].includes(draft.imageProvider) && <option value={draft.imageProvider}>{draft.imageProvider || '未指定'}</option>}
            <option value="openai">OpenAI</option><option value="google">Google</option>
          </select>
        </Field>
        {textField('imageUrl', '图片 API 的完整地址，留空保留默认行为。', { placeholder: 'https://api.openai.com/v1' })}
        {textField('imageModel', '填写图片服务实际支持的模型名称。', { placeholder: '例如 gpt-image-1' })}
        <SecretField field="imageApiKey" configured={Boolean(settings.image.apiKey)} value={draft.imageApiKey} error={errors.imageApiKey} onChange={value => update('imageApiKey', value)} />
      </Section>
    </TabsContent>
    <TabsContent value="runtime" className="system-settings-tab-content">
      <Section icon={ShieldCheck} title="执行与权限" description="控制新会话的工具调用确认与运行边界。">
        {toggle('bypassPermissions', '开启后，新会话中的工具调用将跳过权限确认。建议仅在可信环境中启用。')}
        {draft.bypassPermissions && <p className="system-settings-warning">权限确认已跳过。请确认运行环境与可调用的工具均可信。</p>}
        {textField('maxTurns', '新的 local 会话允许的最大轮次，范围 1–10,000。', { number: true, min: 1, max: 10000 })}
        <Field field="thinkingMode" description="选择模型思考策略；自适应模式由系统决定。">
          <select id="setting-thinkingMode" className="system-settings-select" value={draft.thinkingMode} onChange={event => update('thinkingMode', event.target.value as ThinkingMode)}>
            <option value="adaptive">自适应 · adaptive</option><option value="enabled">始终启用 · enabled</option><option value="disabled">关闭 · disabled</option>
          </select>
        </Field>
        {draft.thinkingMode === 'enabled' && textField('thinkingBudgetTokens', '强制开启思考时使用，范围 1,024–128,000 tokens。', { number: true, min: 1024, max: 128000 })}
      </Section>
      <Section icon={MonitorSmartphone} title="会话复用" description="定期轮换长会话，避免运行时上下文持续累积。">
        {textField('cronReuseMaxRuns', '同一会话执行满该次数后新建会话。0 表示不限，默认 50。', { number: true, min: 0, max: 10000 })}
        {textField('imReuseMaxTurns', '满该轮数后重建并注入近期摘要；工具调用中间状态不保留。0 表示不限，默认 200。', { number: true, min: 0, max: 10000 })}
      </Section>
    </TabsContent>
    <TabsContent value="clients" className="system-settings-tab-content">
      <Section icon={MonitorSmartphone} title="客户端偏好" description="服务端提供的默认行为与工作区上传限制，适用于所有组织。">
        {toggle('clientCronEnabled', '是否向客户端开放定时任务功能。')}
        {toggle('clientShowToolCalls', '默认在对话流中展示工具调用；用户可在客户端覆盖此偏好。')}
        {textField('uploadLimitMiB', '单文件大小上限，最多 1024 MiB。1 MiB = 1,048,576 字节，超限由服务端拒绝。', { number: true, min: 1 / (1024 * 1024), max: 1024, step: 'any' })}
      </Section>
      <Section icon={Building2} title="专属资产" description="配置技能商店专属资产关联的租户标识。">
        {textField('tenantId', '这是服务器级技能商店配置，不等同于侧栏当前选中的组织。', { placeholder: '输入专属资产租户 ID' })}
      </Section>
      <Section icon={KeyRound} title="OAuth2 登录" description="允许 SudoWork 用户通过外部身份提供方登录。">
        {toggle('oauthEnabled', '配置完成后，在客户端启用浏览器跳转登录。')}
        {toggle('oauthRequireState', '校验回调的 State 以防御 CSRF 攻击，建议保持开启。')}
        {!draft.oauthRequireState && <p className="system-settings-warning">State 校验已关闭，OAuth2 回调将不再进行本地 CSRF 校验。</p>}
        {textField('authorizeUrlTemplate', '填写完整授权地址及 client_id、scope 等参数。服务端替换 {redirect_uri}，客户端填充 {state}。', { placeholder: 'https://idp.example.com/authorize?redirect_uri={redirect_uri}&state={state}' })}
        <div className="system-settings-readonly"><span>回调地址</span><code>sudowork://oauth2-callback</code></div>
        <div className="system-settings-readonly"><span>服务器登录脚本</span><code>{settings.oauth2.scriptPath || '未配置'}</code><p>脚本路径只读，请在服务器配置中维护。启用登录需要同时配置授权地址和脚本。</p></div>
        {draft.oauthEnabled && !settings.oauth2.scriptPath && <p className="system-settings-warning">尚未配置登录脚本。即使保存启用状态，OAuth2 登录也不会生效。</p>}
      </Section>
    </TabsContent>
  </>
}
