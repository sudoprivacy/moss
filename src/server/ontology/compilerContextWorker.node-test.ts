import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { SudographModelClient } from '@sudowork/sudograph-runtime'
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
  const protocol = new ToolProtocol({ endpoint, headers: { Authorization: `Bearer ${token}` }, timeoutMs: 5000 }, AbortSignal.timeout(10000))
  try {
    await protocol.connect()
    const descriptors = await protocol.descriptors()
    assert.deepEqual(descriptors.map(item => item.tool.name).sort(), ['sudograph_context', 'sudograph_context_read'])
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
  } finally { await protocol.close() }
})

void test('a worker cannot start with a missing or weak deployment credential', () => {
  const config = { binding: { authorityRef: 'authority', modelRef: 'model', sourceRefs: ['source'] }, actor: 'worker',
    runtime: { python: 'python', compilerRoot: '.', modelDirectory: '.' } }
  for (const token of ['', 'short', 'x'.repeat(513), 'x'.repeat(32) + '\n']) {
    assert.throws(() => createCompilerContextWorker({ ...config, token }), /deployment-owned worker token/)
  }
})

void test('the production worker reads exact pointers and live pages through the published compiler', {
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
    binding: { authorityRef: 'authority', modelRef: 'model', sourceRefs: ['source'] } })
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
    const context = packet.context as { revision: string; context_digest: string; text: string }
    assert.ok(!context.text.includes('row-only-sentinel'), 'records must not be preloaded into context')
    const pointer = { revision: context.revision, context_digest: context.context_digest }
    const catalog = await call('sudograph_context_read', { ...pointer, id: 'catalog' })
    const sources = catalog.sources as { objects: { id: string; name: string }[] }[]
    const object = sources.flatMap(item => item.objects).find(item => item.name === 'widgets')
    assert.ok(object)
    const first = await call('sudograph_context_read', { ...pointer, id: object.id, records: true, limit: 2 })
    const last = await call('sudograph_context_read', { ...pointer, id: object.id, records: true, offset: 2, limit: 2 })
    assert.equal(first.data_kind, 'live_source_page')
    assert.deepEqual([...(first.rows as unknown[][]), ...(last.rows as unknown[][])], expected)
    const stale = await protocol.call('sudograph_context_read', { ...pointer, context_digest: '0'.repeat(64), id: object.id })
    assert.equal(stale.isError, true)
    assert.ok(JSON.stringify(stale).includes('CONTEXT_STALE') && JSON.stringify(stale).includes('sudograph_context'))
    assert.ok(!JSON.stringify(stale).includes(root) && !JSON.stringify(stale).includes(token))
    assert.equal(await digest(), initial, 'all reads preserve the source database')
  } finally { await protocol.close() }
})
