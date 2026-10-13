import { ApiRequestError } from './api/client'

const messages: Record<string, string> = {
  INVALID_REVIEW: '审核必须携带当前配置版本，请刷新后重试。',
  INVALID_RECONCILIATION: '请填写至少 10 个字符的核对依据和结论。',
  CREDENTIAL_ROTATION_REQUIRED: '凭据状态无法确认，请更换密钥后重新审核。',
  CREDENTIAL_OPERATION_EXPIRED: '操作已超时并进入恢复流程，请刷新查看当前状态。',
  CREDENTIAL_ROTATION_FAILED: '密钥更新失败，智能体保持未发布，请重试换钥。',
  UNSUPPORTED_PROVIDER_ATTACHMENTS: '当前仅支持纯文本应用，请关闭 Dify 文件和图片上传能力。',
  CONFIGURATION_CHANGED: '配置已被修改，请关闭弹窗并刷新列表后重试。',
  INVALID_MEMBER: '请选择当前组织的有效成员。',
  INVALID_POLICY: '请检查试点地址和启用状态。',
  ENDPOINT_REQUIRED: '启用试点前请填写至少一个服务地址。',
  INVALID_ENDPOINT: '请填写固定 IP 的 Dify /v1 地址。',
  CREDENTIAL_STORAGE_UNAVAILABLE: '凭据服务不可写，请检查 Nexus Secret。',
  CREDENTIAL_UNAVAILABLE: '无法读取已保存的凭据，请检查凭据服务。',
  PROVIDER_PREFLIGHT_FAILED: 'Dify 连接验证失败，请检查地址和 App API Key。',
  INVALID_DIFY_DEFINITION: '请上传有效的 Dify YAML / JSON 定义。',
  UNSUPPORTED_DIFY_DEFINITION: '当前仅支持 Start、LLM、Answer 节点。',
  DEFINITION_TOO_LARGE: '定义文件超过 256 KB。',
  DEFINITION_READ_FAILED: '无法读取文件，请重新选择。',
  REGISTRATION_FAILED: '接入失败且未发布。请检查凭据服务后重试。',
  REGISTRATION_IN_PROGRESS: '接入请求仍在处理中，请稍后刷新。',
  IDEMPOTENCY_CONFLICT: '此请求内容已变化，请关闭窗口并重新接入。',
  INVALID_ADMIN_INPUT: '请检查必填字段及输入格式。',
  PLATFORM_ADMIN_REQUIRED: '仅平台管理员可以修改试点范围。',
  EXTERNAL_PROVIDER_UNAVAILABLE: '外部智能体服务暂不可用，请联系管理员。',
  ENDPOINT_NOT_APPROVED: '该服务地址不在当前组织的允许范围内。',
  PILOT_NOT_ENABLED: '当前组织尚未启用试点。',
  UNSUPPORTED_PROVIDER_INPUTS: '此应用不支持当前试点，请使用简单文本 Chatflow。',
  CREDENTIAL_UPDATE_IN_PROGRESS: '密钥正在更换，请稍后刷新。',
}

export function externalAgentError(error: unknown): string {
  const code = error instanceof ApiRequestError ? error.code : error instanceof Error ? error.message : undefined
  return (code && messages[code]) || '操作失败，请刷新重试或联系管理员。'
}
