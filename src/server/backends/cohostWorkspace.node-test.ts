import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import type { InternalSessionChannel } from '../internalSessionChannel.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { createCohostWorkspaceAccess, cohostWorkspacePath, writeCohostWorkspaceFile, writeCohostWorkspaceFiles } from './cohostWorkspace.js'
import { cohostRepositoryPath, cohostSessionStatePath, readCohostSessionState, removeCohostSessionState } from './cohostSessionState.js'
import { sessionAgentName } from '../agentIdentity.js'
import type { SessionRecord } from '../types.js'
import { syncCohostSkills } from './cohostSkills.js'

void test('skill reconciliation removes disabled skills and obsolete files while retaining user work and executable intent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-cohost-skill-sync-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pathFor = (path: string, token: string) => {
    assert.equal(token, 'owner-token')
    assert(path.startsWith('/project/'))
    return join(root, path.slice('/project/'.length))
  }
  const client = {
    async stat(path: string, token: string) {
      const info = await lstat(pathFor(path, token)).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      return info ? { isDirectory: info.isDirectory(), entryType: info.isSymbolicLink() ? 6 : 0 } : null
    },
    async readdir(path: string, token: string) { return (await readdir(pathFor(path, token))).map(name => ({ name: `${path}/${name}` })) },
    async delete(path: string, token: string, options: { recursive?: boolean }) {
      assert.equal(options.recursive, true)
      await rm(pathFor(path, token), { recursive: true, force: true })
    },
    async mkdir(path: string, token: string) { await mkdir(pathFor(path, token), { recursive: true }) },
    async write(path: string, content: Buffer, token: string) { await writeFile(pathFor(path, token), content) },
    async chmod(path: string, mode: number, token: string) { await chmod(pathFor(path, token), mode) },
  } as unknown as NexusVfsClient
  const skills = join(root, '.nexus/sudocode/skills')
  await mkdir(join(skills, 'disabled'), { recursive: true })
  await mkdir(join(skills, 'current'), { recursive: true })
  await writeFile(join(skills, 'disabled/SKILL.md'), 'disabled instructions')
  await writeFile(join(skills, 'current/obsolete.sh'), 'obsolete asset')
  await writeFile(join(root, 'user-work.txt'), 'retained user bytes')
  await assert.rejects(syncCohostSkills(client, 'owner-token', '/project', [{
    path: '.nexus/sudocode/skills/../../user-work.txt', content: Buffer.from('unsafe'), mode: 0o600,
  }]), /escapes workspace/)
  assert.equal(await readFile(join(skills, 'disabled/SKILL.md'), 'utf8'), 'disabled instructions', 'validate all input before clearing the prior catalog')
  await syncCohostSkills(client, 'owner-token', '/project', [
    { path: '.nexus/sudocode/skills/current/SKILL.md', content: Buffer.from('current instructions'), mode: 0o600 },
    { path: '.nexus/sudocode/skills/current/run.sh', content: Buffer.from('#!/bin/sh\nprintf ready\n'), mode: 0o700 },
  ])
  assert.deepEqual(await readdir(skills), ['current'])
  assert.deepEqual((await readdir(join(skills, 'current'))).sort(), ['SKILL.md', 'run.sh'])
  assert.equal(await readFile(join(root, 'user-work.txt'), 'utf8'), 'retained user bytes')
  if (process.platform !== 'win32') assert.equal((await lstat(join(skills, 'current/run.sh'))).mode & 0o7777, 0o700)
  await syncCohostSkills(client, 'owner-token', '/project', [])
  await assert.rejects(lstat(skills), { code: 'ENOENT' })
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep.txt'), 'retained linked bytes')
  await symlink(outside, skills, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(syncCohostSkills(client, 'owner-token', '/project', []), /symbolic links/)
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'retained linked bytes')
})

