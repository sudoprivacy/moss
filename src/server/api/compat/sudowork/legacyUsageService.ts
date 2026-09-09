import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AuthCenterDb } from '../../../authCenter/db.js'
import { onlineCommandContext } from '../../../application/commandContext.js'
import type { BillingRepository, BillingUsageRecord, LedgerEntryRecord } from '../../../billing/billingRepository.js'
import { BillingDomainError } from '../../../billing/types.js'
import type { WalletService } from '../../../billing/walletService.js'
import type { IdentityRepository } from '../../../identity/identityRepository.js'
import {
  hasGlobalOrganizationAccess,
  type IdentityActor,
} from '../../../identity/organizationIdentityService.js'
import { runInTransaction } from '../../../storage/sqliteUnitOfWork.js'
import type { SudoworkLegacyUsagePort } from './legacyUsageRoutes.js'

interface ModelDescriptor {
  id: string
  name?: string
}

export class SudoworkLegacyUsageError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SudoworkLegacyUsageError'
  }
}

export class SudoworkLegacyUsageService implements SudoworkLegacyUsagePort {
  private readonly clock: () => number

  constructor(private readonly options: {
    db: DatabaseSync
    auth: AuthCenterDb
    identities: IdentityRepository
    repository: BillingRepository
    wallet: WalletService
    listModels: () => Promise<ModelDescriptor[]> | ModelDescriptor[]
    clock?: () => number
  }) {
    this.clock = options.clock ?? Date.now
  }

  async listModels(): Promise<Array<{ label: string; value: string }>> {
    return (await this.options.listModels()).map(model => ({
      label: model.name?.trim() || model.id,
      value: model.id,
    }))
  }

  async reportUsage(input: {
    actor: IdentityActor
    inputTokens: number
    outputTokens: number
    model?: string
    idempotencyKey?: string
  }): Promise<{ success: true; deducted: number; newBalance: number }> {
    this.assertTokenCount(input.inputTokens)
    this.assertTokenCount(input.outputTokens)
    const totalTokens = input.inputTokens + input.outputTokens
    const cost = Math.ceil((totalTokens / 1000) * 100) / 100
    if (cost <= 0) return { success: true, deducted: 0, newBalance: 0 }

    const user = this.options.auth.getUserById(input.actor.userId)
    if (!user) throw new SudoworkLegacyUsageError(404, '用户不存在')
    const requestKey = input.idempotencyKey?.trim() || randomUUID()
    const commandKey = `sudowork:usage:${requestKey}`
    const createdAt = this.clock()

    try {
      return runInTransaction(this.options.db, () => {
        const result = this.options.wallet.post({
          ownerType: 'user',
          ownerId: user.id,
          deltaUnits: -cost,
          entryType: 'CONSUME',
          memo: `Used ${input.model || 'model'} (${totalTokens} tokens)`,
          sourceType: 'usage_report',
          sourceId: requestKey,
          actorUserId: user.id,
          orgId: user.orgId,
        }, onlineCommandContext(commandKey))

        const previous = this.options.repository.getUsageRecord(commandKey)
        if (previous) {
          if (!sameUsage(previous, input, cost)) {
            throw new SudoworkLegacyUsageError(409, '幂等键已用于不同的用量上报')
          }
          return { success: true as const, deducted: previous.costUnits, newBalance: previous.balanceAfterUnits }
        }
        this.options.repository.insertUsageRecord({
          id: randomUUID(),
          userId: user.id,
          orgId: user.orgId,
          model: input.model ?? null,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          costUnits: cost,
          balanceAfterUnits: result.balanceAfterUnits,
          idempotencyKey: commandKey,
          createdAt,
        })
        return { success: true as const, deducted: cost, newBalance: result.balanceAfterUnits }
      })
    } catch (error) {
      if (error instanceof SudoworkLegacyUsageError) throw error
      if (error instanceof BillingDomainError && error.code === 'INSUFFICIENT_BALANCE') {
        const balance = this.options.repository.getWallet('user', user.id)?.balanceUnits ?? 0
        throw new SudoworkLegacyUsageError(400, '积分不足', { balance, required: cost })
      }
      throw error
    }
  }

