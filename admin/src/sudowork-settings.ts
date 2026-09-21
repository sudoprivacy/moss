import type { ConfigScope } from '../lib/api/types'

export const SUDOWORK_LOGIN_METHODS = [
  { value: '0', label: '手机验证码' },
  { value: '1', label: '用户名密码' },
  { value: '2', label: 'CAS 三方认证' },
] as const

const POLICY_KEYS = new Set([
  'login_method', 'third_party_auth', 'log_report', 'version_update',
  'product_improvement', 'scode_auto_model', 'recharge_mode', 'credit_application',
  'client_cron_enabled', 'client_show_tool_calls', 'workspace_upload_limit_bytes',
])

export function buildSudoworkConfigPatch(config: Record<string, unknown>, dirtyKeys: ReadonlySet<string>, scope: ConfigScope = 'organization') {
  const patch: Record<string, unknown> = {}
  for (const key of dirtyKeys) {
    if (!POLICY_KEYS.has(key) && !(scope === 'platform' && (key === 'sms' || key === 'billing'))) continue
    const value = config[key]
    if (key === 'log_report') {
      const log = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
      patch.log_report = {
        enabled: log.enabled, protocol: log.protocol, domain: log.domain,
        ...(scope === 'platform' && typeof log.key === 'string' && log.key ? { key: log.key } : {}),
      }
    } else {
      patch[key] = value
    }
  }
  return patch
}
