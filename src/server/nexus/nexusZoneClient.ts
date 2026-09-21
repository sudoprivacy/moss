/**
 * NexusZoneClient — Moss 侧 Nexus public `/v2` 管理 API 客户端。
 *
 * 语义要点（SW-20260915-002-MOSS-BINDING §8.7 client 规则，勿改）：
 *  - 只走 public `/v2` HTTP API；不扩展 raw VFS secrets client（gRPC 通道，
 *    nexusClient.ts/nexusSecretClient.ts）做管理——endpoint、service
 *    credential、timeout 与 VFS 通道完全分离（config 见 zones/binding/config.ts）；
 *  - mutation 一律携带 Idempotency-Key；重试（网络不确定后的收敛查询、
 *    429/5xx retryable）必须**复用同一 key**——同 key 同请求返回同
 *    operation，换 key 等于重建资源；
 *  - timeout/连接丢失 => `NexusZoneUnknownError`：效果未知（call 可能已
 *    成功、响应丢失），调用方必须先把 binding 置 `unknown` 并凭 operation
 *    查询收敛，不得当失败重发；
 *  - 响应 wire 校验来自 `@sudo/contracts`（auth/v1 的 validateZone/
 *    validateZoneGrant/validateZoneOperation——owner 定义在 nexus，本仓不
 *    重写 Zone/ZoneGrant interface）；ZoneOperation 是异步操作引用，其
 *    结构由本 client 做**最小字段校验**（operation_id/state/step），这不构
 *    成对 owner object 的重定义；
 *  - Authorization credential 不出现在任何日志/错误消息里。
 */
import { validateZone, validateZoneGrant, validateZoneOperation } from '@sudo/contracts/auth/v1'
import { validatePrincipalRef } from '@sudo/contracts/common/v1'
import type { ZoneBindingConfig } from '../zones/binding/config.js'

/** 请求效果未知（timeout / 连接中断）。先查 operation，不要换 key 重发。 */
export class NexusZoneUnknownError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'NexusZoneUnknownError'
  }
}

/** Nexus 返回的结构化错误（detail: {code, message, retryable}）。 */
export class NexusZoneApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'NexusZoneApiError'
  }
}

/** `/v2` mutation 的异步操作引用（202 + Location 语义）。 */
export interface ZoneOperationRef {
  operation_id: string
  action: string
  zone_id: string | null
  grant_id: string | null
  state: 'queued' | 'running' | 'waiting_dependency' | 'succeeded' | 'failed'
  step: string
  retryable: boolean
}

export interface ZoneGrantInput {
  zoneId: string
  grantee: { subject_type: 'organization' | 'user' | 'agent' | 'service'; subject_id: string; trust_domain?: string }
  capabilities: string[]
  resourcePrefixes?: string[]
  source?: { source_type: 'manual' | 'moss_org_binding' | 'migration' | 'system'; source_id: string }
  reason: string
  policyVersion: string
}

export interface ZoneDelegationInput {
  userId: string
  orgId: string
  membershipVersion: string
  zoneId: string
  audience: string
  ttlS: number
}

export interface ZoneDelegationResult {
  delegation_id: string
  user_id: string
  org_id: string
  zone_id: string
  audience: string
  expires_at: string
  status: string
}

const OPERATION_STATES: readonly ZoneOperationRef['state'][] = [
  'queued',
  'running',
  'waiting_dependency',
  'succeeded',
  'failed',
]

