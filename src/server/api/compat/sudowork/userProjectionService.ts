import type { BillingRepository } from '../../../billing/billingRepository.js'
import type { IdentityRepository } from '../../../identity/identityRepository.js'
import type { SudoworkLegacyUser } from './identityService.js'
import type { SudoworkUserProjection } from './app.js'
import { quotaToPoints, type SudorouterPort } from '../../../billing/sudorouterAdapter.js'

interface ProjectionSecretPort {
  getSecret(namespace: string, key: string, subject?: string): Promise<{
    value: string | null
    status: string
    version: number
  } | null>
}

interface ModelDescriptor {
  id: string
}

export class SudoworkUserProjectionError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'SudoworkUserProjectionError'
  }
}

export class SudoworkUserProjectionService {
  constructor(private readonly options: {
    identities: IdentityRepository
    billing: BillingRepository
    secrets: ProjectionSecretPort
    listModels: () => Promise<ModelDescriptor[]> | ModelDescriptor[]
    getRuntimeConfig: () => { modelServiceUrl: string; scodeAutoModel: string }
    quotaReader?: Pick<SudorouterPort, 'getUser'>
  }) {}

  async project(user: SudoworkLegacyUser): Promise<SudoworkUserProjection> {
    const alias = this.options.identities.resolveNumericAliasGlobal('user', user.id)
    const organizationId = alias
      ? this.options.identities.resolveNumericAlias('enterprise', user.enterpriseId, alias.orgId)
      : null
    if (!alias || organizationId !== alias.orgId) {
      throw new SudoworkUserProjectionError(500, '用户企业信息异常')
    }
    const wallet = this.options.billing.getWallet('user', alias.resourceId)
    let account = this.options.billing.getExternalAccount('sudorouter', 'user', alias.resourceId)
    if (!wallet || !account?.tokenSecretRef) {
      throw new SudoworkUserProjectionError(500, 'Sudorouter 用户 Token 不存在')
    }
    const reference = parseSecretRef(account.tokenSecretRef)
    const secret = await this.options.secrets.getSecret(
      reference.namespace,
      reference.key,
      `org:${alias.orgId}`,
    )
    const token = secret?.value?.trim()
    if (!token) throw new SudoworkUserProjectionError(500, 'Sudorouter 用户 Token 不存在')

    if (this.options.quotaReader) {
      const live = await this.options.quotaReader.getUser(account.externalAccountId).catch(() => null)
      if (live) {
        this.options.billing.upsertExternalAccount({
          ...account,
          externalAccountId: live.externalUserId,
          quotaUnits: live.quotaUnits,
          usedQuotaUnits: live.usedQuotaUnits,
          updatedAt: Date.now(),
        })
        account = this.options.billing.getExternalAccount('sudorouter', 'user', alias.resourceId)!
      }
    }

    const [models, runtime] = await Promise.all([
      this.options.listModels(),
      Promise.resolve(this.options.getRuntimeConfig()),
    ])
    const usedPoints = quotaToPoints(account.usedQuotaUnits)
    const remainingPoints = quotaToPoints(account.quotaUnits)
    return {
      sudorouterKey: token.startsWith('sk-') ? token : `sk-${token}`,
      modelServiceUrl: runtime.modelServiceUrl.replace(/\/+$/, ''),
      models: models.map(model => model.id),
      scodeAutoModel: runtime.scodeAutoModel,
      totalPoints: roundPoints(quotaToPoints(account.quotaUnits + account.usedQuotaUnits)),
      usedPoints: roundPoints(usedPoints),
      remainingPoints,
      bonusPoints: roundPoints(this.options.billing.sumUserLedgerByEntryType(alias.resourceId, 'BONUS')),
      quota: account.quotaUnits,
      usedQuota: account.usedQuotaUnits,
    }
  }
}

function parseSecretRef(reference: string): { namespace: string; key: string } {
  if (!reference.startsWith('nexus://')) {
    throw new SudoworkUserProjectionError(500, 'Sudorouter 用户 Token 引用无效')
  }
  const value = reference.slice('nexus://'.length)
  const separator = value.lastIndexOf('/')
  if (separator <= 0 || separator === value.length - 1) {
    throw new SudoworkUserProjectionError(500, 'Sudorouter 用户 Token 引用无效')
  }
  return { namespace: value.slice(0, separator), key: value.slice(separator + 1) }
}

function roundPoints(value: number): number {
  return Math.round(value * 100) / 100
}
