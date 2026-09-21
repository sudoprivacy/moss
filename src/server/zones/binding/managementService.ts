/**
 * Zone 管理面服务（§8.8 / MOSS-ADMIN）—— admin API 的后端编排：
 * binding 列表/对账/解绑、Zone 生命周期（suspend/resume/deprovision）转发、
 * operation 查询、普通用户可用 Zone 列表。
 *
 * 权限分层（调用方 server.ts 已按角色收口，这里再以 viewer 语义防御）：
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
import type { DbDriver } from '../../db/driver.js'
import type { ZoneBindingConfig } from './config.js'
import { NexusZoneApiError, NexusZoneClient, type ZoneOperationRef } from '../../nexus/nexusZoneClient.js'
import { insertDetachIntent, insertManagedBindingIntent, listBindingsByOrg } from './bindingRepository.js'

export class ZoneManagementError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
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
  grant_expires_at?: string | null
}

function toView(row: Record<string, unknown>): BindingView {
  return {
    binding_id: String(row.binding_id),
    org_id: String(row.org_id),
    nexus_deployment_id: String(row.nexus_deployment_id),
    zone_id: String(row.zone_id),
    purpose: String(row.purpose),
    is_default: Number(row.is_default) === 1,
    desired_state: String(row.desired_state),
    sync_status: String(row.sync_status),
    generation: Number(row.generation),
    nexus_grant_id: row.nexus_grant_id == null ? null : String(row.nexus_grant_id),
    nexus_operation_id: row.nexus_operation_id == null ? null : String(row.nexus_operation_id),
    last_error_code: row.last_error_code == null ? null : String(row.last_error_code),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
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

  /** super admin 看全部；Org admin 看本 Org。 */
  async listBindings(viewer: { role: string; orgId: string }): Promise<BindingView[]> {
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
    const row = await this.driver.get(
      `SELECT org_id, desired_state FROM org_zone_bindings WHERE binding_id = ? LIMIT 1`,
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
   */
  async addBinding(input: {
    orgId: string
    zoneId: string
    purpose: string
    isDefault?: boolean
  }): Promise<BindingView> {
    const { bindingId } = await insertManagedBindingIntent(this.driver, {
      orgId: input.orgId,
      nexusDeploymentId: this.config.nexusDeploymentId,
      zoneId: input.zoneId,
      purpose: input.purpose,
      isDefault: input.isDefault ?? false,
      now: Date.now(),
    })
    const row = await this.driver.get(
      `SELECT * FROM org_zone_bindings WHERE binding_id = ? LIMIT 1`,
      [bindingId],
    )
    return toView(row as Record<string, unknown>)
  }

  /** suspend/resume（super admin）：转发 Nexus，返回 operation。 */
  async zoneLifecycle(
    zoneId: string,
    action: 'suspend' | 'resume',
  ): Promise<ZoneOperationRef> {
    return this.requireClient().zoneLifecycle(zoneId, action, `moss-admin:${zoneId}:${action}:${Date.now()}:${randomUUID()}`)
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
    return this.requireClient().deprovisionZone(zoneId, `moss-admin:deprovision:${zoneId}:${randomUUID()}`)
  }

  /** operation 查询（step/error/retry——UI 故障恢复入口）。 */
  async getOperation(operationId: string): Promise<ZoneOperationRef> {
    return this.requireClient().getOperation(operationId)
  }
}
