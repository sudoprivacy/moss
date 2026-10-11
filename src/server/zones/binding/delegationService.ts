/**
 * ZoneDelegationService —— 普通用户经 active Membership 换发 Nexus 短期
 * delegation（§5.4 / §6.4 / §8.7 client 规则）。
 *
 * 语义要点：
 *  - issuance 只由受信任 Moss issuance service identity 调 Nexus
 *    `POST /v2/auth/zone-delegations`（service credential）；换发出的
 *    delegation 属于**用户自身**，普通用户访问数据面时以自身 delegation
 *    出示，绝不携带 provisioning/global admin credential；
 *  - delegation 绑定 user、effective org、单调 membership revision（`rN`，
 *    role/status 实际变化时递增）、目标 zone（经由该 Org 的 active default
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
  grantId: string
  purpose: 'data-access' | 'runtime'
  scopeRules: Array<{ capability: string; resourcePrefixes: string[] }>
}

const DEFAULT_TTL_S = 900
// nexus zone_security 的 delegation 验证硬编码 audience="nexus-api"
// （verify_delegation 按 audience 精确匹配）——默认值必须与之对齐
const DEFAULT_AUDIENCE = 'nexus-api'
// M-7：audience 白名单——verify 按 audience 精确匹配，非 'nexus-api' 的
// audience 签得出但永远验不过（等于白签 + registry 无界堆积）；端点校验
// 收口于此。nexus 侧支持多 audience 时再扩展。
const ALLOWED_AUDIENCES: readonly string[] = ['nexus-api']

/**
 * 进程级共享实例（低-7）：registry 的短 TTL 复用与 membership revoke 钩子
 * 需要 runner 路径与 API 路径共用同一个实例——组装处（startStandaloneServer
 * 创建 authService 后）set；测试/未 set 场景回退调用方自建。
 */
let sharedZoneDelegation: ZoneDelegationService | null = null

export function setSharedZoneDelegation(service: ZoneDelegationService): void {
  sharedZoneDelegation = service
}

export function getSharedZoneDelegation(): ZoneDelegationService | null {
  return sharedZoneDelegation
}

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
    purpose?: 'data-access' | 'runtime'
    scopeRules?: Array<{ capability: string; resourcePrefixes: string[] }>
  }): Promise<IssuedDelegation> {
    const audience = input.audience ?? DEFAULT_AUDIENCE
    if (!ALLOWED_AUDIENCES.includes(audience)) {
      throw new ZoneDelegationError(
        `audience '${audience}' is not allowed (allowed: ${ALLOWED_AUDIENCES.join(', ')})`,
        'AUDIENCE_NOT_ALLOWED',
      )
    }
    const ttlS = input.ttlS ?? DEFAULT_TTL_S
    // M-7：签发入口惰性清扫过期条目——不同 key（换 audience/ttl/grant）的
    // 过期条目此前永久驻留（唯一删除路径是 membership/org revoke）。活条目
    // 由 TTL（≤900s）+ 本清扫自然界定，不设硬上限（上限值无依据，且驱逐
    // 活条目会丢失 revoke 覆盖）。
    const now = Date.now()
    for (const [key, value] of this.registry) {
      if (Date.parse(value.expiresAt) <= now) this.registry.delete(key)
    }

    const user = await this.driver.get(
      `SELECT id, org_id, role, status, membership_revision FROM users WHERE id = ? AND org_id = ? LIMIT 1`,
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
      `SELECT zone_id, sync_status, nexus_grant_id FROM org_zone_bindings
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
    if (binding.nexus_grant_id == null) {
      throw new ZoneDelegationError('default zone binding has no active grant', 'BINDING_PENDING')
    }

    const purpose = input.purpose ?? 'data-access'
    const scopeRules = input.scopeRules ?? []
    // M-8：cacheKey 含 ttlS——先 ttl=3600 再 ttl=60 命中缓存返回 3600s 的
    // delegation，请求语义与返回物不符。
    const cacheKey = `${input.orgId}:${input.userId}:${audience}:${ttlS}:${JSON.stringify([
      String(binding.nexus_grant_id),
      purpose,
      scopeRules,
    ])}`
    const cached = this.registry.get(cacheKey)
    if (cached && Date.parse(cached.expiresAt) > Date.now() + 5_000) {
      return cached
    }

    const membershipVersion = `r${Number(user.membership_revision)}`

    const result: ZoneDelegationResult = await this.client.issueDelegation(
      {
        userId: input.userId,
        orgId: input.orgId,
        membershipVersion,
        zoneId: String(binding.zone_id),
        audience,
        ttlS,
        grantId: String(binding.nexus_grant_id),
        purpose,
        scopeRules: input.scopeRules,
      },
      randomUUID(),
    )
    const issued: IssuedDelegation = {
      delegationId: result.delegation_id,
      zoneId: result.zone_id,
      audience: result.audience || audience,
      expiresAt: result.expires_at,
      grantId: result.grant_id,
      purpose: result.purpose ?? purpose,
      scopeRules: (result.scope_rules ?? []).map(rule => ({
        capability: rule.capability,
        resourcePrefixes: rule.resource_prefixes,
      })),
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
    // 低-6：匹配 key 的第二段（userId）——org 前缀匹配在"用户已被移动过
    // org 后的混合更新"场景必落空（registry 里的条目挂在旧 org 前缀下）。
    // orgId 仅保留供调用方日志语义。
    void orgId
    await this.revokeMatching((key) => key.split(':')[1] === userId)
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
