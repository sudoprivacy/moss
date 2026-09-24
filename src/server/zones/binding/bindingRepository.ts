/**
 * org_zone_bindings / zone_binding_outbox / zone_binding_audit 的仓储层。
 *
 * 跨 SQLite/PostgreSQL：全部走 DbDriver（run/get/all），不触碰
 * node:sqlite 直调——生产 PG 部署下事务/连接由 driver 的 ALS 传播保证。
 *
 * 并发语义（§8.7 outbox 约束）：
 *  - 领取用乐观并发：先 SELECT 候选，再条件 UPDATE 抢占（affected=0 即
 *    被其他 worker 抢走，跳过）；
 *  - 每次领取 fence+1；后续写回（complete/fail）都带 `WHERE fence = ?`，
 *    lease 过期被接管后，旧 worker 的迟到写回落空（affected=0），不得
 *    覆盖新状态；
 *  - stale lease 接管：lease_until 已过的 claimed 行重新进入可领取集。
 */
import { randomUUID } from 'crypto'
import type { DbDriver, SqlRow } from '../../db/driver.js'
import { defaultZoneIdCandidate } from './zoneIdPolicy.js'

export interface OrgZoneBindingRow {
  binding_id: string
  org_id: string
  nexus_deployment_id: string
  zone_id: string
  purpose: string
  is_default: number
  desired_capabilities: string
  resource_prefixes: string | null
  desired_state: 'bound' | 'detached'
  sync_status: 'pending' | 'syncing' | 'active' | 'detaching' | 'detached' | 'sync_failed' | 'unknown'
  nexus_grant_id: string | null
  nexus_operation_id: string | null
  generation: number
  last_error_code: string | null
  created_at: number
  updated_at: number
}

export interface ZoneBindingOutboxRow {
  id: string
  binding_id: string
  generation: number
  action: 'provision' | 'update' | 'detach'
  status: 'pending' | 'claimed' | 'completed' | 'failed'
  lease_owner: string | null
  lease_until: number | null
  fence: number
  attempts: number
  next_retry_at: number | null
  operation_id: string | null
  grant_source_id: string | null
  last_error_code: string | null
  created_at: number
  updated_at: number
}

/** default binding 的 capability 集：Org 侧业务意图，grant 由 Nexus 裁决。 */
export const DEFAULT_BINDING_CAPABILITIES: readonly string[] = [
  'zone.data.read',
  'zone.data.write',
  'zone.runtime.execute',
]

function mapBinding(row: SqlRow): OrgZoneBindingRow {
  return {
    binding_id: String(row.binding_id),
    org_id: String(row.org_id),
    nexus_deployment_id: String(row.nexus_deployment_id),
    zone_id: String(row.zone_id),
    purpose: String(row.purpose),
    is_default: Number(row.is_default),
    desired_capabilities: String(row.desired_capabilities),
    resource_prefixes: row.resource_prefixes == null ? null : String(row.resource_prefixes),
    desired_state: String(row.desired_state) as OrgZoneBindingRow['desired_state'],
    sync_status: String(row.sync_status) as OrgZoneBindingRow['sync_status'],
    nexus_grant_id: row.nexus_grant_id == null ? null : String(row.nexus_grant_id),
    nexus_operation_id: row.nexus_operation_id == null ? null : String(row.nexus_operation_id),
    generation: Number(row.generation),
    last_error_code: row.last_error_code == null ? null : String(row.last_error_code),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }
}

function mapOutbox(row: SqlRow): ZoneBindingOutboxRow {
  return {
    id: String(row.id),
    binding_id: String(row.binding_id),
    generation: Number(row.generation),
    action: String(row.action) as ZoneBindingOutboxRow['action'],
    status: String(row.status) as ZoneBindingOutboxRow['status'],
    lease_owner: row.lease_owner == null ? null : String(row.lease_owner),
    lease_until: row.lease_until == null ? null : Number(row.lease_until),
    fence: Number(row.fence),
    attempts: Number(row.attempts),
    next_retry_at: row.next_retry_at == null ? null : Number(row.next_retry_at),
    operation_id: row.operation_id == null ? null : String(row.operation_id),
    grant_source_id: row.grant_source_id == null ? null : String(row.grant_source_id),
    last_error_code: row.last_error_code == null ? null : String(row.last_error_code),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }
}

/**
 * 在 org 创建事务内写入 default binding intent + provision outbox + audit。
 *
 * 调用点：AuthCenterDb.createOrganization（单点汇聚全部 7 个 Org 入口）。
 * 只写本地行，不发起任何远端调用（§8.7 事务规则）；Nexus 不可达时行保持
 * pending，由 reconciler 异步收敛。
 */
