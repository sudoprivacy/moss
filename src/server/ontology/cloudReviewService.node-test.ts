import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ShareoneReviewAssets } from '@sudowork/sudograph-runtime'
import type { AuthorizedBrowserPage } from '../browser/browserGateway.js'
import { createCloudModelReviewService } from './cloudReviewService.js'
import { createReviewHostFixture } from './reviewHostFixture.js'

void test('cloud review composes registered model access, personal credentials and private browser handoff on shared HTTP ingress', { timeout: 20000 }, async t => {
  const f = await createReviewHostFixture(t, true)
  const root = await mkdtemp(join(tmpdir(), 'moss-cloud-review-shell-'))
  const files = { 'review.js': '// Transport fixture; this test does not accept the frontend UX.', 'review.css': ':root{color-scheme:dark}' }
  const manifest = { format: 'shareone-review-shell/v1', entry: 'review.js', styles: ['review.css'], files: {} as Record<string, { bytes: number; sha256: string }> }
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, name), body)
    manifest.files[name] = { bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') }
  }
  await writeFile(join(root, 'review-assets.json'), JSON.stringify(manifest))
  const assets = new ShareoneReviewAssets()
  await assets.load(root)
  let credentialReads = 0, providerRequests = 0, isActive = true
  const provider = createServer((req, res) => {
    providerRequests++
    assert.equal(req.headers['x-api-key'], 'personal-provider-fixture')
    const route = new URL(req.url!, 'http://fixture.invalid').pathname
    let body: unknown = {}
    if (route === '/api/v1/me') body = { id: 'personal-shareone-owner' }
    else if (route.startsWith('/api/v1/pages')) body = { share_id: 'private-space', settings: { viewer_scope: 'owner_and_collaborators', allow_comments: true, is_public: false } }
    else if (route.endsWith('/poll')) body = { events: [] }
    req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
  })
  let service: Awaited<ReturnType<typeof createCloudModelReviewService>>
  const ingress = createServer((req, res) => { void service.handleRequest(req, res).then(handled => { if (!handled) res.writeHead(404).end() }).catch(() => res.writeHead(500).end()) })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  await new Promise<void>(resolve => ingress.listen(0, '127.0.0.1', resolve))
  const origin = (server: typeof provider) => {
    const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`
  }
  let launched: AuthorizedBrowserPage | undefined
  service = await createCloudModelReviewService({ store: f.store, origin: origin(ingress), shareoneOrigin: origin(provider), assets,
    runtime: { connectInternalChannel: async () => assert.fail('Reading a model must not start an agent turn') },
    isUserActive: async owner => { assert.deepEqual(owner, { orgId: 'org', userId: 'alice' }); return isActive },
    secrets: {
      getUserSecret: async (org, user, namespace, key) => {
        assert.deepEqual([org, user, namespace, key], ['org', 'alice', 'user:alice:shareone', 'shareone_key'])
        credentialReads++; return { success: true, data: { value: 'personal-provider-fixture', status: 'enabled', version: 1 } }
      },
      putUserSecret: async () => assert.fail('Existing credentials require no pairing'),
      deleteUserSecret: async () => assert.fail('Viewing does not remove credentials'),
    },
    browser: {
      invoke: async () => assert.fail('Do not use public navigation with a private review credential'),
      openAuthorizedPage: async (binding, _controller, page, epochs) => {
        assert.deepEqual(binding, { orgId: 'org', userId: 'alice', sessionId: 'session' })
        assert.deepEqual(epochs, { controlEpoch: 3, targetEpoch: 4 })
        launched = page; return { surface: 'viewer', conversationId: 'session' }
      },
    },
  })
  t.after(async () => {
    await service.close()
    for (const server of [ingress, provider]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    await rm(root, { recursive: true, force: true })
  })
  const owner = { orgId: 'org', userId: 'alice' }
  assert.deepEqual(await service.open(owner, 'session', { controlEpoch: 3, targetEpoch: 4 }), { surface: 'viewer', conversationId: 'session' })
  assert.ok(launched)
  assert.equal((await fetch(launched.url)).status, 403)
  const headers = { Cookie: launched.cookie.name + '=' + launched.cookie.value }
  const response = await fetch(launched.url, { headers })
  assert.equal(response.status, 200)
  const shell = await response.text()
  assert.ok(shell.includes('"allow_comments":true'))
  assert.equal(shell.includes('personal-provider-fixture'), false)
  const connection = await fetch(launched.url + 'connection', { headers })
  assert.equal(connection.status, 200)
  assert.deepEqual(await connection.json(), { state: 'ready', share_id: 'private-space' }, 'the shell connects with the existing personal credential without another login')
  assert.ok(credentialReads > 0)
  const head = await fetch(launched.url + 'v1', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ view: f.project.projectId, operation: 'head' }) })
  assert.equal(head.status, 200)
  assert.equal((await head.json() as { result: { revision: string } }).result.revision, f.state.revision)
  const before = providerRequests
  isActive = false
  assert.equal((await fetch(launched.url, { headers })).status, 403, 'every read rechecks the current account')
  assert.equal(providerRequests, before, 'a revoked owner cannot reach the comment credential provider')
  await assert.rejects(service.open(owner, 'session', { controlEpoch: 3, targetEpoch: 4 }), /unavailable/)
})
