import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'

void test('HTTP user updates await authorization and persistence before responding', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'moss-user-update-'))
  const repo = resolve(import.meta.dirname, '../../..')
  let child: ReturnType<typeof spawn> | undefined
  try {
    const configPath = join(root, 'server.json')
    await writeFile(configPath, JSON.stringify({
      server: { host: '127.0.0.1', port: 0 },
      bootstrapAdmin: { username: 'test-root', password: 'test-local-password' },
      storage: { rootDir: root, dbPath: join(root, 'moss.db'), transcriptDir: join(root, 'transcripts'), runtimeDir: join(root, 'runtime') },
      wikiIndex: { enabled: false },
    }))
    // These optional providers are not installed or invoked by this HTTP fixture.
    const external = ['sharp', '@xenova/transformers', 'onnxruntime-node', '@anthropic-ai/bedrock-sdk', '@anthropic-ai/foundry-sdk', '@anthropic-ai/vertex-sdk', '@anthropic-ai/mcpb']
    execFileSync('bun', ['build', 'src/server/tenantAssistantRoutes.fixture.ts', '--target=node', '--format=esm', '--outdir', join(root, 'build'), ...external.map(name => `--external=${name}`)], { cwd: repo, stdio: 'pipe' })
    child = spawn(process.execPath, [join(root, 'build/tenantAssistantRoutes.fixture.js')], {
      cwd: repo, env: { ...process.env, MOSS_HOME: join(root, 'moss-home'), MOSS_SERVER_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = '', errors = ''
    child.stdout!.on('data', chunk => { output += chunk })
    child.stderr!.on('data', chunk => { errors += chunk })
    const port = await new Promise<number>((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error(`Fixture timeout: ${errors}`)), 20_000)
      child!.stdout!.on('data', () => {
        const match = output.match(/TENANT_TEST_READY:(\d+)/)
        if (match) { clearTimeout(timer); resolvePort(Number(match[1])) }
      })
      child!.on('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exit ${code}: ${errors}`)) })
    })
    async function request(method: string, path: string, token?: string, body?: unknown) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: response.status, data: await response.json() as any }
    }
    async function ok(method: string, path: string, token?: string, body?: unknown) {
      const response = await request(method, path, token, body)
      assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.data)}`)
      return response.data
    }
    async function login(username: string) { return (await ok('POST', '/api/v1/auth/token', undefined, { username, password: 'test-local-password' })).access_token as string }
    const boot = await login('test-root')
    const accounts: Record<string, { admin: string; user: string; userId: string }> = {}
    for (const label of ['a', 'b']) {
      const org = await ok('POST', '/api/v1/organizations', boot, { name: label })
      const switched = await ok('POST', '/api/v1/auth/switch-org', boot, { org_id: org.organization.id })
      await ok('POST', '/api/v1/users', switched.access_token, { name: `${label}-admin`, role: 'admin', password: 'test-local-password' })
      const user = await ok('POST', '/api/v1/users', switched.access_token, { name: `${label}-user`, role: 'user', password: 'test-local-password' })
      accounts[label] = { admin: await login(`${label}-admin`), user: await login(`${label}-user`), userId: user.user.id }
    }
    const a = accounts.a!, b = accounts.b!
    const path = `/api/v1/users/${a.userId}`
    const updated = await ok('PATCH', path, a.admin, { display_name: 'Updated A' })
    assert.equal(updated.user?.displayName, 'Updated A')
    for (const [token, body, status] of [
      [a.admin, { name: ' ' }, 400],
      [a.admin, { role: 'invalid' }, 400],
      [a.admin, { status: 'invalid' }, 400],
      [a.admin, { role: 'super_admin' }, 403],
      [b.admin, { status: 'disabled' }, 404],
      [a.user, { display_name: 'Denied' }, 403],
    ] as const) {
      assert.equal((await request('PATCH', path, token, body)).status, status)
      const after = await ok('GET', '/api/v1/users', a.admin)
      const unchanged = after.users.find((item: any) => item.id === a.userId)
      assert.equal(unchanged.displayName, 'Updated A')
      assert.equal(unchanged.status, 'active')
    }
    assert.equal((await request('PATCH', '/api/v1/users/missing-user', a.admin, { name: 'missing' })).status, 404)
    assert.equal((await request('GET', '/api/v1/auth/me', a.user)).status, 200)
    assert.equal((await ok('PATCH', path, a.admin, { status: 'disabled' })).user.status, 'disabled')
    assert.equal((await request('GET', '/api/v1/auth/me', a.user)).status, 401)
    assert.equal((await ok('PATCH', path, a.admin, { status: 'active' })).user.status, 'active')
    assert.ok(await login('a-user'))
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit') }
    await rm(root, { recursive: true, force: true })
  }
})
