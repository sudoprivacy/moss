import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { assertTrustedCommandContext, type CommandContext } from '../application/commandContext.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'
import { BillingRepository } from './billingRepository.js'
import { BillingDomainError, type BillingOwnerType } from './types.js'
import { toStoredPointUnits } from './pointUnits.js'

const COMMAND_TYPE = 'billing.wallet.post'
const LEGACY_IMPORT_COMMAND_TYPE = 'billing.wallet.import-legacy-snapshot'

export interface PostWalletEntryInput {
  ownerType: BillingOwnerType
  ownerId: string
  deltaUnits: number
  entryType: string
  memo?: string | null
  sourceType: string
  sourceId: string
  actorUserId?: string | null
  orgId?: string | null
  allowNegative?: boolean
}

export interface WalletPostingResult {
  balanceBeforeUnits: number
  balanceAfterUnits: number
  deltaUnits: number
  version: number
}

export interface LegacyWalletEntryInput {
  legacyId: number
  deltaUnits: number
  entryType: string
  memo?: string | null
  createdAt: number
}

export interface ImportLegacyWalletSnapshotInput {
  ownerId: string
  legacyUserId: number
  balanceUnits: number
  sourceChecksum: string
  entries: LegacyWalletEntryInput[]
}

export interface LegacyWalletImportResult {
  balanceUnits: number
  importedEntries: number
  version: number
}

