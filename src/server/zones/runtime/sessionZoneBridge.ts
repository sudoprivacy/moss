/**
 * Session ↔ Nexus Zone 桥（P1a，SW-20260915-002 §8.10 / R5.1–R5.8）。
 *
 * 职责（高内聚，全部 Zone 运行时语义集中于此）：
 *  - home Zone 解析：由 authenticated Org 的 **active default binding** 决定
 *    （policy 在本地 binding 表）；client payload 里的 zone 只是目标提示，
 *    只有与 policy 解析结果一致时才被接受，永不覆盖（R5.3）；
 *  - 权威写入：调 Nexus `POST /v2/sessions` 写权威 `home_zone_id`；Moss 本地
 *    sessions 行仅作投影（`home_zone_id` + observed time/revision——revision
 *    为 null 表示尚未在 Nexus 确认，由后台补写，R5.1）；
 *  - runner generation 对账：session_attempts 记录 `execution_zone_id`
 *    （expand-only 加列——它仍是 runtime generation，不做 Attempt 改名，
 *    R5.9），并调 Nexus `POST /v2/runtime/start` + `GET runs/{pid}` 回读
 *    对账（execution zone 默认 = home zone，R5.2）；
 *  - runner env 注入：NEXUS_ZONE_ID / NEXUS_V2_BASE_URL / 短期用户
 *    delegation ref——**绝不注入 service/global admin credential**（R5.4/5.5）；
 *  - revoke 联动：delegation/binding 失效时将受影响 zone 上的 active run 打成
 *    `revocation_pending`（不能立即终止时的隔离语义，R5.7）。
 *
 * backfill/migration 从不把 `org_id` 字符串直接当 Zone ID 用——home zone
 * 一律来自 binding 表（R5.8）。
 */

import type { DbDriver } from '../../db/driver.js'
import type { ZoneBindingConfig } from '../binding/config.js'
import { NexusZoneApiError, NexusZoneClient } from '../../nexus/nexusZoneClient.js'
// M-4：非终态 attempt 白名单的唯一事实源（与 db.ts touchAttemptHeartbeat 的
// 内联先例同款）——park 的 SQL IN 集合由它编译期生成，杜绝手写列表漂移
// （原 'waiting' 是本地状态机不存在的死值、'detached' 活 runner 被漏）。
import { ALIVE_ATTEMPT_STATES } from '../../attemptLiveness.js'

export interface HomeZoneResolution {
  homeZoneId: string | null
  /** payload 提示被忽略时记录原因（审计/测试断言用）。 */
  payloadZoneAccepted: boolean
  payloadZoneIgnoredReason?: string
}

export interface RunnerZoneContext {
  NEXUS_ZONE_ID: string
  NEXUS_V2_BASE_URL: string
  NEXUS_DELEGATION_REF: string
  NEXUS_RESOURCE_SCOPE: string
}

/**
 * Build the child environment stripping the NEXUS-zone control-plane keys
 * (低-15⑦ 如实声明：MOSS_NEXUS_AUTH_TOKEN / CABIN_TOKEN_SECRET /
 * MOSS_RESOURCE_TOKEN_SECRET 等基线遗留的进程级密钥仍随 process.env 直传
 * runner——基线行为，超出本机制范围，修复需先验证 runner 对它们无依赖）。
 */
export function applyRunnerZoneContext(
  baseEnv: Record<string, string>,
  context: RunnerZoneContext | null,
): Record<string, string> {
  const env = { ...baseEnv }
  delete env.MOSS_NEXUS_V2_SERVICE_TOKEN
  delete env.NEXUS_API_KEY
  delete env.NEXUS_ADMIN_BOOTSTRAP_TOKEN
  delete env.MOSS_INTERNAL_API_TOKEN
  delete env.NEXUS_RESOURCE_SCOPE
  if (context) {
    env.NEXUS_ZONE_ID = context.NEXUS_ZONE_ID
    env.NEXUS_V2_BASE_URL = context.NEXUS_V2_BASE_URL
    env.NEXUS_DELEGATION_REF = context.NEXUS_DELEGATION_REF
    env.NEXUS_RESOURCE_SCOPE = context.NEXUS_RESOURCE_SCOPE
  }
  return env
}

/** 本地 policy：org 的 active default binding 决定 home Zone。 */
export async function resolveHomeZone(
  driver: DbDriver,
  orgId: string,
  nexusDeploymentId: string,
): Promise<string | null> {
  const row = await driver.get(
    `SELECT zone_id FROM org_zone_bindings
     WHERE org_id = ? AND nexus_deployment_id = ? AND is_default = 1
       AND desired_state = 'bound' AND sync_status = 'active'
     ORDER BY created_at LIMIT 1`,
    [orgId, nexusDeploymentId],
  )
  return row ? String(row.zone_id) : null
}

