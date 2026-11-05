import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { ShareoneReviewAssets } from '@sudowork/sudograph-runtime'
import type { AuthorizedBrowserPage } from '../browser/browserGateway.js'
import { createCloudModelReviewService } from './cloudReviewService.js'
import { createReviewHostFixture } from './reviewHostFixture.js'
import { createNativeReviewFixture } from './nativeReviewFixture.js'
import { createDeployedCloudReview, reviewBrowserEpochs } from './cloudReviewDeployment.js'

void test('cloud review composes registered model access, personal credentials and private browser handoff on shared HTTP ingress', { timeout: 20000 }, async t => {
  const f = await createReviewHostFixture(t, true)
  const native = await createNativeReviewFixture(t, 'complete', 'session', () => { f.state.revision = 'c'.repeat(64) })
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
  let thread: Record<string, unknown> | undefined
  let pollCount = 0
  const replies: Record<string, unknown>[] = [], providerErrors: unknown[] = []
  const provider = createServer((req, res) => {
    void (async () => {
    providerRequests++
    assert.equal(req.headers['x-api-key'], 'personal-provider-fixture')
    const route = new URL(req.url!, 'http://fixture.invalid').pathname
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {}
    let body: unknown = {}
    if (route === '/api/v1/me') body = { id: 'personal-shareone-owner' }
    else if (route.startsWith('/api/v1/pages')) body = { share_id: 'private-space', settings: { viewer_scope: 'owner_and_collaborators', allow_comments: true, is_public: false } }
    else if (route === '/api/v1/shares/private-space/comments') {
      if (req.method === 'POST') {
        if (input.author_role === 'agent') { replies.push(input); body = { id: 'agent-reply' } }
        else { thread = { id: 'human-thread', ...input }; body = thread }
      } else body = thread ? [thread] : []
    } else if (route.endsWith('/poll')) {
      pollCount++
      body = { events: thread ? [{ id: 'comment-event', share_id: 'private-space', comment_id: 'human-thread',
        parent_id: null, event_type: 'comment.created', actor_role: 'owner' }] : [], lease_token: 'provider-lease' }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
    })().catch(error => { providerErrors.push(error); res.destroy() })
  })
  let service: Awaited<ReturnType<typeof createCloudModelReviewService>>
  const ingress = createServer((req, res) => { void service.handleRequest(req, res).then(handled => { if (!handled) res.writeHead(404).end() }).catch(() => res.writeHead(500).end()) })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  await new Promise<void>(resolve => ingress.listen(0, '127.0.0.1', resolve))
  const origin = (server: typeof provider) => {
    const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`
  }
  let launched: AuthorizedBrowserPage | undefined
  const options: Parameters<typeof createCloudModelReviewService>[0] = { store: f.store, origin: origin(ingress), shareoneOrigin: origin(provider), assets,
    runtime: native.runtime,
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
        launched = page; return { internalWorkerResult: true, cookie: page.cookie }
      },
    },
  }
  service = await createCloudModelReviewService(options)
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
  assert.equal(native.submissions.length, 0, 'reading the model does not start an agent turn')
  assert.equal((await fetch(launched.url + 'content', { headers })).status, 200)
  const initialRevision = f.state.revision
  const comment = await fetch(launched.url + 'api/v1/shares/private-space/comments', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Please confirm the source field meaning.', quote: 'Products.UnitPrice',
      highlighter_data: JSON.stringify({ stable_id: 'source-field-products-unitprice' }) }),
  })
  assert.equal(comment.status, 200)
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 8000
    while (!condition() && Date.now() < deadline) await delay(10)
    assert.ok(condition(), 'the native review and provider reply must finish within the existing test deadline')
  }
  await waitFor(() => replies.length === 1)
  assert.equal(native.submissions.length, 1)
  assert.equal(native.submissions[0].display, 'Products.UnitPrice\n\nPlease confirm the source field meaning.')
  const transcript = (await readFile(native.transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const userRecord = transcript.find(event => event.type === 'user')
  assert.equal(userRecord.displayText, native.submissions[0].display)
  const expanded = JSON.parse(userRecord.message.content)
  assert.ok(native.submissions[0].content[0].text.endsWith(userRecord.message.content), 'ordinary first-turn context preserves the anchored review input')
  assert.equal(expanded.current_revision, initialRevision)
  assert.deepEqual(expanded.anchor.review_binding, { project: f.project.projectId, conversation: 'session', revision: initialRevision })
  assert.equal(expanded.anchor.stable_id, 'source-field-products-unitprice')
  assert.equal(replies[0].parent_id, 'human-thread')
  assert.ok(String(replies[0].content).includes('The original conversation reviewed the field.'))
  assert.ok(String(replies[0].content).includes('Model revision: ' + f.state.revision))
  assert.ok((await readFile(native.transcriptPath, 'utf8')).includes('native_input_complete'))
  assert.deepEqual(await (await fetch(launched.url + 'delivery', { headers })).json(), { delivered: 1 })
  await service.close()
  service = await createCloudModelReviewService(options)
  const pollsBeforeReplacement = pollCount
  assert.deepEqual(await (await fetch(launched.url + 'delivery', { headers })).json(), { delivered: 1 })
  await waitFor(() => pollCount > pollsBeforeReplacement)
  assert.equal(replies.length, 1, 'replayed provider events cannot post a second reply')
  assert.equal(native.submissions.length, 1, 'host replacement cannot execute the same comment twice')
  assert.equal((await f.store.driver.get('SELECT count(*) AS n FROM ontology_review_dispatch_claims'))?.n, 1)
  assert.deepEqual(providerErrors, [])
  const before = providerRequests
  isActive = false
  assert.equal((await fetch(launched.url, { headers })).status, 403, 'every read rechecks the current account')
  assert.equal(providerRequests, before, 'a revoked owner cannot reach the comment credential provider')
  await assert.rejects(service.open(owner, 'session', { controlEpoch: 3, targetEpoch: 4 }), /unavailable/)
})

void test('deployment and browser-generation contracts reject missing services and caller-selected configuration', async () => {
  assert.deepEqual(reviewBrowserEpochs({ controlEpoch: 0, targetEpoch: 9 }), { controlEpoch: 0, targetEpoch: 9 })
  for (const input of [null, [], {}, { controlEpoch: -1, targetEpoch: 0 }, { controlEpoch: 0.5, targetEpoch: 1 },
    { controlEpoch: 0, targetEpoch: 1, url: 'https://caller.invalid/' }, { controlEpoch: 0, targetEpoch: 1, cookie: 'caller' }]) {
    assert.throws(() => reviewBrowserEpochs(input), /Invalid review browser generation/)
  }
  const options = { secrets: null } as Parameters<typeof createDeployedCloudReview>[0]
  assert.equal(await createDeployedCloudReview(options), null)
  await assert.rejects(createDeployedCloudReview({ ...options, assetsDirectory: '/unused' }), /configured Nexus personal Secrets API/)
})
