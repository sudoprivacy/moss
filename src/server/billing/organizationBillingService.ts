import { createHash, randomUUID } from 'node:crypto'
import type { DbDriver, SqlRow } from '../db/driver.js'
import type { SudorouterSecretPort } from './sudorouterAccountService.js'
import { QUOTA_PER_USD, parseUsd, quotaToUsd, usdMicrosToQuota } from './modelMoney.js'
import { RouterRequestError, type OrganizationRouterPort, type RouterAdminStatus, type RouterToken } from './organizationRouterAdapter.js'
import { ensureOrganizationBillingSchema } from './organizationBillingSchema.js'

const SECRET_NAMESPACE = 'moss:organization-model-keys'
export interface OrganizationBillingActor { userId: string; orgId: string }
export type ModelAccountRow = SqlRow & {
  org_id: string; router_user_id: number | null; router_username: string; initial_quota: number
  default_member_quota: number | null; service_quota: number; quota_per_usd: number
  status: 'pending' | 'ready' | 'disabled' | 'needs_review'; created_at: number; updated_at: number
}
export type ModelTokenRow = SqlRow & {
  id: string; org_id: string; member_id: string; purpose: 'member' | 'service'; router_user_id: number
  router_token_id: number | null; secret_ref: string | null; initial_quota: number | null
  status: 'pending' | 'ready' | 'disabled' | 'revoked' | 'needs_review'
}
type OperationRow = SqlRow & { reference: string; fingerprint: string; status: string; result_json: string | null; request_json: string }

export class OrganizationBillingError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message) }
}
export interface CreateOrganizationModelInput {
  initialAmountUsd: string
  defaultMemberLimitUsd: string | null
  serviceLimitUsd?: string
}

export class OrganizationBillingService {
  private readonly running = new Map<string, Promise<unknown>>()
  constructor(
    readonly db: DbDriver,
    readonly router: OrganizationRouterPort,
    private readonly secrets: SudorouterSecretPort,
    private readonly options: { isRechargeEnabled?: () => boolean; quotaPerUsd?: number; onServiceReady?: (orgId: string, key: string, baseUrl: string) => Promise<void> } = {},
  ) {}
  initialize(): Promise<void> { return ensureOrganizationBillingSchema(this.db) }
  account(orgId: string): Promise<ModelAccountRow | undefined> {
    return this.db.get<ModelAccountRow>('SELECT * FROM organization_model_accounts WHERE org_id = ?', [orgId])
  }
  token(orgId: string, memberId: string, purpose: 'member' | 'service' = 'member'): Promise<ModelTokenRow | undefined> {
    return this.db.get<ModelTokenRow>('SELECT * FROM organization_model_tokens WHERE org_id = ? AND member_id = ? AND purpose = ?', [orgId, memberId, purpose])
  }
  async isShared(orgId: string): Promise<boolean> { return !!await this.account(orgId) }

