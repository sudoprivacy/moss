import { randomUUID } from 'node:crypto'
import { IdentityRepository } from '../identity/identityRepository.js'
import type { ParkStore } from './store.js'
import type { IncomingMessage } from 'node:http'

export interface ParkAuditDetails {
  action?: string
  resource?: string
  resourceId?: string | null
  objectName?: string | null
  actorName?: string
  requestedName?: string
  parentId?: string
  parentName?: string
}

const requestDetails = new WeakMap<IncomingMessage, ParkAuditDetails>()

/** Only authenticated business handlers populate this context; the error boundary reads it. */
export function parkAuditContext(req: IncomingMessage): ParkAuditDetails {
  let details = requestDetails.get(req)
  if (!details) { details = {}; requestDetails.set(req, details) }
  return details
}

/** Known routes describe the operation; only business handlers supply name snapshots. */
function describeOperation(path: string, method: string): Required<Pick<ParkAuditDetails, 'action' | 'resource'>> & Pick<ParkAuditDetails, 'resourceId' | 'objectName'> {
  const suffix = path.replace(/^\/api\/v1\/parks\/[^/]+\//, '')
  const routes: Array<[RegExp, string, string, string?]> = [
    [/^roles\/([^/]+)$/, '设置园区角色', 'user'],
    [/^leads\/([^/]+)\/claim$/, '认领线索', 'lead'],
    [/^leads\/([^/]+)\/follow-ups$/, '记录跟进', 'lead'],
    [/^leads\/([^/]+)$/, '更新线索状态', 'lead'],
    [/^admin\/config$/, '修改园区内容设置', 'park_config', '园区内容设置'],
    [/^admin\/policy\/tree\/nodes$/, '创建政策目录', 'policy_node'],
    [/^admin\/policy\/nodes\/([^/]+)\/documents$/, '上传政策文件', 'policy_document'],
    [/^admin\/policy\/documents\/([^/]+)$/, '删除政策文件', 'policy_document'],
    [/^admin\/policy\/wikis$/, '创建知识库', 'policy_wiki'],
    [/^admin\/policy\/wikis\/([^/]+)\/build$/, '构建知识库', 'policy_wiki'],
    [/^admin\/policy\/wikis\/([^/]+)$/, '修改知识库', 'policy_wiki'],
    [/^admin\/quick-questions(?:\/([^/]+))?$/, method === 'DELETE' ? '删除快捷问题' : '保存快捷问题', 'quick_question'],
    [/^admin\/assistant$/, '保存咨询助手配置', 'assistant', '园区公开咨询助手'],
    [/^admin\/rate-limits$/, '修改限流配置', 'rate_config', '园区限流配置'],
    [/^admin\/redaction$/, '修改脱敏策略', 'redaction_config', '园区脱敏策略'],
    [/^admin\/public-links(?:\/([^/]+))?$/, method === 'DELETE' ? '删除渠道链接' : '保存渠道链接', 'public_link'],
  ]
  if (method === 'GET') {
    const queries: Array<[RegExp, string, string, string?]> = [
      [/^me$/, '查询园区角色', 'park', '园区角色'],
      [/^metrics$/, '查询园区统计', 'park', '园区统计'],
      [/^reports$/, '查询月度报告', 'park', '月度报告'],
      [/^compliance\/summary$/, '查询合规统计', 'park', '合规统计'],
      [/^leads\/summary$/, '查询线索统计', 'lead', '线索统计'],
      [/^follow-ups$/, '查询跟进记录', 'lead', '跟进记录列表'],
      [/^leads$/, '查询线索列表', 'lead', '线索列表'],
      [/^leads\/([^/]+)$/, '查询线索', 'lead'],
      [/^admin\/policy\/tree$/, '查询政策目录', 'policy_node', '政策文件目录'],
      [/^admin\/policy\/nodes\/([^/]+)\/documents$/, '查询政策文件列表', 'policy_node', '政策文件列表'],
      [/^admin\/policy\/documents\/([^/]+)$/, '查询政策文件', 'policy_document'],
      [/^admin\/policy\/wikis$/, '查询知识库列表', 'policy_wiki', '政策知识库列表'],
      [/^admin\/policy\/wikis\/([^/]+)\/(build-status|sources)$/, '查询知识库信息', 'policy_wiki'],
      [/^admin\/public-links$/, '查询渠道链接', 'public_link', '渠道链接列表'],
      [/^admin\/public-links\/([^/]+)\/qr$/, '查询渠道二维码', 'public_link'],
      [/^admin\/quick-questions$/, '查询快捷问题', 'quick_question', '快捷问题列表'],
      [/^admin\/audit-events$/, '查询审计记录', 'park', '审计记录列表'],
      [/^admin\/operations$/, '查询盒子状态', 'box', '园区盒子'],
      [/^admin\/config$/, '查询园区内容设置', 'park_config', '园区内容设置'],
      [/^admin\/assistant$/, '查询咨询助手配置', 'assistant', '园区公开咨询助手'],
      [/^admin\/rate-limits$/, '查询限流配置', 'rate_config', '园区限流配置'],
      [/^admin\/redaction$/, '查询脱敏策略', 'redaction_config', '园区脱敏策略'],
    ]
    for (const [pattern, action, resource, objectName] of queries) {
      const match = pattern.exec(suffix)
      if (match) return { action, resource, resourceId: match[1] ?? null, objectName }
    }
    return { action: '查询园区信息', resource: 'park', objectName: '园区信息' }
  }
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return { action: '未识别操作', resource: 'park' }
  for (const [pattern, action, resource, objectName] of routes) {
    const match = pattern.exec(suffix)
    if (match) return /^admin\/policy\/nodes\/[^/]+\/documents$/.test(suffix)
      ? { action, resource, resourceId: null, objectName }
      : { action, resource, resourceId: match[1] ?? null, objectName }
  }
  const operation = /^admin\/operations\/(backup|restore|verify-upgrade|upgrade|rollback|reindex)$/.exec(suffix)
  const operations: Record<string, string> = { backup: '备份数据', restore: '恢复数据', 'verify-upgrade': '校验升级包', upgrade: '安装升级包', rollback: '回滚版本', reindex: '重新索引政策库' }
  return operation
    ? { action: operations[operation[1]!]!, resource: 'box', objectName: '园区盒子' }
    : { action: '未识别操作', resource: 'park' }
}

export async function recordParkAudit(store: ParkStore, orgId: string, pathname: string, method: string, status: number, actorId: string | null, message?: string, details: ParkAuditDetails = {}): Promise<void> {
  const operation = { ...describeOperation(pathname, method), ...details }
  const id = randomUUID()
  await new IdentityRepository(store.db).insertOperationAudit({
    id, orgId, actorUserId: actorId, actorName: operation.actorName,
    action: operation.action, resource: operation.resource, resourceId: operation.resourceId,
    requestData: {
      ...(operation.objectName ? { object_name: operation.objectName } : {}),
      ...(operation.requestedName ? { requested_name: operation.requestedName } : {}),
      ...(operation.parentId ? { parent_id: operation.parentId, parent_name: operation.parentName } : {}),
    },
    method, path: pathname, responseStatus: status, errorMessage: message ?? null, idempotencyKey: id,
  })
}

export function presentParkAudit(row: { action: string; resource?: string; resource_id?: string | null; method: string; path: string; request_data_json?: string | null; response_status?: number }, historicalName?: string) {
  const previous = describeOperation(row.path, row.method)
  let data: Record<string, unknown> = {}
  try { const parsed: unknown = JSON.parse(row.request_data_json || '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown> } catch { /* Legacy records may contain other payloads. */ }
  const name = data.object_name
  const resourceId = row.resource_id || previous.resourceId
  return {
    action_label: row.action.startsWith('park.') ? previous.action : row.action,
    object_label: typeof name === 'string' && name.trim() ? name
      : previous.objectName || (historicalName ? `${historicalName}（历史文件名称）`
        : typeof data.requested_name === 'string' && data.requested_name.trim() ? `${data.requested_name}（请求名称，未确认对象）`
        : `${row.response_status !== undefined && row.response_status >= 400 ? '未确认对象名称' : '历史记录未保存对象名称'}${resourceId ? `（${resourceId}）` : ''}`),
  }
}

export async function presentStoredParkAudit(store: ParkStore, orgId: string, row: Parameters<typeof presentParkAudit>[0]) {
  const operation = describeOperation(row.path, row.method)
  const id = row.resource_id || operation.resourceId
  const history = operation.resource === 'policy_document' && id ? await store.documentHistory(orgId, id) : undefined
  return presentParkAudit(row, history?.fileName)
}
