import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { assertTrustedCommandContext, type CommandContext } from '../application/commandContext.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'
import {
  BillingRepository,
  type SudorouterProvisioningRecord,
} from './billingRepository.js'
import type { SudorouterAccountPort, SudorouterUserAccount } from './sudorouterAdapter.js'

const TOKEN_NAMESPACE = 'moss:sudorouter-users'

interface SudorouterSecretPort {
  putSecret(namespace: string, key: string, value: string, subject?: string): Promise<void>
  getSecret(namespace: string, key: string, subject?: string): Promise<{
    value: string | null
    status: string
    version: number
  } | null>
}

export interface EnsureSudorouterAccountInput {
  ownerId: string
  orgId: string
  username: string
  displayName: string
  initialQuotaUnits: number
}

export interface SudorouterAccountResult {
  externalUserId: string
  token: string
  tokenSecretRef: string
  quotaUnits: number
  usedQuotaUnits: number
}

export class SudorouterAccountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SudorouterAccountError'
  }
}

export class SudorouterAccountService {
  private readonly inFlight = new Map<string, Promise<SudorouterAccountResult>>()

  constructor(
    private readonly db: DatabaseSync,
    private readonly repository: BillingRepository,
    private readonly provider: SudorouterAccountPort,
    private readonly secrets: SudorouterSecretPort,
    private readonly clock: () => number = Date.now,
  ) {}