  getDashboard(actor: IdentityActor): Record<string, unknown> {
    const stats = this.buildStats(actor)
    const now = this.clock()
    const recentUsage = this.options.repository.listUsageRecords({
      userId: actor.userId,
      from: now - 30 * 86_400_000,
      to: now,
      limit: 100,
      offset: 0,
    })
    return {
      ...stats,
      ledger: {
        list: recentUsage.list.map(toUsageLog),
        total: recentUsage.total,
      },
    }
  }

  listLedger(input: { actor: IdentityActor; timeFrom?: number; timeTo?: number }): { data: unknown[]; total: number } {
    this.requireUser(input.actor.userId)
    const entries = this.options.repository.listLedgerEntries({
      userId: input.actor.userId,
      excludeEntryType: 'OPENING',
      limit: 100,
      offset: 0,
    })
    const from = input.timeFrom === undefined ? undefined : input.timeFrom * 1000
    const to = input.timeTo === undefined ? undefined : input.timeTo * 1000
    const filtered = entries.list.filter(entry => (
      (from === undefined || entry.createdAt >= from) && (to === undefined || entry.createdAt <= to)
    ))
    return { data: filtered.map(entry => this.toLegacyLedger(entry)), total: filtered.length }
  }

  getStats(actor: IdentityActor): Record<string, unknown> {
    return this.buildStats(actor)
  }

  getModelUsageStats(input: { actor: IdentityActor; startDate?: string; endDate?: string }): unknown[] {
    this.requireUser(input.actor.userId)
    const from = parseLocalDate(input.startDate!, false)
    const to = parseLocalDate(input.endDate!, true)
    const records = this.options.repository.listUsageRecords({
      userId: input.actor.userId,
      from,
      to,
      limit: 100_000,
      offset: 0,
    }).list.filter(record => Boolean(record.model))
    const totals = new Map<string, number>()
    const grouped = new Map<string, Map<string, Aggregate>>()
    for (const record of records) {
      const model = record.model!
      const date = formatLocalDate(record.createdAt)
      totals.set(model, (totals.get(model) ?? 0) + record.inputTokens + record.outputTokens)
      const dateGroup = grouped.get(date) ?? new Map<string, Aggregate>()
      const aggregate = dateGroup.get(model) ?? { prompt: 0, completion: 0, total: 0, cost: 0 }
      aggregate.prompt += record.inputTokens
      aggregate.completion += record.outputTokens
      aggregate.total += record.inputTokens + record.outputTokens
      aggregate.cost += record.costUnits
      dateGroup.set(model, aggregate)
      grouped.set(date, dateGroup)
    }
    const topModels = [...totals.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 5)
      .map(([model]) => model)
    const result: unknown[] = []
    for (const date of [...grouped.keys()].sort()) {
      const dateGroup = grouped.get(date)!
      const other: Aggregate = { prompt: 0, completion: 0, total: 0, cost: 0 }
      for (const model of topModels) {
        const value = dateGroup.get(model)
        if (value) result.push(toModelStat(date, model, value))
      }
      for (const [model, value] of dateGroup) {
        if (topModels.includes(model)) continue
        other.prompt += value.prompt
        other.completion += value.completion
        other.total += value.total
        other.cost += value.cost
      }
      if (other.total > 0) result.push(toModelStat(date, 'other', other))
    }
    return result
  }

  listAdminUserLedger(input: { actor: IdentityActor; legacyUserId: number; limit: number }): unknown[] {
    this.assertAdmin(input.actor)
    const alias = this.options.identities.resolveNumericAliasGlobal('user', input.legacyUserId)
    if (!alias) throw new SudoworkLegacyUsageError(404, '用户不存在')
    if (!hasGlobalOrganizationAccess(input.actor) && alias.orgId !== input.actor.orgId) {
      throw new SudoworkLegacyUsageError(403, '无权操作该用户')
    }
    return this.options.repository.listLedgerEntries({
      userId: alias.resourceId,
      excludeEntryType: 'OPENING',
      limit: Math.max(1, Math.min(input.limit, 100)),
      offset: 0,
    }).list.map(entry => this.toLegacyLedger(entry, input.legacyUserId))
  }