/** R5.3：payload zone 只是提示，仅当与 policy 解析一致时接受。 */
export async function resolveHomeZoneWithHint(
  driver: DbDriver,
  orgId: string,
  payloadZoneHint: string | undefined,
  config: ZoneBindingConfig,
): Promise<HomeZoneResolution> {
  // M-6：未配置 /v2 endpoint（zoneBindingEnabled=false）时 Nexus 会话不存
  // 在（P1a 渐进语义：无 Zone 会话落 moss 本地）——新会话不解析 home zone，
  // 不落 home_zone_id；严格模式的 ZoneRequiredError 由调用方的 requireZone
  // 门在 homeZoneId=null 处自然触发。
  if (!config.zoneBindingEnabled) {
    return {
      homeZoneId: null,
      payloadZoneAccepted: false,
      payloadZoneIgnoredReason: 'zone binding disabled (MOSS_NEXUS_V2_BASE_URL unset)',
    }
  }
  const homeZoneId = await resolveHomeZone(driver, orgId, config.nexusDeploymentId)
  if (homeZoneId === null) {
    return {
      homeZoneId: null,
      payloadZoneAccepted: false,
      payloadZoneIgnoredReason: 'org has no active default zone binding',
    }
  }
  if (payloadZoneHint === undefined || payloadZoneHint === homeZoneId) {
    return { homeZoneId, payloadZoneAccepted: payloadZoneHint !== undefined }
  }
  return {
    homeZoneId,
    payloadZoneAccepted: false,
    payloadZoneIgnoredReason: `payload zone hint ${payloadZoneHint} != policy home zone ${homeZoneId}; hint ignored`,
  }
}

/** Nexus Session API 的薄类型（本地副本，非 wire SSOT——见计划阶段 5 决策）。 */
interface NexusSessionView {
  session_id: string
  home_zone_id: string
  updated_at: string
}

/**
 * 建立权威 Nexus session（R5.1）。返回 observed 标记；Nexus 不可达时返回
 * null（调用方落本地投影 + observed=null，等待补写）。
 */
export async function establishNexusSession(
  client: NexusZoneClient,
  input: { sessionId: string; homeZoneId: string },
): Promise<{
  observedAt: string | null
  observedRevision: string | null
  syncError: string | null
} | null> {
  try {
    const response = await client.createSession(input.sessionId, input.homeZoneId)
    return {
      observedAt: new Date().toISOString(),
      observedRevision: response.updated_at,
      syncError: null,
    }
  } catch (error) {
    if (error instanceof NexusZoneApiError && error.status === 409) {
      try {
        const existing = await client.getSession(input.sessionId)
        if (existing.home_zone_id === input.homeZoneId) {
          return {
            observedAt: new Date().toISOString(),
            observedRevision: existing.updated_at,
            syncError: null,
          }
        }
        return {
          observedAt: null,
          observedRevision: null,
          syncError: `HOME_ZONE_CONFLICT:${existing.home_zone_id}`,
        }
      } catch {
        // Fall through to pending: an existing session that cannot be read
        // back authoritatively is not considered reconciled.
      }
    }
    return null
  }
}

/** 后台补写：observed 为 null 的已解析 session 重试权威写入（低-15⑤：LIMIT 批次化）。 */
export async function reconcilePendingNexusSessions(
  driver: DbDriver,
  client: NexusZoneClient,
): Promise<number> {
  const rows = await driver.all(
    `SELECT session_id, home_zone_id FROM sessions
     WHERE home_zone_id IS NOT NULL
       AND home_zone_observed_revision IS NULL
       AND home_zone_sync_error IS NULL
     LIMIT 50`,
  )
  let written = 0
  for (const row of rows) {
    const established = await establishNexusSession(client, {
      sessionId: String(row.session_id),
      homeZoneId: String(row.home_zone_id),
    })
    if (established?.syncError) {
      await driver.run(
        `UPDATE sessions SET home_zone_sync_error = ? WHERE session_id = ?`,
        [established.syncError, String(row.session_id)],
      )
    } else if (established?.observedRevision) {
      await driver.run(
        `UPDATE sessions
         SET home_zone_observed_at = ?, home_zone_observed_revision = ?, home_zone_sync_error = NULL
         WHERE session_id = ?`,
        [established.observedAt, established.observedRevision, String(row.session_id)],
      )
      written += 1
    }
  }
  return written
}

