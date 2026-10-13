import type { DbDriver } from '../db/driver.js'
import { ParkRepository } from './parkRepository.js'

/** Append-only park business audit (方案 §7.7). The table rejects UPDATE/DELETE at the DB level. */
export class ParkAuditService {
  private readonly repo: ParkRepository

  constructor(driver: DbDriver) {
    this.repo = new ParkRepository(driver)
  }

  async record(input: {
    parkOrgId: string
    actorUserId: string
    actorOrgId: string
    action: string
    targetType: string
    targetId?: string | null
    reason?: string | null
    before?: unknown
    after?: unknown
    result?: string | null
    requestId?: string | null
  }): Promise<void> {
    await this.repo.insertAuditEvent({
      parkOrgId: input.parkOrgId,
      actorUserId: input.actorUserId,
      actorOrgId: input.actorOrgId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      reason: input.reason ?? null,
      beforeSummaryJson: input.before === undefined ? null : JSON.stringify(input.before),
      afterSummaryJson: input.after === undefined ? null : JSON.stringify(input.after),
      result: input.result ?? 'ok',
      requestId: input.requestId ?? null,
    })
  }
}
