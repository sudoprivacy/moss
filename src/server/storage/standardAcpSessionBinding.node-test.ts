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

async function exercise(first: DirectConnectStore, peer: DirectConnectStore) {
  const profile = { ownerId: 'alice', orgId: 'org', profileId: 'approved-text-v1', agentId: 'alice-worker',
    authorityId: 'trusted-runtime-1', workspacePath: '/owner/workspace' }
  const make = async (id: string) => {
    await first.createSession({ sessionId: id, transcriptSessionId: id, transcriptPath: `/ui/${id}.jsonl`, userId: 'alice', orgId: 'org',
      role: 'member', scopes: [], cwd: '/host/workspace', runtime: { type: 'host', engine: 'standard_acp', standardAcpProfileId: profile.profileId }, status: 'active', desiredState: 'active' })
    const attempt = await first.createAttempt({ sessionId: id, generation: 1, backendType: 'host', resumeTranscriptSessionId: id, serverInstanceId: 'server-a' })
    await first.setCurrentAttempt(id, attempt.attemptId)
    return attempt
  }
  const attempt = await make('session')
  assert.equal((await peer.getSession('session'))?.runtime.engine, 'standard_acp')
  assert.equal((await peer.getSession('session'))?.runtime.standardAcpProfileId, profile.profileId)
  for (const changes of [{ ownerId: 'bob' }, { orgId: 'foreign' }, { profileId: 'unapproved' }]) {
    await assert.rejects(first.standardAcpSessions.claim('session', attempt.attemptId, { ...profile, ...changes }, 'server-a'))
  }
  await assert.rejects(first.standardAcpSessions.claim('session', attempt.attemptId, profile, 'stale-server'))
  const claim = await first.standardAcpSessions.claim('session', attempt.attemptId, profile, 'server-a')
  assert.equal(claim.nativeSessionId, undefined)
  await assert.rejects(peer.standardAcpSessions.claim('session', attempt.attemptId, profile, 'server-a'), /unknown/)
  assert.equal(await first.standardAcpSessions.bind(claim, 'actual-producer-id', 'server-a'), true)
  assert.equal(await first.standardAcpSessions.bind(claim, 'replacement-history', 'server-a'), false)
  await first.standardAcpSessions.recordInput({ ...claim, nativeSessionId: 'actual-producer-id' }, 'input-1', 'Literal task', 'server-a')
  await assert.rejects(peer.standardAcpSessions.recordInput(claim, 'input-1', 'Another task', 'server-a'), /already recorded/)
  assert.equal(await peer.standardAcpSessions.read('session', 'bob', 'org'), undefined)
  assert.equal(await peer.standardAcpSessions.read('session', 'alice', 'foreign'), undefined)
  assert.equal((await peer.standardAcpSessions.read('session', 'alice', 'org'))?.nativeSessionId, 'actual-producer-id')

  const next = await peer.createAttempt({ sessionId: 'session', generation: 2, backendType: 'host', resumeTranscriptSessionId: 'session', serverInstanceId: 'server-b' })
  await peer.setCurrentAttempt('session', next.attemptId)
  assert.equal(await first.standardAcpSessions.bind(claim, 'actual-producer-id', 'server-a'), false)
  await assert.rejects(peer.standardAcpSessions.claim('session', next.attemptId, profile, 'server-b'), /cleanup/)
  assert.equal(await first.standardAcpSessions.release(claim), true)
  for (const changes of [{ agentId: 'foreign-agent' }, { workspacePath: '/different/history' }, { authorityId: 'another-runtime' }]) {
    await assert.rejects(peer.standardAcpSessions.claim('session', next.attemptId, { ...profile, ...changes }, 'server-b'), /cannot be replaced/)
  }
  const restored = await peer.standardAcpSessions.claim('session', next.attemptId, profile, 'server-b')
  assert.equal(restored.nativeSessionId, 'actual-producer-id')
  assert.equal(await first.standardAcpSessions.release(claim), false, 'stale cleanup cannot release a newer writer')
  await assert.rejects(peer.standardAcpSessions.recordInput(restored, 'input-1', 'Literal task', 'server-b'), /already recorded/)
  await peer.standardAcpSessions.release(restored)

  const uncertain = await make('uncertain')
  const unknown = await first.standardAcpSessions.claim('uncertain', uncertain.attemptId, profile, 'server-a')
  await first.standardAcpSessions.release(unknown)
  await assert.rejects(peer.standardAcpSessions.claim('uncertain', uncertain.attemptId, profile, 'server-a'), /unknown/,
    'confirmed process cleanup does not prove which native history a lost open created')

  const raced = await make('raced')
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? first : peer).standardAcpSessions.claim('raced', raced.attemptId, profile, 'server-a')))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  await first.driver.run("UPDATE sessions SET execution_engine='unregistered' WHERE session_id='raced'")
  await assert.rejects(peer.getSession('raced'), /Unknown native execution engine/)
}

void test('SQLite canonical ACP bindings fence ownership, unknown opens, input replay and physical writer cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moss-acp-binding-'))
  const first = new DirectConnectStore(join(directory, 'state.db')), peer = new DirectConnectStore(join(directory, 'state.db'))
  try { await exercise(first, peer) } finally { await first.close(); await peer.close(); await rm(directory, { recursive: true, force: true }) }
})

void test('PostgreSQL ACP bindings share canonical Session/Attempt fences across pools', { skip: !process.env.MOSS_PG_TEST_URL }, async () => {
  const url = process.env.MOSS_PG_TEST_URL!, schema = `acp_binding_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const second = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const driver = new PgDriver(pool as unknown as PgPoolLike)
  try {
    await applyPgSchema(driver)
    await exercise(forPostgresDirectConnectStore(driver), forPostgresDirectConnectStore(new PgDriver(second as unknown as PgPoolLike)))
  } finally { await pool.end(); await second.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() }
})
