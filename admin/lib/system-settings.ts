import type { SystemSettings, ThinkingMode, UpdateSystemSettingsRequest } from './api/types'

export type SettingsTab = 'models' | 'runtime' | 'clients'
export type SecretDraft = { action: 'keep' | 'replace' | 'clear'; value: string }
export type SettingsDraft = {
  model: string
  url: string
  apiKey: SecretDraft
  imageProvider: string
  imageUrl: string
  imageApiKey: SecretDraft
  imageModel: string
  tenantId: string
  bypassPermissions: boolean
  maxTurns: string
  cronReuseMaxRuns: string
  imReuseMaxTurns: string
  thinkingMode: ThinkingMode
  thinkingBudgetTokens: string
  clientCronEnabled: boolean
  clientShowToolCalls: boolean
  uploadLimitMiB: string
  oauthEnabled: boolean
  oauthRequireState: boolean
  authorizeUrlTemplate: string
}
export type SettingsField = keyof SettingsDraft
export type SettingsErrors = Partial<Record<SettingsField, string>>
export const MIB = 1024 * 1024

export const FIELD_LABELS: Record<SettingsField, string> = {
  model: '默认模型', url: 'API 地址', apiKey: '文本模型 API Key',
  imageProvider: '图片提供商', imageUrl: '图片 API 地址', imageApiKey: '图片模型 API Key', imageModel: '图片模型',
  tenantId: '专属资产租户 ID', bypassPermissions: '跳过权限确认', maxTurns: '最大对话轮数',
  cronReuseMaxRuns: '定时任务会话复用上限', imReuseMaxTurns: 'IM 会话轮换上限',
  thinkingMode: '思考模式', thinkingBudgetTokens: '思考预算',
  clientCronEnabled: '客户端定时任务', clientShowToolCalls: '默认显示工具调用', uploadLimitMiB: '单文件上传上限',
  oauthEnabled: 'OAuth2 登录', oauthRequireState: '校验 State', authorizeUrlTemplate: '授权地址模板',
}

export const TAB_FIELDS: Record<SettingsTab, SettingsField[]> = {
  models: ['model', 'url', 'apiKey', 'imageProvider', 'imageUrl', 'imageApiKey', 'imageModel'],
  runtime: ['bypassPermissions', 'maxTurns', 'cronReuseMaxRuns', 'imReuseMaxTurns', 'thinkingMode', 'thinkingBudgetTokens'],
  clients: ['clientCronEnabled', 'clientShowToolCalls', 'uploadLimitMiB', 'tenantId', 'oauthEnabled', 'oauthRequireState', 'authorizeUrlTemplate'],
}

export function createSettingsDraft(settings: SystemSettings): SettingsDraft {
  return {
    model: settings.model, url: settings.url, apiKey: { action: 'keep', value: '' },
    imageProvider: settings.image.provider, imageUrl: settings.image.url,
    imageApiKey: { action: 'keep', value: '' }, imageModel: settings.image.model,
    tenantId: settings.skillStore.tenantId, bypassPermissions: settings.bypassPermissions,
    maxTurns: String(settings.maxTurns), cronReuseMaxRuns: String(settings.cronReuseMaxRuns),
    imReuseMaxTurns: String(settings.imReuseMaxTurns), thinkingMode: settings.thinkingMode,
    thinkingBudgetTokens: String(settings.thinkingBudgetTokens),
    clientCronEnabled: settings.clientCronEnabled, clientShowToolCalls: settings.clientShowToolCalls,
    // Do not round: the API permits any whole-byte limit, including less than 1 MiB.
    uploadLimitMiB: String(settings.workspaceUploadLimitBytes / MIB),
    oauthEnabled: settings.oauth2.enabled, oauthRequireState: settings.oauth2.requireState,
    authorizeUrlTemplate: settings.oauth2.authorizeUrlTemplate,
  }
}

export function validateSettingsDraft(draft: SettingsDraft): SettingsErrors {
  const errors: SettingsErrors = {}
  if (!draft.model.trim()) errors.model = '请输入默认模型名称。'
  for (const key of ['apiKey', 'imageApiKey'] as const) {
    if (draft[key].action === 'replace' && !draft[key].value.trim()) errors[key] = '请输入新密钥，或选择保持不变 / 清除。'
  }
  for (const key of ['url', 'imageUrl', 'authorizeUrlTemplate'] as const) {
    const value = draft[key].trim()
    if (!value) continue
    try {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('Invalid URL')
    } catch {
      errors[key] = '请输入完整的 http:// 或 https:// 地址。'
    }
  }
  if (draft.oauthEnabled && !draft.authorizeUrlTemplate.trim()) errors.authorizeUrlTemplate = '启用 OAuth2 时需要填写授权地址模板。'
  const ranges = [
    ['maxTurns', 1, 10000], ['cronReuseMaxRuns', 0, 10000],
    ['imReuseMaxTurns', 0, 10000], ['thinkingBudgetTokens', 1024, 128000],
  ] as const
  for (const [key, min, max] of ranges) {
    if (key === 'thinkingBudgetTokens' && draft.thinkingMode !== 'enabled') continue
    if (!/^\d+$/.test(draft[key].trim()) || Number(draft[key]) < min || Number(draft[key]) > max) {
      errors[key] = `请输入 ${min.toLocaleString()}–${max.toLocaleString()} 之间的整数。`
    }
  }
  const bytes = Number(draft.uploadLimitMiB) * MIB
  if (!draft.uploadLimitMiB.trim() || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 1024 * MIB) {
    errors.uploadLimitMiB = '请输入大于 0、最多 1024 MiB 的大小，换算后须为整数个字节。'
  }
  return errors
}

