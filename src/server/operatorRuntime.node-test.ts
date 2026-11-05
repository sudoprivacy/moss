import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ResourceAccessError } from './catalog/resourceError.js'
import { OperatorAccess, serveOperatorRuntime, type OperatorRuntimeDependencies } from './operatorRuntime.js'

const TOKEN = 'operator-'.padEnd(48, 'x')

async function tokenFile(contents: string, mode: number) {
  const directory = await mkdtemp(join(tmpdir(), 'moss-operator-'))
  const path = join(directory, 'operator.token')
  await writeFile(path, contents)
  await chmod(path, mode)
  return { path, directory }
}

void test('operator access exists only for a private, sufficiently long token file', async () => {
  assert.equal(OperatorAccess.load(undefined), null)
  const shared = await tokenFile(TOKEN, 0o640)
  const short = await tokenFile('too-short', 0o600)
  const good = await tokenFile(`${TOKEN}\n`, 0o600)
  try {
    assert.throws(() => OperatorAccess.load(shared.path), /mode 600/)
    assert.throws(() => OperatorAccess.load(short.path), /at least 32/)
    assert.ok(OperatorAccess.load(good.path))
  } finally {
    await Promise.all([shared, short, good].map(file => rm(file.directory, { recursive: true, force: true })))
  }
})

void test('real HTTP: operator upgrades use the owner organization and refuse proxied or unauthenticated callers', async () => {
  const file = await tokenFile(TOKEN, 0o600)
  const calls: string[] = []
  const events: Array<Record<string, unknown>> = []
  const deps: OperatorRuntimeDependencies = {
    inspect: async ownerId => ({ ownerId, isDrifted: true }),
    ownerOrganization: async ownerId => ownerId === 'active-owner' || ownerId === 'busy-owner' ? 'org-b' : null,
    upgrade: async (ownerId, orgId) => {
      calls.push(`${ownerId}@${orgId}`)
      if (ownerId === 'busy-owner') throw new ResourceAccessError(409, 'Agent runtime has active work')
      return { ownerId, isDrifted: false }
    },
    record: event => events.push({ name: event.name, ...event.fields }),
  }
  const access = OperatorAccess.load(file.path)
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url!, 'http://localhost').pathname
    if (!await serveOperatorRuntime(req, res, pathname, access, deps)) {
      res.writeHead(418); res.end('{}')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  const call = (method: string, path: string, headers: IncomingHttpHeaders = {}) => new Promise<{ status: number, body: any }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: headers as Record<string, string> }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end()
  })
  const operator = { 'x-moss-operator-token': TOKEN }
  try {
    assert.equal((await call('GET', '/api/v1/agents')).status, 418, 'other routes are untouched')
    assert.equal((await call('POST', '/api/v1/operator/agent-runtimes/active-owner/upgrade')).status, 403)
    assert.equal((await call('POST', '/api/v1/operator/agent-runtimes/active-owner/upgrade',
      { 'x-moss-operator-token': TOKEN.slice(0, -1) + 'y' })).status, 403)
    assert.equal((await call('POST', '/api/v1/operator/agent-runtimes/active-owner/upgrade',
      { ...operator, 'x-forwarded-for': '203.0.113.9' })).status, 403, 'a same-host proxy never confers operator access')
    assert.deepEqual(calls, [])

    const inspected = await call('GET', '/api/v1/operator/agent-runtimes/active-owner', operator)
    assert.deepEqual(inspected, { status: 200, body: { runtime: { ownerId: 'active-owner', isDrifted: true } } })
    const upgraded = await call('POST', '/api/v1/operator/agent-runtimes/active-owner/upgrade', operator)
    assert.deepEqual(upgraded, { status: 200, body: { runtime: { ownerId: 'active-owner', isDrifted: false } } })
    assert.deepEqual(events, [{ name: 'agent_runtime_upgraded', ownerId: 'active-owner', orgId: 'org-b', actor: 'operator' }])

    const busy = await call('POST', '/api/v1/operator/agent-runtimes/busy-owner/upgrade', operator)
    assert.deepEqual(busy, { status: 409, body: { error: 'Agent runtime has active work' } })
    assert.equal((await call('POST', '/api/v1/operator/agent-runtimes/disabled-owner/upgrade', operator)).status, 404)
    assert.equal((await call('DELETE', '/api/v1/operator/agent-runtimes/active-owner', operator)).status, 405)
    assert.deepEqual(calls, ['active-owner@org-b', 'busy-owner@org-b'])
    assert.equal(events.length, 1, 'only completed upgrades are recorded')
  } finally {
    server.close()
    await rm(file.directory, { recursive: true, force: true })
  }
})

void test('without a token file the operator routes do not exist', async () => {
  const handled = await serveOperatorRuntime({} as never, {} as never, '/api/v1/operator/agent-runtimes/x/upgrade', null, {} as never)
  assert.equal(handled, false)
})