/** reconcileRunnerGeneration 的结果：ok=false 携带错误码（低-15④——不再吞根因）。 */
export type RunnerGenerationReconcileResult =
  | { ok: true; executionZoneId: string; pid: string }
  | { ok: false; errorCode: string }

/**
 * runner generation 对账（R5.2）：以 attempt 为 pid 在 Nexus 固化 execution
 * zone（默认 home zone），回读校验。
 *
 * 低-15④/M-5：start 成功但后续失败（回读超时等）时立即 best-effort 取消
 * 该 run——"幽灵 run"（Nexus 侧已固化、本地 markAttemptLost 后不再有任何
 * 自动取消路径）不再产生；错误码随结果带出，供 markAttemptLost 的
 * error_text 记录（不再 catch-all 吞根因）。
 */
export async function reconcileRunnerGeneration(
  client: NexusZoneClient,
  input: {
    attemptId: string
    sessionId: string
    homeZoneId: string
    delegationRef: string
    executionZoneId?: string
    decisionReason?: string
    policyVersion?: string
  },
): Promise<RunnerGenerationReconcileResult> {
  const pid = runnerPid(input.attemptId)
  const executionZoneId = input.executionZoneId ?? input.homeZoneId
  if (
    executionZoneId !== input.homeZoneId
    && (!input.decisionReason || !input.policyVersion)
  ) {
    throw new Error('cross-Zone execution requires decision reason and policy version')
  }
  let started = false
  try {
    await client.startRuntimeRun({
      pid,
      sessionId: input.sessionId,
      executionZoneHint: executionZoneId,
      delegationRef: input.delegationRef,
      decisionReason: input.decisionReason,
      policyVersion: input.policyVersion,
    })
    started = true
    const readBack = await client.getRuntimeRun(pid)
    return {
      ok: true,
      executionZoneId: readBack.execution_zone_id || executionZoneId,
      pid,
    }
  } catch (error) {
    if (started) {
      try { await client.cancelRuntimeRun(pid, 'terminate') } catch { /* best-effort */ }
    }
    return {
      ok: false,
      errorCode: error instanceof NexusZoneApiError ? error.code : 'OUTCOME_UNKNOWN',
    }
  }
}

/** runner pid 派生（稳定、可对账）。 */
export function runnerPid(attemptId: string): string {
  return `moss-${attemptId}`
}

/**
 * runner env 的 Zone context（R5.4/R5.5）：NEXUS_ZONE_ID + endpoint + 短期
 * **用户** delegation ref。service credential 留在 moss 进程内，永不进
 * runner env。
 *
 * 低-7：delegation 服务优先取进程级共享实例（组装处 set）——registry 的
 * 短 TTL 复用与 membership revoke 钩子对 runner 路径生效（此前每次 spawn
 * new 一个实例，registry 与 revoke 覆盖对 runner 拿走的 delegation 均不
 * 成立）；未 set（测试）时回退新建。runtimePid 必填——与真实 run 的 pid
 * （attemptId 派生）一致由调用方保证，不留错误默认值。
 */
export async function runnerZoneContext(
  driver: DbDriver,
  client: NexusZoneClient,
  input: { sessionId: string; runtimePid: string; config?: ZoneBindingConfig },
): Promise<RunnerZoneContext | null> {
  const row = await driver.get(
    `SELECT home_zone_id FROM sessions WHERE session_id = ? LIMIT 1`,
    [input.sessionId],
  )
  if (!row || row.home_zone_id == null) return null
  const homeZoneId = String(row.home_zone_id)
  const userRow = await driver.get(
    `SELECT org_id, user_id FROM sessions WHERE session_id = ? LIMIT 1`,
    [input.sessionId],
  )
  if (!userRow) return null
  // 短期用户 delegation：由 moss 的 issuance service 换发；runner 只拿到
  // delegation ref（短期、最小 scope），拿不到 service credential。
  const { ZoneDelegationService, getSharedZoneDelegation } = await import('../binding/delegationService.js')
  const { resolveZoneBindingConfig } = await import('../binding/config.js')
  const config = input.config ?? resolveZoneBindingConfig()
  const delegation = getSharedZoneDelegation() ?? new ZoneDelegationService({
    driver,
    client,
    config,
  })
  const runtimePidValue = input.runtimePid
  const issued = await delegation.issueForOrgUser({
    orgId: String(userRow.org_id),
    userId: String(userRow.user_id),
    purpose: 'runtime',
    scopeRules: [{
      capability: 'zone.runtime.execute',
      resourcePrefixes: [`/sessions/${input.sessionId}`],
    }],
  })
  if (issued.zoneId !== homeZoneId) {
    throw new Error(
      `session home Zone ${homeZoneId} no longer matches active binding ${issued.zoneId}`,
    )
  }
  return {
    NEXUS_ZONE_ID: homeZoneId,
    NEXUS_V2_BASE_URL: config.nexusV2BaseUrl,
    NEXUS_DELEGATION_REF: issued.delegationId,
    NEXUS_RESOURCE_SCOPE: JSON.stringify({
      schema_version: 1,
      zone_id: homeZoneId,
      rules: [
        { capability: 'zone.data.read', resource_prefixes: [`/proc/${runtimePidValue}/workspace`] },
        { capability: 'zone.data.write', resource_prefixes: [`/proc/${runtimePidValue}/workspace`] },
      ],
    }),
  }
}