export async function insertDefaultBindingIntent(
  driver: DbDriver,
  input: {
    orgId: string
    nexusDeploymentId: string
    now: number
  },
): Promise<{ bindingId: string; zoneId: string; outboxId: string }> {
  const bindingId = randomUUID()
  const zoneId = defaultZoneIdCandidate(input.orgId)
  const outboxId = randomUUID()

  await driver.run(
    `INSERT INTO org_zone_bindings (
       binding_id, org_id, nexus_deployment_id, zone_id, purpose, is_default,
       desired_capabilities, desired_state, sync_status, generation, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'default', 1, ?, 'bound', 'pending', 1, ?, ?)`,
    [
      bindingId,
      input.orgId,
      input.nexusDeploymentId,
      zoneId,
      JSON.stringify([...DEFAULT_BINDING_CAPABILITIES]),
      input.now,
      input.now,
    ],
  )

  await driver.run(
    `INSERT INTO zone_binding_outbox (
       id, binding_id, generation, action, status, fence, attempts, grant_source_id, created_at, updated_at
     ) VALUES (?, ?, 1, 'provision', 'pending', 0, 0, ?, ?, ?)`,
    [outboxId, bindingId, `${bindingId}:1`, input.now, input.now],
  )

  await driver.run(
    `INSERT INTO zone_binding_audit (id, binding_id, action, actor, detail, created_at)
     VALUES (?, ?, 'binding-intent-created', 'system', ?, ?)`,
    [randomUUID(), bindingId, JSON.stringify({ orgId: input.orgId, zoneId, purpose: 'default' }), input.now],
  )

  return { bindingId, zoneId, outboxId }
}

/** 已存在 default binding（幂等重入，例如 bootstrap 变体的条件创建）。 */
export async function hasActiveDefaultBinding(
  driver: DbDriver,
  orgId: string,
  nexusDeploymentId: string,
): Promise<boolean> {
  const row = await driver.get(
    `SELECT binding_id FROM org_zone_bindings
     WHERE org_id = ? AND nexus_deployment_id = ? AND is_default = 1 AND desired_state = 'bound'
     LIMIT 1`,
    [orgId, nexusDeploymentId],
  )
  return row != null
}

export async function getBinding(driver: DbDriver, bindingId: string): Promise<OrgZoneBindingRow | null> {
  const row = await driver.get(
    `SELECT * FROM org_zone_bindings WHERE binding_id = ? LIMIT 1`,
    [bindingId],
  )
  return row ? mapBinding(row) : null
}

export async function listBindingsByOrg(driver: DbDriver, orgId: string): Promise<OrgZoneBindingRow[]> {
  const rows = await driver.all(
    `SELECT * FROM org_zone_bindings WHERE org_id = ? ORDER BY created_at, binding_id`,
    [orgId],
  )
  return rows.map(mapBinding)
}

/**
 * 领取到期的 outbox 行（乐观并发 + stale lease 接管）。
 * 返回的行持有本次 fence；写回必须带该 fence，否则视为被接管。
 */
export async function claimDueOutbox(
  driver: DbDriver,
  input: { leaseOwner: string; leaseUntilMs: number; now: number; limit: number },
): Promise<ZoneBindingOutboxRow[]> {
  const candidates = await driver.all(
    `SELECT id FROM zone_binding_outbox
     WHERE (status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?))
        OR (status = 'claimed' AND lease_until IS NOT NULL AND lease_until < ?)
     ORDER BY created_at
     LIMIT ?`,
    [input.now, input.now, input.limit],
  )

  const claimed: ZoneBindingOutboxRow[] = []
  for (const candidate of candidates) {
    const id = String(candidate.id)
    const updated = await driver.run(
      `UPDATE zone_binding_outbox
       SET status = 'claimed', lease_owner = ?, lease_until = ?, fence = fence + 1,
           attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND (
             (status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?))
          OR (status = 'claimed' AND lease_until IS NOT NULL AND lease_until < ?)
       )`,
      [input.leaseOwner, input.leaseUntilMs, input.now, id, input.now, input.now],
    )
    if (updated === 0) continue // 被其他 worker 抢走
    const row = await driver.get(`SELECT * FROM zone_binding_outbox WHERE id = ? LIMIT 1`, [id])
    if (row) claimed.push(mapOutbox(row))
  }
  return claimed
}