void test('cohost workspace paths reject traversal, absolute and drive paths', () => {
  for (const path of ['../private', 'a/../../private', '/etc/passwd', 'C:\\private', 'a\0b']) {
    assert.throws(() => cohostWorkspacePath('/proc/pid/workspace', path))
  }
  assert.equal(cohostWorkspacePath('/proc/pid/workspace', 'reports/../a.txt'), '/proc/pid/workspace/a.txt')
  for (const agent of ['../owner', 'agent\\other', 'agent\0other']) {
    assert.throws(() => cohostRepositoryPath(agent, 'session'))
  }
})

void test('skill synchronization bounds concurrency and drains in-flight writes before reporting failure', async () => {
  let releaseBatch!: () => void
  const batch = new Promise<void>(resolve => { releaseBatch = resolve })
  let releaseWrites!: () => void
  const writes = new Promise<void>(resolve => { releaseWrites = resolve })
  let announceBatch!: () => void
  const startedBatch = new Promise<void>(resolve => { announceBatch = resolve })
  let started = 0
  let active = 0
  let maximum = 0
  let isSettled = false
  const failure = new Error('skill storage unavailable')
  const client = {
    async stat() { return { isDirectory: true, entryType: 1 } },
    async delete() {},
    async write() {
      const index = started++
      maximum = Math.max(maximum, ++active)
      if (started === 8) { releaseBatch(); announceBatch() }
      try {
        await batch
        if (index === 0) throw failure
        await writes
      } finally { active-- }
    },
    async chmod() {},
  } as unknown as NexusVfsClient
  const assets = Array.from({ length: 12 }, (_, index) => ({
    path: `.nexus/sudocode/skills/current/file-${index}`, content: Buffer.from('skill'), mode: 0o600,
  }))
  const result = syncCohostSkills(client, 'owner', '/project', assets)
  void result.then(() => { isSettled = true }, () => { isSettled = true })
  try {
    await startedBatch
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(isSettled, false, 'startup must wait until all outstanding writes finish')
    assert.equal(started, 8, 'the first failure must prevent queued writes')
  } finally { releaseWrites() }
  await assert.rejects(result, error => error === failure)
  assert.equal(active, 0)
  assert.equal(maximum, 8)
  assert.equal(started, 8)
})

void test('workspace writes inspect links without issuing mkdir for an existing parent', async () => {
  const calls: string[] = []
  const client = {
    async stat(path: string) {
      calls.push(`stat:${path}`)
      return path.endsWith('/run.sh') ? null : { isDirectory: true, entryType: 1 }
    },
    async mkdir() { assert.fail('the parent directory already exists') },
    async write() { calls.push('write') },
    async chmod() { calls.push('chmod') },
  } as unknown as NexusVfsClient
  await writeCohostWorkspaceFile(client, 'owner', '/project', 'skills/current/run.sh', Buffer.from('script'), 0o700)
  assert.deepEqual(calls, ['stat:/project/skills', 'stat:/project/skills/current', 'stat:/project/skills/current/run.sh', 'write', 'chmod'])
})

void test('directory preparation is shared only within the current write operation', async () => {
  let reads = 0
  let writes = 0
  let isLink = false
  const client = {
    async stat(path: string) {
      if (path !== '/project/skills') return null
      reads++
      return { isDirectory: true, entryType: isLink ? 6 : 1 }
    },
    async mkdir() { assert.fail('directory already exists') },
    async write() { writes++ },
  } as unknown as NexusVfsClient
  await writeCohostWorkspaceFiles(client, 'owner', '/project/', ['a', 'b', 'c'].map(name => ({
    path: `skills/${name}`, content: Buffer.from(name),
  })))
  assert.equal(reads, 1)
  assert.equal(writes, 3)
  await assert.rejects(writeCohostWorkspaceFile(client, 'owner', '/project/', '.', Buffer.from('invalid')), /must name a workspace file/)
  assert.equal(reads, 1, 'invalid destinations must fail before inspecting or changing the workspace')
  isLink = true
  await assert.rejects(writeCohostWorkspaceFile(client, 'owner', '/project', 'skills/d', Buffer.from('d')), /symbolic links/)
  assert.equal(reads, 2, 'another operation must inspect the current path')
  assert.equal(writes, 3)
})

