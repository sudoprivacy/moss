import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { waitForFixtureReady } from '../testing/fixtureReady.js'

void test('HTTP phone login selects an actual enterprise member without moving its original identity', { timeout: 90_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-multi-org-http-'))
  const repo = resolve(import.meta.dirname, '../../..')
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'junction')
  let child: ReturnType<typeof spawn> | undefined
  try {
    const configPath = join(root, 'server.json')
    await writeFile(configPath, JSON.stringify({
      server: { host: '127.0.0.1', port: 0 }, bootstrapAdmin: { username: 'membership-root', password: 'local-http-fixture-password' },
      phoneAuth: { enabled: true, delivery: 'log' },
      storage: { rootDir: root, dbPath: join(root, 'moss.db'), transcriptDir: join(root, 'transcripts'), runtimeDir: join(root, 'runtime') },
      wikiIndex: { enabled: false },
    }))
    const external = ['sharp', '@xenova/transformers', 'onnxruntime-node', '@anthropic-ai/bedrock-sdk', '@anthropic-ai/foundry-sdk', '@anthropic-ai/vertex-sdk', '@anthropic-ai/mcpb']
    execFileSync('bun', ['build', 'src/server/tenantAssistantRoutes.fixture.ts', '--target=node', '--format=esm', '--external=@sudo/contracts/common/v1/resource-ref', '--outdir', join(root, 'build'), ...external.map(name => `--external=${name}`)], { cwd: repo, stdio: 'pipe' })
    child = spawn(process.execPath, [join(root, 'build/tenantAssistantRoutes.fixture.js')], {
      cwd: repo, env: { ...process.env, MOSS_HOME: join(root, 'moss-home'), MOSS_SERVER_CONFIG: configPath, MOSS_TEST_MULTI_ORG_MEMBERSHIP: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = '', errors = ''
    child.stdout!.on('data', chunk => { output += chunk })
    child.stderr!.on('data', chunk => { errors += chunk })
    const port = await waitForFixtureReady(child, /TENANT_TEST_READY:(\d+)/, () => ({ output, errors }), t.signal)
    async function request(method: string, path: string, token?: string, body?: unknown) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: t.signal,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: response.status, data: await response.json() as any }
    }
    async function ok(method: string, path: string, token?: string, body?: unknown) {
      const result = await request(method, path, token, body)
      assert.equal(result.status, 200, `${method} ${path}: ${JSON.stringify(result.data)}`)
      return result.data
    }
    const boot = (await ok('POST', '/api/v1/auth/token', undefined, { username: 'membership-root', password: 'local-http-fixture-password' })).access_token
    await ok('POST', '/api/v1/auth/send-code', undefined, { phone: '13900000001' })
    // Exercise normal one-use code verification using the explicitly configured
    // development delivery of this isolated fixture, never a production phone.
    const code = /verification code for 139\*\*\*\*0001 is (\d+)/.exec(errors)?.[1]
    assert(code, 'Development SMS delivery must be observed')
    const login = await ok('POST', '/api/v1/auth/login', undefined, { phone: '13900000001', code })
    const primary = login.data.access_token
    const original = await ok('GET', '/api/v1/auth/me', primary)
    assert.equal((await request('POST', '/api/v1/auth/login', undefined, { phone: '13900000001', code })).status, 401)
    const company = (await ok('GET', '/api/v1/organizations', boot)).organizations.find((org: any) => org.name === 'Membership company')
    assert(company)
    const companyRoot = (await ok('POST', '/api/v1/auth/switch-org', boot, { org_id: company.id })).access_token
    assert.equal((await request('POST', '/api/v1/users/memberships', undefined, { phone: '13900000001' })).status, 401)
    assert.equal((await request('POST', '/api/v1/users/memberships', companyRoot, { phone: '13900000001', role: 'admin' })).status, 400)
    const added = await ok('POST', '/api/v1/users/memberships', companyRoot, { phone: '13900000001' })
    assert.equal(added.created, true)
    assert.equal(added.user.role, 'user')
    assert.equal((await ok('POST', '/api/v1/users/memberships', companyRoot, { phone: '13900000001' })).created, false)
    const available = await ok('GET', '/api/v1/auth/organizations', primary)
    assert.deepEqual(new Set(available.organizations.map((org: any) => org.id)), new Set([original.organization.id, company.id]))
    const selected = await ok('POST', '/api/v1/auth/switch-org', primary, { org_id: company.id })
    assert.equal(selected.user.id, added.user.id)
    assert.equal(selected.user.orgId, company.id)
    assert.equal(selected.user.role, 'user')
    assert.equal(selected.execution?.isRemoteAllowed, true)
    assert.equal(selected.localRuntime?.userId, added.user.id)
    assert.equal(selected.localRuntime?.organizationId, company.id)
    assert.notEqual(selected.user.id, original.user.id)
    assert.equal((await request('GET', '/api/v1/users', selected.access_token)).status, 403)
    assert.equal((await request('POST', '/api/v1/users/memberships', selected.access_token, { phone: '13900000001' })).status, 403)
    assert.equal((await ok('GET', '/api/v1/auth/me', primary)).user.id, original.user.id)
    await ok('PATCH', `/api/v1/users/${added.user.id}`, companyRoot, { status: 'disabled' })
    assert.equal((await request('GET', '/api/v1/auth/me', selected.access_token)).status, 401)
    assert.equal((await request('GET', '/api/v1/auth/me', primary)).status, 200)
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit') }
    await rm(root, { recursive: true, force: true })
  }
})
