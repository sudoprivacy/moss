import { ApiRequestError } from './api/client'
export const assetStatuses: Record<string, string> = {
  discovered: '待认领',
  draft: '草稿',
  submitted: '待审核',
  returned: '已退回',
  approved: '已登记',
  suspended: '已停用',
  merged: '已合并',
}
export const evidenceStatuses: Record<string, string> = {
  none: '尚未验收',
  current: '证据有效',
  expired: '验收已过期',
  untrusted: '验收签发者已撤销',
  blocked: '待审核或受限制',
}
export const riskLabels: Record<string, string> = {
  low: '低风险',
  medium: '需关注',
  high: '高风险',
  external: '域外／不可控',
}
export const recommendationLabels: Record<string, string> = {
  public_saas_outside_execution_control: '公有 SaaS 仅登记，运行路径不在管控范围内',
  core_domain_or_core_data_requires_L2: '核心域或核心数据要求至少 L2',
  sensitive_data_mutation_requires_L2: '敏感数据写入、删除或导出要求至少 L2',
  office_gateway_control: '办公域建议完成入口、身份和模型网关纳管',
}
export function inventoryError(error: unknown): string {
  const code = error instanceof ApiRequestError ? error.code : error instanceof Error ? error.message : ''
  const labels: Record<string, string> = {
    REGISTRY_NOT_CONFIGURED: '当前服务尚未配置统一台账。',
    REGISTRY_ORGANIZATION_UNCONFIGURED: '当前组织尚未开通统一台账。',
    REGISTRY_INVENTORY_SCHEMA_REQUIRED: '台账数据库尚未初始化，请由运维执行显式初始化。',
    AGENT_ASSET_REVISION_CONFLICT: '记录已被更新，请刷新后重新操作。',
    AGENT_ASSET_IDENTITY_CONFLICT: '该来源智能体已登记，或标识冲突。请刷新台账确认。',
    REGISTRY_IDEMPOTENCY_CONFLICT: '本次操作内容已变化，请关闭窗口并重新操作。',
    AGENT_DEPARTMENT_MISMATCH: '负责人部门已变化，请重新选择负责人并刷新。',
    INVALID_MEMBER: '负责人必须是当前组织的有效成员。',
    AGENT_ASSET_OWNER_FORBIDDEN: '只能登记自己负责的智能体。',
    ADMIN_REQUIRED: '此操作需要组织管理员权限。',
    AGENT_ASSET_NOT_FOUND: '记录不存在或不在你的可见范围内。',
    AGENT_ASSET_STATE_CONFLICT: '当前状态不支持此操作，请刷新。',
    AGENT_CATALOG_LINK_INVALID: '请选择当前组织已接入的外部托管智能体。',
    AGENT_ASSET_LINK_IMMUTABLE: '已关联的目录身份不能更换。',
    AGENT_ASSET_MERGE_CONFLICT: '已关联目录的资产不能合并；请检查两条记录的状态。',
    AGENT_RISK_REDUCTION_REQUIRES_MIGRATION: '核心或敏感数据资产不能通过修改申报降低管控等级；需要受控迁移。',
    AGENT_ACCEPTANCE_EXPIRED: '验收证据已过期，需要重新验收。',
    AGENT_ACCEPTANCE_ISSUER_FORBIDDEN: '验收签发者已撤销，需要重新验收。',
    INVALID_INVENTORY_COMMAND: '登记内容不完整或不符合格式，请检查各项输入。',
    INVENTORY_EXPORT_LIMIT: '导出超过一万条，请缩小范围后重试。',
  }
  return labels[code ?? ''] ?? '台账操作未完成，请刷新核对状态后重试。'
}
