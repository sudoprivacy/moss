import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { waitForFixtureReady } from './testing/fixtureReady.js'

void test('real HTTP: runtime fleet scope, retirement on disable, lock recovery and a reviewed rollout', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-runtime-fleet-routes-'))
  const configPath = join(root, 'server.json')
  await writeFile(configPath, JSON.stringify({ server: { host: '127.0.0.1', port: 0 },
    bootstrapAdmin: { username: 'test-root', password: 'test-local-password' },
    storage: { rootDir: root, dbPath: join(root, 'moss.db'), transcriptDir: join(root, 'transcripts'), runtimeDir: join(root, 'runtime') },
    wikiIndex: { enabled: false } }))
  const repo = resolve(import.meta.dirname, '../..')
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'junction')
  execFileSync('bun', ['build', 'src/server/testing/agentManager.fixture.ts', '--target=node', '--format=esm', '--external=@sudo/contracts/common/v1/resource-ref',
    '--outfile', join(root, 'fixture.mjs'), '--external=sharp', '--external=@xenova/transformers', '--external=onnxruntime-node'],
  { cwd: repo, stdio: 'pipe' })
  const child = spawn(process.execPath, [join(root, 'fixture.mjs')], { cwd: repo,
    env: { ...process.env, MOSS_AGENT_MANAGER_FIXTURE: '1', MOSS_RUNTIME_FLEET_FIXTURE: '1', MOSS_HOME: join(root, 'moss-home'),
      MOSS_SERVER_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] })
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
    const orgs: Record<string, { root: string; admin: string; user: string; userId: string }> = {}
    for (const name of ['a', 'b']) {
      const organization = (await ok('POST', '/api/v1/organizations', boot, { name })).organization
      const scopedRoot = (await ok('POST', '/api/v1/auth/switch-org', boot, { org_id: organization.id })).access_token
      for (const [user, role] of [[`${name}-admin`, 'admin'], [`${name}-user`, 'user'], [`${name}-locked`, 'user']]) {
        await ok('POST', '/api/v1/users', scopedRoot, { name: user, role, password: 'test-local-password' })
      }
      const user = await login(`${name}-user`)
      orgs[name] = { root: scopedRoot, admin: await login(`${name}-admin`), user, userId: subject(user) }
    }
    const a = orgs.a!, b = orgs.b!
    const lockedId = subject(await login('a-locked'))
    const names = (rows: Array<{ ownerName: string }>) => rows.map(row => row.ownerName).sort()

    await t.test('organization admins manage their organization; only the platform administrator sees all', async () => {
      assert.equal((await request('GET', '/api/v1/agent-runtimes', a.user)).status, 403)
      assert.deepEqual(names((await ok('GET', '/api/v1/agent-runtimes', a.admin)).runtimes), ['a-admin', 'a-locked', 'a-user'])
      assert.equal((await request('GET', '/api/v1/agent-runtimes?scope=all', a.admin)).status, 403)
      const all = (await ok('GET', '/api/v1/agent-runtimes?scope=all', a.root)).runtimes
      assert.deepEqual(names(all), ['a-admin', 'a-locked', 'a-user', 'b-admin', 'b-locked', 'b-user'])
      assert.deepEqual([...new Set(all.map((row: { orgName: string }) => row.orgName))].sort(), ['a', 'b'])
      assert.equal((await request('POST', `/api/v1/agent-runtimes/${b.userId}/retire`, a.admin)).status, 404)
      assert.equal((await request('POST', `/api/v1/agent-runtimes/${a.userId}/retire`, a.admin)).status, 409, 'active owners keep their runtime')
    })

    await t.test('an interrupted upgrade lock blocks upgrades until an admin recovers it', async () => {
      const row = (await ok('GET', '/api/v1/agent-runtimes', a.admin)).runtimes.find((item: { ownerId: string }) => item.ownerId === lockedId)
      assert.deepEqual([row.canUpgrade, row.canRecoverLock, row.upgradeLock], [false, true, { createdAt: '2026-11-02T06:58:00Z' }])
      assert.equal((await request('POST', `/api/v1/agent-runtimes/${lockedId}/upgrade`, a.admin)).status, 409)
      assert.deepEqual(await ok('POST', `/api/v1/agent-runtimes/${lockedId}/recover-lock`, a.admin), { isRecovered: true })
      assert.equal((await ok('POST', `/api/v1/agent-runtimes/${lockedId}/upgrade`, a.admin)).runtime.isDrifted, false)
    })

    await t.test('disabling an owner retires their runtime without an explicit request', async () => {
      await ok('PATCH', `/api/v1/users/${a.userId}`, a.admin, { status: 'disabled' })
      for (let attempt = 0; attempt < 100 && !output.includes(`FLEET_FIXTURE_RETIRED:${a.userId}`); attempt++) await delay(50)
      assert.ok(output.includes(`FLEET_FIXTURE_RETIRED:${a.userId}`), output)
      assert.deepEqual(names((await ok('GET', '/api/v1/agent-runtimes', a.admin)).runtimes), ['a-admin', 'a-locked'])
    })

    await t.test('a rollout runs only the plan the platform administrator reviewed', async () => {
      assert.equal((await request('GET', '/api/v1/agent-runtimes/rollout', a.admin)).status, 403)
      const { plan } = await ok('GET', '/api/v1/agent-runtimes/rollout', a.root)
      assert.deepEqual(names(plan), ['a-admin', 'b-admin', 'b-user'], 'b-locked waits for recovery; upgraded and retired owners are excluded')
      const reviewed = plan.map((row: { ownerId: string }) => row.ownerId)
      assert.equal((await request('POST', '/api/v1/agent-runtimes/rollout', a.root, { owner_ids: reviewed.slice(1) })).status, 409)
      assert.equal((await request('POST', '/api/v1/agent-runtimes/rollout', a.root, { owner_ids: 'all' })).status, 400)
      await ok('POST', '/api/v1/agent-runtimes/rollout', a.root, { owner_ids: reviewed }, 202)
      let rollout
      for (let attempt = 0; attempt < 100; attempt++) {
        rollout = (await ok('GET', '/api/v1/agent-runtimes/rollout', a.root)).rollout
        if (rollout.finishedAt !== null) break
        await delay(50)
      }
      assert.deepEqual(rollout.owners.map((owner: { outcome: string }) => owner.outcome), ['upgraded', 'upgraded', 'upgraded'])
      assert.deepEqual((await ok('GET', '/api/v1/agent-runtimes/rollout', a.root)).plan, [])
    })
    assert.doesNotMatch(errors, /AGENT_TEST_ERROR/)
  } finally {
    child.kill()
    await rm(root, { recursive: true, force: true })
  }
})
