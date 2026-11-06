import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { mossAgentName, sessionAgentName } from './agentIdentity.js'
import { waitForFixtureReady } from './testing/fixtureReady.js'

void test('real HTTP: deleting an Agent removes its sessions and identity, within the owner and organization', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-agent-deletion-routes-'))
  const configPath = join(root, 'server.json'), dbPath = join(root, 'moss.db')
  await writeFile(configPath, JSON.stringify({ server: { host: '127.0.0.1', port: 0 },
    bootstrapAdmin: { username: 'test-root', password: 'test-local-password' },
    storage: { rootDir: root, dbPath, transcriptDir: join(root, 'transcripts'), runtimeDir: join(root, 'runtime') },
    wikiIndex: { enabled: false } }))
  const repo = resolve(import.meta.dirname, '../..')
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'junction')
  execFileSync('bun', ['build', 'src/server/testing/agentManager.fixture.ts', '--target=node', '--format=esm', '--external=@sudo/contracts/common/v1/resource-ref',
    '--outfile', join(root, 'fixture.mjs'), '--external=sharp', '--external=@xenova/transformers', '--external=onnxruntime-node'],
  { cwd: repo, stdio: 'pipe' })
  const child = spawn(process.execPath, [join(root, 'fixture.mjs')], { cwd: repo,
    env: { ...process.env, MOSS_AGENT_MANAGER_FIXTURE: '1', MOSS_HOME: join(root, 'moss-home'), MOSS_SERVER_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'] })
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
    async function ok(method: string, path: string, token?: string, body?: unknown, status = 200) {
      const response = await request(method, path, token, body)
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.data)}`)
      return response.data
    }
    const login = async (name: string) =>
      (await ok('POST', '/api/v1/auth/token', undefined, { username: name, password: 'test-local-password' })).access_token as string
    const subject = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).sub as string
    const boot = await login('test-root')
    const orgs: Record<string, { id: string; admin: string; user: string; userId: string }> = {}
    for (const name of ['a', 'b']) {
      const organization = (await ok('POST', '/api/v1/organizations', boot, { name })).organization
      const scopedRoot = (await ok('POST', '/api/v1/auth/switch-org', boot, { org_id: organization.id })).access_token
      for (const role of ['admin', 'user']) {
        await ok('POST', '/api/v1/users', scopedRoot, { name: `${name}-${role}`, role, password: 'test-local-password' })
      }
      const user = await login(`${name}-user`)
      orgs[name] = { id: organization.id, admin: await login(`${name}-admin`), user, userId: subject(user) }
    }
    const a = orgs.a!, b = orgs.b!
    const agentPath = (name: string, ownerId: string) =>
      `/api/v1/agent-manager/agents/${encodeURIComponent(name)}?owner_id=${ownerId}`

    await t.test('an owner deletes an Agent they made; its sessions go, the default Agent\'s stay', async () => {
      const personal = (await ok('POST', '/api/v1/user-agents', a.user, { displayName: 'Probe' }, 201)).data
      const probe = (await ok('POST', '/api/v1/sessions', a.user,
        { runtime: { type: 'cohost' }, assistant_name: `moss-agent:own:${personal.id}` })).session_id
      const kept = (await ok('POST', '/api/v1/sessions', a.user, { runtime: { type: 'cohost' } })).session_id
      assert.equal((await request('DELETE', `/api/v1/user-agents/${personal.id}`, b.user)).status, 404)
      assert.deepEqual(await ok('DELETE', `/api/v1/user-agents/${personal.id}`, a.user), { success: true, data: {
        name: `u-${a.userId}--${personal.id}`, sessions: 1, isNativeDeleted: false, isIdentityDeleted: true } })
      assert.deepEqual((await ok('GET', '/api/v1/user-agents', a.user)).data, [])
      assert.equal((await request('GET', `/api/v1/sessions/${probe}`, a.user)).status, 404)
      await ok('GET', `/api/v1/sessions/${kept}`, a.user)
      assert.equal((await request('DELETE', `/api/v1/user-agents/${personal.id}`, a.user)).status, 404)
      const audit = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const row = audit.prepare(`SELECT actor_user_id, resource, resource_id, request_data_json FROM operation_audit_events
          WHERE action = 'AGENT_DELETED'`).get() as Record<string, string>
        assert.deepEqual({ ...row, request_data_json: JSON.parse(row.request_data_json!) }, {
          actor_user_id: a.userId, resource: 'agent', resource_id: a.userId,
          request_data_json: { agentName: `u-${a.userId}--${personal.id}`, sessions: 1, isNativeDeleted: false, isIdentityDeleted: true } })
      } finally { audit.close() }
    })

    await t.test('the default and Moss Agents cannot be deleted', async () => {
      assert.equal((await request('DELETE', agentPath(`user-${a.userId}`, a.userId), a.admin)).status, 409)
      const moss = sessionAgentName(a.userId, mossAgentName(a.id, a.userId))
      assert.equal((await request('DELETE', agentPath(moss, a.userId), a.admin)).status, 409)
    })

    await t.test('administrators delete Agents of owners they manage, never across organizations', async () => {
      assert.equal((await request('DELETE', agentPath('persistent-agent', b.userId), a.user)).status, 403)
      assert.equal((await request('DELETE', agentPath('persistent-agent', a.userId), b.admin)).status, 404)
      assert.equal((await request('DELETE', agentPath('persistent-agent', a.userId))).status, 401)
      assert.deepEqual(await ok('DELETE', agentPath('persistent-agent', a.userId), a.admin),
        { name: 'persistent-agent', sessions: 0, isNativeDeleted: false, isIdentityDeleted: false })
    })
    assert.doesNotMatch(errors, /AGENT_TEST_ERROR/)
  } finally {
    if (child.exitCode === null) {
      const closed = once(child, 'close')
      child.kill()
      await closed
    }
    await rm(root, { recursive: true, force: true })
  }
})
