/**
 * Zone 管理面 API（§8.8 / MOSS-ADMIN）。
 *
 * UI 语义约束（zones-page 渲染时同样遵守）：
 *  - "解绑 Org 访问"（detach binding）与"删除 Zone 数据"（deprovision）是
 *    两个操作，分开的入口与确认强度；
 *  - desired（binding 行的业务意图）与 observed（refresh 后的 Nexus 实况
 *    快照）分列展示；
 *  - deprovision 前端要求二次输入 Zone ID，与后端双重校验。
 */
import { dcClient } from './client'

export interface ZoneBinding {
  binding_id: string
  org_id: string
  nexus_deployment_id: string
  zone_id: string
  purpose: string
  is_default: boolean
  desired_state: string
  sync_status: string
  generation: number
  nexus_grant_id: string | null
  nexus_operation_id: string | null
  last_error_code: string | null
  created_at: number
  updated_at: number
  /** 最近一次 refresh 的 observed 详情（未对账时为 null/缺省）。 */
  observed_display_name?: string | null
  observed_zone_status?: string | null
  observed_revision?: string | null
  observed_grant_status?: string | null
  observed_grant_source?: string | null
  grant_expires_at?: string | null
  /** 对账时间（BIGINT 毫秒，B-3 持久化列；UI 计算相对时长）。 */
  observed_at?: number | null
}

export interface ZoneOperation {
  operation_id: string
  action: string
  zone_id: string | null
  grant_id: string | null
  state: string
  step: string
  retryable: boolean
  error: { code: string; message: string; retryable: boolean } | null
}

export interface AvailableZone {
  zone_id: string
  purpose: string
}

export function listZoneBindings(): Promise<{ bindings: ZoneBinding[] }> {
  return dcClient.get('/api/v1/zones/bindings')
}

export function addZoneBinding(input: {
  org_id: string
  zone_id: string
  purpose?: string
}): Promise<ZoneBinding> {
  return dcClient.post('/api/v1/zones/bindings', input)
}

export function refreshZoneBinding(bindingId: string): Promise<ZoneBinding> {
  return dcClient.post(`/api/v1/zones/bindings/${bindingId}/refresh`)
}

export function detachZoneBinding(bindingId: string): Promise<{ generation: number }> {
  return dcClient.post(`/api/v1/zones/bindings/${bindingId}/detach`)
}

export function listAvailableZones(): Promise<{ zones: AvailableZone[] }> {
  return dcClient.get('/api/v1/zones/available')
}

export function getZoneOperation(operationId: string): Promise<ZoneOperation> {
  return dcClient.get(`/api/v1/zones/operations/${operationId}`)
}

/** zoneLifecycle 的读收敛确认结果：unknown 后后端经 getZone 判定操作已实际生效（无 operation 可引用）。 */
export interface ZoneLifecycleConfirmed {
  zone_id: string
  zone_status: string
  confirmed: true
}

export function zoneLifecycle(zoneId: string, action: 'suspend' | 'resume'): Promise<ZoneOperation | ZoneLifecycleConfirmed> {
  return dcClient.post(`/api/v1/zones/${zoneId}:${action}`)
}

export function deprovisionZone(zoneId: string, confirmZoneId: string): Promise<ZoneOperation> {
  return dcClient.post(`/api/v1/zones/${zoneId}/deprovision`, { confirm_zone_id: confirmZoneId })
}

/** 解除 ZONE_DELETE_BLOCKED 的 runtime 入口：terminate 终止 / park 隔离。 */
export function cancelZoneRuntimeRun(pid: string, mode: 'terminate' | 'pending'): Promise<{ pid: string; state: string }> {
  return dcClient.post(`/api/v1/zones/runtime-runs/${pid}/cancel`, { mode })
}
