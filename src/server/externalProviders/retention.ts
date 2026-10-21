import type { ExternalTaskStore } from './store.js'

const DAY = 86400_000
export const PILOT_RETENTION = { eventDays: 1, historyDays: 30, auditDays: 90, batchSize: 100 } as const

/** Retire payloads, never uncertain outcomes or idempotency reservations. */
export async function maintainRetention(store: ExternalTaskStore, now = Date.now()): Promise<void> {
  const db = store.db
  await store.ready
  await store.scheduled('retention', 60_000, async () => {
    const compact = await db.all(`SELECT id, sequence FROM external_tasks t
      WHERE status IN ('succeeded', 'failed', 'rejected') AND deadline_at < ?
      AND NOT EXISTS (SELECT 1 FROM external_pilot_retention r WHERE r.task_id = t.id)
      ORDER BY deadline_at, id LIMIT ?`, [now - PILOT_RETENTION.eventDays * DAY, PILOT_RETENTION.batchSize])
    for (const row of compact) {
      // Terminal tasks already contain a complete checkpoint. Old cursors resync to it.
      await db.run('INSERT INTO external_pilot_retention(task_id, compacted_at) VALUES (?, ?) ON CONFLICT(task_id) DO NOTHING', [String(row.id), now])
      await db.run('DELETE FROM session_events WHERE task_id = ? AND sequence < ?', [String(row.id), Number(row.sequence)])
    }
    const retired = await db.all(`SELECT t.* FROM external_tasks t
      JOIN external_pilot_retention r ON r.task_id = t.id
      WHERE t.status IN ('succeeded', 'failed', 'rejected') AND t.deadline_at < ? AND r.retired_at IS NULL
      ORDER BY t.deadline_at, t.id LIMIT ?`, [now - PILOT_RETENTION.historyDays * DAY, PILOT_RETENTION.batchSize])
    for (const row of retired) {
      const task = JSON.parse(String(row.document))
      const record = await db.get('SELECT document FROM product_task_records WHERE task_id = ?', [String(row.id)])
      const resolution = record ? JSON.parse(String(record.document)).resolution : null
      const audit = { task_id: row.id, session_id: row.session_id, org_id: row.org_id, user_id: row.user_id,
        request_hash: row.request_hash, status: row.status, error_code: task.error_code, resolution,
        created_at: task.created_at, updated_at: task.updated_at, retired_at: now }
      await db.run('UPDATE external_pilot_retention SET retired_at = ?, audit_document = ? WHERE task_id = ?', [now, JSON.stringify(audit), String(row.id)])
      // The compact row is an indefinite, capacity-bounded tombstone. It cannot be dispatched.
      await db.run('UPDATE tasks SET document = ? WHERE id = ? AND id IN (SELECT id FROM external_tasks)', [JSON.stringify({ _retired: true }), String(row.id)])
      for (const table of ['session_events', 'product_task_records', 'external_pilot_run_bindings']) {
        await db.run(`DELETE FROM ${table} WHERE task_id = ?`, [String(row.id)])
      }
      await db.run(`UPDATE sessions SET title = '' WHERE session_id = ? AND EXISTS (SELECT 1 FROM external_session_bindings x WHERE x.id = sessions.session_id AND x.active_task_id IS NULL)
        AND NOT EXISTS (SELECT 1 FROM external_tasks t WHERE t.session_id = ?
        AND NOT EXISTS (SELECT 1 FROM external_pilot_retention r WHERE r.task_id = t.id AND r.retired_at IS NOT NULL))`, [String(row.session_id), String(row.session_id)])
    }
    await db.run(`UPDATE external_pilot_retention SET audit_document = NULL WHERE task_id IN (
      SELECT task_id FROM external_pilot_retention WHERE retired_at < ? AND audit_document IS NOT NULL
      ORDER BY retired_at, task_id LIMIT ?)`, [now - PILOT_RETENTION.auditDays * DAY, PILOT_RETENTION.batchSize])
    // Admin audit has no task text or credentials and follows the longer audit window.
    await db.run(`DELETE FROM external_pilot_admin_audit WHERE id IN (
      SELECT id FROM external_pilot_admin_audit WHERE created_at < ? ORDER BY created_at, id LIMIT ?)`,
    [now - PILOT_RETENTION.auditDays * DAY, PILOT_RETENTION.batchSize])
  }, now)
}
