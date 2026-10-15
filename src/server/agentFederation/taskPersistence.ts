import type { DbDriver } from '../db/driver.js'
import { SESSION_SCHEMA } from '../storage/sessionSchema.js'
import type { ExternalTask } from '../../../contracts/external-provider/v1/contract.js'

export function attemptState(status: ExternalTask['status']): string {
  return status === 'accepted' || status === 'dispatching' ? 'starting'
    : status === 'running' ? 'running' : status === 'succeeded' ? 'stopped' : status === 'unknown' ? 'lost' : 'failed'
}

/** One-way, transactional adoption of Pilot facts. Legacy writers fail after cutover. */
export async function migrateExternalTaskPersistence(db: DbDriver): Promise<void> {
  await db.exec(`${SESSION_SCHEMA}
    CREATE TABLE IF NOT EXISTS federation_task_migrations (id TEXT PRIMARY KEY, completed INTEGER NOT NULL);
  `)
  await db.transaction(async () => {
    await db.run("INSERT INTO federation_task_migrations(id, completed) VALUES ('canonical-v1', 0) ON CONFLICT(id) DO NOTHING")
    await db.run("UPDATE federation_task_migrations SET id = id WHERE id = 'canonical-v1'")
    if (Number((await db.get("SELECT completed FROM federation_task_migrations WHERE id = 'canonical-v1'"))?.completed)) return
    if (db.kind === 'postgres') {
      await db.exec('LOCK TABLE external_pilot_sessions, external_pilot_tasks, external_pilot_attempts, external_pilot_events IN ACCESS EXCLUSIVE MODE')
      await db.exec('ALTER TABLE session_events ADD COLUMN IF NOT EXISTS task_id TEXT; ALTER TABLE session_events ADD COLUMN IF NOT EXISTS sequence BIGINT;')
    } else {
      const columns = await db.all('PRAGMA table_info(session_events)')
      if (!columns.some(row => row.name === 'task_id')) await db.exec('ALTER TABLE session_events ADD COLUMN task_id TEXT')
      if (!columns.some(row => row.name === 'sequence')) await db.exec('ALTER TABLE session_events ADD COLUMN sequence BIGINT')
    }
    await db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL,
        deadline_at BIGINT NOT NULL, sequence INTEGER NOT NULL, document TEXT NOT NULL,
        attempt_id TEXT UNIQUE,
        UNIQUE(org_id, user_id, idempotency_key),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE INDEX IF NOT EXISTS tasks_deadline ON tasks(status, deadline_at);
      CREATE INDEX IF NOT EXISTS tasks_session ON tasks(session_id);
      CREATE INDEX IF NOT EXISTS sessions_external_owner ON sessions(org_id, user_id, last_active_at) WHERE runtime_type = 'external';
      CREATE TABLE IF NOT EXISTS external_session_bindings (
        id TEXT PRIMARY KEY REFERENCES sessions(session_id), agent_id TEXT NOT NULL, agent_name TEXT NOT NULL,
        active_task_id TEXT, conversation_id TEXT
      );
      CREATE TABLE IF NOT EXISTS external_attempt_leases (
        attempt_id TEXT PRIMARY KEY REFERENCES session_attempts(attempt_id), token TEXT NOT NULL,
        lease_until BIGINT NOT NULL, invocation_context TEXT
      );
      CREATE INDEX IF NOT EXISTS external_attempt_leases_expiry ON external_attempt_leases(lease_until);
      CREATE UNIQUE INDEX IF NOT EXISTS session_events_task_sequence ON session_events(task_id, sequence);
      CREATE VIEW external_sessions AS
        SELECT s.session_id AS id, s.org_id, s.user_id, x.agent_id, x.agent_name, s.title,
          x.active_task_id, x.conversation_id, s.created_at, s.last_active_at AS updated_at
        FROM sessions s JOIN external_session_bindings x ON x.id = s.session_id WHERE s.runtime_type = 'external';
      CREATE VIEW task_attempts AS
        SELECT a.attempt_id AS id, t.id AS task_id, t.status, a.started_at, a.last_heartbeat_at AS updated_at
        FROM session_attempts a JOIN tasks t ON t.attempt_id = a.attempt_id;
      CREATE VIEW task_events AS
        SELECT task_id, sequence, payload_json AS document FROM session_events WHERE task_id IS NOT NULL;
    `)
    let cursor = ''
    while (true) {
      const rows = await db.all('SELECT * FROM external_pilot_sessions WHERE id > ? ORDER BY id LIMIT 100', [cursor])
      if (!rows.length) break
      for (const row of rows) {
        if (await db.get('SELECT session_id FROM sessions WHERE session_id = ?', [String(row.id)])) throw new Error('Canonical external session identity collision')
        await db.run(`INSERT INTO sessions(session_id, transcript_session_id, org_id, user_id, role, scopes_json, cwd,
          runtime_type, status, desired_state, transcript_path, title, assistant_name, source, client_metadata, created_at, last_active_at)
          VALUES (?, ?, ?, ?, 'user', '[]', '', 'external', 'detached', 'active', '', ?, ?, 'external_provider', ?, ?, ?)`,
        [String(row.id), String(row.id), String(row.org_id), String(row.user_id), String(row.title), String(row.agent_name), JSON.stringify({ task_contract: 'task.sudo.dev/v1alpha1', migration: 'external-pilot' }), Number(row.created_at), Number(row.updated_at)])
        await db.run('INSERT INTO external_session_bindings(id, agent_id, agent_name, active_task_id, conversation_id) VALUES (?, ?, ?, ?, ?)', [String(row.id), String(row.agent_id), String(row.agent_name), row.active_task_id ? String(row.active_task_id) : null, row.conversation_id ? String(row.conversation_id) : null])
      }
      cursor = String(rows.at(-1)!.id)
    }
    cursor = ''
    const jsonNumber = (field: string) => db.kind === 'postgres'
      ? `CAST(t.document::jsonb->>'${field}' AS BIGINT)` : `CAST(json_extract(t.document, '$.${field}') AS BIGINT)`
    await db.exec(`CREATE TEMP TABLE federation_task_order AS SELECT t.id,
      ROW_NUMBER() OVER (PARTITION BY t.session_id ORDER BY
        CASE WHEN ${jsonNumber('session_sequence')} > 0 THEN 1 ELSE 0 END,
        ${jsonNumber('session_sequence')}, COALESCE(a.started_at, ${jsonNumber('created_at')}, t.deadline_at), t.id) AS generation
      FROM external_pilot_tasks t LEFT JOIN external_pilot_attempts a ON a.task_id = t.id;`)
    while (true) {
      const rows = await db.all('SELECT t.*, o.generation FROM external_pilot_tasks t JOIN federation_task_order o ON o.id = t.id WHERE t.id > ? ORDER BY t.id LIMIT 100', [cursor])
      if (!rows.length) break
      for (const row of rows) {
        const task = JSON.parse(String(row.document)) as Partial<ExternalTask>
        const oldAttempt = await db.get('SELECT * FROM external_pilot_attempts WHERE task_id = ?', [String(row.id)])
        const attemptId = oldAttempt ? String(oldAttempt.id) : task.attempt_id ?? null
        await db.run(`INSERT INTO tasks(id, org_id, user_id, session_id, idempotency_key, request_hash, status, deadline_at, sequence, document, attempt_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [String(row.id), String(row.org_id), String(row.user_id), String(row.session_id), String(row.idempotency_key), String(row.request_hash), String(row.status), Number(row.deadline_at), Number(row.sequence), String(row.document), attemptId])
        if (attemptId) {
          const state = attemptState(String(row.status) as ExternalTask['status'])
          await db.run(`INSERT INTO session_attempts(attempt_id, session_id, generation, backend_type, runtime_state, resume_transcript_session_id, started_at, last_heartbeat_at, stopped_at)
            VALUES (?, ?, ?, 'external', ?, ?, ?, ?, ?)`, [attemptId, String(row.session_id), Number(row.generation), state, String(row.session_id), Number(oldAttempt?.started_at ?? task.created_at ?? row.deadline_at), Number(oldAttempt?.updated_at ?? task.updated_at ?? row.deadline_at), ['stopped', 'failed', 'lost'].includes(state) ? Number(task.updated_at ?? row.deadline_at) : null])
          await db.run("INSERT INTO external_attempt_leases(attempt_id, token, lease_until) VALUES (?, '', 0)", [attemptId])
          await db.run('UPDATE sessions SET current_attempt_id = ? WHERE session_id = ? AND EXISTS (SELECT 1 FROM external_session_bindings x WHERE x.id = ? AND x.active_task_id = ?)', [attemptId, String(row.session_id), String(row.session_id), String(row.id)])
        }
        // Copy every normalized event, including delta-only rows after the last checkpoint.
        for (const event of await db.all('SELECT * FROM external_pilot_events WHERE task_id = ? ORDER BY sequence', [String(row.id)])) {
          const payload = JSON.parse(String(event.document)) as { created_at?: number; type?: string }
          await db.run(`INSERT INTO session_events(event_id, session_id, attempt_id, event_type, payload_json, created_at, task_id, sequence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [`task:${row.id}:${event.sequence}`, String(row.session_id), attemptId, `task.${payload.type ?? 'status'}`, String(event.document), payload.created_at ?? Number(row.deadline_at), String(row.id), Number(event.sequence)])
        }
      }
      cursor = String(rows.at(-1)!.id)
    }
    const mismatches = await db.get(`SELECT COUNT(*) AS total FROM external_pilot_tasks p LEFT JOIN tasks t ON t.id = p.id
      WHERE t.id IS NULL OR t.document != p.document OR t.sequence != p.sequence OR t.request_hash != p.request_hash`)
    if (Number(mismatches?.total)) throw new Error('Canonical external task migration verification failed')
    const eventMismatches = await db.get(`SELECT COUNT(*) AS total FROM external_pilot_events p
      LEFT JOIN session_events e ON e.task_id = p.task_id AND e.sequence = p.sequence
      WHERE e.event_id IS NULL OR e.payload_json != p.document`)
    if (Number(eventMismatches?.total)) throw new Error('Canonical external event migration verification failed')
    await db.exec('DROP TABLE federation_task_order')
    const tables = ['external_pilot_sessions', 'external_pilot_tasks', 'external_pilot_attempts', 'external_pilot_events']
    // The verified canonical rows are now the sole facts. Do not retain ungoverned copies of task text.
    for (const table of [...tables].reverse()) await db.run(`DELETE FROM ${table}`)
    if (db.kind === 'postgres') await db.exec(`CREATE OR REPLACE FUNCTION reject_legacy_external_write() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'External Pilot store migrated; legacy writes are disabled'; END; $$ LANGUAGE plpgsql;`)
    for (const table of tables) {
      if (db.kind === 'postgres') await db.exec(`CREATE TRIGGER sealed_${table} BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_legacy_external_write()`)
      else for (const action of ['INSERT', 'UPDATE', 'DELETE']) await db.exec(`CREATE TRIGGER sealed_${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT, 'External Pilot store migrated; legacy writes are disabled'); END`)
    }
    await db.run("UPDATE federation_task_migrations SET completed = 1 WHERE id = 'canonical-v1'")
  })
}
