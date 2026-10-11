import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Pool } from 'pg'
import { DirectConnectStore, forPostgresDirectConnectStore } from '../db.js'
import { PgDriver, type PgPoolLike } from '../db/driver.js'
import { applyPgSchema } from '../db/pg_schema.js'
import { sessionAgentName } from '../agentIdentity.js'

async function exerciseBindings(first: DirectConnectStore, peer: DirectConnectStore): Promise<void> {
  const binding = { ownerId: 'owner', agentId: sessionAgentName('owner', 'helper'), durableSessionId: 'native-history', repositoryPath: '/agents/owner/workspaces/moss-session' }
  const createSession = (sessionId: string, type: 'host' | 'cohost' = 'cohost', userId = 'owner', assistantName = 'helper') => first.createSession({
    sessionId, transcriptSessionId: sessionId, transcriptPath: `${sessionId}/ui-projection.jsonl`,
    userId, orgId: 'org', role: 'member', scopes: [], cwd: '/host-local/workspace',
    runtime: { type, engine: 'scode' }, status: 'active', desiredState: 'active', assistantName,
  })
  await createSession('moss-session')
  const attempt = await first.createAttempt({ sessionId: 'moss-session', generation: 1, backendType: 'cohost',
    resumeTranscriptSessionId: 'moss-session', serverInstanceId: 'host-a' })
  await first.setCurrentAttempt('moss-session', attempt.attemptId)
  assert.equal(await first.cohostSessions.bind('moss-session', attempt.attemptId, binding, 'host-a'), true)
  assert.deepEqual(await peer.cohostSessions.get('moss-session'), binding)
  assert.equal(await peer.cohostSessions.bind('moss-session', attempt.attemptId, binding, 'host-a'), true)
  assert.equal(await first.cohostSessions.bind('moss-session', attempt.attemptId,
    { ...binding, durableSessionId: 'replacement-history' }, 'host-a'), false)
  assert.equal(await first.cohostSessions.bind('moss-session', attempt.attemptId,
    { ...binding, repositoryPath: '/another/repository' }, 'host-a'), false)
  assert.equal(await first.cohostSessions.bind('moss-session', attempt.attemptId,
    { ...binding, agentId: 'different-agent' }, 'host-a'), false)
  assert.equal(await first.cohostSessions.bind('moss-session', attempt.attemptId,
    { ...binding, ownerId: 'different-owner' }, 'host-a'), false)
  const session = await peer.getSession('moss-session')
  assert.equal(session?.transcriptSessionId, 'moss-session')
  assert.equal(session?.transcriptPath, 'moss-session/ui-projection.jsonl')

  await peer.driver.run('UPDATE session_attempts SET server_instance_id = ? WHERE attempt_id = ?', ['host-b', attempt.attemptId])
  assert.equal(await first.cohostSessions.bind('moss-session', attempt.attemptId, binding, 'host-a'), false)
  assert.equal(await peer.cohostSessions.bind('moss-session', attempt.attemptId, binding, 'host-b'), true)
  const oldOwner = { attemptId: attempt.attemptId, ownerInstanceId: 'host-a' }
  await first.setSessionLifecycle('moss-session', 'detached', 'active', true, oldOwner)
  await first.markSessionEnded('moss-session', 'failed', 'active', oldOwner)
  assert.equal((await peer.getSession('moss-session'))?.status, 'active', 'a fenced server cannot update a session even before its attempt ID changes')
  const currentOwner = { attemptId: attempt.attemptId, ownerInstanceId: 'host-b' }
  await peer.setSessionLifecycle('moss-session', 'detached', 'active', true, currentOwner)
  assert.equal((await first.getSession('moss-session'))?.status, 'detached')
  await peer.setSessionLifecycle('moss-session', 'active', 'active', true, currentOwner)
  const next = await peer.createAttempt({ sessionId: 'moss-session', generation: 2, backendType: 'cohost',
    resumeTranscriptSessionId: 'moss-session', serverInstanceId: 'host-b' })
  await peer.setCurrentAttempt('moss-session', next.attemptId)
  assert.equal(await first.cohostSessions.bind('moss-session', attempt.attemptId, binding, 'host-b'), false)
  assert.equal(await peer.cohostSessions.bind('moss-session', next.attemptId, binding, 'host-b'), true)
  assert.deepEqual(await first.cohostSessions.get('moss-session'), binding)
  await first.markSessionEnded('moss-session', 'failed', 'active', { attemptId: attempt.attemptId, ownerInstanceId: 'host-b' })
  assert.equal((await peer.getSession('moss-session'))?.status, 'active', 'an old attempt cannot end its replacement session')

  await createSession('another-session')
  const other = await first.createAttempt({ sessionId: 'another-session', generation: 1, backendType: 'cohost',
    resumeTranscriptSessionId: 'another-session', serverInstanceId: 'host-a' })
  await first.setCurrentAttempt('another-session', other.attemptId)
  await assert.rejects(first.cohostSessions.bind('another-session', other.attemptId, binding, 'host-a'))
  assert.equal(await peer.cohostSessions.get('another-session'), undefined)

  for (const [sessionId, userId, assistant] of [
    ['same-owner-other-agent', 'owner', 'another-helper'], ['other-owner', 'other-owner', 'helper'],
  ]) {
    await createSession(sessionId!, 'cohost', userId, assistant)
    const separate = await first.createAttempt({ sessionId: sessionId!, generation: 1, backendType: 'cohost',
      resumeTranscriptSessionId: sessionId!, serverInstanceId: 'host-a' })
    await first.setCurrentAttempt(sessionId!, separate.attemptId)
    const distinct = { ...binding, ownerId: userId!, agentId: sessionAgentName(userId!, assistant),
      repositoryPath: `/agents/${sessionAgentName(userId!, assistant)}/workspaces/${sessionId}` }
    if (userId === binding.ownerId) {
      await assert.rejects(first.cohostSessions.bind(sessionId!, separate.attemptId, distinct, 'host-a'))
      assert.equal(await peer.cohostSessions.get(sessionId!), undefined,
        'Agent links share their user runtime session store and cannot alias one primary transcript')
    } else {
      assert.equal(await first.cohostSessions.bind(sessionId!, separate.attemptId, distinct, 'host-a'), true,
        'different user runtime stores can generate the same native ID')
      assert.deepEqual(await peer.cohostSessions.get(sessionId!), distinct)
    }
  }

  await createSession('raced-session')
  const raced = await first.createAttempt({ sessionId: 'raced-session', generation: 1, backendType: 'cohost',
    resumeTranscriptSessionId: 'raced-session', serverInstanceId: 'host-a' })
  await first.setCurrentAttempt('raced-session', raced.attemptId)
  const attempts = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
    const candidate = { ...binding, durableSessionId: index % 2 ? 'raced-native-a' : 'raced-native-b',
      repositoryPath: '/agents/owner/workspaces/raced-session' }
    const store = index % 2 ? first : peer
    return { candidate, isBound: await store.cohostSessions.bind('raced-session', raced.attemptId, candidate, 'host-a') }
  }))
  const winner = await peer.cohostSessions.get('raced-session')
  assert.ok(attempts.some(result => result.isBound))
  assert.ok(attempts.some(result => !result.isBound))
  for (const result of attempts) assert.equal(result.isBound, result.candidate.durableSessionId === winner?.durableSessionId)

  await peer.deleteSession('moss-session')
  assert.equal(await peer.cohostSessions.bind('moss-session', next.attemptId, binding, 'host-b'), false)
  assert.deepEqual(await peer.cohostSessions.get('moss-session'), binding, 'deletion cannot reset the retained native history')
}