  /** DB session lock excludes other processes without holding an SQL transaction over HTTP. */
  async exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
    const pending = this.running.get(key)
    if (pending) { await pending.catch(() => {}); return this.exclusive(key, run) }
    const promise = this.db.tryRunExclusiveSession(`org-model:${key}`, run)
    this.running.set(key, promise)
    try {
      const result = await promise
      if (result === null) throw new OrganizationBillingError('PROCESSING', '操作正在处理中', 409)
      return result
    } finally { if (this.running.get(key) === promise) this.running.delete(key) }
  }

  async configureOrganization(orgId: string, name: string, input: CreateOrganizationModelInput): Promise<ModelAccountRow> {
    return this.exclusive(`account:${orgId}`, async () => this.provisionOrganization(await this.stageOrganization(orgId, input), name))
  }

  /** Local-only hook, safe inside the identity creation transaction. */
  async stageOrganization(orgId: string, input: CreateOrganizationModelInput): Promise<ModelAccountRow> {
    const quotaPerUsd = this.options.quotaPerUsd ?? QUOTA_PER_USD
    const initial = usdMicrosToQuota(parseUsd(input.initialAmountUsd), quotaPerUsd)
    const member = input.defaultMemberLimitUsd === null ? null : usdMicrosToQuota(parseUsd(input.defaultMemberLimitUsd), quotaPerUsd)
    const service = usdMicrosToQuota(parseUsd(input.serviceLimitUsd ?? '1.00'), quotaPerUsd)
      const now = Date.now()
      await this.db.run(`INSERT INTO organization_model_accounts
        (org_id, router_username, initial_quota, default_member_quota, service_quota, quota_per_usd, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(org_id) DO NOTHING`,
      [orgId, `mo_${createHash('sha256').update(orgId).digest('hex').slice(0, 17)}`, initial, member, service, quotaPerUsd, now, now])
      const account = (await this.account(orgId))!
      if (account.initial_quota !== initial || account.default_member_quota !== member || account.service_quota !== service) {
        throw new OrganizationBillingError('CONFIG_CONFLICT', '组织开户配置已存在；请勿重复创建不同配置', 409)
      }
      return account
  }

  async retryOrganization(orgId: string, name: string): Promise<ModelAccountRow> {
    return this.exclusive(`account:${orgId}`, async () => {
      const account = await this.requireAccount(orgId)
      return this.provisionOrganization(account, name)
    })
  }

  private async provisionOrganization(account: ModelAccountRow, name: string): Promise<ModelAccountRow> {
    if (account.status === 'disabled' || account.status === 'ready') return account
    try {
      if (!account.router_user_id) {
        const created = await this.operation<{ id: number; username: string }>(account.org_id, 'create-account', `account:${account.org_id}`, {
          username: account.router_username, name,
        }, false, () => this.router.createAccount(account.router_username, name))
        await this.db.run('UPDATE organization_model_accounts SET router_user_id = ?, updated_at = ? WHERE org_id = ?', [created.id, Date.now(), account.org_id])
        account = (await this.account(account.org_id))!
      }
      const userId = account.router_user_id!
      const reference = `initial:${account.org_id}`
      const previous = await this.getOperation(reference)
      // Freeze the baseline once, before creating any usable Keys.
      const request = previous ? JSON.parse(previous.request_json) as { id: number; delta: number } : {
        id: userId, delta: Math.max(0, account.initial_quota - (await this.router.getAccount(userId)).quota),
      }
      await this.operation(account.org_id, 'initial-quota', reference, request, false, async () => {
        if (request.delta) await this.router.changeAccountQuota(userId, request.delta, `Moss organization initial allocation ${account.org_id}`)
        return { delta: request.delta }
      })
      const service = await this.ensureToken(account, '', 'service', account.service_quota)
      const key = await this.readKey(service)
      await this.options.onServiceReady?.(account.org_id, key, this.router.modelBaseUrl)
      await this.db.run("UPDATE organization_model_accounts SET status = 'ready', updated_at = ? WHERE org_id = ?", [Date.now(), account.org_id])
      return (await this.account(account.org_id))!
    } catch (error) {
      await this.db.run("UPDATE organization_model_accounts SET status = 'needs_review', updated_at = ? WHERE org_id = ?", [Date.now(), account.org_id])
      throw error
    }
  }

  async ensureMember(orgId: string, userId: string, limitUsd?: string | null): Promise<ModelTokenRow> {
    return this.exclusive(`member:${orgId}:${userId}`, async () => {
      const user = await this.db.get('SELECT id, org_id, status FROM users WHERE id = ?', [userId])
      if (!user || user.org_id !== orgId || !['active', 'pending'].includes(String(user.status))) {
        throw new OrganizationBillingError('MEMBER_UNAVAILABLE', '成员不可用或不属于当前组织', 403)
      }
      const account = await this.requireAccount(orgId)
      if (account.status !== 'ready') throw new OrganizationBillingError('ACCOUNT_PENDING', '组织模型账户尚未就绪', 409)
      const existing = await this.token(orgId, userId)
      if (existing?.status === 'revoked') throw new OrganizationBillingError('KEY_REVOKED', '原组织凭据已撤销', 403)
      const limit = limitUsd === undefined ? account.default_member_quota : limitUsd === null ? null : usdMicrosToQuota(parseUsd(limitUsd), account.quota_per_usd)
      return this.ensureToken(account, userId, 'member', limit)
    })
  }

  private async ensureToken(account: ModelAccountRow, memberId: string, purpose: 'member' | 'service', limit: number | null): Promise<ModelTokenRow> {
    const id = randomUUID()
    await this.db.run(`INSERT INTO organization_model_tokens
      (id, org_id, member_id, purpose, router_user_id, initial_quota, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(org_id, member_id, purpose) DO NOTHING`,
    [id, account.org_id, memberId, purpose, account.router_user_id!, limit, Date.now(), Date.now()])
    let token = (await this.token(account.org_id, memberId, purpose))!
    if (['ready', 'disabled'].includes(token.status)) return token
    const current = token
    try {
      await this.operation(account.org_id, 'create-token', `create-token:${token.id}`, { tokenBindingId: token.id, limit: token.initial_quota }, false, async () => {
        const created = await this.router.createToken(account.router_user_id!, `${purpose}-${token.id.slice(0, 18)}`, token.initial_quota)
        await this.db.run('UPDATE organization_model_tokens SET router_token_id = ?, updated_at = ? WHERE id = ?', [created.id, Date.now(), current.id])
        await this.secrets.putSecret(SECRET_NAMESPACE, current.id, created.key, `org:${account.org_id}`)
        await this.db.run("UPDATE organization_model_tokens SET secret_ref = ?, status = 'ready', updated_at = ? WHERE id = ?", [current.id, Date.now(), current.id])
        return { tokenId: created.id }
      }, memberId || undefined)
      token = (await this.token(account.org_id, memberId, purpose))!
      return token
    } catch (error) {
      await this.db.run("UPDATE organization_model_tokens SET status = 'needs_review', updated_at = ? WHERE id = ?", [Date.now(), current.id])
      throw error
    }
  }

  async credential(orgId: string, userId: string): Promise<{ sudorouterUserId: string; sudorouterKey: string } | null> {
    const account = await this.account(orgId)
    if (!account || account.status !== 'ready') return null
    const user = await this.db.get('SELECT org_id, status FROM users WHERE id = ?', [userId])
    if (!user || user.org_id !== orgId || user.status !== 'active') return null
    const token = await this.token(orgId, userId)
    if (!token || token.status !== 'ready') return null
    return { sudorouterUserId: String(account.router_user_id), sudorouterKey: await this.readKey(token) }
  }

  /** Trusted provisioning adapter; pending identities are not yet eligible for client credential reads. */
  async provisionMemberAccount(orgId: string, userId: string, limitUsd?: string | null) {
    let account = await this.requireAccount(orgId)
    if (account.status !== 'ready') {
      const organization = await this.db.get('SELECT name FROM organizations WHERE id = ?', [orgId])
      account = await this.retryOrganization(orgId, String(organization?.name ?? orgId))
    }
    const token = await this.ensureMember(orgId, userId, limitUsd)
    return { externalUserId: String(account.router_user_id), token: await this.readKey(token), tokenSecretRef: `nexus://${SECRET_NAMESPACE}/${token.secret_ref}`,
      quotaUnits: token.initial_quota ?? 0, usedQuotaUnits: 0 }
  }
  private async readKey(token: ModelTokenRow): Promise<string> {
    if (!token.secret_ref) throw new OrganizationBillingError('KEY_PENDING', '模型凭据尚未就绪', 409)
    const secret = await this.secrets.getSecret(SECRET_NAMESPACE, token.secret_ref, `org:${token.org_id}`)
    if (!secret?.value) throw new OrganizationBillingError('KEY_UNAVAILABLE', '模型凭据不可用', 503)
    return secret.value
  }

  async assertAdmin(actor: OrganizationBillingActor, orgId: string, recharge = false): Promise<void> {
    const user = await this.db.get('SELECT org_id, role, status FROM users WHERE id = ?', [actor.userId])
    if (!user || user.status !== 'active' || actor.orgId !== orgId
      || (recharge ? user.role !== 'admin' || user.org_id !== orgId : user.role !== 'super_admin' && (user.role !== 'admin' || user.org_id !== orgId))) {
      throw new OrganizationBillingError('FORBIDDEN', '需要当前组织管理员权限', 403)
    }
  }
  async dashboard(actor: OrganizationBillingActor): Promise<Record<string, unknown>> {
    const user = await this.db.get('SELECT org_id, role, status FROM users WHERE id = ?', [actor.userId])
    if (!user || user.status !== 'active' || user.org_id !== actor.orgId && user.role !== 'super_admin') {
      throw new OrganizationBillingError('FORBIDDEN', '无权访问当前组织', 403)
    }
    const account = await this.requireAccount(actor.orgId)
    const isAdmin = user.role === 'admin' || user.role === 'super_admin'
    const binding = await this.token(actor.orgId, actor.userId)
    const [organization, members] = await Promise.all([
      isAdmin && account.router_user_id ? this.router.getAccount(account.router_user_id) : Promise.resolve(null),
      binding?.router_token_id ? this.router.listTokens(binding.router_user_id, binding.router_token_id) : Promise.resolve([]),
    ])
    return {
      mode: 'organization_shared', currency: 'USD', org_id: actor.orgId, account_status: account.status,
      can_manage: isAdmin, can_recharge: user.role === 'admin' && user.org_id === actor.orgId && (this.options.isRechargeEnabled?.() ?? false),
      ...(organization ? { model_balance_usd: quotaToUsd(organization.quota, account.quota_per_usd), used_amount_usd: quotaToUsd(organization.used_quota, account.quota_per_usd) } : {}),
      member: members[0] ? this.projectToken(members[0], account) : null,
      ...(isAdmin ? { default_member_limit_usd: account.default_member_quota === null ? null : quotaToUsd(account.default_member_quota, account.quota_per_usd) } : {}),
    }
  }
  projectToken(token: RouterToken, account: ModelAccountRow): Record<string, unknown> {
    return { token_id: token.id, admin_status: token.admin_status, effective_status: token.effective_status,
      unlimited: token.unlimited_quota, remaining_limit_usd: token.unlimited_quota ? null : quotaToUsd(token.remain_quota, account.quota_per_usd),
      used_amount_usd: quotaToUsd(token.used_quota, account.quota_per_usd), key_masked: token.key_masked ?? null }
  }
  async listMembers(actor: OrganizationBillingActor): Promise<Record<string, unknown>[]> {
    await this.assertAdmin(actor, actor.orgId)
    const account = await this.requireAccount(actor.orgId)
    const bindings = await this.db.all<ModelTokenRow>('SELECT * FROM organization_model_tokens WHERE org_id = ?', [actor.orgId])
    const tokens = account.router_user_id ? await this.router.listTokens(account.router_user_id) : []
    const byId = new Map(tokens.map(token => [token.id, token]))
    return bindings.map(binding => ({ user_id: binding.member_id || null, purpose: binding.purpose, provisioning_status: binding.status,
      ...(binding.router_token_id && byId.has(binding.router_token_id) ? this.projectToken(byId.get(binding.router_token_id)!, account) : {}) }))
  }

  /** Revoke upstream access before an identity mutation, including copied client Keys. */
  async beforeMemberChange(orgId: string, memberId: string, status: string, targetOrgId?: string): Promise<void> {
    if (!await this.isShared(orgId)) return
    if (targetOrgId && targetOrgId !== orgId) throw new OrganizationBillingError('ORGANIZATION_IMMUTABLE', '共享账户成员不能迁移组织', 409)
    const identity = await this.db.get('SELECT status FROM users WHERE id = ?', [memberId])
    if (!identity || status === identity.status) return
    await this.exclusive(`member:${orgId}:${memberId}`, async () => {
      const token = await this.token(orgId, memberId)
      if (!token?.router_token_id || token.status === 'revoked') return true
      // Activation does not undo an administrator's independent Key suspension.
      if (status === 'active') return true
      await this.db.run("UPDATE organization_model_tokens SET status = 'disabled', updated_at = ? WHERE id = ?", [Date.now(), token.id])
      const reference = `identity:${token.id}:${status}:${randomUUID()}`
      await this.operation(orgId, 'identity-key-disable', reference, { tokenId: token.router_token_id, status: 'disabled' }, true,
        () => this.router.setTokenStatus(token.router_user_id, token.router_token_id!, 'disabled', reference), memberId)
      if (status === 'deleted') await this.db.run("UPDATE organization_model_tokens SET status = 'revoked', updated_at = ? WHERE id = ?", [Date.now(), token.id])
      return true
    })
  }

  async logs(actor: OrganizationBillingActor, page = 1, pageSize = 20): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new OrganizationBillingError('INVALID_PAGE', '分页参数无效')
    // dashboard validates active membership; only admins receive organization totals.
    const dashboard = await this.dashboard(actor)
    const account = await this.requireAccount(actor.orgId)
    const own = await this.token(actor.orgId, actor.userId)
    if (!account.router_user_id || !dashboard.can_manage && !own?.router_token_id) return { items: [], total: 0, page, page_size: pageSize, truncated: false }
    const rows = []
    let truncated = false
    for (let upstreamPage = 1; upstreamPage <= 100; upstreamPage++) {
      const batch = await this.router.listLogs(account.router_user_id, account.router_username, upstreamPage, 100)
      rows.push(...batch.items.filter(log => log.type === 2 && (dashboard.can_manage || log.token_id === own!.router_token_id)))
      if (!batch.items.length || upstreamPage * 100 >= batch.total) break
      if (upstreamPage === 100) truncated = true
    }
    return { items: rows.slice((page - 1) * pageSize, page * pageSize).map(log => ({ id: log.id, token_id: log.token_id,
      created_at: log.created_at, model_name: log.model_name, amount_usd: quotaToUsd(log.quota, account.quota_per_usd),
      input_tokens: log.prompt_tokens, output_tokens: log.completion_tokens, request_id: log.request_id })),
      total: rows.length, page, page_size: pageSize, truncated }
  }

  async setMemberStatus(actor: OrganizationBillingActor, memberId: string, status: RouterAdminStatus, reference: string): Promise<RouterToken> {
    await this.assertAdmin(actor, actor.orgId)
    const member = await this.db.get('SELECT org_id, status FROM users WHERE id = ?', [memberId])
    if (!member || member.org_id !== actor.orgId || status === 'enabled' && member.status !== 'active') throw new OrganizationBillingError('MEMBER_UNAVAILABLE', '成员未激活或不属于当前组织', 409)
    return this.exclusive(`member:${actor.orgId}:${memberId}`, async () => {
      const token = await this.requireToken(actor.orgId, memberId)
      if (status === 'disabled') await this.db.run("UPDATE organization_model_tokens SET status = 'disabled', updated_at = ? WHERE id = ?", [Date.now(), token.id])
      await this.operation(actor.orgId, 'token-status', reference, { tokenId: token.router_token_id, status }, true,
        () => this.router.setTokenStatus(token.router_user_id, token.router_token_id!, status, reference), memberId, actor.userId)
      const current = (await this.router.listTokens(token.router_user_id, token.router_token_id!))[0]
      if (!current) throw new OrganizationBillingError('KEY_UNAVAILABLE', '成员 Key 状态不可用', 503)
      await this.db.run('UPDATE organization_model_tokens SET status = ?, updated_at = ? WHERE id = ?', [current.admin_status === 'disabled' ? 'disabled' : 'ready', Date.now(), token.id])
      return current
    })
  }
  async adjustMemberLimit(actor: OrganizationBillingActor, memberId: string, amountUsd: string, direction: 'increase' | 'decrease', reference: string): Promise<RouterToken> {
    await this.assertAdmin(actor, actor.orgId)
    const account = await this.requireAccount(actor.orgId)
    const delta = usdMicrosToQuota(parseUsd(amountUsd, false), account.quota_per_usd) * (direction === 'decrease' ? -1 : 1)
    return this.exclusive(`member:${actor.orgId}:${memberId}`, async () => {
      const token = await this.requireToken(actor.orgId, memberId)
      return this.operation(actor.orgId, 'token-quota', reference, { tokenId: token.router_token_id, delta }, true,
        () => this.router.adjustTokenQuota(token.router_user_id, token.router_token_id!, delta, reference), memberId, actor.userId)
    })
  }

  async manageService(actor: OrganizationBillingActor, reference: string, change: { status: RouterAdminStatus } | { amountUsd: string; direction: 'increase' | 'decrease' }): Promise<RouterToken> {
    await this.assertAdmin(actor, actor.orgId)
    const account = await this.requireAccount(actor.orgId)
    return this.exclusive(`service:${actor.orgId}`, async () => {
      const token = await this.token(actor.orgId, '', 'service')
      if (!token?.router_token_id) throw new OrganizationBillingError('KEY_UNAVAILABLE', '默认服务 Key 尚未就绪', 409)
      if ('status' in change) {
        if (change.status === 'disabled') await this.db.run("UPDATE organization_model_tokens SET status = 'disabled', updated_at = ? WHERE id = ?", [Date.now(), token.id])
        await this.operation(actor.orgId, 'service-status', reference, { tokenId: token.router_token_id, status: change.status }, true,
          () => this.router.setTokenStatus(token.router_user_id, token.router_token_id!, change.status, reference), undefined, actor.userId)
        const current = (await this.router.listTokens(token.router_user_id, token.router_token_id!))[0]
        if (!current) throw new OrganizationBillingError('KEY_UNAVAILABLE', '默认服务 Key 状态不可用', 503)
        await this.db.run('UPDATE organization_model_tokens SET status = ?, updated_at = ? WHERE id = ?', [current.admin_status === 'disabled' ? 'disabled' : 'ready', Date.now(), token.id])
        return current
      }
      const delta = usdMicrosToQuota(parseUsd(change.amountUsd, false), account.quota_per_usd) * (change.direction === 'decrease' ? -1 : 1)
      return this.operation(actor.orgId, 'service-limit', reference, { tokenId: token.router_token_id, delta }, true,
        () => this.router.adjustTokenQuota(token.router_user_id, token.router_token_id!, delta, reference), undefined, actor.userId)
    })
  }

  async setAccountStatus(actor: OrganizationBillingActor, status: RouterAdminStatus, reference: string): Promise<void> {
    await this.assertAdmin(actor, actor.orgId)
    await this.exclusive(`account:${actor.orgId}`, async () => {
      const account = await this.requireAccount(actor.orgId)
      if (!account.router_user_id || !['ready', 'disabled'].includes(account.status)) throw new OrganizationBillingError('ACCOUNT_PENDING', '组织开户尚未完成', 409)
      if (status === 'disabled') await this.db.run("UPDATE organization_model_accounts SET status = 'disabled', updated_at = ? WHERE org_id = ?", [Date.now(), actor.orgId])
      // The reused old status endpoint sets an absolute state, so replay is safe.
      await this.operation(actor.orgId, 'account-status', reference, { accountId: account.router_user_id, status }, true,
        () => this.router.setAccountStatus(account.router_user_id!, status).then(() => ({ status })), undefined, actor.userId)
      const current = await this.router.getAccount(account.router_user_id)
      await this.db.run('UPDATE organization_model_accounts SET status = ?, updated_at = ? WHERE org_id = ?', [current.status === 1 ? 'ready' : 'disabled', Date.now(), actor.orgId])
      return true
    })
  }

  async setDefaults(actor: OrganizationBillingActor, limitUsd: string | null): Promise<void> {
    await this.assertAdmin(actor, actor.orgId)
    const account = await this.requireAccount(actor.orgId)
    const limit = limitUsd === null ? null : usdMicrosToQuota(parseUsd(limitUsd), account.quota_per_usd)
    await this.db.run('UPDATE organization_model_accounts SET default_member_quota = ?, updated_at = ? WHERE org_id = ?', [limit, Date.now(), actor.orgId])
  }

  async requireAccount(orgId: string): Promise<ModelAccountRow> {
    const account = await this.account(orgId)
    if (!account) throw new OrganizationBillingError('NOT_SHARED', '组织尚未启用共享模型账户', 409)
    return account
  }
  private async requireToken(orgId: string, memberId: string): Promise<ModelTokenRow> {
    const token = await this.token(orgId, memberId)
    if (!token?.router_token_id || token.status === 'revoked') throw new OrganizationBillingError('KEY_UNAVAILABLE', '成员模型凭据不可用', 409)
    return token
  }
  private getOperation(reference: string): Promise<OperationRow | undefined> {
    return this.db.get<OperationRow>('SELECT * FROM organization_model_operations WHERE reference = ?', [reference])
  }
  async operation<T>(orgId: string, type: string, reference: string, request: unknown, remotelyIdempotent: boolean, execute: () => Promise<T>, memberId?: string, actorId?: string): Promise<T> {
    if (!reference || reference.length > 200) throw new OrganizationBillingError('INVALID_REFERENCE', '缺少有效操作标识')
    const requestJson = JSON.stringify(request)
    const fingerprint = createHash('sha256').update(JSON.stringify([orgId, type, memberId ?? null, request])).digest('hex')
    await this.db.run(`INSERT INTO organization_model_operations
      (reference, org_id, member_id, actor_user_id, operation_type, fingerprint, request_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(reference) DO NOTHING`,
    [reference, orgId, memberId ?? null, actorId ?? null, type, fingerprint, requestJson, Date.now(), Date.now()])
    const op = (await this.getOperation(reference))!
    if (op.fingerprint !== fingerprint) throw new OrganizationBillingError('IDEMPOTENCY_CONFLICT', '操作标识已用于其他请求', 409)
    if (op.status === 'succeeded') return JSON.parse(op.result_json!) as T
    if (['sending', 'unknown'].includes(op.status) && !remotelyIdempotent) {
      throw new OrganizationBillingError('NEEDS_REVIEW', '外部操作结果待核对，请勿重复发放额度或创建凭据', 409)
    }
    if (op.status === 'rejected' && !remotelyIdempotent) throw new OrganizationBillingError('OPERATION_REJECTED', '外部操作被拒绝，需要核对', 409)
    await this.db.run("UPDATE organization_model_operations SET status = 'sending', updated_at = ? WHERE reference = ?", [Date.now(), reference])
    try {
      const result = await execute()
      await this.db.run("UPDATE organization_model_operations SET status = 'succeeded', result_json = ?, updated_at = ? WHERE reference = ?", [JSON.stringify(result), Date.now(), reference])
      return result
    } catch (error) {
      await this.db.run('UPDATE organization_model_operations SET status = ?, updated_at = ? WHERE reference = ?', [error instanceof RouterRequestError && error.outcome === 'rejected' ? 'rejected' : 'unknown', Date.now(), reference])
      throw error
    }
  }
}