  private buildStats(actor: IdentityActor): Record<string, unknown> {
    this.requireUser(actor.userId)
    const wallet = this.options.repository.getWallet('user', actor.userId)
    if (!wallet) throw new SudoworkLegacyUsageError(404, '用户不存在')
    const allUsage = this.options.repository.listUsageRecords({
      userId: actor.userId,
      limit: 100_000,
      offset: 0,
    }).list
    const todayStart = startOfLocalDay(this.clock())
    const today = allUsage.filter(record => record.createdAt >= todayStart && record.createdAt <= this.clock())
    const used = sum(allUsage.map(record => record.costUnits))
    const bonuses = this.options.repository.listLedgerEntries({
      userId: actor.userId,
      entryType: 'BONUS',
      limit: 100_000,
      offset: 0,
    }).list
    return {
      points: {
        total: roundPoints(wallet.balanceUnits + used),
        used: roundPoints(used),
        remaining: wallet.balanceUnits,
        bonus: roundPoints(sum(bonuses.map(entry => entry.deltaUnits))),
      },
      usage_today: {
        tokens: sum(today.map(record => record.inputTokens + record.outputTokens)),
        cost_points: roundPoints(sum(today.map(record => record.costUnits))),
        requests: today.length,
      },
    }
  }

  private requireUser(userId: string): void {
    if (!this.options.auth.getUserById(userId)) throw new SudoworkLegacyUsageError(404, '用户不存在')
  }

  private assertAdmin(actor: IdentityActor): void {
    if (actor.role !== 'admin' && actor.role !== 'super_admin') {
      throw new SudoworkLegacyUsageError(403, '权限不足')
    }
  }

  private assertTokenCount(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SudoworkLegacyUsageError(400, 'Token 数量无效')
    }
  }

  private toLegacyLedger(entry: LedgerEntryRecord, legacyUserId?: number): Record<string, unknown> {
    return {
      id: entry.legacyId,
      user_id: legacyUserId ?? this.options.identities.getNumericAlias('user', entry.ownerId),
      amount: entry.deltaUnits,
      type: entry.entryType,
      memo: entry.memo,
      timestamp: new Date(entry.createdAt).toISOString(),
    }
  }
}

interface Aggregate {
  prompt: number
  completion: number
  total: number
  cost: number
}

function sameUsage(
  record: BillingUsageRecord,
  input: { inputTokens: number; outputTokens: number; model?: string },
  cost: number,
): boolean {
  return record.inputTokens === input.inputTokens
    && record.outputTokens === input.outputTokens
    && record.model === (input.model ?? null)
    && record.costUnits === cost
}

function toUsageLog(record: BillingUsageRecord): Record<string, unknown> {
  return {
    id: record.id,
    model: record.model,
    timestamp: new Date(record.createdAt).toISOString(),
    prompt_tokens: record.inputTokens,
    completion_tokens: record.outputTokens,
    created_at: Math.floor(record.createdAt / 1000),
  }
}

function toModelStat(date: string, model: string, value: Aggregate): Record<string, unknown> {
  return {
    date,
    model,
    prompt_tokens: value.prompt,
    completion_tokens: value.completion,
    total_tokens: value.total,
    cost: roundPoints(value.cost),
  }
}

function startOfLocalDay(timestamp: number): number {
  const value = new Date(timestamp)
  value.setHours(0, 0, 0, 0)
  return value.getTime()
}

function parseLocalDate(value: string, endOfDay: boolean): number {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year!, month! - 1, day!, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0).getTime()
}

function formatLocalDate(timestamp: number): string {
  const date = new Date(timestamp)
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
    .join('-')
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function roundPoints(value: number): number {
  return Math.round(value * 100) / 100
}