/** binding 置 syncing（领取 provision 后、调 Nexus 前）。fence 由 outbox 保护。 */
export async function markBindingSyncing(
  driver: DbDriver,
  input: { bindingId: string; operationId: string | null; now: number },
): Promise<void> {
  await driver.run(
    `UPDATE org_zone_bindings
     SET sync_status = 'syncing', nexus_operation_id = COALESCE(?, nexus_operation_id), updated_at = ?
     WHERE binding_id = ?`,
    [input.operationId, input.now, input.bindingId],
  )
}

/**
 * provision 成功的写回：outbox completed + binding active（记录 grant 与
 * operation）。fence 不匹配（被接管）时返回 false 且不落任何写。
 */
export async function completeProvision(
  driver: DbDriver,
  input: {
    outboxId: string
    fence: number
    bindingId: string
    zoneId: string
    grantId: string | null
    operationId: string
    now: number
  },
): Promise<boolean> {
  const done = await driver.run(
    `UPDATE zone_binding_outbox
     SET status = 'completed', operation_id = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
     WHERE id = ? AND status = 'claimed' AND fence = ?`,
    [input.operationId, input.now, input.outboxId, input.fence],
  )
  if (done === 0) return false
  await driver.run(
    `UPDATE org_zone_bindings
     SET sync_status = 'active', nexus_grant_id = ?, nexus_operation_id = ?,
         last_error_code = NULL, updated_at = ?
     WHERE binding_id = ?`,
    [input.grantId, input.operationId, input.now, input.bindingId],
  )
  await driver.run(
    `INSERT INTO zone_binding_audit (id, binding_id, action, actor, detail, created_at)
     VALUES (?, ?, 'provision-completed', 'reconciler', ?, ?)`,
    [
      randomUUID(),
      input.bindingId,
      JSON.stringify({ zoneId: input.zoneId, grantId: input.grantId, operationId: input.operationId }),
      input.now,
    ],
  )
  return true
}

/**
 * 尝试失败的写回：可重试则指数退避回 pending，不可重试则 failed +
 * binding sync_failed；网络类不确定失败（timeout/断连）标 binding
 * `unknown`（效果未知，恢复后由 operation 查询收敛，§8.7 client 规则）。
 */
export async function failOutboxAttempt(
  driver: DbDriver,
  input: {
    outboxId: string
    fence: number
    bindingId: string
    errorCode: string
    unknownOutcome: boolean
    retryable: boolean
    now: number
    baseBackoffMs: number
  },
): Promise<boolean> {
  const backoff = input.baseBackoffMs * 2 ** Math.min(input.fence, 8)
  const status = input.retryable ? 'pending' : 'failed'
  const done = await driver.run(
    `UPDATE zone_binding_outbox
     SET status = ?, last_error_code = ?, lease_owner = NULL, lease_until = NULL,
         next_retry_at = ?, updated_at = ?
     WHERE id = ? AND status = 'claimed' AND fence = ?`,
    [status, input.errorCode, input.retryable ? input.now + backoff : null, input.now, input.outboxId, input.fence],
  )
  if (done === 0) return false
  const syncStatus = input.unknownOutcome ? 'unknown' : input.retryable ? 'pending' : 'sync_failed'
  await driver.run(
    `UPDATE org_zone_bindings
     SET sync_status = ?, last_error_code = ?, updated_at = ?
     WHERE binding_id = ?`,
    [syncStatus, input.errorCode, input.now, input.bindingId],
  )
  await driver.run(
    `INSERT INTO zone_binding_audit (id, binding_id, action, actor, detail, created_at)
     VALUES (?, ?, 'provision-attempt-failed', 'reconciler', ?, ?)`,
    [
      randomUUID(),
      input.bindingId,
      JSON.stringify({
        errorCode: input.errorCode,
        unknownOutcome: input.unknownOutcome,
        retryable: input.retryable,
        attempt: input.fence,
      }),
      input.now,
    ],
  )
  return true
}

/** 用 operation 查询结果收敛 unknown binding（exactly-once 恢复路径）。 */
export async function settleFromOperation(
  driver: DbDriver,
  input: {
    outboxId: string
    fence: number
    bindingId: string
    zoneId: string
    grantId: string | null
    operationId: string
    now: number
  },
): Promise<boolean> {
  return completeProvision(driver, input)
}

/**
 * 管理面添加 binding（§8.8：一个 Org 多 Zone / 一个 Zone 多 Org 均成立）。
 * 与 default intent 同一收敛路径（provision outbox + reconciler）；
 * zone_id 由调用方（super admin）指定——非 default 场景没有自动候选政策。
 */