export class NexusZoneClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(config: Pick<ZoneBindingConfig, 'nexusV2BaseUrl' | 'nexusV2ServiceToken' | 'nexusV2TimeoutMs'>) {
    // 去掉尾斜杠，路径拼接统一在此处
    this.baseUrl = config.nexusV2BaseUrl.replace(/\/+$/, '')
    this.token = config.nexusV2ServiceToken
    this.timeoutMs = config.nexusV2TimeoutMs
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    input: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
        signal: controller.signal,
      })
    } catch (error) {
      // 网络层失败（含 timeout abort）：效果未知
      throw new NexusZoneUnknownError(`nexus /v2 ${method} ${path} outcome unknown`, error)
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      let code = 'UNKNOWN'
      let message = `nexus /v2 ${method} ${path} -> ${response.status}`
      let retryable = false
      try {
        const detail = (await response.json()) as { detail?: { code?: string; message?: string; retryable?: boolean } }
        if (detail?.detail && typeof detail.detail === 'object') {
          code = detail.detail.code ?? code
          message = detail.detail.message ?? message
          retryable = Boolean(detail.detail.retryable)
        }
      } catch {
        // 非 JSON 错误体：保留 HTTP 语义
      }
      throw new NexusZoneApiError(message, code, retryable, response.status)
    }

    if (response.status === 204) return null
    try {
      return await response.json()
    } catch (error) {
      throw new NexusZoneUnknownError(`nexus /v2 ${method} ${path} returned unparseable body`, error)
    }
  }

  private static parseOperation(payload: unknown): ZoneOperationRef {
    if (typeof payload !== 'object' || payload === null) {
      throw new NexusZoneApiError('malformed operation payload', 'CONTRACT', false, 0)
    }
    const op = payload as Record<string, unknown>
    const state = String(op.state) as ZoneOperationRef['state']
    if (!OPERATION_STATES.includes(state)) {
      throw new NexusZoneApiError(`unknown operation state: ${String(op.state)}`, 'CONTRACT', false, 0)
    }
    return {
      operation_id: String(op.operation_id),
      action: String(op.action),
      zone_id: op.zone_id == null ? null : String(op.zone_id),
      grant_id: op.grant_id == null ? null : String(op.grant_id),
      state,
      step: String(op.step ?? ''),
      retryable: Boolean(op.retryable),
    }
  }

  /** POST /v2/zones —— 202 + operation（§6.2）。 */
  async createZone(
    input: { zoneId: string; displayName: string },
    idempotencyKey: string,
  ): Promise<ZoneOperationRef> {
    const payload = await this.request('POST', '/v2/zones', {
      idempotencyKey,
      body: {
        zone_id: input.zoneId,
        display_name: input.displayName,
      },
    })
    return NexusZoneClient.parseOperation(payload)
  }

  /** POST /v2/zones/{zone_id}/grants —— 202 + operation（§6.3）。 */
  async createGrant(input: ZoneGrantInput, idempotencyKey: string): Promise<ZoneOperationRef> {
    if (!validatePrincipalRef(input.grantee)) {
      throw new NexusZoneApiError('grantee failed @sudo/contracts PrincipalRef validation', 'CONTRACT', false, 0)
    }
    const payload = await this.request('POST', `/v2/zones/${encodeURIComponent(input.zoneId)}/grants`, {
      idempotencyKey,
      body: {
        grantee: input.grantee,
        capabilities: input.capabilities,
        resource_prefixes: input.resourcePrefixes,
        source: input.source,
        reason: input.reason,
        policy_version: input.policyVersion,
      },
    })
    return NexusZoneClient.parseOperation(payload)
  }

  /** GET /v2/zone-operations/{operation_id} —— unknown 收敛与轮询。 */
  async getOperation(operationId: string): Promise<ZoneOperationRef> {
    const payload = await this.request('GET', `/v2/zone-operations/${encodeURIComponent(operationId)}`)
    return NexusZoneClient.parseOperation(payload)
  }

  /** GET /v2/zones/{zone_id} —— binding 对账（observed Nexus state）。 */
  async getZone(zoneId: string): Promise<{
    zone_id: string
    display_name: string
    status: string
    revision: string
  }> {
    const payload = await this.request('GET', `/v2/zones/${encodeURIComponent(zoneId)}`)
    if (!validateZone(payload)) {
      throw new NexusZoneApiError('zone payload failed @sudo/contracts Zone validation', 'CONTRACT', false, 0)
    }
    const zone = payload as { zone_id: string; display_name: string; status: string; revision: string }
    return { zone_id: zone.zone_id, display_name: zone.display_name, status: zone.status, revision: zone.revision }
  }

  /** GET /v2/zones/{zone_id}/grants/{grant_id} —— grant 对账。 */
  async getGrant(zoneId: string, grantId: string): Promise<{
    grant_id: string
    status: string
    revision: string
    expires_at: string | null
  }> {
    const payload = await this.request(
      'GET',
      `/v2/zones/${encodeURIComponent(zoneId)}/grants/${encodeURIComponent(grantId)}`,
    )
    if (!validateZoneGrant(payload)) {
      throw new NexusZoneApiError('grant payload failed @sudo/contracts ZoneGrant validation', 'CONTRACT', false, 0)
    }
    const grant = payload as { grant_id: string; status: string; revision: string; expires_at: string | null }
    return {
      grant_id: grant.grant_id,
      status: grant.status,
      revision: grant.revision,
      expires_at: grant.expires_at ?? null,
    }
  }

  /** POST /v2/auth/zone-delegations —— 仅受信任 Moss issuance service（§6.4）。 */
  async issueDelegation(input: ZoneDelegationInput, idempotencyKey: string): Promise<ZoneDelegationResult> {
    const payload = await this.request('POST', '/v2/auth/zone-delegations', {
      idempotencyKey,
      body: {
        user_id: input.userId,
        org_id: input.orgId,
        membership_version: input.membershipVersion,
        zone_id: input.zoneId,
        audience: input.audience,
        ttl_s: input.ttlS,
      },
    })
    if (typeof payload !== 'object' || payload === null) {
      throw new NexusZoneApiError('malformed delegation payload', 'CONTRACT', false, 0)
    }
    const d = payload as Record<string, unknown>
    // §6.4 端点的最小结构校验（该对象不属于 Zone/ZoneGrant owner 家族）
    for (const key of ['delegation_id', 'user_id', 'org_id', 'zone_id', 'expires_at'] as const) {
      if (typeof d[key] !== 'string' || d[key] === '') {
        throw new NexusZoneApiError(`delegation payload missing ${key}`, 'CONTRACT', false, 0)
      }
    }
    return {
      delegation_id: String(d.delegation_id),
      user_id: String(d.user_id),
      org_id: String(d.org_id),
      zone_id: String(d.zone_id),
      audience: String(d.audience ?? ''),
      expires_at: String(d.expires_at),
      status: String(d.status ?? 'active'),
    }
  }

  /** DELETE /v2/auth/zone-delegations/{delegation_id} —— membership 失效钩子。 */
  async revokeDelegation(delegationId: string, idempotencyKey: string): Promise<void> {
    await this.request('DELETE', `/v2/auth/zone-delegations/${encodeURIComponent(delegationId)}`, {
      idempotencyKey,
    })
  }

  /**
   * DELETE /v2/zones/{zone_id}/grants/{grant_id} —— revoke = DELETE grant
   * （§6.3）。响应携带 operation + authorization revision（无 action/state/
   * step 字段——与 mutation 端点的 OperationView 不同，勿用 parseOperation）。
   */
  async revokeGrant(zoneId: string, grantId: string, idempotencyKey: string): Promise<ZoneOperationRef> {
    const payload = await this.request(
      'DELETE',
      `/v2/zones/${encodeURIComponent(zoneId)}/grants/${encodeURIComponent(grantId)}`,
      { idempotencyKey },
    )
    if (typeof payload !== 'object' || payload === null || typeof (payload as Record<string, unknown>).operation_id !== 'string') {
      throw new NexusZoneApiError('revoke payload missing operation_id', 'CONTRACT', false, 0)
    }
    const op = payload as Record<string, unknown>
    return {
      operation_id: String(op.operation_id),
      action: 'revoke',
      zone_id: zoneId,
      grant_id: grantId,
      state: 'succeeded',
      step: '',
      retryable: false,
    }
  }

  /** POST /v2/zones/{zone_id}:suspend|:resume —— super-admin 生命周期管理（§6.2）。 */
  async zoneLifecycle(zoneId: string, action: 'suspend' | 'resume', idempotencyKey: string): Promise<ZoneOperationRef> {
    const payload = await this.request(
      'POST',
      `/v2/zones/${encodeURIComponent(zoneId)}:${action}`,
      { idempotencyKey },
    )
    return NexusZoneClient.parseOperation(payload)
  }

  /**
   * DELETE /v2/zones/{zone_id} —— request deprovision（§6.2：语义是异步
   * deprovision operation，不是同步擦行）。调用方必须已完成二次确认。
   */
  async deprovisionZone(zoneId: string, idempotencyKey: string): Promise<ZoneOperationRef> {
    const payload = await this.request('DELETE', `/v2/zones/${encodeURIComponent(zoneId)}`, {
      idempotencyKey,
    })
    return NexusZoneClient.parseOperation(payload)
  }

  /** 契约校验导出（测试/对账用）：ZoneOperation wire 的 owner 校验。 */
  static zoneOperationContractValid(payload: unknown): boolean {
    return validateZoneOperation(payload)
  }
}
