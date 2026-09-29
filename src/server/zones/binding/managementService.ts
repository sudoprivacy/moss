/**
 * Zone 管理面服务（§8.8 / MOSS-ADMIN）—— admin API 的后端编排：
 * binding 列表/对账/解绑、Zone 生命周期（suspend/resume/deprovision）转发、
 * operation 查询、普通用户可用 Zone 列表。
 *
 * 权限分层由本 service 在 binding 管理入口执行：
 *  - super admin：全部 binding、create/delete/lifecycle；
 *  - Org admin：本 Org 的 binding 管理（detach）与状态查看；
 *  - 普通用户：仅可用 Zone 列表（不看 grant 历史）。
 *
 * 语义要点（R2.3/R2.5）：
 *  - 解绑（detach）与删除 Zone 数据（deprovision）是两个完全不同的操作，
 *    走不同的路径与确认强度；
 *  - deprovision 要求二次输入 Zone ID（confirm_zone_id 必须与目标一致），
 *    返回 operation 引用，不同步删除；
 *  - refresh 对账 desired（本地 binding）与 observed（Nexus zone/grant 实况）。
 */
import { randomUUID } from 'crypto'
import { ADMIN_ROLES } from '../../auth/roles.js'
import { isUniqueViolation, type DbDriver } from '../../db/driver.js'
import type { ZoneBindingConfig } from './config.js'
import { NexusZoneApiError, NexusZoneUnknownError, NexusZoneClient, type ZoneOperationRef } from '../../nexus/nexusZoneClient.js'
import { insertDetachIntent, insertManagedBindingIntent, listBindingsByOrg } from './bindingRepository.js'
import { rowToOrgZoneBinding } from './bindingWire.js'
import { describeRefusal, validateZoneId } from '@sudo/contracts/zone-id'

export class ZoneManagementError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly retryable: boolean = false,
  ) {
    super(message)
    this.name = 'ZoneManagementError'
  }
}

export interface BindingView {
  binding_id: string
  org_id: string
  nexus_deployment_id: string
  zone_id: string
  purpose: string
  is_default: boolean
  /** desired（本地业务意图） */
  desired_state: string
  /** observed（对账快照；'unknown' 表示效果未知待收敛） */
  sync_status: string
  generation: number
  nexus_grant_id: string | null
  nexus_operation_id: string | null
  last_error_code: string | null
  created_at: number
  updated_at: number
  /** 以下为最近一次 refresh 的 observed 详情（未对账时为 null）。 */
  observed_display_name?: string | null
  observed_zone_status?: string | null
  observed_revision?: string | null
  observed_grant_status?: string | null
  observed_grant_source?: string | null
  grant_expires_at?: string | null
}

/** zoneLifecycle 的读收敛确认结果：unknown 后经 getZone 判定操作已实际生效（无 operation 可引用）。 */
export interface ZoneLifecycleConfirmed {
  zone_id: string
  zone_status: string
  confirmed: true
}

function toView(row: Record<string, unknown>): BindingView {
  const wire = rowToOrgZoneBinding(row)
  return {
    binding_id: wire.binding_id,
    org_id: wire.org_id,
    nexus_deployment_id: wire.nexus_deployment_id,
    zone_id: wire.zone_id,
    purpose: wire.purpose,
    is_default: wire.is_default,
    desired_state: wire.desired_state,
    sync_status: wire.sync_status,
    generation: wire.generation,
    nexus_grant_id: wire.nexus_grant_id ?? null,
    nexus_operation_id: wire.nexus_operation_id ?? null,
    last_error_code: wire.last_error_code ?? null,
    created_at: Date.parse(wire.created_at),
    updated_at: Date.parse(wire.updated_at),
  }
}

export class ZoneManagementService {
  private readonly driver: DbDriver
  private readonly client: NexusZoneClient | null
  private readonly config: ZoneBindingConfig

  constructor(input: { driver: DbDriver; client: NexusZoneClient | null; config: ZoneBindingConfig }) {
    this.driver = input.driver
    this.client = input.client
    this.config = input.config
  }

