import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { once } from 'node:events'
import WebSocket from 'ws'
import { waitForFixtureReady } from './testing/fixtureReady.js'

void test('real HTTP: Agent ownership, organization boundaries and trusted manager grants', { timeout: 90_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-agent-manager-routes-'))
  const configPath = join(root, 'server.json')
  await writeFile(configPath, JSON.stringify({ server: { host: '127.0.0.1', port: 0 },
    bootstrapAdmin: { username: 'test-root', password: 'test-local-password' },
    storage: { rootDir: root, dbPath: join(root, 'moss.db'), transcriptDir: join(root, 'transcripts'), runtimeDir: join(root, 'runtime') },
    wikiIndex: { enabled: false } }))
  const repo = resolve(import.meta.dirname, '../..')
  execFileSync('bun', ['build', 'src/server/testing/agentManager.fixture.ts', '--target=node', '--format=esm',
    '--outfile', join(root, 'fixture.mjs'), '--external=sharp', '--external=@xenova/transformers', '--external=onnxruntime-node'],
  { cwd: repo, stdio: 'pipe' })
  const child = spawn(process.execPath, [join(root, 'fixture.mjs')], { cwd: repo,
    env: { ...process.env, MOSS_AGENT_MANAGER_FIXTURE: '1', MOSS_HOME: join(root, 'moss-home'),
      MOSS_SERVER_CONFIG: configPath, MOSS_WORKSPACE_URL: 'https://workbench.example' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { errors += chunk })
  try {
    const port = await waitForFixtureReady(child, /AGENT_TEST_READY:(\d+)/, () => ({ output, errors }), t.signal)
    async function request(method: string, path: string, token?: string, body?: unknown) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: t.signal,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: response.status, data: await response.json() as any }
    }
    async function ok(method: string, path: string, token?: string, body?: unknown) {
      const response = await request(method, path, token, body)
      assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.data)}`)
      return response.data
    }
    async function login(name: string) {
      return (await ok('POST', '/api/v1/auth/token', undefined, { username: name, password: 'test-local-password' })).access_token as string
    }
    const boot = await login('test-root')
    const accounts: Array<{ orgId: string; admin: string; user: string; userId: string }> = []
    for (const name of ['a', 'b']) {
      const organization = (await ok('POST', '/api/v1/organizations', boot, { name })).organization
      const switched = (await ok('POST', '/api/v1/auth/switch-org', boot, { org_id: organization.id })).access_token
      for (const role of ['admin', 'user']) await ok('POST', '/api/v1/users', switched,
        { name: `${name}-${role}`, role, password: 'test-local-password' })
      const user = await login(`${name}-user`)
      accounts.push({ orgId: organization.id, admin: await login(`${name}-admin`), user,
        userId: JSON.parse(Buffer.from(user.split('.')[1]!, 'base64url').toString()).sub })
    }
    const [a, b] = accounts as [typeof accounts[number], typeof accounts[number]]
    assert.equal((await request('GET', '/api/v1/agents')).status, 401)
    assert.equal((await request('GET', '/api/v1/agents?limit=101', a.admin)).status, 400)
    const listed = await ok('GET', '/api/v1/agents', a.user)
    assert(listed.agents.every((agent: any) => agent.ownerId === a.userId))
    assert(listed.agents.some((agent: any) => agent.name === 'persistent-agent' && agent.canStart))
    assert.equal((await request('GET', `/api/v1/agents/persistent-agent?owner_id=${b.userId}`, a.admin)).status, 404)
    assert.equal((await request('POST', '/api/v1/agents/persistent-agent/sessions', a.user, { owner_id: b.userId })).status, 404)
    assert.equal((await request('POST', '/api/v1/agents/worker-agent/sessions', a.admin, { owner_id: a.userId })).status, 403)
    assert.equal((await ok('POST', `/api/v1/agent-runtimes/${a.userId}/upgrade`, a.user)).runtime.ownerId, a.userId)
    assert.equal((await request('POST', `/api/v1/agent-runtimes/${b.userId}/upgrade`, a.user)).status, 403)
    assert.equal((await request('POST', `/api/v1/agent-runtimes/${b.userId}/upgrade`, a.admin)).status, 404)
    assert.equal((await ok('GET', `/api/v1/agents/persistent-agent?owner_id=${a.userId}`, a.user)).canUpgrade, true)
    const created = await request('POST', '/api/v1/agents/persistent-agent/sessions', a.admin,
      { owner_id: a.userId, management_actor_id: b.userId, source: 'forged' })
    assert.equal(created.status, 201, JSON.stringify(created.data))
    assert.equal(created.data.workspaceUrl, `https://workbench.example/#/conversation/${created.data.sessionId}`)
    const session = (await ok('GET', `/api/v1/sessions/${created.data.sessionId}`, a.admin)).session
    const adminId = JSON.parse(Buffer.from(a.admin.split('.')[1]!, 'base64url').toString()).sub
    assert.equal(session.userId, a.userId, 'the Agent owner remains the billing principal')
    assert.equal(session.role, 'user', 'management authority never becomes the Agent owner runtime role')
    assert.equal(session.source, 'agent-manager')
    assert.equal(session.clientMetadata.agent_manager_actor_id, adminId)
    assert.equal(session.clientMetadata.agent_manager_agent_name, 'persistent-agent')
    assert.equal((await request('PATCH', `/api/v1/sessions/${created.data.sessionId}`, a.user,
      { client_metadata: { agent_manager_actor_id: b.userId } })).status, 400)
    assert.equal((await request('GET', `/api/v1/sessions/${created.data.sessionId}`, b.admin)).status, 403)
    const managementSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${created.data.sessionId}`,
      { headers: { Authorization: `Bearer ${a.admin}` } })
    t.after(() => managementSocket.terminate())
    await once(managementSocket, 'open')
    const firstReply = once(managementSocket, 'message')
    managementSocket.send('qa-before-role-change')
    assert.equal(JSON.parse((await firstReply)[0].toString()).data, 'qa-before-role-change\n')
    const managementClosed = once(managementSocket, 'close')
    const bootInA = (await ok('POST', '/api/v1/auth/switch-org', boot, { org_id: a.orgId })).access_token
    await ok('PATCH', `/api/v1/users/${adminId}`, bootInA, { role: 'user' })
    managementSocket.send('qa-after-role-change')
    assert.equal((await managementClosed)[0], 1008,
      'the direct Moss WebSocket must reject controls after a management role changes')
    assert.equal((await request('GET', '/api/v1/agents', a.admin)).status, 401,
      'a role change immediately invalidates the previous management token')
    assert.equal((await request('GET', `/api/v1/sessions/${created.data.sessionId}`, a.admin)).status, 401)
    const downgraded = await login('a-admin')
    assert.equal((await request('GET', `/api/v1/sessions/${created.data.sessionId}`, downgraded)).status, 403,
      'the persisted management actor metadata cannot replace current permission')
    assert((await ok('GET', '/api/v1/agents', downgraded)).agents.every((agent: any) => agent.ownerId === adminId))
  } finally {
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited }
    await rm(root, { recursive: true, force: true })
  }
})
