import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { getDefaultServerConfig } from '../config.js'

/**
 * A disabled corp app must be unusable through every agent-facing route
 * (the `corpapp` CLI), not only hidden from the list. Before, the list
 * filtered it out but resolve, send, internal groups, customer groups,
 * names, approvals, media, the queue and the WeCom callback listener all
 * kept working. Re-enabling must bring every one of them back.
 *
 * Reuses the tenant-routes server fixture (Node, since node:sqlite).
 */

type Fixture = { baseUrl: string; callbackUrl: string; rootDir: string; process: ReturnType<typeof Bun.spawn> }

let fx: Fixture
let adminToken = ''

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${fx.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, body: json }
}

beforeAll(async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'moss-corpapp-disabled-'))
  const config = getDefaultServerConfig()
  config.server.host = '127.0.0.1'
  config.server.port = 0
  config.bootstrapAdmin.username = 'corpapp-admin'
  config.bootstrapAdmin.password = 'corpapp-admin-pw'
  config.storage = {
    rootDir,
    dbPath: join(rootDir, 'moss.db'),
    transcriptDir: join(rootDir, 'transcripts'),
    runtimeDir: join(rootDir, 'runtime'),
  }
  config.wikiIndex.enabled = false
  const configPath = join(rootDir, 'server.json')
  await writeFile(configPath, JSON.stringify(config), 'utf8')

  const outDir = join(rootDir, 'fixture-build')
  const repoRoot = resolve(import.meta.dir, '..', '..', '..')
  const bundle = Bun.spawnSync([
    'bun', 'build', resolve(import.meta.dir, '..', 'tenantAssistantRoutes.fixture.ts'),
    '--target=node', '--format=esm', '--outdir', outDir,
    '--external=better-sqlite3', '--external=@xenova/transformers', '--external=onnxruntime-node', '--external=sharp',
  ], { cwd: repoRoot })
  if (bundle.exitCode !== 0) throw new Error(`fixture bundle failed: ${bundle.stderr.toString()}`)

  // Free port for the public callback listener.
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const callbackPort = probe.port
  probe.stop(true)

  const proc = Bun.spawn(['node', join(outDir, 'tenantAssistantRoutes.fixture.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MOSS_HOME: join(rootDir, 'moss-home'),
      MOSS_SERVER_CONFIG: configPath,
      MOSS_CALLBACK_PORT: String(callbackPort),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let out = ''
  let port = 0
  while (!port) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`fixture exited: ${out}${await new Response(proc.stderr).text()}`)
    out += decoder.decode(chunk.value, { stream: true })
    const m = out.match(/TENANT_TEST_READY:(\d+)/)
    if (m) port = Number(m[1])
  }
  fx = { baseUrl: `http://127.0.0.1:${port}`, callbackUrl: `http://127.0.0.1:${callbackPort}`, rootDir, process: proc }

  const login = await fetch(`${fx.baseUrl}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'corpapp-admin', password: 'corpapp-admin-pw' }),
  })
  adminToken = ((await login.json()) as { access_token: string }).access_token
}, 120_000)

afterAll(async () => {
  if (!fx) return
  fx.process.kill()
  await fx.process.exited
  await rm(fx.rootDir, { recursive: true, force: true })
})

describe('disabled corp app over the agent routes', () => {
  let id = ''
  const name = 'disabled-app'

  // Every per-app route the CLI can reach, with a body valid enough to get
  // past input validation if the enabled check were missing.
  const routes = (): Array<[string, string, unknown?]> => [
    ['POST', `/api/v1/agent/corp-apps/${id}/messages`, { to: 'alice', text: 'hi' }],
    ['GET', `/api/v1/agent/corp-apps/${id}/inbound`],
    ['GET', `/api/v1/agent/corp-apps/${id}/media?mediaId=m1`],
    ['GET', `/api/v1/agent/corp-apps/${id}/approvals?starttime=1&endtime=2`],
    ['GET', `/api/v1/agent/corp-apps/${id}/approvals/sp1`],
    ['POST', `/api/v1/agent/corp-apps/${id}/names`, { userIds: ['alice'] }],
    ['GET', `/api/v1/agent/corp-apps/${id}/customer-groups`],
    ['GET', `/api/v1/agent/corp-apps/${id}/customer-groups/wr1`],
    ['POST', `/api/v1/agent/corp-apps/${id}/group-messages`, { chatIdList: ['wr1'], sender: 'alice', text: 'hi' }],
    ['GET', `/api/v1/agent/corp-apps/${id}/group-messages`],
    ['POST', `/api/v1/agent/corp-apps/${id}/internal-groups`, { name: 'g', owner: 'alice', userList: ['alice', 'bob'] }],
    ['GET', `/api/v1/agent/corp-apps/${id}/internal-groups/c1`],
    ['PATCH', `/api/v1/agent/corp-apps/${id}/internal-groups/c1`, { name: 'g2' }],
    ['POST', `/api/v1/agent/corp-apps/${id}/internal-groups/c1/messages`, { text: 'hi' }],
    ['POST', `/api/v1/agent/corp-apps/${id}/queue`, { action: 'list' }],
  ]

  it('creates an app, then disables it', async () => {
    const created = await api('POST', '/api/v1/corp-apps', {
      type: 'wecomapp',
      name,
      config: { corpId: 'ww-test', agentId: '1000001' },
      credentials: { secret: 's' },
    })
    expect(created.status).toBe(200)
    id = created.body.id
    const patched = await api('PATCH', `/api/v1/corp-apps/${id}`, { enabled: false })
    expect(patched.status).toBe(200)
  })

  it('is hidden from the list and refused by resolve', async () => {
    const list = await api('GET', '/api/v1/agent/corp-apps')
    expect(list.status).toBe(200)
    expect(list.body.apps.map((a: any) => a.id)).not.toContain(id)

    const byName = await api('GET', `/api/v1/agent/corp-apps/resolve?name=${name}`)
    expect(byName.status).toBe(403)
    expect(byName.body.error.code).toBe('corp_app_disabled')
  })

  it('refuses every per-app route', async () => {
    for (const [method, path, body] of routes()) {
      const r = await api(method, path, body)
      expect({ method, path, status: r.status, code: r.body?.error?.code }).toEqual({
        method, path, status: 403, code: 'corp_app_disabled',
      })
    }
  })

  it('takes no WeCom callbacks', async () => {
    const verify = await fetch(`${fx.callbackUrl}/api/v1/corp-apps/callback/${id}?echostr=x&msg_signature=x&timestamp=1&nonce=n`)
    expect(verify.status).toBe(403)
    expect(await verify.text()).toBe('corp app disabled')
    // POST still answers an empty 200 so WeCom does not keep retrying.
    const event = await fetch(`${fx.callbackUrl}/api/v1/corp-apps/callback/${id}?msg_signature=x&timestamp=1&nonce=n`, {
      method: 'POST',
      body: '<xml></xml>',
    })
    expect(event.status).toBe(200)
    expect(await event.text()).toBe('')
  })

  it('works again once re-enabled', async () => {
    await api('PATCH', `/api/v1/corp-apps/${id}`, { enabled: true })
    const byName = await api('GET', `/api/v1/agent/corp-apps/resolve?name=${name}`)
    expect(byName.status).toBe(200)
    const inbound = await api('GET', `/api/v1/agent/corp-apps/${id}/inbound`)
    expect(inbound.status).toBe(200)
    const list = await api('GET', '/api/v1/agent/corp-apps')
    expect(list.body.apps.map((a: any) => a.id)).toContain(id)
    // Past the enabled gate: the bad signature fails inside the handler instead.
    const verify = await fetch(`${fx.callbackUrl}/api/v1/corp-apps/callback/${id}?echostr=x&msg_signature=x&timestamp=1&nonce=n`)
    expect(await verify.text()).not.toBe('corp app disabled')
  })
})