/**
 * revoke 联动（R5.7）：binding/dlegation 失效时，把该 zone 上 active 的
 * runner generation 在 Nexus 打成 revocation_pending（隔离；不能立即终止
 * 时不再获得新资源）。
 */
export async function parkRunsForZone(
  driver: DbDriver,
  client: NexusZoneClient,
  zoneId: string,
): Promise<number> {
  const rows = await driver.all(
    `SELECT a.attempt_id FROM session_attempts a
     JOIN sessions s ON s.session_id = a.session_id
     WHERE a.execution_zone_id = ? AND a.runtime_state IN (${ALIVE_ATTEMPT_STATES.map(s => `'${s}'`).join(', ')})
       AND s.status IN ('active', 'detached')`,
    [zoneId],
  )
  let parked = 0
  for (const row of rows) {
    try {
      await client.cancelRuntimeRun(runnerPid(String(row.attempt_id)), 'pending')
      parked += 1
    } catch {
      // run 可能已终止（幂等语义）——best-effort
    }
  }
  return parked
}

/**
 * run 生命周期对账（M-5）：moss 侧的 run 只有 start 没有 end——正常结束、
 * idle kill、terminate、drain、markAttemptStopped/markAttemptLost 全路径都
 * 不通知 Nexus，run 在 Nexus 侧停留活跃态（ZONE_DELETE_BLOCKED 卡住
 * deprovision），回读超时产生的"幽灵 run"更是永不收敛。
 *
 * 后台对账模型（唯一完备解——同步式嵌入覆盖不了进程崩溃场景）：扫终态
 * attempt（stopped/failed/lost，含僵尸 attempt 的幽灵 run）且未标记
 * nexus_run_ended_at 的行，逐个 cancelRuntimeRun(terminate) 后回填标记。
 * 失败（Nexus 不可达）下轮重试（未标记的行仍在查询集内）；对不存在的
 * run 的 404 也标记（幂等语义，宁可标记）。
 */
export async function endZoneRunsForSettledAttempts(
  driver: DbDriver,
  client: NexusZoneClient,
  limit: number,
): Promise<number> {
  const rows = await driver.all(
    `SELECT attempt_id FROM session_attempts
     WHERE execution_zone_id IS NOT NULL
       AND nexus_run_ended_at IS NULL
       AND runtime_state IN ('stopped', 'failed', 'lost')
     ORDER BY started_at
     LIMIT ?`,
    [limit],
  )
  let ended = 0
  for (const row of rows) {
    const attemptId = String(row.attempt_id)
    try {
      await client.cancelRuntimeRun(runnerPid(attemptId), 'terminate')
    } catch {
      // 404（run 从未建/已清）同样标记结束；网络失败不标记、下轮重试。
      // 区分不了 404 与网络错时保守不标记——宁可下轮重试（幂等），不可
      // 漏标（漏标无收敛）。
      if (!(await isRunCancelConfirmedAbsent(driver, client, attemptId))) continue
    }
    await driver.run(
      `UPDATE session_attempts SET nexus_run_ended_at = ? WHERE attempt_id = ?`,
      [Date.now(), attemptId],
    )
    ended += 1
  }
  return ended
}

/** cancel 失败后的甄别：回读 run 确认其已不存在（不存在=幂等可标记；读不到=保守不标记）。 */
async function isRunCancelConfirmedAbsent(driver: DbDriver, client: NexusZoneClient, attemptId: string): Promise<boolean> {
  try {
    await client.getRuntimeRun(runnerPid(attemptId))
    return false // run 仍在——cancel 确实失败，不标记
  } catch (error) {
    if (error instanceof NexusZoneApiError && error.status === 404) return true
    return false // 网络类——保守不标记
  }
}
