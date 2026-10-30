import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { SudographModelClient, SudographReviewHost } from '@sudowork/sudograph-runtime'
import { stringify } from 'yaml'
import { ToolProtocol } from '../agentFederation/toolProtocol.js'
import { createCompilerContextWorker } from './compilerContextWorker.js'

void test('the production worker enforces endpoint authentication and fixed tool inputs before reading a model', async t => {
  const token = 'fixture-worker-token-for-acceptance-only'
  const config = { token, binding: { authorityRef: 'authority', modelRef: 'model', sourceRefs: ['source'] }, actor: 'worker',
    runtime: { python: '/deliberately-unavailable/private-python', compilerRoot: '/private-model-root', modelDirectory: '/private-model-data' } }
  const server = createCompilerContextWorker(config)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) })
  const address = server.address()
  assert(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}/mcp`
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' })).status, 401)
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://foreign.invalid' }, body: '{}' })).status, 403)
  assert.equal((await fetch(endpoint + '/foreign-model', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })).status, 403)
  const reviewEndpoint = new URL('/review', endpoint)
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  assert.equal((await fetch(reviewEndpoint, { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await fetch(reviewEndpoint, { method: 'GET', headers })).status, 403)
  assert.equal((await fetch(reviewEndpoint, { method: 'POST', headers: { ...headers, origin: 'https://foreign.invalid' }, body: '{}' })).status, 403)
  for (const body of [{ operation: 'head', model_ref: 'foreign' }, { operation: 'head', actor: 'foreign' },
    { operation: 'head', path: '/private-other' }, { operation: 'apply', model: 'foreign' }, { operation: 'export' },
    { operation: 'html', endpoint: 'https://foreign.invalid/steal' }]) {
    assert.equal((await fetch(reviewEndpoint, { method: 'POST', headers, body: JSON.stringify(body) })).status, 400)
  }
  assert.equal((await fetch(reviewEndpoint, { method: 'POST', headers, body: ' '.repeat(65536) + '{"operation":"head"}' })).status, 400)
  const unavailable = await fetch(reviewEndpoint, { method: 'POST', headers, body: '{"operation":"head"}' })
  assert.equal(unavailable.status, 503)
  const diagnostic = await unavailable.text()
  assert.ok(diagnostic.includes('VIEW_UNAVAILABLE') && !diagnostic.includes('/private-') && !diagnostic.includes(token))
  const protocol = new ToolProtocol({ endpoint, headers: { Authorization: `Bearer ${token}` }, timeoutMs: 5000 }, AbortSignal.timeout(10000))
  try {
    await protocol.connect()
    const descriptors = await protocol.descriptors()
    assert.deepEqual(descriptors.map(item => item.tool.name).sort(), ['sudograph_context', 'sudograph_context_read', 'sudograph_model_apply', 'sudograph_model_contract'])
    assert.equal((await protocol.call('sudograph_context', { model_ref: 'foreign', path: '/foreign-model' })).isError, true)
    const failure = await protocol.call('sudograph_context', {})
    assert.equal(failure.isError, true)
    assert.ok(!JSON.stringify(failure).includes('/private-') && !JSON.stringify(failure).includes(token))
    const pointer = { revision: 'revision', context_digest: 'digest', id: 'catalog' }
    for (const request of [{ ...pointer, path: '/foreign-model' }, { ...pointer, model_ref: 'foreign' },
      { ...pointer, actor: 'foreign' }, { ...pointer, limit: 101 }, { ...pointer, offset: -1 },
      { ...pointer, records: 'true' }, { ...pointer, revision: '' }]) {
      assert.equal((await protocol.call('sudograph_context_read', request)).isError, true)
    }
    const readFailure = await protocol.call('sudograph_context_read', pointer)
    assert.equal(readFailure.isError, true)
    assert.ok(!JSON.stringify(readFailure).includes('/private-') && !JSON.stringify(readFailure).includes(token))
    assert.ok(JSON.stringify(readFailure).includes('MODEL_READ_UNAVAILABLE'))
    assert.equal((await protocol.call('sudograph_model_contract', { model_ref: 'foreign' })).isError, true)
    assert.equal((await protocol.call('sudograph_model_apply', {
      base_revision: 'revision', operation_id: 'operation', model: '', actor: 'foreign',
    })).isError, true)
    const writeFailure = await protocol.call('sudograph_model_apply', {
      base_revision: 'revision', operation_id: 'operation', model: '',
    })
    assert.equal(writeFailure.isError, true)
    assert.ok(JSON.stringify(writeFailure).includes('MODEL_OPERATION_UNAVAILABLE'))
    assert.ok(!JSON.stringify(writeFailure).includes('/private-') && !JSON.stringify(writeFailure).includes(token))
  } finally { await protocol.close() }
})

void test('a worker cannot start with a missing or weak deployment credential', () => {
  const config = { binding: { authorityRef: 'authority', modelRef: 'model', sourceRefs: ['source'] }, actor: 'worker',
    runtime: { python: 'python', compilerRoot: '.', modelDirectory: '.' } }
  for (const token of ['', 'short', 'x'.repeat(513), 'x'.repeat(32) + '\n']) {
    assert.throws(() => createCompilerContextWorker({ ...config, token }), /deployment-owned worker token/)
  }
})

void test('the production worker reads pointers and atomically compiles edits through the published compiler', {
  skip: !process.env.MOSS_SUDOGRAPH_COMPILER_PYTHON, timeout: 60000,
}, async t => {
  const python = process.env.MOSS_SUDOGRAPH_COMPILER_PYTHON
  assert.ok(python)
  const root = await mkdtemp(join(tmpdir(), 'moss-compiler-context-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  const source = join(root, 'source.db')
  const execute = promisify(execFile)
  const observe = async () => {
    const result = await execute(python, ['-c', 'import sqlite3,sys,json; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps(c.execute("SELECT id,label FROM widgets ORDER BY id").fetchall())); c.close()', source])
    return JSON.parse(result.stdout) as unknown[][]
  }
  await execute(python, ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE widgets(id INTEGER PRIMARY KEY,label TEXT)"); c.executemany("INSERT INTO widgets VALUES(?,?)",[(1,"row-only-sentinel"),(2,None),(3,"third")]); c.commit(); c.close()', source])
  const digest = async () => createHash('sha256').update(await readFile(source)).digest('hex')
  const initial = await digest(), expected = await observe()
  const runtime = { python, compilerRoot: root, modelDirectory: root }
  const client = new SudographModelClient(runtime)
  await client.registerSource('model', 'worker', { source: 'sqlite:///' + source.replaceAll('\\', '/'),
    namespace: 'worker-acceptance', operationId: randomUUID(), language: 'en' })
  const token = 'fixture-worker-token-for-live-acceptance'
  const server = createCompilerContextWorker({ token, runtime, actor: 'worker',
    binding: { authorityRef: 'authority', modelRef: 'model', sourceRefs: ['source-z', 'source', 'source-z'] } })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const protocol = new ToolProtocol({ endpoint: `http://127.0.0.1:${address.port}/mcp`,
    headers: { Authorization: `Bearer ${token}` }, timeoutMs: 15000 }, AbortSignal.timeout(45000))
  try {
    await protocol.connect()
    const call = async (name: string, input: Record<string, unknown>) => {
      const result = await protocol.call(name, input)
      assert.equal(result.isError, undefined, JSON.stringify(result))
      const content = result.content[0]
      assert.ok(content?.type === 'text')
      return JSON.parse(content.text) as Record<string, unknown>
    }
    const packet = await call('sudograph_context', {})
    assert.deepEqual(packet.source_refs, ['source', 'source-z'])
    const context = packet.context as { revision: string; context_digest: string; text: string }
    assert.ok(!context.text.includes('row-only-sentinel'), 'records must not be preloaded into context')
    const pointer = { revision: context.revision, context_digest: context.context_digest }
    const catalog = await call('sudograph_context_read', { ...pointer, id: 'catalog' })
    const sources = catalog.sources as { objects: { id: string; name: string }[] }[]
    const object = sources.flatMap(item => item.objects).find(item => item.name === 'widgets')
    assert.ok(object)
    const review = async (input: Record<string, unknown>, status = 200) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/review`, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
      assert.equal(response.status, status)
      return response.json() as Promise<Record<string, unknown>>
    }
    const head = await review({ operation: 'head' })
    assert.deepEqual({ ...head, result: undefined }, { format: 'sudograph-worker-review/v1', authority_ref: 'authority',
      model_ref: 'model', source_refs: ['source', 'source-z'], scope: 'full-registered-model', result: undefined })
    assert.equal((head.result as { revision: string }).revision, context.revision)
    const document = (await review({ operation: 'document', endpoint: `/review/${'a'.repeat(32)}/v1` })).result as { revision: string; html: string }
    assert.equal(document.revision, context.revision)
    assert.ok(document.html.includes(object.id) && !document.html.includes('row-only-sentinel'), 'review HTML retains stable identities without embedding source rows')
    const reviewedPage = await review({ operation: 'page', params: { ...pointer, id: object.id, limit: 2 } })
    assert.deepEqual((reviewedPage.result as { rows: unknown[][] }).rows, expected.slice(0, 2))
    let canReview = true
    const viewer = new SudographReviewHost({
      authorize: async binding => {
        assert.deepEqual({ workspaceId: binding.workspaceId, conversationId: binding.conversationId }, { workspaceId: 'model', conversationId: 'review-conversation' })
        if (!canReview) throw new Error('Review access revoked')
      },
      read: async (_model, request) => (await review(request)).result,
    })
    t.after(() => viewer.close())
    const launch = await viewer.createSession({ workspaceId: 'model', conversationId: 'review-conversation' })
    const cookie = { Cookie: launch.cookie.name + '=' + launch.cookie.value }
    assert.equal((await fetch(launch.url)).status, 403)
    const rendered = await fetch(launch.url, { headers: cookie })
    assert.equal(rendered.status, 200)
    assert.ok((await rendered.text()).includes(object.id), 'the installed shared host serves the actual worker-compiled graph')
    const browserRead = async (operation: string, params?: Record<string, unknown>) => {
      const response = await fetch(launch.url + 'v1', { method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ view: 'model', operation, ...(params ? { params } : {}) }) })
      assert.equal(response.status, 200)
      return (await response.json() as { result: Record<string, unknown> }).result
    }
    assert.deepEqual((await browserRead('page', { ...pointer, id: object.id, limit: 2 })).rows, expected.slice(0, 2))
    const staleReview = await review({ operation: 'page', params: { ...pointer, context_digest: '0'.repeat(64), id: object.id } }, 409)
    assert.equal(staleReview.error, 'CONTEXT_STALE')
    assert.ok(!JSON.stringify(staleReview).includes(root) && !JSON.stringify(staleReview).includes(token))
    const first = await call('sudograph_context_read', { ...pointer, id: object.id, records: true, limit: 2 })
    const last = await call('sudograph_context_read', { ...pointer, id: object.id, records: true, offset: 2, limit: 2 })
    assert.equal(first.data_kind, 'live_source_page')
    assert.deepEqual([...(first.rows as unknown[][]), ...(last.rows as unknown[][])], expected)
    const stale = await protocol.call('sudograph_context_read', { ...pointer, context_digest: '0'.repeat(64), id: object.id })
    assert.equal(stale.isError, true)
    assert.ok(JSON.stringify(stale).includes('CONTEXT_STALE') && JSON.stringify(stale).includes('sudograph_context'))
    assert.ok(!JSON.stringify(stale).includes(root) && !JSON.stringify(stale).includes(token))
    const contract = await call('sudograph_model_contract', {}) as {
      revision: string; write: { document_schema: { examples: { definitions: Record<string, { origin: string }> }[] } }
    }
    const example = structuredClone(contract.write.document_schema.examples[0])
    const invalid = structuredClone(example)
    Object.values(invalid.definitions)[0].origin = 'invented-origin'
    const refused = await protocol.call('sudograph_model_apply', {
      base_revision: contract.revision, operation_id: randomUUID(), model: stringify(invalid),
    })
    assert.equal(refused.isError, true)
    assert.ok(JSON.stringify(refused).includes('origin') && JSON.stringify(refused).includes('recovery'))
    assert.equal((await call('sudograph_model_contract', {})).revision, contract.revision, 'rejected writes cannot advance the model')
    const malformed = await protocol.call('sudograph_model_apply', {
      base_revision: contract.revision, operation_id: randomUUID(), model: `private-path: [${root}, ${token}\n`,
    })
    assert.equal(malformed.isError, true)
    assert.ok(!JSON.stringify(malformed).includes(root) && !JSON.stringify(malformed).includes(token))
    const edit = { base_revision: contract.revision, operation_id: randomUUID(), model: stringify(example) }
    const receipt = await call('sudograph_model_apply', edit)
    assert.notEqual(receipt.revision, contract.revision)
    assert.deepEqual(await call('sudograph_model_apply', edit), receipt, 'retry returns the same committed receipt')
    assert.equal((await call('sudograph_model_contract', {})).revision, receipt.revision)
    const changed = (await call('sudograph_context', {})).context as { revision: string; context_digest: string }
    assert.equal(changed.revision, receipt.revision)
    assert.equal(((await review({ operation: 'head' })).result as { revision: string }).revision, receipt.revision, 'review and agent context follow the same atomic commit')
    assert.equal((await browserRead('head')).revision, receipt.revision)
    canReview = false
    assert.equal((await fetch(launch.url, { headers: cookie })).status, 403, 'revocation prevents another compiler read')
    const model = await client.invoke<{ projection: { model_revision: string }; business: { definitions: Record<string, { review_status: string }> } }>('model', 'worker', { operation: 'read', product: 'model' })
    assert.equal(model.projection.model_revision, receipt.revision, 'graph and context share the committed model revision')
    assert.equal(Object.keys(model.business.definitions).length, Object.keys(example.definitions).length)
    assert.ok(Object.values(model.business.definitions).every(definition => definition.review_status === 'unreviewed'), 'compiling does not confirm business definitions')
    const retained = await call('sudograph_context_read', { revision: changed.revision, context_digest: changed.context_digest, id: object.id })
    assert.equal(retained.id, object.id, 'business edits retain canonical source identities')
    assert.equal(await digest(), initial, 'model authoring and reads preserve the source database')
  } finally { await protocol.close() }
})
