import type { DbDriver } from '../db/driver.js'

/** Original Pilot rows, including a delta beyond the checkpoint. */
export async function seedExternalTaskMigration(db: DbDriver) {
  await db.exec(`
    CREATE TABLE external_pilot_sessions(id TEXT PRIMARY KEY, org_id TEXT, user_id TEXT, agent_id TEXT, agent_name TEXT, title TEXT, active_task_id TEXT, conversation_id TEXT, created_at BIGINT, updated_at BIGINT);
    CREATE TABLE external_pilot_tasks(id TEXT PRIMARY KEY, org_id TEXT, user_id TEXT, session_id TEXT, idempotency_key TEXT, request_hash TEXT, status TEXT, deadline_at BIGINT, sequence INTEGER, document TEXT);
    CREATE TABLE external_pilot_attempts(id TEXT PRIMARY KEY, task_id TEXT, started_at BIGINT, updated_at BIGINT);
    CREATE TABLE external_pilot_events(task_id TEXT, sequence INTEGER, document TEXT);
    INSERT INTO external_pilot_sessions VALUES ('session-1', 'org-1', 'user-1', 'agent-1', 'agent-name', 'Retain title', 'task-1', 'remote-session', 100, 200);
    INSERT INTO external_pilot_attempts VALUES ('attempt-1', 'task-1', 110, 200);
  `)
  const document = JSON.stringify({ id: 'task-1', attempt_id: 'attempt-1', session_sequence: 1, status: 'dispatching', answer: '', raw_answer: '', created_at: 100, updated_at: 200, _checkpoint_sequence: 1 })
  const event = JSON.stringify({ created_at: 150, type: 'answer', state: { status: 'running' }, delta: { offset: 0, text: 'partial' } })
  await db.run("INSERT INTO external_pilot_tasks VALUES ('task-1', 'org-1', 'user-1', 'session-1', 'request-1', 'hash-1', 'running', 9999999999999, 2, ?)", [document])
  await db.run("INSERT INTO external_pilot_events VALUES ('task-1', 2, ?)", [event])
  return { db, document, event }
}
