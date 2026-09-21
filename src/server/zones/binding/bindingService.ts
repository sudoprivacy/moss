/**
 * Zone binding reconciler —— 消费 zone_binding_outbox，把 default binding
 * 收敛为 Nexus 上的 Zone + Org ZoneGrant（§8.7）。
 *
 * 幂等推进设计：provision 的每一步（createZone / createGrant）都携带由
 * (binding_id, generation, action) 派生的稳定 idempotency key——单轮未走
 * 完（超时/unknown/进程重启）后下一轮从头部幂等重入，同 key 返回同
 * operation，绝不重复创建。这替代了在 outbox 行里存多阶段状态机：
 * 阶段事实由 Nexus operation 持有，本地只存最终 grant/operation 引用。
 *
 * 错误分派（§8.7 client 规则）：
 *  - NexusZoneUnknownError（timeout/断连）→ binding `unknown` + 可重试：
 *    效果未知，下轮以同 key 收敛（先隐式查 operation——createZone 同 key
 *    幂等返回原 operation，即等价于"先查 operation"）；
 *  - ZONE_ALREADY_EXISTS → 合法收敛路径（此前 provision 已建过 Zone），
 *    继续走 grant；
 *  - retryable API 错误 → 指数退避回 pending；不可重试 → failed +
 *    binding sync_failed（§8.7 验收：Nexus 离线 Org 创建可完成、binding
 *    pending；恢复后 exactly-once）。
 */
import type { DbDriver } from '../../db/driver.js'
import type { ZoneBindingConfig } from './config.js'
import {
  claimDueOutbox,
  completeDetach,
  completeProvision,
  failOutboxAttempt,
  getBinding,
  markBindingSyncing,
  type ZoneBindingOutboxRow,
} from './bindingRepository.js'
import {
  NexusZoneApiError,
  NexusZoneClient,
  type ZoneOperationRef,
} from '../../nexus/nexusZoneClient.js'

export interface ZoneBindingReconcilerOptions {
  driver: DbDriver
  client: NexusZoneClient
  config: ZoneBindingConfig
  /** grant 的 policy 版本（审计与对账用）。 */
  policyVersion?: string
  /** 单条 provision 内等待单个 operation 完成的上限。 */
  operationWaitMs?: number
  operationPollIntervalMs?: number
  /** 单轮最多处理的 outbox 行数。 */
  batchSize?: number
  leaseOwner?: string
  leaseMs?: number
  baseBackoffMs?: number
}

