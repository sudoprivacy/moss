import type { QmsLeaseStore } from './qmsScheduler.js'
import type { QmsSqlPort } from './qmsSchema.js'

export class PostgresQmsLeaseStore implements QmsLeaseStore {
  constructor(private readonly db: QmsSqlPort) {}

  async tryAcquire(taskName: string, ownerId: string, now: number, leaseMs: number): Promise<boolean> {
    const rows = await this.db.execute(
      `INSERT INTO qms_task_leases (
        task_name, owner_id, lease_until, last_started_at, last_error, updated_at
      ) VALUES ($1, $2, TO_TIMESTAMP($3 / 1000.0), TO_TIMESTAMP($3 / 1000.0), NULL, NOW())
      ON CONFLICT (task_name) DO UPDATE SET
        owner_id = EXCLUDED.owner_id,
        lease_until = TO_TIMESTAMP($4 / 1000.0),
        last_started_at = TO_TIMESTAMP($3 / 1000.0),
        last_error = NULL,
        updated_at = NOW()
      WHERE qms_task_leases.lease_until <= TO_TIMESTAMP($3 / 1000.0)
         OR qms_task_leases.owner_id = EXCLUDED.owner_id
      RETURNING owner_id`,
      [taskName, ownerId, now, now + leaseMs],
    )
    return rows.length === 1 && rows[0]?.owner_id === ownerId
  }

  async complete(taskName: string, ownerId: string, now = Date.now()): Promise<void> {
    await this.db.execute(
      `UPDATE qms_task_leases SET
        lease_until = TO_TIMESTAMP($3 / 1000.0), last_completed_at = TO_TIMESTAMP($3 / 1000.0),
        last_error = NULL, updated_at = NOW()
      WHERE task_name = $1 AND owner_id = $2`,
      [taskName, ownerId, now],
    )
  }

  async fail(taskName: string, ownerId: string, error: string, now = Date.now()): Promise<void> {
    await this.db.execute(
      `UPDATE qms_task_leases SET
        lease_until = TO_TIMESTAMP($4 / 1000.0), last_error = $3, updated_at = NOW()
      WHERE task_name = $1 AND owner_id = $2`,
      [taskName, ownerId, error.slice(0, 2_000), now],
    )
  }
}