export function buildSystemSettingsPatch(settings: SystemSettings, draft: SettingsDraft): UpdateSystemSettingsRequest {
  if (settings.settingsParseError) throw new Error('配置文件解析失败，请先在服务器修复后重新加载。')
  if (Object.keys(validateSettingsDraft(draft)).length) throw new Error('请先修正配置中的错误。')
  const patch: UpdateSystemSettingsRequest = {}
  for (const key of ['model', 'url', 'thinkingMode'] as const) {
    if (draft[key].trim() !== settings[key]) Object.assign(patch, { [key]: draft[key].trim() })
  }
  for (const key of ['bypassPermissions', 'clientCronEnabled', 'clientShowToolCalls'] as const) {
    if (draft[key] !== settings[key]) patch[key] = draft[key]
  }
  for (const key of ['maxTurns', 'cronReuseMaxRuns', 'imReuseMaxTurns', 'thinkingBudgetTokens'] as const) {
    // A hidden, unfinished budget input must not be serialized as 0 / NaN.
    if (key === 'thinkingBudgetTokens' && draft.thinkingMode !== 'enabled') continue
    if (Number(draft[key]) !== settings[key]) patch[key] = Number(draft[key])
  }
  const bytes = Number(draft.uploadLimitMiB) * MIB
  if (bytes !== settings.workspaceUploadLimitBytes) patch.workspaceUploadLimitBytes = bytes
  if (draft.apiKey.action !== 'keep') patch.apiKey = draft.apiKey.action === 'clear' ? '' : draft.apiKey.value.trim()
  const image: NonNullable<UpdateSystemSettingsRequest['image']> = {}
  if (draft.imageProvider !== settings.image.provider) image.provider = draft.imageProvider
  if (draft.imageUrl.trim() !== settings.image.url) image.url = draft.imageUrl.trim()
  if (draft.imageModel.trim() !== settings.image.model) image.model = draft.imageModel.trim()
  if (draft.imageApiKey.action !== 'keep') image.apiKey = draft.imageApiKey.action === 'clear' ? '' : draft.imageApiKey.value.trim()
  if (Object.keys(image).length) patch.image = image
  if (draft.tenantId.trim() !== settings.skillStore.tenantId) patch.skillStore = { tenantId: draft.tenantId.trim() }
  const oauth2: NonNullable<UpdateSystemSettingsRequest['oauth2']> = {}
  if (draft.oauthEnabled !== settings.oauth2.enabled) oauth2.enabled = draft.oauthEnabled
  if (draft.oauthRequireState !== settings.oauth2.requireState) oauth2.requireState = draft.oauthRequireState
  if (draft.authorizeUrlTemplate.trim() !== settings.oauth2.authorizeUrlTemplate) oauth2.authorizeUrlTemplate = draft.authorizeUrlTemplate.trim()
  if (Object.keys(oauth2).length) patch.oauth2 = oauth2
  return patch
}

export type SettingsChange = { field: SettingsField; label: string; before: string; after: string }

export function getSettingsChanges(settings: SystemSettings, draft: SettingsDraft): SettingsChange[] {
  const baseline = createSettingsDraft(settings)
  const display = (field: SettingsField, value: SettingsDraft[SettingsField]) => {
    if (typeof value === 'boolean') return value ? '开启' : '关闭'
    if (typeof value === 'object') return '已隐藏'
    if (field === 'uploadLimitMiB') return `${value} MiB`
    return value || '未设置'
  }
  return (Object.keys(FIELD_LABELS) as SettingsField[]).flatMap(field => {
    const value = draft[field]
    if (typeof value === 'object') {
      const configured = field === 'apiKey' ? Boolean(settings.apiKey) : Boolean(settings.image.apiKey)
      if (value.action === 'keep' || (value.action === 'clear' && !configured)) return []
      return [{ field, label: FIELD_LABELS[field], before: configured ? '已配置（已隐藏）' : '未配置', after: value.action === 'clear' ? '清除密钥' : '替换为新密钥（已隐藏）' }]
    }
    if (field === 'thinkingBudgetTokens' && draft.thinkingMode !== 'enabled') return []
    return value === baseline[field] ? [] : [{ field, label: FIELD_LABELS[field], before: display(field, baseline[field]), after: display(field, value) }]
  })
}

export function getRedactedSettings(settings: SystemSettings) {
  return {
    ...settings,
    apiKey: settings.apiKey ? '[已配置，已隐藏]' : '[未配置]',
    image: { ...settings.image, apiKey: settings.image.apiKey ? '[已配置，已隐藏]' : '[未配置]' },
  }
}
