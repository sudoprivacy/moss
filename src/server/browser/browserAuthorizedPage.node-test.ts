import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { browserAction, browserController, openSessionAuthorizedPage, type AuthorizedBrowserPage, type BrowserBinding } from './browserGateway.js'
import { BrowserWorkerRegistry } from './browserWorkerRegistry.js'

void test('trusted review launch uses the existing host transport and revokes uncertain grants', async t => {
  const binding = { orgId: 'fixture-org', userId: 'fixture-owner', sessionId: 'conversation' }
  let current: BrowserBinding | null = binding
  let owner: BrowserBinding | null = binding
  let isActive = true
  let isDenied = false
  let revokeDuringNavigation = false
  const actions: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, 'Bearer fixture-host-credential')
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/binding') { response.end(JSON.stringify({ binding: owner, browserRunning: true })); return }
      assert.equal(request.url, '/invoke')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.deepEqual(value.binding, binding)
      assert.equal(value.controller, browserController(binding))
      actions.push(value.action)
      if (revokeDuringNavigation) isActive = false
      if (isDenied) { response.writeHead(409).end(JSON.stringify({ error: 'stale_browser_operation' })); return }
      response.end(JSON.stringify({ session: { state: 'human', activeTargetId: 'review-tab' } }))
    })().catch(error => { response.writeHead(500).end(JSON.stringify({ error: String(error) })) })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const environment = ['MOSS_BROWSER_IMAGE', 'MOSS_BROWSER_SECRET', 'MOSS_BROWSER_NETWORK', 'MOSS_BROWSER_OWNER_IMAGES',
    'MOSS_BROWSER_ALLOWED_OWNERS', 'MOSS_BROWSER_GATEWAY_URL', 'MOSS_BROWSER_GATEWAY_TOKEN', 'MOSS_BROWSER_GATEWAY_AI_TOKEN']
  const previous = Object.fromEntries(environment.map(key => [key, process.env[key]]))
  for (const key of environment) delete process.env[key]
  Object.assign(process.env, { MOSS_BROWSER_GATEWAY_URL: `http://127.0.0.1:${address.port}/`,
    MOSS_BROWSER_GATEWAY_TOKEN: 'fixture-host-credential', MOSS_BROWSER_GATEWAY_AI_TOKEN: 'fixture-agent-credential' })
  t.after(() => { for (const key of environment) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] } })
  const worker = new BrowserWorkerRegistry(async () => current ? { ...current, desiredState: 'active' } : null)
  const deps = { worker, getSession: async () => current, isUserActive: async () => isActive }
  const epochs = { controlEpoch: 7, targetEpoch: 11 }
  let revoked = 0
  const cookie = { name: 'fixture_review', value: 'a'.repeat(64), url: 'http://127.0.0.1:8123/review/private/',
    path: '/review/private/', httpOnly: true as const, sameSite: 'Strict' as const, expires: Date.now() / 1000 + 60 }
  const page = Object.defineProperties({ url: cookie.url }, {
    cookie: { value: cookie }, revoke: { value: async () => { await new Promise<void>(resolve => setImmediate(resolve)); revoked++ } },
  }) as AuthorizedBrowserPage
  assert(!JSON.stringify(page).includes(cookie.value), 'the private SDK handoff remains non-serializable')
  const result = await openSessionAuthorizedPage(deps, binding, binding.sessionId, page, epochs)
  assert.deepEqual(result, { session: { state: 'human', activeTargetId: 'review-tab' } })
  assert(!JSON.stringify(result).includes(cookie.value))
  assert.deepEqual(actions, [{ kind: 'open-authorized-page', url: page.url, cookie, ...epochs }])
  assert.equal(revoked, 0)

  await assert.rejects(openSessionAuthorizedPage(deps, { ...binding, userId: 'manager' }, binding.sessionId, page, epochs), /session_forbidden/)
  assert.equal(revoked, 1, 'a failed launch must wait for the shared database revocation to commit')
  assert.equal(actions.length, 1, 'another account cannot reach the private worker operation')
  owner = { ...binding, sessionId: 'another-conversation' }
  await assert.rejects(openSessionAuthorizedPage(deps, binding, binding.sessionId, page, epochs), /browser_not_started/)
  assert.equal(actions.length, 1, 'review must not claim another conversation or start a browser')
  owner = binding
  isDenied = true
  await assert.rejects(openSessionAuthorizedPage(deps, binding, binding.sessionId, page, epochs), /stale_browser_operation/)
  assert.equal(actions.length, 2, 'a failed navigation is sent once without retry or public fallback')
  isDenied = false
  revokeDuringNavigation = true
  await assert.rejects(openSessionAuthorizedPage(deps, binding, binding.sessionId, page, epochs), /session_forbidden/)
  assert.equal(revoked, 4, 'each failed or revoked launch releases its own review grant')

  for (const kind of ['open-authorized-page', 'set-cookie']) assert.throws(() => browserAction({ kind, url: page.url, cookie }), /invalid_browser_action/)
  assert.deepEqual(browserAction({ kind: 'navigate', ...epochs, url: page.url, cookie }), { kind: 'navigate', ...epochs, url: page.url })
})
