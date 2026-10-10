import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { PrivateAgentArchives, ARCHIVE_CHUNK_BYTES } from './privateAgentArchives.js'

const owner = { userId: 'alice', orgId: 'org-a' }
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')

void test('private archives isolate users and organizations, verify bytes, and tolerate retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'private-archives-'))
  try {
    const store = new PrivateAgentArchives(root)
    const bytes = Buffer.alloc(ARCHIVE_CHUNK_BYTES + 11, 42)
    const item = await store.create(owner, { displayName: 'Travel', engines: ['codex'], size: bytes.length, sha256: digest(bytes), sessionCount: 20 })
    await assert.rejects(store.complete(owner, item.agentName), /incomplete/)
    for (const other of [{ ...owner, userId: 'bob' }, { ...owner, orgId: 'org-b' }]) {
      assert.deepEqual(await store.list(other), [])
      await assert.rejects(store.get(other, item.agentName), /not found/)
      await assert.rejects(store.put(other, item.agentName, 0, bytes.subarray(0, ARCHIVE_CHUNK_BYTES), digest(bytes)), /not found/)
    }
    const first = bytes.subarray(0, ARCHIVE_CHUNK_BYTES)
    await assert.rejects(store.put(owner, item.agentName, 0, first, '0'.repeat(64)), /checksum/)
    await Promise.all([store.put(owner, item.agentName, 0, first, digest(first)), store.put(owner, item.agentName, 0, first, digest(first))])
    const changed = Buffer.alloc(first.length, 12)
    await assert.rejects(store.put(owner, item.agentName, 0, changed, digest(changed)), /different|Conflicting/)
    const last = bytes.subarray(ARCHIVE_CHUNK_BYTES)
    await store.put(owner, item.agentName, 1, last, digest(last))
    assert.equal((await store.complete(owner, item.agentName)).status, 'ready')
    assert.equal((await store.complete(owner, item.agentName)).canSpawn, false)
    assert.equal((await store.chunk(owner, item.agentName, 1)).size, 11)
    await assert.rejects(store.chunk(owner, item.agentName, 2), /index/)
    await assert.rejects(store.get(owner, '../org-b'), /not found/)
    await assert.rejects(store.create(owner, { ...item, ownerId: 'bob' }), /Invalid/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

void test('a complete set of chunks cannot commit with the wrong archive checksum', async () => {
  const root = await mkdtemp(join(tmpdir(), 'private-archives-'))
  try {
    const store = new PrivateAgentArchives(root)
    const bytes = Buffer.from('content')
    const item = await store.create(owner, { displayName: 'Bad hash', engines: ['claude-code'], size: bytes.length, sha256: '0'.repeat(64), sessionCount: 1 })
    await store.put(owner, item.agentName, 0, bytes, digest(bytes))
    await assert.rejects(store.complete(owner, item.agentName), /checksum/)
    await assert.rejects(store.chunk(owner, item.agentName, 0), /incomplete/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
