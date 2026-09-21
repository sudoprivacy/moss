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
}

/** Build the child environment without leaking Moss/Nexus control-plane keys. */
export function applyRunnerZoneContext(
  baseEnv: Record<string, string>,
  context: RunnerZoneContext | null,
): Record<string, string> {
  const env = { ...baseEnv }
  delete env.MOSS_NEXUS_V2_SERVICE_TOKEN
  delete env.NEXUS_API_KEY
  delete env.NEXUS_ADMIN_BOOTSTRAP_TOKEN
  if (context) {
    env.NEXUS_ZONE_ID = context.NEXUS_ZONE_ID
    env.NEXUS_V2_BASE_URL = context.NEXUS_V2_BASE_URL
    env.NEXUS_DELEGATION_REF = context.NEXUS_DELEGATION_REF
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
): Promise<{ observedAt: string; observedRevision: string } | null> {
  try {
    const response = await client.createSession(input.sessionId, input.homeZoneId)
    return { observedAt: new Date().toISOString(), observedRevision: response.updated_at }
  } catch (error) {
    if (error instanceof NexusZoneApiError && error.status === 409) {
      try {
        const existing = await client.getSession(input.sessionId)
        if (existing.home_zone_id === input.homeZoneId) {
          return { observedAt: new Date().toISOString(), observedRevision: existing.updated_at }
        }
      } catch {
        // Fall through to pending: an existing session that cannot be read
        // back authoritatively is not considered reconciled.
      }
    }
    return null
  }
}

/** 后台补写：observed 为 null 的已解析 session 重试权威写入。 */
export async function reconcilePendingNexusSessions(
  driver: DbDriver,
  client: NexusZoneClient,
): Promise<number> {
  const rows = await driver.all(
    `SELECT session_id, home_zone_id FROM sessions
     WHERE home_zone_id IS NOT NULL AND home_zone_observed_revision IS NULL`,
  )
  let written = 0
  for (const row of rows) {
    const established = await establishNexusSession(client, {
      sessionId: String(row.session_id),
      homeZoneId: String(row.home_zone_id),
    })
    if (established) {
      await driver.run(
        `UPDATE sessions
         SET home_zone_observed_at = ?, home_zone_observed_revision = ?
         WHERE session_id = ?`,
        [established.observedAt, established.observedRevision, String(row.session_id)],
      )
      written += 1
    }
  }
  return written
}

/**
 * runner generation 对账（R5.2）：以 attempt 为 pid 在 Nexus 固化 execution
 * zone（默认 home zone），回读校验。返回对账结果（null=Nexus 不可达，
 * 本地 execution_zone_id 仍记录，对账待补）。
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
): Promise<{ executionZoneId: string; pid: string } | null> {
  const pid = runnerPid(input.attemptId)
  const executionZoneId = input.executionZoneId ?? input.homeZoneId
  if (
    executionZoneId !== input.homeZoneId
    && (!input.decisionReason || !input.policyVersion)
  ) {
    throw new Error('cross-Zone execution requires decision reason and policy version')
  }
  try {
    const run = await client.startRuntimeRun({
      pid,
      sessionId: input.sessionId,
      executionZoneHint: executionZoneId,
      delegationRef: input.delegationRef,
      decisionReason: input.decisionReason,
      policyVersion: input.policyVersion,
    })
    const readBack = await client.getRuntimeRun(pid)
    return {
      executionZoneId: readBack.execution_zone_id || run.execution_zone_id,
      pid,
    }
  } catch {
    return null
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
 */
export async function runnerZoneContext(
  driver: DbDriver,
  client: NexusZoneClient,
  input: { sessionId: string; config?: ZoneBindingConfig },
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
  const { ZoneDelegationService } = await import('../binding/delegationService.js')
  const { resolveZoneBindingConfig } = await import('../binding/config.js')
  const config = input.config ?? resolveZoneBindingConfig()
  const delegation = new ZoneDelegationService({
    driver,
    client,
    config,
  })
  const issued = await delegation.issueForOrgUser({
    orgId: String(userRow.org_id),
    userId: String(userRow.user_id),
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
     WHERE a.execution_zone_id = ? AND a.runtime_state IN ('starting', 'running', 'waiting')
       AND s.status = 'active'`,
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