  private requireClient(): NexusZoneClient {
    if (!this.client) {
      throw new ZoneManagementError('Nexus /v2 management endpoint is not configured', 'NOT_CONFIGURED', 503)
    }
    return this.client
  }

  private mapNexusZoneError(error: unknown): never {
    if (error instanceof NexusZoneApiError) {
      throw new ZoneManagementError(
        error.message,
        error.code,
        error.status || 502,
        error.retryable,
      )
    }
    throw error
  }

  /** super admin 看全部；Org admin 看本 Org。 */
  async listBindings(viewer: { role: string; orgId: string }): Promise<BindingView[]> {
    if (!ADMIN_ROLES.has(viewer.role)) throw new ZoneManagementError('binding management requires org admin', 'FORBIDDEN', 403)
    if (viewer.role === 'super_admin') {
      const rows = await this.driver.all(
        `SELECT * FROM org_zone_bindings ORDER BY created_at, binding_id`,
      )
      return rows.map(toView)
    }
    return (await listBindingsByOrg(this.driver, viewer.orgId)).map((row) =>
      toView(row as unknown as Record<string, unknown>),
    )
  }

  /** desired vs observed 对账：实时查 Nexus zone+grant，更新本地快照。 */
  async refreshBinding(bindingId: string, viewer: { role: string; orgId: string }): Promise<BindingView> {
    if (!ADMIN_ROLES.has(viewer.role)) throw new ZoneManagementError('binding management requires org admin', 'FORBIDDEN', 403)
    const row = await this.driver.get(
      `SELECT * FROM org_zone_bindings WHERE binding_id = ? LIMIT 1`,
      [bindingId],
    )
    if (!row) throw new ZoneManagementError('binding not found', 'BINDING_NOT_FOUND', 404)
    const view = toView(row)
    if (viewer.role !== 'super_admin' && viewer.orgId !== view.org_id) {
      throw new ZoneManagementError('not your org binding', 'FORBIDDEN', 403)
    }
    const client = this.requireClient()
    const now = Date.now()
    let observed: string
    let observedDetail: Partial<BindingView> = {}
    try {
      const zone = await client.getZone(view.zone_id)
      const grant = view.nexus_grant_id
        ? await client.getGrant(view.zone_id, view.nexus_grant_id)
        : null
      observed =
        view.desired_state === 'detached'
          ? zone.status === 'active' || grant?.status === 'active'
            ? 'sync_failed' // 期望已解绑但远端仍活跃
            : 'detached'
          : zone.status === 'active' && (!view.nexus_grant_id || grant?.status === 'active')
            ? 'active'
            : zone.status === 'suspended'
              ? 'syncing' // Zone 挂起非 binding 故障，保留中间态供 UI 区分
              : 'syncing'
      observedDetail = {
        observed_display_name: zone.display_name,
        observed_zone_status: zone.status,
        observed_revision: zone.revision,
        observed_grant_status: grant?.status ?? null,
        observed_grant_source: grant?.sourceType ?? null,
        grant_expires_at: grant?.expires_at ?? null,
      }
    } catch (error) {
      observed = error instanceof NexusZoneApiError && error.status === 404 ? 'sync_failed' : 'unknown'
    }
    await this.driver.run(
      `UPDATE org_zone_bindings SET sync_status = ?, updated_at = ? WHERE binding_id = ?`,
      [observed, now, bindingId],
    )
    const updated = await this.driver.get(
      `SELECT * FROM org_zone_bindings WHERE binding_id = ? LIMIT 1`,
      [bindingId],
    )
    return { ...toView(updated as Record<string, unknown>), ...observedDetail }
  }

