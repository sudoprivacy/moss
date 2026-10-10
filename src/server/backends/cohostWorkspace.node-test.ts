import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { createCohostWorkspaceAccess, cohostWorkspacePath } from './cohostWorkspace.js'
import { cohostRepositoryPath, cohostSessionStatePath, readCohostSessionState, writeCohostSessionState } from './cohostSessionState.js'
import { sessionAgentName } from '../agentIdentity.js'
import type { SessionRecord } from '../types.js'

void test('cohost workspace paths reject traversal, absolute and drive paths', () => {
  for (const path of ['../private', 'a/../../private', '/etc/passwd', 'C:\\private', 'a\0b']) {
    assert.throws(() => cohostWorkspacePath('/proc/pid/workspace', path))
  }
  assert.equal(cohostWorkspacePath('/proc/pid/workspace', 'reports/../a.txt'), '/proc/pid/workspace/a.txt')
  for (const agent of ['../owner', 'agent\\other', 'agent\0other']) {
    assert.throws(() => cohostRepositoryPath(agent, 'session'))
  }
})

void test('cohost state preserves the durable ID and refuses corrupt recovery metadata', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'moss-cohost-state-'))
  try {
    assert.equal(await readCohostSessionState(cwd), undefined)
    await writeCohostSessionState(cwd, { sessionId: 'pid-first', durableSessionId: 'history-first' })
    await writeCohostSessionState(cwd, { sessionId: 'pid-resumed', durableSessionId: 'history-first' })
    assert.deepEqual(await readCohostSessionState(cwd), { sessionId: 'pid-resumed', durableSessionId: 'history-first' })
    await writeFile(cohostSessionStatePath(cwd), '{"sessionId":"../other","durableSessionId":"history-first"}')
    await assert.rejects(readCohostSessionState(cwd), /Invalid cohost session state/)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

void test('workspace I/O uses the verified execution descriptor and closes every RPC client', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'moss-cohost-workspace-'))
  const root = '/proc/pid/workspace'
  const session = { sessionId: 'moss-id', cwd, userId: 'owner', assistantName: 'helper' } as SessionRecord
  const descriptor = { session_id: 'pid', owner_id: 'owner', agent_id: sessionAgentName('owner', 'helper'),
    durable_session_id: 'durable', workspace_path: root+'/' }
  const calls: string[] = []
  let closes = 0
  let ready = 0
  let entryName = root+'/result.txt'
  const client = {
    async call(method: string, raw: string, token: string) {
      assert.equal(token, 'user-token');assert.equal(method, 'managed_agent.get_session_v1')
      assert.deepEqual(JSON.parse(raw), { session_id: 'pid' })
      return JSON.stringify(descriptor)
    },
    async stat(path: string) { return { size: 5, entryType: path.endsWith('/link') ? 6 : 0, isDirectory: false } },
    async readdir(path: string) { calls.push('list:'+path);return [{ name: entryName, entryType: 0 }] },
    async read(path: string) { calls.push('read:'+path);return Buffer.from('hello') },
    async mkdir(path: string) { calls.push('mkdir:'+path) },
    async write(path: string, bytes: Buffer) { calls.push('write:'+path+':'+bytes.toString()) },
    close() { closes++ },
  } as unknown as NexusVfsClient
  try {
    await writeCohostSessionState(cwd, { sessionId: 'pid', durableSessionId: 'durable' })
    const access = createCohostWorkspaceAccess(session, { async ensureSessionReady() { ready++;return {} as never } },
      async () => ({ client, authToken: 'user-token' }))
    assert.equal((await access.listTree(2))[0]?.relativePath, 'result.txt')
    assert.equal((await access.readFile('result.txt')).toString(), 'hello')
    await access.writeFile('reports/new.txt', Buffer.from('bytes'))
    assert.deepEqual(calls, ['list:'+root, 'read:'+root+'/result.txt', 'mkdir:'+root+'/reports', 'write:'+root+'/reports/new.txt:bytes'])
    await assert.rejects(access.readFile('link/private.txt'), /symbolic links/)
    await assert.rejects(access.writeFile('../outside', Buffer.from('x')), /escapes workspace/)
    descriptor.owner_id = 'another-owner'
    await assert.rejects(access.readFile('result.txt'), /owner does not match/)
    descriptor.owner_id = 'owner';descriptor.workspace_path = '/proc/other/workspace'
    await assert.rejects(access.readFile('result.txt'), /Invalid cohost workspace descriptor/)
    assert.equal(calls.length, 4, 'refused operations must never read or write file bytes')
    assert.equal(closes, 7);assert.equal(ready, 7)
    descriptor.workspace_path = root
    entryName = '/proc/another/workspace/private.txt'
    await assert.rejects(access.listTree(2), /Invalid cohost workspace entry/)
    entryName = root+'/nested/private.txt'
    await assert.rejects(access.listTree(2), /Invalid cohost workspace entry/)
    assert.equal(closes, 9)
    const repositoryPath = cohostRepositoryPath(descriptor.agent_id, session.sessionId)
    await writeCohostSessionState(cwd, { sessionId: 'pid', durableSessionId: 'durable', repositoryPath })
    entryName = repositoryPath+'/persisted.txt'
    assert.equal((await access.listTree(2))[0]?.relativePath, 'persisted.txt')
    assert.equal((await access.readFile('persisted.txt')).toString(), 'hello')
    await access.writeFile('uploaded.txt', Buffer.from('durable'))
    assert.deepEqual(calls.slice(-4), ['list:'+repositoryPath, 'read:'+repositoryPath+'/persisted.txt',
      'mkdir:'+repositoryPath, 'write:'+repositoryPath+'/uploaded.txt:durable'])
    await writeCohostSessionState(cwd, { sessionId: 'pid', durableSessionId: 'durable',
      repositoryPath: cohostRepositoryPath(descriptor.agent_id, 'different-session') })
    const callCount = calls.length
    await assert.rejects(access.readFile('persisted.txt'), /repository does not belong/)
    assert.equal(calls.length, callCount)
    assert.equal(closes, 13)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
