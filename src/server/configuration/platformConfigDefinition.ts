export const PLATFORM_PROVIDERS = ['sms', 'sudorouter', 'fuiou', 'dify', 'qms'] as const
export type PlatformProvider = typeof PLATFORM_PROVIDERS[number]
export type PlatformValue = string | number | boolean | string[]
export type PlatformValues = Record<string, PlatformValue>
export interface PlatformField {
  key: string
  label: string
  type: 'text' | 'url' | 'number' | 'boolean' | 'lines' | 'secret'
  required?: boolean
  min?: number
  max?: number
}
const field = (key: string, label: string, type: PlatformField['type'] = 'text', required = false): PlatformField => ({ key, label, type, required })
const number = (key: string, label: string, min = 1, max = 86400000): PlatformField => ({ key, label, type: 'number', min, max })
const enabled = field('enabled', '启用服务', 'boolean')
export const PLATFORM_DEFINITIONS: Record<PlatformProvider, { label: string; description: string; fields: PlatformField[] }> = {
  sms: {
    label: '腾讯短信', description: '所有组织共用的短信通道；登录方式在组织策略中选择。',
    fields: [enabled, field('sdkAppId', 'SDK App ID', 'text', true), field('signName', '短信签名', 'text', true),
      field('templateId', '模板 ID', 'text', true), field('region', '地域', 'text', true),
      field('templateParams', '模板参数（每行一个）', 'lines'), number('codeTtlSec', '验证码有效期（秒）', 60, 3600),
      number('resendCooldownSec', '重发间隔（秒）', 1, 3600), number('maxSendsPerHour', '每小时最多发送次数', 1, 100),
      number('maxVerifyAttempts', '验证码最多尝试次数', 1, 20),
      field('secretId', 'Secret ID', 'secret', true), field('secretKey', 'Secret Key', 'secret', true)],
  },
  sudorouter: {
    label: 'Sudorouter', description: '平台共用的账号与额度管理 API；模型服务地址在各组织的系统设置中配置。',
    fields: [enabled, field('baseUrl', '管理 API 根地址', 'url', true), field('adminUserId', '管理员用户 ID', 'text', true),
      number('timeoutMs', '请求超时（毫秒）'), field('apiToken', '平台管理 Token', 'secret', true)],
  },
  fuiou: {
    label: '富友支付', description: '平台商户及支付连接配置；组织充值策略独立管理。',
    fields: [enabled, field('testMode', '使用测试环境', 'boolean'), field('merchantCode', '商户号', 'text', true),
      field('testApiUrl', '测试支付地址', 'url'), field('prodApiUrl', '生产支付地址', 'url'),
      field('testRefundUrl', '测试退款地址', 'url'), field('prodRefundUrl', '生产退款地址', 'url'),
      field('callbackBaseUrl', '支付回调根地址', 'url'), number('timeoutMs', '请求超时（毫秒）'),
      field('merchantPrivateKey', '商户私钥', 'secret', true), field('publicKey', '富友平台公钥', 'secret', true)],
  },
  dify: {
    label: 'Dify', description: '平台管理连接与 SSO 凭据；企业空间和应用绑定保持组织隔离。',
    fields: [enabled, field('baseUrl', '服务地址', 'url', true), number('timeoutMs', '请求超时（毫秒）'), field('systemToken', 'System Token', 'secret', true),
      field('provisionSecret', '开户 Secret', 'secret'), field('ssoSecret', 'SSO Secret', 'secret')],
  },
  qms: {
    label: 'QMS', description: '遥测数据库、队列和通知配置；企业数据访问权限保持隔离。',
    fields: [enabled, field('apiKeyHeader', 'API Key 请求头', 'text', true), field('encryptionRequired', '要求遥测加密', 'boolean'),
      number('queueFlushIntervalMs', '队列刷新间隔（毫秒）'), number('queueBatchSize', '批量大小', 1, 10000),
      number('perfRetentionDays', '性能数据保留天数', 1, 3650), number('conversationRetentionDays', '对话数据保留天数', 1, 3650),
      field('postgresUrl', 'PostgreSQL 连接地址', 'secret', true), field('redisUrl', 'Redis 连接地址', 'secret', true),
      field('apiKey', 'API Key', 'secret', true), field('privateKeyPem', '遥测私钥', 'secret'), field('publicKeyPem', '遥测公钥', 'secret'),
      field('larkWebhookUrl', '飞书 Webhook', 'secret'), field('smtpUrl', 'SMTP 连接地址', 'secret')],
  },
}
export function isPlatformProvider(value: string): value is PlatformProvider {
  return (PLATFORM_PROVIDERS as readonly string[]).includes(value)
}
