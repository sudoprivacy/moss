import { randomUUID } from 'node:crypto'
import { IdentityRepository } from '../identity/identityRepository.js'
import type { ParkStore } from './store.js'

export interface ParkAuditDetails {
  action?: string
  resource?: string
  resourceId?: string | null
  objectName?: string | null
  actorName?: string
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
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return { action: '未识别操作', resource: 'park' }
  for (const [pattern, action, resource, objectName] of routes) {
    const match = pattern.exec(suffix)
    if (match) return { action, resource, resourceId: match[1] ?? null, objectName }
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
    requestData: operation.objectName ? { object_name: operation.objectName } : undefined,
    method, path: pathname, responseStatus: status, errorMessage: message ?? null, idempotencyKey: id,
  })
}

export function presentParkAudit(row: { action: string; resource_id?: string | null; method: string; path: string; request_data_json?: string | null }) {
  const previous = describeOperation(row.path, row.method)
  let name: unknown
  try { name = JSON.parse(row.request_data_json || '{}').object_name } catch { /* Legacy records may contain other payloads. */ }
  const resourceId = row.resource_id || previous.resourceId
  return {
    action_label: row.action.startsWith('park.') ? previous.action : row.action,
    object_label: typeof name === 'string' && name.trim() ? name
      : previous.objectName || (resourceId ? `名称不可恢复（${resourceId}）` : '名称不可恢复'),
  }
}