  /** 解绑 Org 访问（≠删除 Zone 数据）：desired→detached + outbox detach。 */
  async detachBinding(
    bindingId: string,
    viewer: { role: string; orgId: string },
  ): Promise<{ generation: number }> {
    if (!ADMIN_ROLES.has(viewer.role)) throw new ZoneManagementError('binding management requires org admin', 'FORBIDDEN', 403)
    const row = await this.driver.get(
      `SELECT org_id, zone_id, desired_state FROM org_zone_bindings WHERE binding_id = ? LIMIT 1`,
      [bindingId],
    )
    if (!row) throw new ZoneManagementError('binding not found', 'BINDING_NOT_FOUND', 404)
    if (viewer.role !== 'super_admin' && viewer.orgId !== String(row.org_id)) {
      throw new ZoneManagementError('not your org binding', 'FORBIDDEN', 403)
    }
    if (String(row.desired_state) === 'detached') {
      throw new ZoneManagementError('binding already detached', 'ALREADY_DETACHED', 409)
    }
    const { generation } = await insertDetachIntent(this.driver, { bindingId, now: Date.now() })
    // P1a (§8.10 R5.7)：解绑即隔离——该 zone 上 active 的 runner generation
    // 在 Nexus 打成 revocation_pending（不再获得新资源）。
    if (this.client) {
      try {
        const { parkRunsForZone } = await import('../runtime/sessionZoneBridge.js')
        await parkRunsForZone(this.driver, this.client, String(row.zone_id))
      } catch { /* best-effort：Nexus 侧 verify 的 grant/epoch 复查兜底 */ }
    }
    return { generation }
  }

  /** 普通用户：本 Org 可用 Zone（只看 active binding，不看 grant 历史）。 */
  async listAvailableZones(orgId: string): Promise<Array<{ zone_id: string; purpose: string }>> {
    const rows = await this.driver.all(
      `SELECT zone_id, purpose FROM org_zone_bindings
       WHERE org_id = ? AND nexus_deployment_id = ? AND desired_state = 'bound' AND sync_status = 'active'`,
      [orgId, this.config.nexusDeploymentId],
    )
    return rows.map((row) => ({ zone_id: String(row.zone_id), purpose: String(row.purpose) }))
  }

  /**
   * 添加 binding（super admin）：一个 Org 多 Zone / 一个 Zone 多 Org（§8.7
   * 验收）。zone_id 由管理员指定（不做自动候选）；同 provision 收敛路径。
   * 入口校验：org 存在性 + zone_id 契约格式（保留字归 Nexus daemon 拒绝）；
   * 重复组合按 UNIQUE 约束捕获转 409（竞态安全，非预检）。
   */
  async addBinding(input: {
    orgId: string
    zoneId: string
    purpose: string
    isDefault?: boolean
  }): Promise<BindingView> {
    const org = await this.driver.get(
      `SELECT id FROM organizations WHERE id = ? LIMIT 1`,
      [input.orgId],
    )
    if (!org) throw new ZoneManagementError(`组织不存在：${input.orgId}`, 'ORG_NOT_FOUND', 404)
    const refusal = validateZoneId(input.zoneId)
    if (refusal) throw new ZoneManagementError(`zone_id 不合法：${describeRefusal(refusal)}`, 'INVALID_ZONE_ID', 400)
    let bindingId: string
    try {
      ;({ bindingId } = await insertManagedBindingIntent(this.driver, {
        orgId: input.orgId,
        nexusDeploymentId: this.config.nexusDeploymentId,
        zoneId: input.zoneId,
        purpose: input.purpose,
        isDefault: input.isDefault ?? false,
        now: Date.now(),
      }))
    } catch (err) {
      // 表级 4 列 UNIQUE 是本入口唯一可能冲突源（partial unique 仅约束
      // is_default=1 的行，而本入口 isDefault 恒为 false）。
      if (isUniqueViolation(err)) {
        // 冲突行可能是已解绑（detached）的历史行：UNIQUE 不含 desired_state，
        // detach 只 UPDATE 不删行——文案必须与事实一致。
        const existing = await this.driver.get(
          `SELECT desired_state FROM org_zone_bindings
           WHERE org_id = ? AND nexus_deployment_id = ? AND zone_id = ? AND purpose = ? LIMIT 1`,
          [input.orgId, this.config.nexusDeploymentId, input.zoneId, input.purpose],
        )
        if (existing && String(existing.desired_state) === 'detached') {
          throw new ZoneManagementError('该组合存在已解绑的历史绑定行，需先处理该历史行（当前 schema 不支持同组合重绑）', 'BINDING_ALREADY_EXISTS', 409)
        }
        throw new ZoneManagementError('该绑定已存在（同组织 + Zone + 用途），无需重复创建', 'BINDING_ALREADY_EXISTS', 409)
      }
      throw err
    }
    const row = await this.driver.get(
      `SELECT * FROM org_zone_bindings WHERE binding_id = ? LIMIT 1`,
      [bindingId],
    )
    return toView(row as Record<string, unknown>)
  }

