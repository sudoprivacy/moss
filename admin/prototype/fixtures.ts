export type SettingsTab = 'models' | 'runtime' | 'clients'

export const INITIAL_SETTINGS = {
  model: 'claude-sonnet-5',
  apiUrl: 'https://api.example.com/v1',
  apiKey: 'demo-key-not-a-real-credential',
  imageEnabled: true,
  imageModel: 'image-model',
  imageUrl: 'https://images.example.com/v1',
  requireApproval: true,
  maxTurns: '30',
  thinkingMode: 'adaptive',
  clientCronEnabled: false,
  showToolCalls: true,
  uploadLimit: '100',
  oauthEnabled: false,
}

export type Settings = typeof INITIAL_SETTINGS
export type FieldKey = keyof Settings
export type FormErrors = Partial<Record<FieldKey, string>>

export const FIELD_LABELS: Record<FieldKey, string> = {
  model: '默认文本模型',
  apiUrl: '文本模型 API 地址',
  apiKey: 'API Key',
  imageEnabled: '启用图片模型',
  imageModel: '图片模型',
  imageUrl: '图片模型 API 地址',
  requireApproval: '敏感操作需要审批',
  maxTurns: '单次会话最大轮数',
  thinkingMode: '思考模式',
  clientCronEnabled: '客户端定时任务',
  showToolCalls: '展示工具调用',
  uploadLimit: '单个文件上传上限',
  oauthEnabled: '企业单点登录',
}

export const TAB_FIELDS: Record<SettingsTab, FieldKey[]> = {
  models: ['model', 'apiUrl', 'apiKey', 'imageEnabled', 'imageModel', 'imageUrl'],
  runtime: ['requireApproval', 'maxTurns', 'thinkingMode'],
  clients: ['clientCronEnabled', 'showToolCalls', 'uploadLimit', 'oauthEnabled'],
}

export function validateSettings(settings: Settings): FormErrors {
  const errors: FormErrors = {}
  for (const key of ['apiUrl', 'imageUrl'] as const) {
    if (key === 'imageUrl' && !settings.imageEnabled) continue
    try {
      const url = new URL(settings[key])
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('protocol')
    } catch {
      errors[key] = '请输入有效的 http:// 或 https:// 地址。'
    }
  }
  if (!settings.apiKey.trim()) errors.apiKey = '请填写示例密钥，不要使用真实凭据。'
  if (settings.imageEnabled && !settings.imageModel.trim()) errors.imageModel = '请输入图片模型名称。'
  for (const key of ['maxTurns', 'uploadLimit'] as const) {
    const value = Number(settings[key])
    if (!Number.isInteger(value) || value < 1 || value > 1000) errors[key] = '请输入 1–1000 之间的整数。'
  }
  return errors
}

export function displayValue(key: FieldKey, value: Settings[FieldKey]): string {
  if (key === 'apiKey') return '••••••••（不展示内容）'
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  const names: Record<string, string> = {
    'claude-sonnet-5': 'Claude Sonnet 5',
    'claude-opus-5': 'Claude Opus 5',
    adaptive: '自适应',
    standard: '标准',
    extended: '深度思考',
  }
  return names[value] ?? value
}