void test('native skill writes retain the authorization token and apply executable mode to the written file', async () => {
  const calls: string[] = []
  const client = {
    async stat() { return undefined },
    async mkdir(path: string, token: string) { assert.equal(token, 'owner'); calls.push(`mkdir:${path}`) },
    async write(path: string, bytes: Buffer, token: string) { assert.equal(token, 'owner'); calls.push(`write:${path}:${bytes.toString()}`) },
    async chmod(path: string, mode: number, token: string) { assert.equal(token, 'owner'); calls.push(`chmod:${path}:${mode}`) },
  } as unknown as NexusVfsClient
  await writeCohostWorkspaceFile(client, 'owner', '/project', 'skills/run.sh', Buffer.from('script'), 0o700)
  assert.deepEqual(calls, ['mkdir:/project/skills', 'write:/project/skills/run.sh:script', 'chmod:/project/skills/run.sh:448'])
  for (const mode of [-1, 0o4777, 1.5]) {
    await assert.rejects(writeCohostWorkspaceFile(client, 'owner', '/project', 'bad', Buffer.from('bad'), mode), /Invalid workspace file mode/)
  }
  assert.equal(calls.length, 3, 'invalid modes must not write bytes before failing')
  client.chmod = async () => { throw new Error('UNIMPLEMENTED') }
  await assert.rejects(writeCohostWorkspaceFile(client, 'owner', '/project', 'bad', Buffer.from('script'), 0o700), /UNIMPLEMENTED/)
})

void test('cohost state preserves the durable ID and refuses corrupt recovery metadata', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'moss-cohost-state-'))
  try {
    assert.equal(await readCohostSessionState(cwd), undefined)
    await mkdir(join(cwd, '.moss'))
    for (const sessionId of ['old-process', '43210', '43210.7']) {
      await writeFile(cohostSessionStatePath(cwd), JSON.stringify({ sessionId, durableSessionId: 'history-first' }))
      const durable = await readCohostSessionState(cwd)
      assert.deepEqual(durable, { durableSessionId: 'history-first' })
    }
    await removeCohostSessionState(cwd)
    assert.equal(await readCohostSessionState(cwd), undefined)
    await removeCohostSessionState(cwd)
    await writeFile(cohostSessionStatePath(cwd), '{"durableSessionId":"../other"}')
    await assert.rejects(readCohostSessionState(cwd), /Invalid cohost session state/)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

void test('workspace requests routed to another Moss host do not require that host to have a locator file', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'moss-cohost-other-host-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const session = { sessionId: 'moss-id', cwd: '/legacy/host/workspace', userId: 'owner', assistantName: 'helper' } as SessionRecord
  const agentId = sessionAgentName('owner', 'helper')
  const binding = { ownerId: session.userId, agentId, durableSessionId: 'native-durable', repositoryPath: cohostRepositoryPath(agentId, session.sessionId) }
  let closes = 0
  const client = {
    async call() { return JSON.stringify({ session_id: '43210.7', owner_id: 'owner', agent_id: agentId,
      durable_session_id: binding.durableSessionId, workspace_path: '/proc/43210.7/workspace' }) },
    async stat() { return { entryType: 0, isDirectory: false } },
    async read(path: string) {
      assert.equal(path, `${binding.repositoryPath}/retained.txt`)
      return Buffer.from('retained bytes')
    },
    close() { closes++ },
  } as unknown as NexusVfsClient
  const access = createCohostWorkspaceAccess(session, {
    async connectCohostRuntime(owner, expectedAgent) {
      assert.equal(owner, session.userId)
      assert.equal(expectedAgent, agentId)
      return { client, authToken: 'owner-token', identity: null }
    },
    async connectInternalChannel() {
      const channel = new EventEmitter() as InternalSessionChannel
      channel.destroy = () => {}
      setImmediate(() => channel.emit('data', JSON.stringify({ type: 'hello', sessionId: session.sessionId,
        attemptId: 'attempt', runtimeType: 'cohost', state: 'running', managedProcessId: '43210.7',
        cohostSessionBinding: binding })+'\n'))
      return channel
    },
  })
  assert.equal((await access.readFile('retained.txt')).toString(), 'retained bytes')
  assert.equal(closes, 1)
})