export async function insertManagedBindingIntent(
  driver: DbDriver,
  input: {
    orgId: string
    nexusDeploymentId: string
    zoneId: string
    purpose: string
    isDefault: boolean
    now: number
  },
): Promise<{ bindingId: string; outboxId: string }> {
  const bindingId = randomUUID()
  const outboxId = randomUUID()
  await driver.run(
    `INSERT INTO org_zone_bindings (
       binding_id, org_id, nexus_deployment_id, zone_id, purpose, is_default,
       desired_capabilities, desired_state, sync_status, generation, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'bound', 'pending', 1, ?, ?)`,
    [
      bindingId,
      input.orgId,
      input.nexusDeploymentId,
      input.zoneId,
      input.purpose,
      input.isDefault ? 1 : 0,
      JSON.stringify([...DEFAULT_BINDING_CAPABILITIES]),
      input.now,
      input.now,
    ],
  )
  await driver.run(
    `INSERT INTO zone_binding_outbox (
       id, binding_id, generation, action, status, fence, attempts, grant_source_id, created_at, updated_at
     ) VALUES (?, ?, 1, 'provision', 'pending', 0, 0, ?, ?, ?)`,
    [outboxId, bindingId, `${bindingId}:1`, input.now, input.now],
  )
  await driver.run(
    `INSERT INTO zone_binding_audit (id, binding_id, action, actor, detail, created_at)
     VALUES (?, ?, 'binding-intent-created', 'admin', ?, ?)`,
    [
      randomUUID(),
      bindingId,
      JSON.stringify({ orgId: input.orgId, zoneId: input.zoneId, purpose: input.purpose, managed: true }),
      input.now,
    ],
  )
  return { bindingId, outboxId }
}

/**
 * 解绑入口（§8.8："解绑 Org 访问"≠"删除 Zone 数据"）：desired_state →
 * detached、generation+1，并写 detach outbox 行（reconciler 异步 revoke 该
 * binding 派生的 grant——exactly-once，与其他 mutation 同一模型）。
 * Zone 数据、审计历史一概不动。
 */
export async function insertDetachIntent(
  driver: DbDriver,
  input: { bindingId: string; now: number },
): Promise<{ outboxId: string; generation: number }> {
  const binding = await getBinding(driver, input.bindingId)
  if (!binding) throw new Error(`binding not found: ${input.bindingId}`)
  if (binding.desired_state === 'detached') {
    throw new Error('binding is already detached')
  }
  const generation = binding.generation + 1
  const outboxId = randomUUID()
  await driver.run(
    `UPDATE org_zone_bindings
     SET desired_state = 'detached', generation = ?, sync_status = 'detaching', updated_at = ?
     WHERE binding_id = ? AND desired_state = 'bound'`,
    [generation, input.now, input.bindingId],
  )
  await driver.run(
    `INSERT INTO zone_binding_outbox (
       id, binding_id, generation, action, status, fence, attempts, created_at, updated_at
     ) VALUES (?, ?, ?, 'detach', 'pending', 0, 0, ?, ?)`,
    [outboxId, input.bindingId, generation, input.now, input.now],
  )
  await driver.run(
    `INSERT INTO zone_binding_audit (id, binding_id, action, actor, detail, created_at)
     VALUES (?, ?, 'detach-intent-created', 'admin', ?, ?)`,
    [randomUUID(), input.bindingId, JSON.stringify({ generation }), input.now],
  )
  return { outboxId, generation }
}

/** detach 完成：outbox completed + binding sync detached。fence 保护同前。 */
export async function completeDetach(
  driver: DbDriver,
  input: { outboxId: string; fence: number; bindingId: string; operationId: string | null; now: number },
): Promise<boolean> {
  const done = await driver.run(
    `UPDATE zone_binding_outbox
     SET status = 'completed', operation_id = COALESCE(?, operation_id), lease_owner = NULL, lease_until = NULL, updated_at = ?
     WHERE id = ? AND status = 'claimed' AND fence = ?`,
    [input.operationId, input.now, input.outboxId, input.fence],
  )
  if (done === 0) return false
  await driver.run(
    `UPDATE org_zone_bindings
     SET sync_status = 'detached', updated_at = ?
     WHERE binding_id = ?`,
    [input.now, input.bindingId],
  )
  await driver.run(
    `INSERT INTO zone_binding_audit (id, binding_id, action, actor, detail, created_at)
     VALUES (?, ?, 'detach-completed', 'reconciler', ?, ?)`,
    [randomUUID(), input.bindingId, JSON.stringify({ operationId: input.operationId }), input.now],
  )
  return true
}
