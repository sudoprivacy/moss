// Runs under Node (the store uses node:sqlite, which Bun lacks): `tsx --test`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DirectConnectStore } from '../db.js'

describe('implicit task compatibility metadata', () => {
  it('assigns a stable task id to each newly-created session', async () => {
    const store = new DirectConnectStore(':memory:')
    const created = await store.createSession({
      sessionId: 'session-1',
      transcriptSessionId: 'session-1',
      transcriptPath: '/tmp/session-1.jsonl',
      userId: 'user-1',
      orgId: 'org-1',
      role: 'user',
      scopes: [],
      cwd: '/tmp',
      runtime: { type: 'host' } as never,
      status: 'creating',
      desiredState: 'active',
    })

    assert.notEqual(created.taskId, created.sessionId)
    assert.equal(created.clientMetadata?.implicit_task_id, created.taskId)
    assert.equal(created.clientMetadata?.task_contract, 'implicit-v1')
    assert.equal(created.clientMetadata?.requested_execution, 'cloud')

    const reloaded = await store.getSession(created.sessionId)
    assert.equal(reloaded?.taskId, created.taskId)
    assert.equal((await store.listSessions({ orgId: 'org-1' }))[0]?.taskId, created.taskId)
  })

  it('uses the session id as a stable fallback for pre-migration rows', async () => {
    const store = new DirectConnectStore(':memory:')
    await store.createSession({
      sessionId: 'legacy-session',
      transcriptSessionId: 'legacy-session',
      transcriptPath: '/tmp/legacy-session.jsonl',
      userId: 'user-1',
      orgId: 'org-1',
      role: 'user',
      scopes: [],
      cwd: '/tmp',
      runtime: { type: 'host' } as never,
      status: 'active',
      desiredState: 'active',
    })
    store.requireSqliteDb().prepare('UPDATE sessions SET client_metadata = NULL WHERE session_id = ?').run(
      'legacy-session',
    )

    assert.equal((await store.getSession('legacy-session'))?.taskId, 'legacy-session')
  })
})
