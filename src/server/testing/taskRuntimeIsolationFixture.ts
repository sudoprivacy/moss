import assert from 'node:assert/strict'
import type { DbDriver } from '../db/driver.js'
import { DirectConnectStore } from '../db.js'
import { ExternalTaskStore, type Binding } from '../externalProviders/store.js'
import { maintainRetention } from '../externalProviders/retention.js'
import { ExternalExecutionOwnership } from '../agentFederation/executionOwnership.js'

/** Same storage/isolation assertions run against SQLite and actual PostgreSQL. */
export async function verifyTaskRuntimeIsolation(db: DbDriver): Promise<void> {
  const store = new ExternalTaskStore(db)
  await store.ready
  const actor = { orgId: 'isolation-org', userId: 'isolation-user' }, now = Date.now()
  const binding = { id: 'external-agent', source_digest: 'sha256:' + '1'.repeat(64), revision: 1 } as Binding
  const external = await store.create(actor, { agent_id: binding.id, query: 'synthetic', idempotency_key: 'external-request' }, binding, 60_000)
  for (const state of ['accepted', 'running', 'unknown', 'succeeded']) {
    const id = `hosted-${state}`
    await db.run(`INSERT INTO sessions(session_id, transcript_session_id, org_id, user_id, role, scopes_json, cwd,
      runtime_type, status, desired_state, current_attempt_id, transcript_path, title, created_at, last_active_at)
      VALUES (?, ?, ?, ?, 'user', '[]', '', 'hosted', 'active', 'active', ?, '', 'Keep hosted title', ?, ?)`,
    [id, id, actor.orgId, actor.userId, `${id}-attempt`, now, now])
    await db.run(`INSERT INTO session_attempts(attempt_id, session_id, generation, backend_type, runtime_state,
      server_instance_id, resume_transcript_session_id, started_at) VALUES (?, ?, 1, 'hosted', 'running', 'dead-controller', ?, ?)`,
    [`${id}-attempt`, id, id, now])
    await db.run(`INSERT INTO tasks(id, org_id, user_id, session_id, idempotency_key, request_hash, status,
      deadline_at, sequence, document, attempt_id) VALUES (?, ?, ?, ?, ?, 'hosted-hash', ?, ?, 2, ?, ?)`,
    [id, actor.orgId, actor.userId, id, `${id}-request`, state, now - 100 * 86400_000,
      JSON.stringify({ kind: 'HostedTask', id, sensitive_fixture: 'Do not project, dispatch or retire' }), `${id}-attempt`])
    await db.run(`INSERT INTO session_events(event_id, session_id, attempt_id, event_type, payload_json, created_at, task_id, sequence)
      VALUES (?, ?, ?, 'task.status', ?, ?, ?, 1)`, [`${id}-event`, id, `${id}-attempt`, JSON.stringify({ kind: 'HostedEvent', state }), now, id])
  }
  const snapshots = async () => ({
    tasks: await db.all("SELECT * FROM tasks WHERE id LIKE 'hosted-%' ORDER BY id"),
    sessions: await db.all("SELECT * FROM sessions WHERE runtime_type = 'hosted' ORDER BY session_id"),
    attempts: await db.all("SELECT * FROM session_attempts WHERE backend_type = 'hosted' ORDER BY attempt_id"),
    events: await db.all("SELECT * FROM session_events WHERE task_id LIKE 'hosted-%' ORDER BY event_id"),
  })
  const before = await snapshots(), ownership = new ExternalExecutionOwnership(store)
  try {
    for (const id of ['hosted-accepted', 'hosted-running', 'hosted-unknown', 'hosted-succeeded']) {
      await assert.rejects(store.task(actor, id), { code: 'TASK_NOT_FOUND' })
      await assert.rejects(store.events(actor, id, 0), { code: 'TASK_NOT_FOUND' })
      await assert.rejects(store.history(actor, id), { code: 'SESSION_NOT_FOUND' })
      await assert.rejects(store.taskRecord(actor, id), { code: 'TASK_NOT_FOUND' })
      await assert.rejects(store.reconcileUnknown(actor, id, 'Must not apply'), { code: 'TASK_NOT_FOUND' })
      assert.equal(await store.mutate(id, () => { assert.fail('Foreign runtime reached external mutator') }), null)
      assert.equal(await ownership.claim(id), null)
      // The idempotency namespace is GLOBAL across runtimes. Never turn a conflict into a new dispatch.
      await assert.rejects(store.existingRequest(actor, `${id}-request`, 'different-hash'), { code: 'IDEMPOTENCY_CONFLICT' })
      await assert.rejects(store.existingRequest(actor, `${id}-request`, 'hosted-hash'), { code: 'TASK_RUNTIME_MISMATCH' })
      await assert.rejects(store.create(actor, { agent_id: binding.id, query: 'synthetic', idempotency_key: `${id}-request` }, binding, 60_000), { code: 'IDEMPOTENCY_CONFLICT' })
    }
    assert.deepEqual(await store.unresolved(actor.orgId), [])
    assert.deepEqual(await ownership.candidates(), [external.id])
    assert.deepEqual((await store.sessions(actor)).map(s => s.id), [external.session_id])
    assert.equal((await store.task(actor, external.id)).api_version, external.api_version)
    await store.expire(now + 120_000)
    assert.equal((await store.task(actor, external.id)).status, 'rejected')
    await maintainRetention(store, now + 40 * 86400_000)
    assert.equal((await db.get('SELECT document FROM tasks WHERE id = ?', [external.id]))?.document, '{"_retired":true}')
    assert.deepEqual(await snapshots(), before)
    assert.equal(Number((await db.get("SELECT COUNT(*) AS count FROM external_pilot_retention WHERE task_id LIKE 'hosted-%'"))?.count), 0)
    const canonical = new DirectConnectStore('driver-backed-test', db)
    assert.equal((await canonical.getSession('hosted-running'))?.runtime.type, 'hosted')
    assert.equal((await canonical.getSession('hosted-running'))?.runtime.engine, 'hosted_artifact')
    assert.deepEqual(await canonical.listSessionsToRecover(), [])
    assert.deepEqual(await canonical.listSessions({ orgId: actor.orgId }), [])
    assert.deepEqual(await canonical.listAttemptsByRuntimeState(['starting', 'running', 'detached']), [])
    assert.deepEqual(await canonical.listOrphanedActiveSessions('other-controller', 1), [])
    // Additive view initialization on an already canonical database keeps task facts unchanged.
    await db.exec('DROP VIEW external_tasks')
    await new ExternalTaskStore(db).ready
    assert.deepEqual(await snapshots(), before)
    assert.equal(Number((await db.get('SELECT COUNT(*) AS count FROM external_tasks'))?.count), 1)
  } finally { await ownership.stop() }
}
