import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Pool } from 'pg'
import { AgentRuntimeHomes } from '@sudo/user-runtime'
import { DirectConnectStore, forPostgresDirectConnectStore } from '../db.js'
import { PgDriver, type PgPoolLike } from '../db/driver.js'
import { applyPgSchema } from '../db/pg_schema.js'

async function exerciseHomes(first: DirectConnectStore, peer: DirectConnectStore): Promise<void> {
  for (const agent of ['old-a', 'old-b', 'old-c']) {
    const sessionId = `session-${agent}`
    await first.createSession({ sessionId, transcriptSessionId: sessionId, transcriptPath: `${sessionId}.jsonl`,
      userId: 'owner', orgId: 'org', role: 'member', scopes: [], cwd: '/workspace',
      runtime: { type: 'cohost', engine: 'scode' }, status: 'active', desiredState: 'active', assistantName: agent })
    const attempt = await first.createAttempt({ sessionId, generation: 1, backendType: 'cohost',
      resumeTranscriptSessionId: sessionId, serverInstanceId: 'host-a' })
    await first.setCurrentAttempt(sessionId, attempt.attemptId)
    assert.equal(await first.cohostSessions.bind(sessionId, attempt.attemptId, { ownerId: 'owner', agentId: agent,
      durableSessionId: `native-${agent}`, repositoryPath: `/agents/${agent}/workspaces/${sessionId}` }, 'host-a'), true)
  }
  const left = new AgentRuntimeHomes(first.cohostAgentHomes, 2)
  const right = new AgentRuntimeHomes(peer.cohostAgentHomes, 2)
  const claims = await Promise.allSettled([left.resolve('owner', 'new-shared'), right.resolve('owner', 'new-shared')])
  assert(claims.every(result => result.status === 'fulfilled'), JSON.stringify(claims, (_, value) =>
    value instanceof Error ? { message: value.message, stack: value.stack } : value))
  const shared = await left.resolve('owner', 'new-shared')
  assert.notEqual(shared.allocationId, 'primary', 'import old native homes before applying new capacity')
  for (const agent of ['old-a', 'old-b', 'old-c']) {
    assert.equal((await right.resolve('owner', agent)).allocationId, 'primary')
  }
  const packed = await Promise.allSettled(Array.from({ length: 10 }, (_, index) =>
    (index % 2 ? left : right).resolve('owner', `packed-${index}`)))
  assert(packed.every(result => result.status === 'fulfilled'))
  const counts = new Map<string, number>()
  for (const home of await first.cohostAgentHomes.list('owner')) {
    counts.set(home.allocationId, (counts.get(home.allocationId) ?? 0) + 1)
  }
  for (const [allocation, count] of counts) {
    if (allocation !== 'primary') assert(count <= 2, `concurrent claims overfilled ${allocation}: ${count}`)
  }
  assert.equal((await right.resolve('another-owner', 'new-shared')).allocationId, 'primary')
  assert.equal(await right.find('another-owner', 'old-a'), undefined)
  const resized = new AgentRuntimeHomes(peer.cohostAgentHomes, 1)
  assert.deepEqual(await resized.resolve('owner', 'new-shared', 'primary'), shared)
  let didChoose = false
  assert.deepEqual(await first.cohostAgentHomes.claim('owner', 'new-shared', () => {
    didChoose = true; throw new Error('existing home must bypass allocation')
  }), shared)
  assert.equal(didChoose, false)
  await assert.rejects(first.cohostAgentHomes.claim('owner', 'failed-claim', () => { throw new Error('chooser-failed') }), /chooser-failed/)
  assert.equal(await peer.cohostAgentHomes.find('owner', 'failed-claim'), undefined)
  assert.deepEqual(await new AgentRuntimeHomes(first.cohostAgentHomes, 20).resolve('owner', 'new-shared'), shared)
}

void test('SQLite Agent homes import native histories and serialize concurrent claims across controller handles', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-agent-home-'))
  const path = join(root, 'shared.db')
  const first = new DirectConnectStore(path), peer = new DirectConnectStore(path)
  t.after(async () => { await first.close(); await peer.close(); await rm(root, { recursive: true, force: true }) })
  await exerciseHomes(first, peer)
  assert.equal((await first.driver.get('PRAGMA busy_timeout'))?.timeout, 5000)
  assert.equal((await peer.driver.get('PRAGMA busy_timeout'))?.timeout, 5000)
  const reopened = new DirectConnectStore(path)
  try { assert.equal((await reopened.cohostAgentHomes.find('owner', 'old-a'))?.allocationId, 'primary') }
  finally { await reopened.close() }
})

for (const isolation of ['read committed', 'repeatable read', 'serializable']) {
void test(`PostgreSQL Agent homes serialize controller claims with ${isolation} pool defaults`,
  { skip: !process.env.MOSS_PG_TEST_URL }, async t => {
    const schema = `agent_home_${randomUUID().replaceAll('-', '')}`
    const config = { connectionString: process.env.MOSS_PG_TEST_URL }
    const admin = new Pool(config)
    await admin.query(`CREATE SCHEMA ${schema}`)
    const pool = async () => {
      const connection = new Pool({ ...config, options: `-c search_path=${schema}`, max: 1 })
      await connection.query(`SET default_transaction_isolation = '${isolation}'`)
      return connection as unknown as PgPoolLike
    }
    const firstDriver = new PgDriver(await pool())
    const peerDriver = new PgDriver(await pool())
    t.after(async () => {
      await firstDriver.close(); await peerDriver.close()
      await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
    })
    await applyPgSchema(firstDriver)
    await exerciseHomes(forPostgresDirectConnectStore(firstDriver), forPostgresDirectConnectStore(peerDriver))
    assert.equal((await firstDriver.get('SHOW default_transaction_isolation'))?.default_transaction_isolation, isolation)
    assert.equal((await peerDriver.get('SHOW default_transaction_isolation'))?.default_transaction_isolation, isolation)
  })
}
