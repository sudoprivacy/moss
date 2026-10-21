import { ApiRequestError } from './api/client'
import type { AssetRecord, HostedArtifact } from './api/agent-inventory'

/** Display the exact reviewed artifact; server admission remains authoritative. */
export function hostedArtifactAdmitted(asset: AssetRecord, artifact: HostedArtifact): boolean {
  const acceptance = asset.acceptance
  return asset.status === 'approved' && ['L2', 'L3'].includes(asset.actual_level)
    && asset.evidence_status === 'current' && !!acceptance && acceptance.expires_at > Date.now()
    && artifact.asset_id === asset.id && artifact.metadata_digest === asset.metadata_digest
    && acceptance.metadata_digest === artifact.metadata_digest && acceptance.spec_digest === artifact.spec_digest
    && acceptance.execution_revision === artifact.image.image_id
}
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
    HOSTED_RESOURCE_LIMITS_UNAVAILABLE: '执行节点无法落实内存、交换空间或进程数量限制。请部署管理员检查容器运行环境，当前任务不会启动。',
    HOSTED_CLEANUP_UNCONFIRMED: '尚未确认执行容器已清理，请核对执行节点后再关闭会话。',
    REGISTRY_RESOURCE_NOT_FOUND: '未找到版本快照或 Nexus 文件接口。请检查文件服务部署后重试相同版本。',
    REGISTRY_RESOURCE_UNAVAILABLE: 'Nexus 文件服务暂时不可用，请恢复服务后核对版本快照。',
    REGISTRY_RESOURCE_DIGEST_MISMATCH: '版本快照摘要与制品不一致，已拒绝发布或执行。',
    EVALUATION_SOURCE_RUNTIME_INVALID: '原工程运行环境或协议不符合当前支持范围，请检查部署配置。',
    EVALUATION_SOURCE_EXECUTION_FAILED: '原工程执行未确认完成，请查看已保存的调用记录；已开始的用例不会自动重发。',
    AGENT_MIGRATION_COMPARISON_REQUIRED: 'L2 验收必须关联已保存的迁移对比，独立评测或人工填写的分数不能代替。',
    AGENT_MIGRATION_COMPARISON_MISMATCH: '验收报告与迁移对比、镜像或评测集不一致，或对比未通过。',

    EVALUATION_NOT_SETTLED: '所有用例结束并确认执行与凭证清理后才能固定阈值或生成对比；请先核对未知结果。',
    EVALUATION_POLICY_REQUIRED: '此托管运行未预先绑定迁移阈值，不能补挂；请按已保存阈值创建新的候选运行。',
    EVALUATION_POLICY_MISMATCH: '迁移阈值与当前资产、制品或评测集不一致，请重新选择。',
    EVALUATION_SOURCE_BASELINE_REQUIRED: '固定迁移阈值需要原平台基线，独立托管评测不能作为基线。',

    EVALUATION_THRESHOLD_INVALID: '阈值应为 0 到 100 之间的数字，最多两位小数。',
    EVALUATION_SOURCE_UNAVAILABLE: '原平台当前不可访问，或控制台凭据已过期，请刷新部署凭据后重试尚未开始的用例。',
    EVALUATION_SOURCE_MISMATCH: '原平台内容、模型或登记制品不一致，已拒绝作为迁移基线。',
    EVALUATION_SOURCE_CHANGED: '原平台发布内容或执行凭据在评测期间发生变化，本次结果需核对，不会自动重发。',
    EVALUATION_SOURCE_KEY_MISMATCH: '基线调用凭据不属于指定的 Dify 应用。',
    EVALUATION_SOURCE_EVIDENCE_REQUIRED: '原平台未返回可核对的运行编号，无法确认基线成功。',

    EVALUATION_RUN_SCHEMA_REQUIRED: '评测运行数据库尚未初始化，请由部署管理员执行显式初始化。',
    EVALUATION_SOURCE_NOT_CONFIGURED: '原平台基线运行器尚未配置，不能用托管镜像代替原平台执行。',
    HOSTED_NOT_CONFIGURED: '当前环境尚未配置托管执行服务。',
    HOSTED_MODEL_NOT_CONFIGURED: '此制品使用的模型尚未连接托管执行环境。',
    HOSTED_RUNTIME_UNAVAILABLE: '托管运行环境不可用，请核对镜像和执行服务。',
    EVALUATION_CASE_IN_PROGRESS: '已有用例正在执行；请刷新查看结果，超时后可核对。',
    EVALUATION_CLEANUP_UNCONFIRMED: '上一个用例的运行环境或凭证清理尚未确认，已阻止继续执行。',
    EVALUATION_CAPACITY_LIMIT: '待执行评测已达到容量上限，请先完成或停止已有评测。',
    EVALUATION_CASE_INTERRUPTED: '执行确认超时，结果保持未知，不会自动重发。',
    EVALUATION_STOPPED: '评测已停止，未开始的用例已关闭。',
    HOSTED_RESULT_UNCONFIRMED: '未能确认运行结果，请核对执行记录。',
    MODEL_EXECUTION_UNCONFIRMED: '模型可能已执行并计费，但返回结果未确认。此用例不会重发，请核对模型调用和账单。',
    MODEL_CALL_INTERRUPTED: '模型调用确认中断，结果保持未知。核对账单不会重新执行模型。',
    HOSTED_MODEL_UNCONFIRMED: '模型未返回可确认的结果，此用例不会重发。',
    MODEL_RECONCILIATION_PENDING: '模型调用或凭证清理尚未确认，请核对后再继续。',
    EVALUATION_IAM_CLEANUP_PENDING: '执行凭证回收尚未确认，请再次核对。',
    EVALUATION_CREDENTIAL_UNAVAILABLE: '一次性执行凭证已无法取回；此用例不会重新运行。',
    EVALUATION_SCHEMA_REQUIRED: '评测数据库尚未初始化，请由部署管理员执行显式初始化。',
    EVALUATION_VERSION_CONFLICT: '同名同版本的评测集已存在，请使用新版本号。',
    EVALUATION_IDEMPOTENCY_CONFLICT: '此次提交内容已变化，请重新编辑后提交。',
    EVALUATION_ASSET_NOT_ADMITTED: '台账资料或状态已变化，请刷新后重新核对。',
    EVALUATION_DATASET_LIMIT: '评测集超过大小限制，请减少样本或缩短内容。',
    INVALID_EVALUATION_DATASET: '请检查评测集名称、版本和样本；每个样本必须包含输入和预期结果。',
    HOSTED_SCHEMA_REQUIRED: '托管制品数据库尚未初始化，请由部署管理员执行显式初始化。',
    HOSTED_ASSET_NOT_ADMITTED: '台账资料或状态已变化，请刷新后核对负责人、模型资源和托管位置。',
    HOSTED_SOURCE_MISMATCH: '源文件、模型或输出上限与镜像描述不一致，请重新构建并核对制品。',
    HOSTED_PLATFORM_MISMATCH: '镜像类型与台账的来源平台不一致。',
    HOSTED_BUILT_IMAGE_REQUIRED: '请提供实际构建完成的镜像摘要。',
    HOSTED_IDEMPOTENCY_CONFLICT: '本次登记内容已变化，请重新选择文件后提交。',
    INVALID_HOSTED_ARTIFACT: '镜像描述不符合托管制品格式，请检查导出的 JSON 文件。',
    DIFY_UNSUPPORTED: 'DSL 含当前不支持的结构、依赖或参数。请核对支持范围，系统未忽略这些内容。',
    DIFY_YAML_INVALID: 'DSL 不是有效的 UTF-8 YAML 文件。',
    DIFY_YAML_DUPLICATE_OR_NONSTRING_KEY: 'DSL 含重复字段或非文本字段名，请修正后重新导入。',
    DIFY_YAML_ALIAS_DENIED: 'DSL 使用了不支持的 YAML 别名，请展开后重新导入。',
    DIFY_YAML_COMPLEXITY: 'DSL 的嵌套或节点数超出当前导入限制。',
    DIFY_SOURCE_SIZE: 'DSL 文件为空或超过 256 KB 限制。',
    REGISTRY_NOT_CONFIGURED: '当前服务尚未配置统一台账。',
    REGISTRY_ORGANIZATION_UNCONFIGURED: '当前组织尚未开通统一台账。',
    REGISTRY_INVENTORY_SCHEMA_REQUIRED: '台账数据库尚未初始化，请由运维执行显式初始化。',
    AGENT_SUSPENSION_ACTIVE: '智能体处于停用状态。回收确认后请重新提交审核，才可恢复使用。',
    AGENT_SUSPENSION_PENDING: '停用回收尚未确认，请在详情中核对进度。',
    AGENT_ASSET_REVISION_CONFLICT: '记录已被更新，请刷新后重新操作。',
    AGENT_ASSET_IDENTITY_CONFLICT: '该来源智能体已登记，或标识冲突。请刷新台账确认。',
    REGISTRY_IDEMPOTENCY_CONFLICT: '本次操作内容已变化，请关闭窗口并重新操作。',
    AGENT_DEPARTMENT_MISMATCH: '负责人部门已变化，请重新选择负责人并刷新。',
    INVALID_MEMBER: '负责人必须是当前组织的有效成员。',
    AGENT_ASSET_OWNER_FORBIDDEN: '只能登记自己负责的智能体。',
    HOSTED_ENROLLMENT_REQUIRED: '请先登记托管目录身份。',
    HOSTED_ASSET_LINK_MIGRATION_REQUIRED: '此资产已关联另一目录，需先完成受控迁移，不能直接替换身份。',
    HOSTED_RELEASE_ARTIFACT_MISMATCH: '版本与制品不一致，请刷新并选择当前台账对应的制品。',
    HOSTED_CATALOG_IDENTITY_CONFLICT: '托管目录身份不一致，请核对注册中心配置。',
    INVALID_RELEASE_INPUT: '请检查版本号、审核理由和有效期。',
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
    AGENT_ASSET_ALREADY_CLAIMED: '此资产已被认领，请刷新查看负责人。',
    AGENT_ASSET_OWNER_REQUIRED: '请先认领或指定有效负责人，再提交登记。',
    DISCOVERY_ORIGIN_NOT_APPROVED: '服务地址未获当前组织批准，请由部署管理员配置发现来源地址。',
    DISCOVERY_SCOPE_MISMATCH: '来源返回的工作区或账户与配置不一致，已拒绝导入。',
    DISCOVERY_SOURCE_DISABLED: '发现来源已停用或服务地址已撤销。',
    DISCOVERY_UPSTREAM_UNAVAILABLE: '无法读取来源，请检查服务状态、控制台访问令牌及读取权限。',
    DISCOVERY_CREDENTIAL_UNAVAILABLE: '来源凭据已不可用，请重新添加发现来源。',
    DISCOVERY_RESPONSE_INVALID: '来源响应不符合支持的清单格式，请核对平台版本。',
    DISCOVERY_PAGINATION_INVALID: '来源分页结果不一致，未声明扫描完整。',
    DISCOVERY_SCAN_LIMIT: '来源超出单次扫描限制，请缩小工作区或扫描范围。',
    DISCOVERY_SOURCE_LIMIT: '最多启用 20 个来源，请先停用不再使用的来源。',
    INVALID_DISCOVERY_SOURCE: '发现来源配置不完整，请检查名称、范围和访问令牌。',
    CREDENTIAL_STORAGE_UNAVAILABLE: '密钥库不可用，无法保存发现来源凭据。',
  }
  const field = error instanceof ApiRequestError && code?.startsWith('DIFY_')
    ? /^DSL_FIELD:([A-Za-z0-9_.$\[\]]{1,160})$/.exec(error.message)?.[1] : undefined
  return (labels[code ?? ''] ?? '台账操作未完成，请刷新核对状态后重试。') + (field ? ` 位置：${field}。` : '')
}