export class WalletService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly repository = new BillingRepository(db),
    private readonly clock: () => number = Date.now,
  ) {}

  post(input: PostWalletEntryInput, context: CommandContext): WalletPostingResult {
    assertTrustedCommandContext(context)
    this.validateInput(input)
    const requestFingerprint = this.fingerprintPost(input)

    return runInTransaction(this.db, () => {
      const previous = this.repository.getCommandResult<WalletPostingResult>(COMMAND_TYPE, context.idempotencyKey)
      if (previous) {
        if (previous.requestFingerprint !== requestFingerprint) {
          throw new BillingDomainError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同的财务命令')
        }
        return previous.result
      }

      const wallet = this.repository.getWallet(input.ownerType, input.ownerId)
      if (!wallet) throw new BillingDomainError('WALLET_NOT_FOUND', '钱包不存在')
      this.ensureOpeningEntry(input, wallet.balanceUnits, context)

      const nextBalance = wallet.balanceUnits + input.deltaUnits
      if (!input.allowNegative && nextBalance < 0) {
        throw new BillingDomainError('INSUFFICIENT_BALANCE', '积分不足')
      }
      const timestamp = this.clock()
      if (!this.repository.updateWallet({
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        expectedVersion: wallet.version,
        balanceUnits: nextBalance,
        updatedAt: timestamp,
      })) {
        throw new BillingDomainError('WALLET_VERSION_CONFLICT', '钱包余额已变化，请重试')
      }

      const ledgerKey = `wallet:${context.idempotencyKey}`
      this.repository.insertLedgerEntry({
        id: randomUUID(),
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        deltaUnits: input.deltaUnits,
        balanceBeforeUnits: wallet.balanceUnits,
        balanceAfterUnits: nextBalance,
        entryType: input.entryType,
        memo: input.memo,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        idempotencyKey: ledgerKey,
        contextSource: context.source,
        actorUserId: input.actorUserId,
        createdAt: timestamp,
      })
      this.repository.insertAuditEvent({
        id: randomUUID(),
        action: 'WALLET_POSTED',
        aggregateType: 'wallet',
        aggregateId: `${input.ownerType}:${input.ownerId}`,
        actorUserId: input.actorUserId,
        orgId: input.orgId,
        contextSource: context.source,
        idempotencyKey: ledgerKey,
        payload: {
          deltaUnits: input.deltaUnits,
          balanceBeforeUnits: wallet.balanceUnits,
          balanceAfterUnits: nextBalance,
          entryType: input.entryType,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
        },
        createdAt: timestamp,
      })
      const result: WalletPostingResult = {
        balanceBeforeUnits: wallet.balanceUnits,
        balanceAfterUnits: nextBalance,
        deltaUnits: input.deltaUnits,
        version: wallet.version + 1,
      }
      this.repository.saveCommandResult(
        COMMAND_TYPE,
        context.idempotencyKey,
        requestFingerprint,
        context.source,
        result,
        timestamp,
      )
      return result
    })
  }

  rebuild(ownerType: BillingOwnerType, ownerId: string): {
    stored: number
    rebuilt: number
    difference: number
  } {
    const wallet = this.repository.getWallet(ownerType, ownerId)
    if (!wallet) throw new BillingDomainError('WALLET_NOT_FOUND', '钱包不存在')
    const rebuilt = this.repository.sumOwnerLedger(ownerType, ownerId)
    return { stored: wallet.balanceUnits, rebuilt, difference: wallet.balanceUnits - rebuilt }
  }

  importLegacySnapshot(
    input: ImportLegacyWalletSnapshotInput,
    context: CommandContext,
  ): LegacyWalletImportResult {
    assertTrustedCommandContext(context)
    if (context.source !== 'migration' || context.externalEffects !== 'suppress_external') {
      throw new BillingDomainError('MIGRATION_CONTEXT_REQUIRED', '历史钱包导入必须使用迁移上下文')
    }
    this.validateLegacySnapshot(input)
    const requestFingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')

    return runInTransaction(this.db, () => {
      const previous = this.repository.getCommandResult<LegacyWalletImportResult>(
        LEGACY_IMPORT_COMMAND_TYPE,
        context.idempotencyKey,
      )
      if (previous) {
        if (previous.requestFingerprint !== requestFingerprint) {
          throw new BillingDomainError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同的历史钱包快照')
        }
        return previous.result
      }

      const wallet = this.repository.getWallet('user', input.ownerId)
      if (!wallet) throw new BillingDomainError('WALLET_NOT_FOUND', '钱包不存在')
      if (wallet.balanceUnits !== 0 && wallet.balanceUnits !== input.balanceUnits) {
        throw new BillingDomainError('MIGRATION_TARGET_CONFLICT', 'Moss 钱包余额与旧余额不一致')
      }
      const existingEntryCount = this.repository.countOwnerLedgerEntries('user', input.ownerId)
      if (existingEntryCount !== 0) {
        const existingResult = this.matchImportedLegacySnapshot(input, wallet.version, existingEntryCount)
        if (!existingResult) {
          throw new BillingDomainError('MIGRATION_TARGET_CONFLICT', '目标钱包已有不一致账本，禁止覆盖或拼接历史流水')
        }
        this.repository.saveCommandResult(
          LEGACY_IMPORT_COMMAND_TYPE, context.idempotencyKey, requestFingerprint,
          context.source, existingResult, this.clock(),
        )
        return existingResult
      }

      const openingAt = input.entries[0]?.createdAt ?? this.clock()
      this.repository.insertLedgerEntry({
        id: stableId('p3-opening', String(input.legacyUserId)),
        ownerType: 'user', ownerId: input.ownerId, deltaUnits: 0,
        balanceBeforeUnits: 0, balanceAfterUnits: 0, entryType: 'OPENING',
        memo: `Sudowork 余额快照校验: ${input.balanceUnits}`,
        sourceType: 'sudowork_user_balance_snapshot', sourceId: String(input.legacyUserId),
        idempotencyKey: `migration:p3:opening:user:${input.legacyUserId}`,
        contextSource: context.source, actorUserId: null, createdAt: openingAt,
      })
      let runningBalance = 0
      for (const entry of input.entries) {
        const before = runningBalance
        runningBalance += entry.deltaUnits
        this.repository.insertLedgerEntry({
          id: stableId('p3-ledger', String(entry.legacyId)),
          legacyId: entry.legacyId,
          ownerType: 'user', ownerId: input.ownerId, deltaUnits: entry.deltaUnits,
          balanceBeforeUnits: before, balanceAfterUnits: runningBalance,
          entryType: entry.entryType, memo: entry.memo,
          sourceType: 'sudowork_ledger', sourceId: String(entry.legacyId),
          idempotencyKey: `migration:p3:ledger:${entry.legacyId}`,
          contextSource: context.source, actorUserId: null, createdAt: entry.createdAt,
        })
      }

      let version = wallet.version
      if (wallet.balanceUnits !== input.balanceUnits) {
        if (!this.repository.updateWallet({
          ownerType: 'user', ownerId: input.ownerId, expectedVersion: wallet.version,
          balanceUnits: input.balanceUnits, updatedAt: this.clock(),
        })) throw new BillingDomainError('WALLET_VERSION_CONFLICT', '钱包余额已变化，请重试')
        version += 1
      }
      const auditKey = `migration:p3:wallet:${input.legacyUserId}:${input.sourceChecksum}`
      this.repository.insertAuditEvent({
        id: stableId('p3-wallet-audit', `${input.legacyUserId}:${input.sourceChecksum}`),
        action: 'LEGACY_WALLET_IMPORTED', aggregateType: 'wallet', aggregateId: `user:${input.ownerId}`,
        actorUserId: null, orgId: null, contextSource: context.source, idempotencyKey: auditKey,
        payload: {
          legacyUserId: input.legacyUserId, sourceChecksum: input.sourceChecksum,
          balanceUnits: input.balanceUnits, ledgerEntries: input.entries.length,
          externalEffects: 'suppressed',
        },
        createdAt: this.clock(),
      })
      const result = { balanceUnits: input.balanceUnits, importedEntries: input.entries.length + 1, version }
      this.repository.saveCommandResult(
        LEGACY_IMPORT_COMMAND_TYPE, context.idempotencyKey, requestFingerprint,
        context.source, result, this.clock(),
      )
      return result
    })
  }

  private ensureOpeningEntry(
    input: PostWalletEntryInput,
    balanceUnits: number,
    context: CommandContext,
  ): void {
    if (balanceUnits === 0 || this.repository.countOwnerLedgerEntries(input.ownerType, input.ownerId) > 0) return
    const ownerKey = `${input.ownerType}:${input.ownerId}`
    this.repository.insertLedgerEntry({
      id: randomUUID(),
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      deltaUnits: balanceUnits,
      balanceBeforeUnits: 0,
      balanceAfterUnits: balanceUnits,
      entryType: 'OPENING',
      memo: '钱包期初余额',
      sourceType: 'wallet_opening',
      sourceId: ownerKey,
      idempotencyKey: `wallet-opening:${ownerKey}`,
      contextSource: context.source,
      actorUserId: input.actorUserId,
      createdAt: this.clock(),
    })
  }

  private validateInput(input: PostWalletEntryInput): void {
    if (!input.ownerId.trim()) throw new BillingDomainError('OWNER_REQUIRED', '钱包主体不能为空')
    try {
      if (toStoredPointUnits(input.deltaUnits) === 0) throw new Error('zero')
    } catch {
      throw new BillingDomainError('INVALID_AMOUNT', '积分变动必须为非零且最多保留两位小数')
    }
    if (!input.entryType.trim() || !input.sourceType.trim() || !input.sourceId.trim()) {
      throw new BillingDomainError('SOURCE_REQUIRED', '账本类型和来源不能为空')
    }
  }

  private validateLegacySnapshot(input: ImportLegacyWalletSnapshotInput): void {
    if (!input.ownerId.trim() || !Number.isSafeInteger(input.legacyUserId) || input.legacyUserId <= 0) {
      throw new BillingDomainError('INVALID_MIGRATION_SOURCE', '历史钱包主体或用户 ID 无效')
    }
    if (!isValidPointAmount(input.balanceUnits) || !/^[a-f0-9]{8,}$/i.test(input.sourceChecksum)) {
      throw new BillingDomainError('INVALID_MIGRATION_SOURCE', '历史钱包余额或来源校验值无效')
    }
    const ids = new Set<number>()
    let sum = 0
    for (const entry of input.entries) {
      if (!Number.isSafeInteger(entry.legacyId) || entry.legacyId <= 0 || ids.has(entry.legacyId)
        || !isValidPointAmount(entry.deltaUnits) || !entry.entryType.trim()
        || !Number.isSafeInteger(entry.createdAt)) {
        throw new BillingDomainError('INVALID_MIGRATION_SOURCE', '历史钱包流水无效或 ID 重复')
      }
      ids.add(entry.legacyId)
      sum += entry.deltaUnits
      if (!isValidPointAmount(sum)) {
        throw new BillingDomainError('INVALID_MIGRATION_SOURCE', '历史钱包流水累计值超出安全整数范围')
      }
    }
    if (sum !== input.balanceUnits) {
      throw new BillingDomainError('MIGRATION_BALANCE_MISMATCH', '历史流水合计与余额不一致')
    }
  }

  private matchImportedLegacySnapshot(
    input: ImportLegacyWalletSnapshotInput,
    version: number,
    existingEntryCount: number,
  ): LegacyWalletImportResult | null {
    if (existingEntryCount !== input.entries.length + 1) return null
    const opening = this.repository.getLedgerEntry(`migration:p3:opening:user:${input.legacyUserId}`)
    if (!opening || opening.ownerId !== input.ownerId || opening.deltaUnits !== 0
      || opening.balanceBeforeUnits !== 0 || opening.balanceAfterUnits !== 0
      || opening.entryType !== 'OPENING') return null
    let runningBalance = 0
    for (const source of input.entries) {
      const entry = this.repository.getLedgerEntry(`migration:p3:ledger:${source.legacyId}`)
      const before = runningBalance
      runningBalance += source.deltaUnits
      if (!entry || entry.ownerId !== input.ownerId || entry.deltaUnits !== source.deltaUnits
        || entry.balanceBeforeUnits !== before || entry.balanceAfterUnits !== runningBalance
        || entry.entryType !== source.entryType || entry.createdAt !== source.createdAt) return null
    }
    if (runningBalance !== input.balanceUnits) return null
    return { balanceUnits: input.balanceUnits, importedEntries: 0, version }
  }

  private fingerprintPost(input: PostWalletEntryInput): string {
    const canonical = JSON.stringify([
      input.ownerType,
      input.ownerId,
      input.deltaUnits,
      input.entryType,
      input.memo ?? null,
      input.sourceType,
      input.sourceId,
      input.actorUserId ?? null,
      input.orgId ?? null,
      input.allowNegative === true,
    ])
    return createHash('sha256').update(canonical).digest('hex')
  }
}

function isValidPointAmount(value: number): boolean {
  try {
    toStoredPointUnits(value)
    return true
  } catch {
    return false
  }
}

function stableId(namespace: string, value: string): string {
  const digest = createHash('sha256').update(`${namespace}:${value}`).digest('hex')
  return `${namespace}-${digest.slice(0, 24)}`
}