void test('SQLite bindings survive host-local workspace loss and refuse stale owner or history replacement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-cohost-binding-'))
  const path = join(root, 'shared.db')
  const first = new DirectConnectStore(path)
  const peer = new DirectConnectStore(path)
  t.after(async () => { await first.close(); await peer.close(); await rm(root, { recursive: true, force: true }) })
  await exerciseBindings(first, peer)
  const reopened = new DirectConnectStore(path)
  try { assert.equal((await reopened.cohostSessions.get('moss-session'))?.durableSessionId, 'native-history') }
  finally { await reopened.close() }
})

void test('PostgreSQL bindings are shared across independent Moss connection pools and fence stale writers',
  { skip: !process.env.MOSS_PG_TEST_URL }, async t => {
    const schema = `cohost_binding_${randomUUID().replaceAll('-', '')}`
    const config = { connectionString: process.env.MOSS_PG_TEST_URL }
    const admin = new Pool(config)
    await admin.query(`CREATE SCHEMA ${schema}`)
    const firstDriver = new PgDriver(new Pool({ ...config, options: `-c search_path=${schema}` }) as unknown as PgPoolLike)
    const peerDriver = new PgDriver(new Pool({ ...config, options: `-c search_path=${schema}` }) as unknown as PgPoolLike)
    t.after(async () => {
      await firstDriver.close(); await peerDriver.close()
      await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
    })
    await applyPgSchema(firstDriver)
    await exerciseBindings(forPostgresDirectConnectStore(firstDriver), forPostgresDirectConnectStore(peerDriver))
  })