const DEFAULT_OPERATION_WAIT_MS = 60_000
const DEFAULT_OPERATION_POLL_MS = 500
const DEFAULT_BATCH = 8
const DEFAULT_LEASE_MS = 120_000
const DEFAULT_BACKOFF_MS = 2_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class ZoneBindingReconciler {
  private readonly driver: DbDriver
  private readonly client: NexusZoneClient
  private readonly config: ZoneBindingConfig
  private readonly policyVersion: string
  private readonly operationWaitMs: number
  private readonly operationPollMs: number
  private readonly batchSize: number
  private readonly leaseOwner: string
  private readonly leaseMs: number
  private readonly baseBackoffMs: number

  constructor(options: ZoneBindingReconcilerOptions) {
    this.driver = options.driver
    this.client = options.client
    this.config = options.config
    this.policyVersion = options.policyVersion ?? 'moss-default-v1'
    this.operationWaitMs = options.operationWaitMs ?? DEFAULT_OPERATION_WAIT_MS
    this.operationPollMs = options.operationPollIntervalMs ?? DEFAULT_OPERATION_POLL_MS
    this.batchSize = options.batchSize ?? DEFAULT_BATCH
    this.leaseOwner = options.leaseOwner ?? `moss-reconciler-${process.pid}`
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BACKOFF_MS
  }

  /** 处理一轮到期 outbox。幂等、无副作用排序要求；返回计数仅用于观测。 */
  async reconcileOnce(now = Date.now()): Promise<{ claimed: number; completed: number; retried: number; failed: number }> {
    const rows = await claimDueOutbox(this.driver, {
      leaseOwner: this.leaseOwner,
      leaseUntilMs: now + this.leaseMs,
      now,
      limit: this.batchSize,
    })
    let completed = 0
    let retried = 0
    let failed = 0
    for (const row of rows) {
      const outcome = await this.processRow(row, now)
      if (outcome === 'completed') completed++
      else if (outcome === 'failed') failed++
      else retried++
    }
    return { claimed: rows.length, completed, retried, failed }
  }

  private async processRow(row: ZoneBindingOutboxRow, now: number): Promise<'completed' | 'failed' | 'retried'> {
    const binding = await getBinding(this.driver, row.binding_id)
    if (!binding) {
      // binding 行缺失（数据被人为清除）：failed 终态，不反复空转
      await failOutboxAttempt(this.driver, {
        outboxId: row.id,
        fence: row.fence,
        bindingId: row.binding_id,
        errorCode: 'BINDING_NOT_FOUND',
        unknownOutcome: false,
        retryable: false,
        now,
        baseBackoffMs: this.baseBackoffMs,
      })
      return 'failed'
    }
    if (row.action === 'detach') {
      return this.processDetach(row, binding, now)
    }
    if (binding.desired_state !== 'bound') {
      // provision 语义已被 desired 翻转取代（例如 provision 排队期间解绑）：
      // 该 provision 行不再收敛，标 failed 终态
      await failOutboxAttempt(this.driver, {
        outboxId: row.id,
        fence: row.fence,
        bindingId: row.binding_id,
        errorCode: 'DESIRED_STATE_DETACHED',
        unknownOutcome: false,
        retryable: false,
        now,
        baseBackoffMs: this.baseBackoffMs,
      })
      return 'failed'
    }

    await markBindingSyncing(this.driver, { bindingId: binding.binding_id, operationId: null, now })

    // 稳定 idempotency key：(binding, generation, action) 派生——重入同 key
    const zoneKey = `moss-binding:${row.binding_id}:${row.generation}:provision-zone`
    const grantKey = `moss-binding:${row.binding_id}:${row.generation}:provision-grant`

    try {
      // 1) Zone（幂等；已存在视为合法收敛，继续 grant）
      let zoneOp: ZoneOperationRef
      try {
        zoneOp = await this.client.createZone(
          { zoneId: binding.zone_id, displayName: binding.zone_id },
          zoneKey,
        )
      } catch (error) {
        if (error instanceof NexusZoneApiError && error.code === 'ZONE_ALREADY_EXISTS') {
          zoneOp = { operation_id: '', action: 'create', zone_id: binding.zone_id, grant_id: null, state: 'succeeded', step: 'already-exists', retryable: false }
        } else {
          throw error
        }
      }
      if (zoneOp.operation_id !== '') {
        await this.waitOperation(zoneOp.operation_id)
      }

      // 2) Org ZoneGrant（source 指回 binding，ReBAC/审计可溯源）
      const grantOp = await this.client.createGrant(
        {
          zoneId: binding.zone_id,
          grantee: { subject_type: 'organization', subject_id: binding.org_id },
          capabilities: JSON.parse(binding.desired_capabilities) as string[],
          source: { source_type: 'moss_org_binding', source_id: binding.binding_id },
          reason: 'moss default org zone binding',
          policyVersion: this.policyVersion,
        },
        grantKey,
      )
      const doneGrantOp = await this.waitOperation(grantOp.operation_id)
      if (doneGrantOp.state !== 'succeeded' || !doneGrantOp.grant_id) {
        // operation 终态失败：不可重试（重试同 key 也同结果），标 failed
        const ok = await failOutboxAttempt(this.driver, {
          outboxId: row.id,
          fence: row.fence,
          bindingId: binding.binding_id,
          errorCode: doneGrantOp.state === 'failed' ? 'GRANT_OPERATION_FAILED' : 'GRANT_ID_MISSING',
          unknownOutcome: false,
          retryable: false,
          now: Date.now(),
          baseBackoffMs: this.baseBackoffMs,
        })
        return ok ? 'failed' : 'retried'
      }

      const ok = await completeProvision(this.driver, {
        outboxId: row.id,
        fence: row.fence,
        bindingId: binding.binding_id,
        zoneId: binding.zone_id,
        grantId: doneGrantOp.grant_id,
        operationId: doneGrantOp.operation_id,
        now: Date.now(),
      })
      return ok ? 'completed' : 'retried' // ok=false：lease 被接管，本 worker 放弃
    } catch (error) {
      const unknown = !(error instanceof NexusZoneApiError)
      const retryable = unknown ? true : error.retryable
      const code = error instanceof NexusZoneApiError ? error.code : 'OUTCOME_UNKNOWN'
      const ok = await failOutboxAttempt(this.driver, {
        outboxId: row.id,
        fence: row.fence,
        bindingId: binding.binding_id,
        errorCode: code,
        unknownOutcome: unknown,
        retryable,
        now: Date.now(),
        baseBackoffMs: this.baseBackoffMs,
      })
      return ok ? (retryable ? 'retried' : 'failed') : 'retried'
    }
  }

  /**
   * detach 收敛：revoke 该 binding 派生的 grant（幂等 key 稳定；grant 已
   * 不存在视为合法收敛）。只撤访问，不触碰 Zone 数据（§8.8）。
   */
  private async processDetach(
    row: ZoneBindingOutboxRow,
    binding: { binding_id: string; zone_id: string; nexus_grant_id: string | null },
    now: number,
  ): Promise<'completed' | 'failed' | 'retried'> {
    try {
      let operationId: string | null = null
      if (binding.nexus_grant_id) {
        const revokeKey = `moss-binding:${row.binding_id}:${row.generation}:detach-revoke`
        let op
        try {
          op = await this.client.revokeGrant(binding.zone_id, binding.nexus_grant_id, revokeKey)
        } catch (error) {
          if (error instanceof NexusZoneApiError && error.code === 'GRANT_NOT_FOUND') {
            op = { operation_id: '', action: 'revoke', zone_id: binding.zone_id, grant_id: null, state: 'succeeded', step: 'already-revoked', retryable: false }
          } else {
            throw error
          }
        }
        if (op.operation_id !== '') {
          const done = await this.waitOperation(op.operation_id)
          if (done.state !== 'succeeded') {
            const ok = await failOutboxAttempt(this.driver, {
              outboxId: row.id,
              fence: row.fence,
              bindingId: binding.binding_id,
              errorCode: 'REVOKE_OPERATION_FAILED',
              unknownOutcome: false,
              retryable: false,
              now: Date.now(),
              baseBackoffMs: this.baseBackoffMs,
            })
            return ok ? 'failed' : 'retried'
          }
          operationId = done.operation_id
        }
      }
      const ok = await completeDetach(this.driver, {
        outboxId: row.id,
        fence: row.fence,
        bindingId: binding.binding_id,
        operationId,
        now: Date.now(),
      })
      return ok ? 'completed' : 'retried'
    } catch (error) {
      const unknown = !(error instanceof NexusZoneApiError)
      const retryable = unknown ? true : error.retryable
      const code = error instanceof NexusZoneApiError ? error.code : 'OUTCOME_UNKNOWN'
      const ok = await failOutboxAttempt(this.driver, {
        outboxId: row.id,
        fence: row.fence,
        bindingId: binding.binding_id,
        errorCode: code,
        unknownOutcome: unknown,
        retryable,
        now: Date.now(),
        baseBackoffMs: this.baseBackoffMs,
      })
      return ok ? (retryable ? 'retried' : 'failed') : 'retried'
    }
  }

  /** 轮询至 operation 终态或超时；超时抛 UnknownError（下轮幂等重入）。 */
  private async waitOperation(operationId: string): Promise<ZoneOperationRef> {
    const deadline = Date.now() + this.operationWaitMs
    for (;;) {
      const op = await this.client.getOperation(operationId)
      if (op.state === 'succeeded' || op.state === 'failed') return op
      if (Date.now() >= deadline) {
        throw new NexusZoneApiError(
          `operation ${operationId} not settled within ${this.operationWaitMs}ms`,
          'OPERATION_TIMEOUT',
          true,
          0,
        )
      }
      await sleep(this.operationPollMs)
    }
  }
}