void test('workspace I/O uses the verified execution descriptor and closes every RPC client', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'moss-cohost-workspace-'))
  const root = '/proc/pid/workspace'
  const session = { sessionId: 'moss-id', cwd: '/legacy/host/workspace', userId: 'owner', assistantName: 'helper' } as SessionRecord
  const descriptor = { session_id: 'pid', owner_id: 'owner', agent_id: sessionAgentName('owner', 'helper'),
    durable_session_id: 'durable', workspace_path: root+'/' }
  const binding = { ownerId: session.userId, agentId: descriptor.agent_id, durableSessionId: 'durable', repositoryPath: session.cwd }
  const calls: string[] = []
  let closes = 0
  let connections = 0
  let entryName = root+'/result.txt'
  const client = {
    async call(method: string, raw: string, token: string) {
      assert.equal(token, 'user-token');assert.equal(method, 'managed_agent.get_session_v1')
      assert.deepEqual(JSON.parse(raw), { session_id: descriptor.session_id })
      return JSON.stringify(descriptor)
    },
    async stat(path: string) { return path.endsWith('/reports') ? null : { size: 5, entryType: path.endsWith('/link') ? 6 : 0, isDirectory: false } },
    async readdir(path: string) { calls.push('list:'+path);return [{ name: entryName, entryType: 0 }] },
    async read(path: string) { calls.push('read:'+path);return Buffer.from('hello') },
    async mkdir(path: string) { calls.push('mkdir:'+path) },
    async write(path: string, bytes: Buffer) { calls.push('write:'+path+':'+bytes.toString()) },
    close() { closes++ },
  } as unknown as NexusVfsClient
  try {
    const access = createCohostWorkspaceAccess(session, {
      async connectCohostRuntime(owner, expectedAgent) {
        assert.equal(owner, session.userId)
        assert.equal(expectedAgent, sessionAgentName(session.userId, session.assistantName))
        return { client, authToken: 'user-token', identity: null }
      },
      async connectInternalChannel(id) {
        connections++
        assert.equal(id, session.sessionId)
        const channel = new EventEmitter() as InternalSessionChannel
        channel.destroy = () => {}
        setImmediate(() => channel.emit('data', JSON.stringify({ type: 'hello', sessionId: id, attemptId: 'attempt', runtimeType: 'cohost', state: 'running', managedProcessId: descriptor.session_id,
          cohostSessionBinding: binding })+'\n'))
        return channel
      },
    })
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
    assert.equal(closes, 7);assert.equal(connections, 7)
    descriptor.workspace_path = root
    entryName = '/proc/another/workspace/private.txt'
    await assert.rejects(access.listTree(2), /Invalid cohost workspace entry/)
    entryName = root+'/nested/private.txt'
    await assert.rejects(access.listTree(2), /Invalid cohost workspace entry/)
    assert.equal(closes, 9)
    const repositoryPath = cohostRepositoryPath(descriptor.agent_id, session.sessionId)
    binding.repositoryPath = repositoryPath
    entryName = repositoryPath+'/persisted.txt'
    assert.equal((await access.listTree(2))[0]?.relativePath, 'persisted.txt')
    assert.equal((await access.readFile('persisted.txt')).toString(), 'hello')
    await access.writeFile('uploaded.txt', Buffer.from('durable'))
    assert.deepEqual(calls.slice(-3), ['list:'+repositoryPath, 'read:'+repositoryPath+'/persisted.txt',
      'write:'+repositoryPath+'/uploaded.txt:durable'])
    descriptor.session_id = 'resumed-pid'
    descriptor.workspace_path = '/proc/resumed-pid/workspace'
    assert.equal((await access.readFile('persisted.txt')).toString(), 'hello')
    assert.equal(await readCohostSessionState(cwd), undefined)
    binding.repositoryPath = cohostRepositoryPath(descriptor.agent_id, 'different-session')
    const callCount = calls.length
    await assert.rejects(access.readFile('persisted.txt'), /repository does not belong/)
    assert.equal(calls.length, callCount)
    assert.equal(closes, 14)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