  /** suspend/resume（super admin）：转发 Nexus，返回 operation；unknown 时读收敛判定。 */
  async zoneLifecycle(
    zoneId: string,
    action: 'suspend' | 'resume',
  ): Promise<ZoneOperationRef | ZoneLifecycleConfirmed> {
    try {
      return await this.requireClient().zoneLifecycle(zoneId, action, `moss-admin:${zoneId}:${action}:${Date.now()}:${randomUUID()}`)
    } catch (error) {
      // zone 不存在（本地环境收敛前的高频路径）→ 明确中文提示
      if (error instanceof NexusZoneApiError && error.status === 404) {
        throw new ZoneManagementError('该 Zone 尚未在 Nexus 创建完成（或已被删除），请先在列表刷新对账确认绑定状态', error.code, 404)
      }
      // 重复挂起/恢复（最高频误操作）→ 中文特化
      if (error instanceof NexusZoneApiError && error.code === 'ZONE_NOT_ACTIVE') {
        throw new ZoneManagementError('该 Zone 当前状态不支持此操作（如重复挂起或恢复已挂起的 Zone），请刷新对账确认状态', error.code, error.status || 409)
      }
      if (error instanceof NexusZoneUnknownError) {
        try {
          const zone = await this.requireClient().getZone(zoneId)
          if (zone.status === (action === 'suspend' ? 'suspended' : 'active')) {
            return { zone_id: zoneId, zone_status: zone.status, confirmed: true }
          }
          // getZone 成功且状态未达预期 = 操作确定未生效、Nexus 可达
          throw new ZoneManagementError(
            `操作未生效（Nexus 可达，当前 Zone 状态：${zone.status}），可重试 ${action}`,
            'NEXUS_LIFECYCLE_NOT_APPLIED', 502)
        } catch (e) {
          if (e instanceof ZoneManagementError) throw e
          if (e instanceof NexusZoneApiError && e.status === 404) {
            // 读收敛时 zone 已不存在（如并发 deprovision）：Nexus 明确应答，操作可判定未生效
            throw new ZoneManagementError('该 Zone 已不存在（可能已被删除），操作未生效', 'NEXUS_LIFECYCLE_NOT_APPLIED', 502)
          }
          // getZone 亦失败（不可达）→ 维持 unknown 语义
          const err = new ZoneManagementError(
            'Nexus 未响应（超时或不可达），操作效果未知——可能已生效，请稍后在列表刷新对账确认 Zone 状态',
            'NEXUS_OUTCOME_UNKNOWN', 504)
          err.cause = error
          throw err
        }
      }
      return this.mapNexusZoneError(error)
    }
  }

  /**
   * deprovision（super admin，破坏性）：二次确认 Zone ID + 返回 operation，
   * 不在请求内同步等待删除完成（§8.8）。
   */
  async deprovisionZone(zoneId: string, confirmZoneId: string): Promise<ZoneOperationRef> {
    if (confirmZoneId !== zoneId) {
      throw new ZoneManagementError(
        'confirmation zone id does not match the target zone id',
        'CONFIRM_MISMATCH',
        400,
      )
    }
    try {
      return await this.requireClient().deprovisionZone(
        zoneId,
        `moss-admin:deprovision:${zoneId}:${randomUUID()}`,
      )
    } catch (error) {
      return this.mapNexusZoneError(error)
    }
  }

  /** operation 查询（step/error/retry——UI 故障恢复入口）。 */
  async getOperation(operationId: string): Promise<ZoneOperationRef> {
    return this.requireClient().getOperation(operationId)
  }
}
