import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { waitForFixtureReady } from '../testing/fixtureReady.js'
import { AGENT_CONTROL_PROTOCOL } from './contract.js'

void test('real Moss HTTP: native control and browser management share owner checks, effects and receipts', { timeout: 90_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-control-http-'))
  const repo = resolve(import.meta.dirname, '../../..'), configPath = join(root, 'server.json')
  await writeFile(configPath, JSON.stringify({ server: { host: '127.0.0.1', port: 0 },
    bootstrapAdmin: { username: 'control-root', password: 'test-local-password' },
    storage: { rootDir: root, dbPath: join(root, 'moss.db'), transcriptDir: join(root, 'transcripts'), runtimeDir: join(root, 'runtime') },
    wikiIndex: { enabled: false } }))
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'junction')
  execFileSync('bun', ['build', 'src/server/testing/agentManager.fixture.ts', '--target=node', '--format=esm',
    '--external=@sudo/contracts/common/v1/resource-ref', '--external=sharp', '--external=@xenova/transformers', '--external=onnxruntime-node',
    '--outfile', join(root, 'fixture.mjs')], { cwd: repo, stdio: 'pipe' })
  const child = spawn(process.execPath, [join(root, 'fixture.mjs')], { cwd: repo,
    env: { ...process.env, MOSS_AGENT_MANAGER_FIXTURE: '1', MOSS_AGENT_CONTROL_FIXTURE: '1',
      MOSS_AGENT_CONTROL_DEPLOYMENT_ID: 'dgx-http-fixture', MOSS_HOME: join(root, 'moss-home'),
      MOSS_SERVER_CONFIG: configPath, MOSS_WORKSPACE_URL: 'https://workbench.example' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { errors += chunk })
  try {
    const port = await waitForFixtureReady(child, /AGENT_TEST_READY:(\d+)/, () => ({ output, errors }), t.signal)
    async function request(method: string, path: string, token?: string, body?: unknown) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: t.signal,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      return { status: response.status, headers: response.headers, data: await response.json() as any }
    }
    const login = await request('POST', '/api/v1/auth/token', undefined, { username: 'control-root', password: 'test-local-password' })
    assert.equal(login.status, 200)
    const parent = String(login.data.access_token)
    const ownerId = JSON.parse(Buffer.from(parent.split('.')[1]!, 'base64url').toString()).sub as string
    const managed = '/api/v1/agent-manager/agents/persistent-agent'
    const actor = await request('POST', `${managed}/sessions`, parent, { owner_id: ownerId })
    assert.equal(actor.status, 201)
    const control = '/api/v1/agent-control'
    assert.equal((await request('GET', `${control}/capabilities`)).status, 401)
    assert.equal((await request('GET', `${control}/capabilities`, parent)).status, 403)
    const issued = await request('POST', `${control}/delegations`, parent, {
      actorSessionId: actor.data.sessionId, target: { deploymentId: 'dgx-http-fixture', ownerId },
      actions: ['agents.list', 'agents.spawn'], ttlSeconds: 120,
    })
    assert.equal(issued.status, 200)
    assert.equal(issued.headers.get('cache-control'), 'no-store')
    const token = String(issued.data.credential.accessToken)
    assert.equal((await request('GET', '/api/v1/agent-manager/agents', token)).status, 401,
      'an admin control capability must not become a browser login')
    assert.equal((await request('POST', `${control}/delegations`, token, {})).status, 403,
      'a delegated Agent cannot mint another delegation')
    const capabilities = await request('GET', `${control}/capabilities`, token)
    assert.equal(capabilities.status, 200)
    assert.deepEqual(capabilities.data.tools.map((tool: { action: string }) => tool.action), ['agents.list', 'agents.spawn'])
    assert.ok(!JSON.stringify(capabilities.data).includes(token))
    const entry = join(root, 'moss-agent-control.mjs'), install = join(root, 'private-control')
    execFileSync('bun', ['build', 'src/server/agentControl/nativeMain.ts', '--target=node', '--format=esm',
      '--outfile', entry], { cwd: repo, stdio: 'pipe' })
    const setup = spawnSync(process.execPath, [entry, 'install', install, `http://127.0.0.1:${port}`],
      { input: JSON.stringify(issued.data), encoding: 'utf8' })
    assert.equal(setup.status, 0, setup.stderr)
    assert.ok(!setup.stdout.includes(token)); assert.ok(!setup.stderr.includes(token))
    const manifest = JSON.parse(await readFile(join(install, '.sudocode-plugin', 'plugin.json'), 'utf8'))
    assert.deepEqual(manifest.tools.map((tool: any) => tool.name), ['moss_agents_list', 'moss_agent_spawn', 'moss_control_operation'])
    const call = spawnSync(process.execPath, [join(install, 'control.mjs'), 'tool'], { input: '{}', encoding: 'utf8',
      env: { ...process.env, SUDOCODE_TOOL_NAME: 'moss_agents_list', SUDOCODE_TOOL_CALL_ID: 'host-native-list' } })
    assert.equal(call.status, 0, call.stderr)
    assert.equal(JSON.parse(call.stdout).outcome, 'completed')
    assert.ok(!call.stdout.includes(token)); assert.ok(!call.stdout.includes(parent))
    const duplicateSetup = spawnSync(process.execPath, [entry, 'install', install, `http://127.0.0.1:${port}`],
      { input: JSON.stringify(issued.data), encoding: 'utf8' })
    assert.equal(duplicateSetup.status, 1, 'private install must not overwrite a running delegation')
    const body = { protocol: AGENT_CONTROL_PROTOCOL, operationId: 'http-native-command', action: 'agents.spawn', arguments: { agent: 'persistent-agent' } }
    const first = await request('POST', `${control}/invoke`, token, body)
    assert.equal(first.status, 200); assert.equal(first.data.outcome, 'completed')
    assert.equal(first.data.audit.initiatedBy, ownerId)
    assert.equal(first.data.audit.actor.sessionId, actor.data.sessionId)
    const repeated = await request('POST', `${control}/invoke`, token, body)
    assert.deepEqual(repeated.data, first.data)
    const receipt = await request('GET', `${control}/operations/http-native-command`, token)
    assert.deepEqual(receipt.data, first.data)
    const created = await request('GET', `/api/v1/sessions/${first.data.result.sessionId}`, parent)
    assert.equal(created.status, 200); assert.equal(created.data.session.userId, ownerId)
    assert.equal(created.data.session.clientMetadata.agent_manager_actor_id, ownerId)
    const detail = await request('GET', `${managed}?owner_id=${ownerId}`, parent)
    assert.equal(detail.data.sessions.length, 2, 'one human start plus exactly one native start')
    assert.equal((await request('POST', `${control}/invoke`, token, { ...body, operationId: 'bad-owner',
      arguments: { agent: 'persistent-agent', ownerId: 'forged' } })).status, 400)
    const revoked = await request('DELETE', `${control}/delegations/${issued.data.delegation.id}`, parent)
    assert.equal(revoked.status, 200)
    assert.deepEqual((await request('GET', `${control}/operations/http-native-command`, parent)).data, first.data,
      'the original human can inspect the durable receipt after revocation without replaying an effect')
    assert.equal((await request('GET', `${control}/operations/http-native-command`, token)).status, 403)
    assert.equal((await request('POST', `${control}/invoke`, token, { ...body, operationId: 'after-revoke' })).status, 403)
    assert.ok(!JSON.stringify(first.data).includes(token))
  } finally {
    if (child.exitCode === null) { const closed = once(child, 'exit'); child.kill(); await closed }
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`) && root.includes('moss-control-http-'))
    await unlink(join(root, 'node_modules'))
    await rm(root, { recursive: true, force: true })
  }
})
