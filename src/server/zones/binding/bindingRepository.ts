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
 *
 * per-binding FIFO（M-1）：同 binding 的后序行必须等前序行终态
 * （completed/failed）才可领取——消除"detach 行在 provision 在途期间被
 * 领取、读不到 grant_id 跳过 revoke"的乱序窗口。次级排序用 generation
 * （created_at 毫秒同值时保序）。stale-lease 接管语义不变：前序行 lease
 * 过期仍属候选集、会被重新领取收敛，后序行继续等待——无死锁。
 */
export async function claimDueOutbox(
  driver: DbDriver,
  input: { leaseOwner: string; leaseUntilMs: number; now: number; limit: number },
): Promise<ZoneBindingOutboxRow[]> {
  const candidates = await driver.all(
    `SELECT o.id FROM zone_binding_outbox o
     WHERE ((o.status = 'pending' AND (o.next_retry_at IS NULL OR o.next_retry_at <= ?))
        OR (o.status = 'claimed' AND o.lease_until IS NOT NULL AND o.lease_until < ?))
       AND NOT EXISTS (
         SELECT 1 FROM zone_binding_outbox p
         WHERE p.binding_id = o.binding_id
           AND p.status IN ('pending', 'claimed')
           AND (p.created_at < o.created_at
             OR (p.created_at = o.created_at AND p.generation < o.generation))
       )
     ORDER BY o.created_at
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

/**
 * binding 置 syncing（领取 provision 后、调 Nexus 前）。fence 由 outbox 保护。
 * 低-9：终态守卫——lease 被接管并 completeProvision 后，旧 worker 迟到的
 * syncing 写回不得把 active/detached 拉回中间态（≤5 分钟对账自愈，此前
 * 依赖该自愈）。
 */
export async function markBindingSyncing(
  driver: DbDriver,
  input: { bindingId: string; operationId: string | null; now: number },
): Promise<void> {
  await driver.run(
    `UPDATE org_zone_bindings
     SET sync_status = 'syncing', nexus_operation_id = COALESCE(?, nexus_operation_id), updated_at = ?
     WHERE binding_id = ? AND sync_status IN ('pending', 'syncing', 'unknown')`,
    [input.operationId, input.now, input.bindingId],
  )
}

/** completeProvision 的三态结果：true=正常收敛；false=lease 被接管（本 worker 放弃）；'desired-flipped'=desired 已被翻转为 detached（grant 引用已在同事务落库，由既有 detach 行完成 revoke）。 */
export type CompleteProvisionOutcome = true | false | 'desired-flipped'

/**
 * provision 成功的写回：outbox completed + binding active（记录 grant 与
 * operation）。fence 不匹配（被接管）时返回 false 且不落任何写。
 *
 * desired 守卫（M-1）+ 同事务 grant 引用（Z-1）：provision 在途期间 desired
 * 被翻转为 detached 时，不把 binding 写回 active，改为在同一事务内仅落
 * grant 引用（不动 sync_status）——provision 行终态化与引用原子提交，另一
 * worker 要么看到已提交的 grant_id（FIFO 随之放行 detach 行、按引用正常
 * revoke），要么 provision 行未终态（FIFO 挡住 detach 行领取）。跨 worker
 * 竞态窗口归零；队列中已有的 detach 行是 revoke 的唯一执行者（幂等 key
 * 稳定，失败由 outbox 重试），不在此处立即 revoke、不写补偿行（会与既有
 * detach 行撞 UNIQUE(binding_id, generation, action)）。
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
): Promise<CompleteProvisionOutcome> {
  let outcome: CompleteProvisionOutcome = false
  await driver.transaction(async () => {
    const done = await driver.run(
      `UPDATE zone_binding_outbox
       SET status = 'completed', operation_id = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'claimed' AND fence = ?`,
      [input.operationId, input.now, input.outboxId, input.fence],
    )
    if (done === 0) return
    const active = await driver.run(
      `UPDATE org_zone_bindings
       SET sync_status = 'active', nexus_grant_id = ?, nexus_operation_id = ?,
           last_error_code = NULL, updated_at = ?
       WHERE binding_id = ? AND desired_state = 'bound'`,
      [input.grantId, input.operationId, input.now, input.bindingId],
    )
    if (active === 0) {
      const row = await driver.get(
        `SELECT desired_state FROM org_zone_bindings WHERE binding_id = ? LIMIT 1`,
        [input.bindingId],
      )
      if (row && String(row.desired_state) === 'detached') {
        await driver.run(
          `UPDATE org_zone_bindings
           SET nexus_grant_id = ?, nexus_operation_id = ?, last_error_code = NULL, updated_at = ?
           WHERE binding_id = ? AND desired_state = 'detached'`,
          [input.grantId, input.operationId, input.now, input.bindingId],
        )
        await driver.run(
          `INSERT INTO zone_binding_audit (id, binding_id, action, actor, detail, created_at)
           VALUES (?, ?, 'provision-completed-desired-flipped', 'reconciler', ?, ?)`,
          [
            randomUUID(),
            input.bindingId,
            JSON.stringify({ zoneId: input.zoneId, grantId: input.grantId, operationId: input.operationId }),
            input.now,
          ],
        )
        outcome = 'desired-flipped'
      }
      // 行不存在（数据被人为清除）或非 detached 的意外态：outbox 已终态即可，
      // 不落引用（保守）。
      return
    }
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
    outcome = true
  })
  return outcome
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
  let outcome = false
  // 多语句写自包事务（低-3）。
  await driver.transaction(async () => {
    const done = await driver.run(
      `UPDATE zone_binding_outbox
       SET status = ?, last_error_code = ?, lease_owner = NULL, lease_until = NULL,
           next_retry_at = ?, updated_at = ?
       WHERE id = ? AND status = 'claimed' AND fence = ?`,
      [status, input.errorCode, input.retryable ? input.now + backoff : null, input.now, input.outboxId, input.fence],
    )
    if (done === 0) return
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
    outcome = true
  })
  return outcome
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
): Promise<CompleteProvisionOutcome> {
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
  // 多语句写自包事务（低-3）：进程在语句间崩溃不留半截 intent（对照
  // createOrganization 的事务先例）；嵌套调用自动 join 外层（driver 语义）。
  await driver.transaction(async () => {
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
  })
  return { bindingId, outboxId }
}

/**
 * default 转移（H-2）：org 内既有的生效 default binding 降级为非 default
 * （is_default=0），为新的 default 腾出 partial unique 空间。audit 挂在被
 * 降级的旧行上——同一 org 的下一条 binding-intent-created/revived 审计即
 * 继任者，时间序可查，无需在降级时预知继任 id。addBinding 与 revive 共用。
 */
export async function demoteExistingDefaultBinding(
  driver: DbDriver,
  input: { orgId: string; nexusDeploymentId: string; excludeBindingId?: string; now: number },
): Promise<string | null> {
  const existing = await driver.get(
    `SELECT binding_id FROM org_zone_bindings
     WHERE org_id = ? AND nexus_deployment_id = ? AND is_default = 1 AND desired_state = 'bound'
       AND binding_id != ?
     LIMIT 1`,
    [input.orgId, input.nexusDeploymentId, input.excludeBindingId ?? ''],
  )
  if (!existing) return null
  const demotedId = String(existing.binding_id)
  await driver.run(
    `UPDATE org_zone_bindings SET is_default = 0, updated_at = ? WHERE binding_id = ?`,
    [input.now, demotedId],
  )
  await driver.run(
    `INSERT INTO zone_binding_audit (id, binding_id, action, actor, detail, created_at)
     VALUES (?, ?, 'default-moved', 'admin', ?, ?)`,
    [randomUUID(), demotedId, JSON.stringify({ orgId: input.orgId, reason: 'superseded' }), input.now],
  )
  return demotedId
}

/** reviveBindingIntent 的结果。 */
export type ReviveBindingIntentResult =
  | { ok: true; bindingId: string; generation: number }
  | { ok: false; reason: 'outbox-in-flight' | 'revive-race' }

/** 事务内部信号：复活 UPDATE 落空（并发 revive 竞态）——回滚后重读裁定。 */
class ReviveLostRace extends Error {}

/**
 * 复活已解绑的 binding（H-2 恢复路径）：UPDATE 复用既有行（不 INSERT，
 * 不撞 4 列 UNIQUE），generation+1 → 全新幂等 key，走 provision 收敛
 * （createZone 对 ZONE_ALREADY_EXISTS 容忍，grant 由 reconciler 重建）。
 * 前置拒绝在途 outbox 行（FIFO 下复活会被在途 detach 行覆盖，中间态错乱；
 * failed 为终态故放行——revoke 终态失败的行也必须能重绑，否则回到不可逆）。
 */
export async function reviveBindingIntent(
  driver: DbDriver,
  input: { bindingId: string; isDefault: boolean; now: number },
): Promise<ReviveBindingIntentResult> {
  const binding = await getBinding(driver, input.bindingId)
  if (!binding) throw new Error(`binding not found: ${input.bindingId}`)
  if (binding.desired_state !== 'detached') {
    // 已 bound：幂等成功（重复复活/并发胜者已达成）。
    return { ok: true, bindingId: binding.binding_id, generation: binding.generation }
  }
  const inFlight = await driver.get(
    `SELECT id FROM zone_binding_outbox
     WHERE binding_id = ? AND status IN ('pending', 'claimed') LIMIT 1`,
    [input.bindingId],
  )
  if (inFlight) return { ok: false, reason: 'outbox-in-flight' }
  const generation = binding.generation + 1
  const outboxId = randomUUID()
  try {
    await driver.transaction(async () => {
      if (input.isDefault) {
        await demoteExistingDefaultBinding(driver, {
          orgId: binding.org_id,
          nexusDeploymentId: binding.nexus_deployment_id,
          excludeBindingId: binding.binding_id,
          now: input.now,
        })
      }
      const updated = await driver.run(
        `UPDATE org_zone_bindings
         SET desired_state = 'bound', sync_status = 'pending', generation = ?,
             nexus_grant_id = NULL, nexus_operation_id = NULL, is_default = ?, updated_at = ?
         WHERE binding_id = ? AND desired_state = 'detached'`,
        [generation, input.isDefault ? 1 : 0, input.now, input.bindingId],
      )
      if (updated === 0) throw new ReviveLostRace()
      await driver.run(
        `INSERT INTO zone_binding_outbox (
           id, binding_id, generation, action, status, fence, attempts, grant_source_id, created_at, updated_at
         ) VALUES (?, ?, ?, 'provision', 'pending', 0, 0, ?, ?, ?)`,
        [outboxId, input.bindingId, generation, `${input.bindingId}:${generation}`, input.now, input.now],
      )
      await driver.run(
        `INSERT INTO zone_binding_audit (id, binding_id, action, actor, detail, created_at)
         VALUES (?, ?, 'binding-intent-revived', 'admin', ?, ?)`,
        [
          randomUUID(),
          input.bindingId,
          JSON.stringify({ generation, isDefault: input.isDefault }),
          input.now,
        ],
      )
    })
  } catch (error) {
    if (error instanceof ReviveLostRace) {
      const after = await getBinding(driver, input.bindingId)
      if (after && after.desired_state === 'bound') {
        return { ok: true, bindingId: after.binding_id, generation: after.generation }
      }
      return { ok: false, reason: 'revive-race' }
    }
    throw error
  }
  return { ok: true, bindingId: input.bindingId, generation }
}


/** insertDetachIntent 的结果：并发败者（UPDATE 落空——desired 已被并发翻转）得到 ok:false，由调用方转 409。 */
export type InsertDetachIntentResult =
  | { ok: true; outboxId: string; generation: number }
  | { ok: false; reason: 'already-detached' }

/** 事务内部信号：条件 UPDATE 落空（并发 detach 竞态的败者）——回滚（无写入发生）并转 ok:false。 */
class DetachLostRace extends Error {}

/**
 * 解绑入口（§8.8："解绑 Org 访问"≠"删除 Zone 数据"）：desired_state →
 * detached、generation+1，并写 detach outbox 行（reconciler 异步 revoke 该
 * binding 派生的 grant——exactly-once，与其他 mutation 同一模型）。
 * Zone 数据、审计历史一概不动。
 */
export async function insertDetachIntent(
  driver: DbDriver,
  input: { bindingId: string; now: number },
): Promise<InsertDetachIntentResult> {
  const binding = await getBinding(driver, input.bindingId)
  if (!binding) throw new Error(`binding not found: ${input.bindingId}`)
  if (binding.desired_state === 'detached') {
    return { ok: false, reason: 'already-detached' }
  }
  const generation = binding.generation + 1
  const outboxId = randomUUID()
  try {
    // 事务 + UPDATE 行数检查（低-2/低-3）：并发双击的败者不再撞 outbox
    // UNIQUE 抛裸 500，而是得到明确的 ok:false（调用方转 409）。
    await driver.transaction(async () => {
      const updated = await driver.run(
        `UPDATE org_zone_bindings
         SET desired_state = 'detached', generation = ?, sync_status = 'detaching', updated_at = ?
         WHERE binding_id = ? AND desired_state = 'bound'`,
        [generation, input.now, input.bindingId],
      )
      if (updated === 0) throw new DetachLostRace()
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
    })
  } catch (error) {
    if (error instanceof DetachLostRace) return { ok: false, reason: 'already-detached' }
    throw error
  }
  return { ok: true, outboxId, generation }
}

/**
 * org 删除路径的 binding 收尾（低-4）：该 org 全部 bound binding 逐行写
 * detach intent（outbox 异步 revoke grant——替代原先不写 outbox 的裸
 * UPDATE，grant 不再残留）。authService 与 identity 两个删除入口共用；
 * 必须与 org 的 DELETE 同处一个事务（调用方保证）——FK 失败连 detach
 * 一并回滚，非空 org 的试探删除（常规 409 路径）不会误毁 binding。
 */
export async function detachAllBindingsForOrg(
  driver: DbDriver,
  input: { orgId: string; now: number },
): Promise<number> {
  const rows = await driver.all(
    `SELECT binding_id FROM org_zone_bindings WHERE org_id = ? AND desired_state = 'bound'`,
    [input.orgId],
  )
  for (const row of rows) {
    // ok:false = 行已被并发 detach：无需重复，继续。
    await insertDetachIntent(driver, { bindingId: String(row.binding_id), now: input.now })
  }
  return rows.length
}

/** detach 完成：outbox completed + binding sync detached。fence 保护同前。 */
export async function completeDetach(
  driver: DbDriver,
  input: { outboxId: string; fence: number; bindingId: string; operationId: string | null; now: number },
): Promise<boolean> {
  let outcome = false
  // 多语句写自包事务（低-3）。
  await driver.transaction(async () => {
    const done = await driver.run(
      `UPDATE zone_binding_outbox
       SET status = 'completed', operation_id = COALESCE(?, operation_id), lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'claimed' AND fence = ?`,
      [input.operationId, input.now, input.outboxId, input.fence],
    )
    if (done === 0) return
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
    outcome = true
  })
  return outcome
}
