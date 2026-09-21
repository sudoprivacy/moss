/**
 * ZoneDelegationService —— 普通用户经 active Membership 换发 Nexus 短期
 * delegation（§5.4 / §6.4 / §8.7 client 规则）。
 *
 * 语义要点：
 *  - issuance 只由受信任 Moss issuance service identity 调 Nexus
 *    `POST /v2/auth/zone-delegations`（service credential）；换发出的
 *    delegation 属于**用户自身**，普通用户访问数据面时以自身 delegation
 *    出示，绝不携带 provisioning/global admin credential；
 *  - delegation 绑定 user、effective org、membership version（`${status}:${role}`
 *    ——role/status 一变版本即变）、目标 zone（经由该 Org 的 active default
 *    binding）与 audience；nexus 侧 verify 每次都会复查 membership（回调）
 *    与 grant/epoch，因此旧 delegation 在 membership 变化后的下一次访问
 *    必然被拒（fail-closed，不依赖本进程的主动 revoke）；
 *  - 进程内登记簿（registry）只做两件事：短 TTL 内复用未过期 delegation、
 *    membership 变化时 best-effort 主动 revoke。重启即丢——安全兜底是
 *    nexus verify 的 membership 复查，不是本地状态；
 *  - delegation_id / 任何凭据不写日志、不落 DB。
 */
import { randomUUID } from 'crypto'
import type { DbDriver } from '../../db/driver.js'
import type { ZoneBindingConfig } from './config.js'
import { NexusZoneClient, type ZoneDelegationResult } from '../../nexus/nexusZoneClient.js'

export class ZoneDelegationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'ZoneDelegationError'
  }
}

export interface IssuedDelegation {
  delegationId: string
  zoneId: string
  audience: string
  expiresAt: string
}

const DEFAULT_TTL_S = 900
// nexus zone_security 的 delegation 验证硬编码 audience="nexus-api"
// （verify_delegation 按 audience 精确匹配）——默认值必须与之对齐
const DEFAULT_AUDIENCE = 'nexus-api'

export class ZoneDelegationService {
  private readonly driver: DbDriver
  private readonly client: NexusZoneClient
  private readonly config: ZoneBindingConfig
  /** key `${orgId}:${userId}:${audience}` → 未过期 delegation。 */
  private readonly registry = new Map<string, IssuedDelegation>()

  constructor(input: { driver: DbDriver; client: NexusZoneClient; config: ZoneBindingConfig }) {
    this.driver = input.driver
    this.client = input.client
    this.config = input.config
  }

  /**
   * 为 org 内的 active 用户换发 default Zone 的短期 delegation。
   * binding 非 active（pending/sync_failed/…）时抛 PENDING——grant pending
   * 不授权（§4.6 约束）。
   */
  async issueForOrgUser(input: {
    orgId: string
    userId: string
    audience?: string
    ttlS?: number
  }): Promise<IssuedDelegation> {
    const audience = input.audience ?? DEFAULT_AUDIENCE
    const ttlS = input.ttlS ?? DEFAULT_TTL_S

    const user = await this.driver.get(
      `SELECT id, org_id, role, status FROM users WHERE id = ? AND org_id = ? LIMIT 1`,
      [input.userId, input.orgId],
    )
    if (!user) {
      throw new ZoneDelegationError('user not found in org', 'MEMBERSHIP_NOT_FOUND')
    }
    if (String(user.status) !== 'active') {
      // pending/locked/disabled 一律不发（member suspended → 旧 delegation 由
      // nexus membership 复查拒绝，新 delegation 也无从产生）
      throw new ZoneDelegationError('membership is not active', 'MEMBERSHIP_NOT_ACTIVE')
    }

    const binding = await this.driver.get(
      `SELECT zone_id, sync_status FROM org_zone_bindings
       WHERE org_id = ? AND nexus_deployment_id = ? AND is_default = 1 AND desired_state = 'bound'
       ORDER BY created_at LIMIT 1`,
      [input.orgId, this.config.nexusDeploymentId],
    )
    if (!binding) {
      throw new ZoneDelegationError('org has no default zone binding', 'BINDING_NOT_FOUND')
    }
    if (String(binding.sync_status) !== 'active') {
      throw new ZoneDelegationError(
        `default zone binding is ${String(binding.sync_status)}, not active`,
        'BINDING_PENDING',
      )
    }

    const cacheKey = `${input.orgId}:${input.userId}:${audience}`
    const cached = this.registry.get(cacheKey)
    if (cached && Date.parse(cached.expiresAt) > Date.now() + 5_000) {
      return cached
    }

    // membership version：`${status}:${role}` —— role/status 变更即版本变更
    const membershipVersion = `${String(user.status)}:${String(user.role)}`

    const result: ZoneDelegationResult = await this.client.issueDelegation(
      {
        userId: input.userId,
        orgId: input.orgId,
        membershipVersion,
        zoneId: String(binding.zone_id),
        audience,
        ttlS,
      },
      randomUUID(),
    )
    const issued: IssuedDelegation = {
      delegationId: result.delegation_id,
      zoneId: result.zone_id,
      audience: result.audience || audience,
      expiresAt: result.expires_at,
    }
    this.registry.set(cacheKey, issued)
    return issued
  }

  /**
   * membership 失效钩子（removed/suspended/role downgrade）：best-effort
   * revoke 本进程登记的 delegation。真正的 fail-closed 来自 nexus verify
   * 的 membership 复查——这里失败（网络等）不影响安全语义，只影响收敛速度。
   */
  async revokeForUser(orgId: string, userId: string): Promise<void> {
    await this.revokeMatching((key) => key.startsWith(`${orgId}:${userId}:`))
  }

  /** Org detach / binding 失效钩子。 */
  async revokeForOrg(orgId: string): Promise<void> {
    await this.revokeMatching((key) => key.startsWith(`${orgId}:`))
  }

  private async revokeMatching(matches: (key: string) => boolean): Promise<void> {
    const targets: IssuedDelegation[] = []
    for (const [key, value] of this.registry) {
      if (matches(key)) {
        targets.push(value)
        this.registry.delete(key)
      }
    }
    for (const target of targets) {
      try {
        await this.client.revokeDelegation(target.delegationId, randomUUID())
      } catch {
        // best-effort：nexus 侧 verify 的 membership/grant/epoch 复查兜底
      }
    }
  }
}