  ensureAccount(
    input: EnsureSudorouterAccountInput,
    context: CommandContext,
  ): Promise<SudorouterAccountResult> {
    assertTrustedCommandContext(context)
    this.validate(input)
    if (context.externalEffects !== 'enqueue') {
      throw new SudorouterAccountError('迁移和回放上下文不得创建 Sudorouter 账号')
    }
    const key = `${input.orgId}:${input.ownerId}`
    const running = this.inFlight.get(key)
    if (running) return running
    const operation = this.run(input, context).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, operation)
    return operation
  }

  private async run(
    input: EnsureSudorouterAccountInput,
    context: CommandContext,
  ): Promise<SudorouterAccountResult> {
    const requestFingerprint = fingerprint(input)
    const existingAccount = this.repository.getExternalAccount('sudorouter', 'user', input.ownerId)
    if (existingAccount?.tokenSecretRef) {
      const token = await this.readToken(existingAccount.tokenSecretRef, input.orgId)
      return {
        externalUserId: existingAccount.externalAccountId,
        token,
        tokenSecretRef: existingAccount.tokenSecretRef,
        quotaUnits: existingAccount.quotaUnits,
        usedQuotaUnits: existingAccount.usedQuotaUnits,
      }
    }

    let operation = runInTransaction(this.db, () => {
      const byKey = this.repository.getSudorouterProvisioningByKey(context.idempotencyKey)
      if (byKey && byKey.requestFingerprint !== requestFingerprint) {
        throw new SudorouterAccountError('Sudorouter 开户幂等键已用于不同请求')
      }
      const byOwner = this.repository.getSudorouterProvisioningByOwner(input.ownerId)
      if (byOwner && byOwner.requestFingerprint !== requestFingerprint) {
        throw new SudorouterAccountError('该用户已存在不同的 Sudorouter 开户请求')
      }
      if (byKey ?? byOwner) return (byKey ?? byOwner)!
      this.repository.insertSudorouterProvisioning({
        id: randomUUID(), ownerId: input.ownerId, orgId: input.orgId,
        username: input.username.trim(), displayName: input.displayName.trim() || input.username.trim(),
        initialQuotaUnits: input.initialQuotaUnits, status: 'PENDING',
        idempotencyKey: context.idempotencyKey, requestFingerprint,
        contextSource: context.source, createdAt: this.clock(),
      })
      return this.repository.getSudorouterProvisioningByKey(context.idempotencyKey)!
    })

    if (operation.status === 'COMPLETED' && operation.tokenSecretRef && operation.externalAccountId) {
      return this.completed(operation, await this.readToken(operation.tokenSecretRef, input.orgId))
    }

    try {
      let account = await this.resolveAccount(operation, input, context)
      operation = this.repository.getSudorouterProvisioningByOwner(input.ownerId)!

      if (operation.status !== 'QUOTA_READY' && operation.status !== 'TOKEN_READY' && operation.status !== 'COMPLETED') {
        account = await this.ensureQuota(account, input.initialQuotaUnits, context.idempotencyKey)
        runInTransaction(this.db, () => {
          this.repository.upsertExternalAccount({
            provider: 'sudorouter', ownerType: 'user', ownerId: input.ownerId,
            externalAccountId: account.externalUserId, quotaUnits: account.quotaUnits,
            usedQuotaUnits: account.usedQuotaUnits, updatedAt: this.clock(),
          })
          this.repository.updateSudorouterProvisioning({
            id: operation.id, status: 'QUOTA_READY', quotaUnits: account.quotaUnits,
            usedQuotaUnits: account.usedQuotaUnits, updatedAt: this.clock(),
          })
        })
        operation = this.repository.getSudorouterProvisioningByOwner(input.ownerId)!
      }

      const tokenSecretRef = operation.tokenSecretRef ?? secretRef(input.ownerId)
      let token: string
      if (operation.tokenSecretRef) {
        token = await this.readToken(operation.tokenSecretRef, input.orgId)
      } else {
        token = await this.provider.createToken({
          externalUserId: operation.externalAccountId!,
          name: `${input.username.trim()}-token`,
          idempotencyKey: `${context.idempotencyKey}:token`,
        })
        await this.secrets.putSecret(TOKEN_NAMESPACE, input.ownerId, token, `org:${input.orgId}`)
      }

      const timestamp = this.clock()
      runInTransaction(this.db, () => {
        this.repository.upsertExternalAccount({
          provider: 'sudorouter', ownerType: 'user', ownerId: input.ownerId,
          externalAccountId: operation.externalAccountId!,
          quotaUnits: operation.quotaUnits!, usedQuotaUnits: operation.usedQuotaUnits!,
          tokenSecretRef, updatedAt: timestamp,
        })
        this.repository.updateSudorouterProvisioning({
          id: operation.id, status: 'COMPLETED', tokenSecretRef,
          updatedAt: timestamp, completedAt: timestamp,
        })
      })
      return {
        externalUserId: operation.externalAccountId!, token, tokenSecretRef,
        quotaUnits: operation.quotaUnits!, usedQuotaUnits: operation.usedQuotaUnits!,
      }
    } catch (error) {
      runInTransaction(this.db, () => this.repository.updateSudorouterProvisioning({
        id: operation.id, status: 'FAILED',
        errorText: error instanceof Error ? error.message : String(error),
        updatedAt: this.clock(),
      }))
      throw error
    }
  }

  private async resolveAccount(
    operation: SudorouterProvisioningRecord,
    input: EnsureSudorouterAccountInput,
    context: CommandContext,
  ): Promise<SudorouterUserAccount> {
    if (operation.externalAccountId) {
      const existing = await this.provider.getUser(operation.externalAccountId)
      if (existing) return { ...existing, username: input.username.trim() }
    }
    const username = input.username.trim()
    const account = await this.provider.findUserByUsername(username)
      ?? await this.provider.createUser({
        username, displayName: input.displayName,
        idempotencyKey: `${context.idempotencyKey}:account`,
      })
    runInTransaction(this.db, () => {
      this.repository.upsertExternalAccount({
        provider: 'sudorouter', ownerType: 'user', ownerId: input.ownerId,
        externalAccountId: account.externalUserId, quotaUnits: account.quotaUnits,
        usedQuotaUnits: account.usedQuotaUnits, updatedAt: this.clock(),
      })
      this.repository.updateSudorouterProvisioning({
        id: operation.id, status: 'ACCOUNT_READY', externalAccountId: account.externalUserId,
        quotaUnits: account.quotaUnits, usedQuotaUnits: account.usedQuotaUnits,
        updatedAt: this.clock(),
      })
    })
    return account
  }

  private async ensureQuota(
    account: SudorouterUserAccount,
    initialQuotaUnits: number,
    idempotencyKey: string,
  ): Promise<SudorouterUserAccount> {
    const baselineQuotaUnits = account.quotaUnits
    const deltaUnits = Math.max(0, initialQuotaUnits - baselineQuotaUnits)
    if (deltaUnits === 0) return account
    const changed = await this.provider.changeQuota({
      externalUserId: account.externalUserId, deltaUnits,
      comment: '新用户注册赠送额度', idempotencyKey: `${idempotencyKey}:initial-quota`,
    })
    if (!changed.success) throw new SudorouterAccountError(changed.error || 'Sudorouter 初始额度设置失败')
    return { ...account, quotaUnits: baselineQuotaUnits + deltaUnits }
  }

  private async readToken(reference: string, orgId: string): Promise<string> {
    const parsed = parseSecretRef(reference)
    const record = await this.secrets.getSecret(parsed.namespace, parsed.key, `org:${orgId}`)
    const token = record?.value?.trim()
    if (!token) throw new SudorouterAccountError('Sudorouter 用户 Token 不存在')
    return token
  }

  private completed(operation: SudorouterProvisioningRecord, token: string): SudorouterAccountResult {
    return {
      externalUserId: operation.externalAccountId!, token,
      tokenSecretRef: operation.tokenSecretRef!,
      quotaUnits: operation.quotaUnits!, usedQuotaUnits: operation.usedQuotaUnits!,
    }
  }

  private validate(input: EnsureSudorouterAccountInput): void {
    if (!input.ownerId.trim() || !input.orgId.trim() || !input.username.trim()) {
      throw new SudorouterAccountError('Sudorouter 开户用户信息不完整')
    }
    if (!Number.isSafeInteger(input.initialQuotaUnits) || input.initialQuotaUnits < 0) {
      throw new SudorouterAccountError('Sudorouter 初始额度无效')
    }
  }
}

function fingerprint(input: EnsureSudorouterAccountInput): string {
  return createHash('sha256').update(JSON.stringify([
    input.ownerId, input.orgId, input.username.trim(),
    input.displayName.trim(), input.initialQuotaUnits,
  ])).digest('hex')
}

function secretRef(ownerId: string): string {
  return `nexus://${TOKEN_NAMESPACE}/${ownerId}`
}

function parseSecretRef(reference: string): { namespace: string; key: string } {
  if (!reference.startsWith('nexus://')) throw new SudorouterAccountError('Sudorouter Token 引用无效')
  const value = reference.slice('nexus://'.length)
  const index = value.lastIndexOf('/')
  if (index <= 0 || index === value.length - 1) throw new SudorouterAccountError('Sudorouter Token 引用无效')
  return { namespace: value.slice(0, index), key: value.slice(index + 1) }
}
