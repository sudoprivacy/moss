import { replayCommandContext, type CommandContext } from '../application/commandContext.js'
import {
  PostCutoverChangeLogError,
  type PostCutoverChange,
  type PostCutoverChangeLog,
  type RedeliveryRecord,
  type RedeliveryRequest,
  type ReplayApproval,
} from './postCutoverChangeLog.js'

interface ReplayHandler {
  (change: PostCutoverChange, context: CommandContext): Promise<Record<string, unknown>>
}

interface RedeliveryAdapter {
  deliver(request: RedeliveryRequest): Promise<Record<string, unknown>>
}

export type ReplayServiceErrorCode = 'APPROVAL_REQUIRED' | 'TARGET_NOT_ALLOWED' | 'HANDLER_NOT_FOUND' | 'REDELIVERY_CONFLICT'

export class ReplayServiceError extends Error {
  constructor(readonly code: ReplayServiceErrorCode, message: string) {
    super(message)
    this.name = 'ReplayServiceError'
  }
}

export class ReplayService {
  private readonly allowedTargets: ReadonlySet<string>

  constructor(private readonly options: {
    log: PostCutoverChangeLog
    replayHandlers: Record<string, ReplayHandler>
    redeliveryAdapter: RedeliveryAdapter
    allowedRedeliveryTargets: readonly string[]
  }) {
    this.allowedTargets = new Set(options.allowedRedeliveryTargets)
  }

  async replay(change: PostCutoverChange, approval: ReplayApproval): Promise<Record<string, unknown>> {
    assertApproval(approval)
    const handler = this.options.replayHandlers[change.domain]
    if (!handler) throw new ReplayServiceError('HANDLER_NOT_FOUND', `没有 ${change.domain} 领域的回放处理器`)
    const reservation = this.options.log.beginReplay(change.eventId, approval)
    if (!reservation.execute) return reservation.change.replayResult ?? {}
    try {
      const result = await handler(
        reservation.change,
        replayCommandContext(change.eventId, `replay:${change.eventId}`),
      )
      return this.options.log.completeReplay(change.eventId, result).replayResult ?? {}
    } catch (error) {
      this.options.log.failReplay(change.eventId, error)
      throw error
    }
  }

  async redeliver(request: RedeliveryRequest, approval: ReplayApproval): Promise<RedeliveryRecord> {
    assertApproval(approval)
    if (!this.allowedTargets.has(request.target)) {
      throw new ReplayServiceError('TARGET_NOT_ALLOWED', `补发目标不在审批白名单: ${request.target}`)
    }
    let reservation
    try {
      reservation = this.options.log.beginRedelivery(request, approval)
    } catch (error) {
      if (error instanceof PostCutoverChangeLogError && error.code === 'CHANGE_CONFLICT') {
        throw new ReplayServiceError('REDELIVERY_CONFLICT', error.message)
      }
      throw error
    }
    if (!reservation.execute) return reservation.record
    try {
      const result = await this.options.redeliveryAdapter.deliver(request)
      return this.options.log.completeRedelivery(request.originalIdempotencyKey, result)
    } catch (error) {
      this.options.log.failRedelivery(request.originalIdempotencyKey, error)
      throw error
    }
  }
}

function assertApproval(approval: ReplayApproval): void {
  if (!approval.approvedBy.trim() || !Number.isSafeInteger(approval.approvedAt) || approval.approvedAt <= 0 || !approval.reason.trim()) {
    throw new ReplayServiceError('APPROVAL_REQUIRED', '回放或补发必须包含有效审批人、审批时间和原因')
  }
}
