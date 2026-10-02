import { useState, type ReactNode } from 'react'
import { BrainCircuit, ChevronDown, Eye, EyeOff, Image, KeyRound, LoaderCircle, LockKeyhole, PlugZap, ShieldCheck, SlidersHorizontal, Sparkles, Terminal, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { TabsContent } from '@/components/ui/tabs'
import type { FieldKey, FormErrors, Settings } from './fixtures'

interface SettingsSectionsProps {
  draft: Settings
  errors: FormErrors
  update: <K extends FieldKey>(key: K, value: Settings[K]) => void
  testing: boolean
  testResult: boolean
  testConnection: () => void
}

function Field({ id, label, help, error, children }: {
  id: string
  label: string
  help?: string
  error?: string
  children: ReactNode
}) {
  return (
    <div className="setting-row">
      <div className="field-label">
        <label htmlFor={id}>{label}</label>
        {help && <p id={`${id}-help`}>{help}</p>}
      </div>
      <div className="field-control">
        {children}
        {error && <p className="field-error" id={`${id}-error`} role="alert">{error}</p>}
      </div>
    </div>
  )
}

function ToggleRow({ id, title, description, value, onChange }: {
  id: string
  title: string
  description: string
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="toggle-row">
      <div><label htmlFor={id}>{title}</label><p id={`${id}-help`}>{description}</p></div>
      <Switch id={id} checked={value} onCheckedChange={onChange} aria-describedby={`${id}-help`} />
    </div>
  )
}

export function SettingsSections({ draft, errors, update, testing, testResult, testConnection }: SettingsSectionsProps) {
  const [showKey, setShowKey] = useState(false)
  return (
    <>
      <TabsContent value="models" className="prototype-tab-panel">
        <section className="settings-section" id="text-model" aria-labelledby="text-model-title">
          <div className="section-heading">
            <div className="section-icon"><BrainCircuit size={19} /></div>
            <div><h2 id="text-model-title">文本模型</h2><p>为新会话和智能体设置默认模型。</p></div>
            <span className="provider-label"><span className="provider-letter">A</span> Anthropic</span>
          </div>
          <div className="section-fields">
            <Field id="model" label="默认模型" help="未指定模型时使用">
              <div className="select-wrap model-select"><Sparkles size={16} /><select id="model" value={draft.model} onChange={event => update('model', event.target.value)} aria-describedby="model-help"><option value="claude-sonnet-5">Claude Sonnet 5</option><option value="claude-opus-5">Claude Opus 5</option></select><ChevronDown size={14} /></div>
              <p className="control-hint">模型名称为示例，可在正式接入后配置可用模型。</p>
            </Field>
            <Field id="apiUrl" label="API 地址" help="模型服务的访问地址" error={errors.apiUrl}>
              <input id="apiUrl" className="prototype-input technical-input" type="url" value={draft.apiUrl} onChange={event => update('apiUrl', event.target.value)} aria-invalid={!!errors.apiUrl} aria-describedby={`apiUrl-help${errors.apiUrl ? ' apiUrl-error' : ''}`} spellCheck={false} />
            </Field>
            <Field id="apiKey" label="API Key" help="服务端统一管理凭据" error={errors.apiKey}>
              <div className="password-wrap"><KeyRound size={15} /><input id="apiKey" className="prototype-input technical-input" type={showKey ? 'text' : 'password'} autoComplete="off" value={draft.apiKey} onChange={event => update('apiKey', event.target.value)} aria-invalid={!!errors.apiKey} aria-describedby={`apiKey-note${errors.apiKey ? ' apiKey-error' : ''}`} /><button type="button" className="icon-button" aria-label={showKey ? '隐藏示例密钥' : '显示示例密钥'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
              <p className="control-hint" id="apiKey-note"><LockKeyhole size={12} /> 仅供演示，请勿填写真实密钥。</p>
            </Field>
          </div>
          <div className="section-footer"><span className="inline-note" role="status">{testResult ? <><ShieldCheck size={14} /> 模拟测试通过，未发出网络请求</> : <><span className="small-dot" /> 示例连接，尚未连接真实服务</>}</span><Button type="button" variant="outline" size="sm" disabled={testing} onClick={testConnection}>{testing ? <LoaderCircle className="spin" /> : <PlugZap />}{testing ? '模拟测试中' : '模拟连接测试'}</Button></div>
        </section>

        <section className="settings-section" id="image-model" aria-labelledby="image-model-title">
          <div className="section-heading">
            <div className="section-icon image-icon"><Image size={19} /></div>
            <div><h2 id="image-model-title">图片模型 <span className="subtle-tag">可选</span></h2><p>为智能体提供图片生成能力。</p></div>
            <Switch aria-label="启用图片模型" checked={draft.imageEnabled} onCheckedChange={value => update('imageEnabled', value)} />
          </div>
          {draft.imageEnabled ? <div className="section-fields">
            <Field id="imageModel" label="模型名称" error={errors.imageModel}><input id="imageModel" className="prototype-input technical-input" value={draft.imageModel} onChange={event => update('imageModel', event.target.value)} aria-invalid={!!errors.imageModel} aria-describedby={errors.imageModel ? 'imageModel-error' : undefined} /></Field>
            <Field id="imageUrl" label="API 地址" error={errors.imageUrl}><input id="imageUrl" className="prototype-input technical-input" type="url" value={draft.imageUrl} onChange={event => update('imageUrl', event.target.value)} aria-invalid={!!errors.imageUrl} aria-describedby={errors.imageUrl ? 'imageUrl-error' : undefined} spellCheck={false} /></Field>
          </div> : <div className="disabled-section"><Image size={19} /><p>图片生成已关闭。开启后可以配置模型和服务地址。</p></div>}
        </section>
      </TabsContent>

      <TabsContent value="runtime" className="prototype-tab-panel">
        <section className="settings-section" aria-labelledby="permission-title">
          <div className="section-heading"><div className="section-icon"><ShieldCheck size={19} /></div><div><h2 id="permission-title">执行权限</h2><p>在自动化效率与操作安全之间取得平衡。</p></div><span className="subtle-tag">服务器级</span></div>
          <div className="section-fields"><ToggleRow id="requireApproval" title="敏感操作需要审批" description="执行文件修改、终端命令等操作前请求确认。" value={draft.requireApproval} onChange={value => update('requireApproval', value)} />
            {!draft.requireApproval && <div className="warning-note" role="status"><ShieldCheck size={16} /><span>正式接入时，关闭审批会提高操作风险。本原型不会改变真实权限。</span></div>}
          </div>
        </section>
        <section className="settings-section" aria-labelledby="runtime-title">
          <div className="section-heading"><div className="section-icon"><SlidersHorizontal size={19} /></div><div><h2 id="runtime-title">运行策略</h2><p>控制会话长度与模型思考方式。</p></div></div>
          <div className="section-fields">
            <Field id="maxTurns" label="最大会话轮数" help="单次任务的执行上限" error={errors.maxTurns}><div className="unit-input"><input id="maxTurns" type="number" min="1" max="1000" className="prototype-input" value={draft.maxTurns} onChange={event => update('maxTurns', event.target.value)} aria-invalid={!!errors.maxTurns} aria-describedby={`maxTurns-help${errors.maxTurns ? ' maxTurns-error' : ''}`} /><span>轮</span></div></Field>
            <Field id="thinkingMode" label="思考模式" help="复杂任务的推理策略"><div className="select-wrap"><select id="thinkingMode" value={draft.thinkingMode} onChange={event => update('thinkingMode', event.target.value)} aria-describedby="thinkingMode-help"><option value="adaptive">自适应 · 由模型判断任务复杂度</option><option value="standard">标准 · 优先响应速度</option><option value="extended">深度思考 · 优先推理质量</option></select><ChevronDown size={14} /></div></Field>
          </div>
        </section>
      </TabsContent>

      <TabsContent value="clients" className="prototype-tab-panel">
        <section className="settings-section" aria-labelledby="client-title">
          <div className="section-heading"><div className="section-icon"><Terminal size={19} /></div><div><h2 id="client-title">客户端能力</h2><p>管理连接到服务端的客户端体验。</p></div></div>
          <div className="section-fields"><ToggleRow id="clientCronEnabled" title="客户端定时任务" description="允许客户端创建和执行周期性任务。" value={draft.clientCronEnabled} onChange={value => update('clientCronEnabled', value)} /><ToggleRow id="showToolCalls" title="展示工具调用" description="在会话中显示工具名称、执行过程与结果。" value={draft.showToolCalls} onChange={value => update('showToolCalls', value)} /><Field id="uploadLimit" label="单个文件上传上限" help="适用于工作空间上传" error={errors.uploadLimit}><div className="unit-input"><input id="uploadLimit" type="number" min="1" max="1000" className="prototype-input" value={draft.uploadLimit} onChange={event => update('uploadLimit', event.target.value)} aria-invalid={!!errors.uploadLimit} aria-describedby={`uploadLimit-help${errors.uploadLimit ? ' uploadLimit-error' : ''}`} /><span>MB</span></div></Field></div>
        </section>
        <section className="settings-section" aria-labelledby="sso-title">
          <div className="section-heading"><div className="section-icon"><Workflow size={19} /></div><div><h2 id="sso-title">身份集成</h2><p>通过企业身份服务统一登录。</p></div><span className="subtle-tag">预览</span></div>
          <div className="section-fields"><ToggleRow id="oauthEnabled" title="企业单点登录" description="此开关仅演示状态，未接入 OAuth 身份服务。" value={draft.oauthEnabled} onChange={value => update('oauthEnabled', value)} /></div>
        </section>
      </TabsContent>
    </>
  )
}
