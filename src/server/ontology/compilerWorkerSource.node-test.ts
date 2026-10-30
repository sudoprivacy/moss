import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Pool } from 'pg'
import { SudographModelClient } from '@sudowork/sudograph-runtime'
import { ToolProtocol } from '../agentFederation/toolProtocol.js'
import { compilerWorkerConfiguration } from './compilerWorkerConfig.js'

void test('the worker CLI uses the shared provider and injected secret for an authorized PostgreSQL source', {
  skip: !process.env.MOSS_PG_TEST_URL || !process.env.MOSS_SUDOGRAPH_COMPILER_PYTHON, timeout: 60000,
}, async t => {
  const admin = new Pool({ connectionString: process.env.MOSS_PG_TEST_URL, max: 1 })
  const id = randomUUID().replaceAll('-', ''), schema = `worker_source_${id}`, role = `worker_reader_${id}`
  const password = randomUUID(), token = randomUUID(), root = await mkdtemp(join(tmpdir(), 'moss-worker-source-'))
  let hasSchema = false, hasRole = false
  t.after(async () => {
    try {
      if (hasSchema) await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      if (hasRole) await admin.query(`DROP ROLE ${role}`)
    } finally { await admin.end(); await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }) }
  })
  await admin.query(`CREATE SCHEMA ${schema}`)
  hasSchema = true
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
  hasRole = true
  await admin.query(`CREATE TABLE ${schema}.widgets(id INTEGER PRIMARY KEY, label TEXT);
    INSERT INTO ${schema}.widgets VALUES (1, 'source-row-only'), (2, NULL);
    CREATE VIEW ${schema}.widget_names AS SELECT id,label FROM ${schema}.widgets;
    CREATE TABLE ${schema}.concealed(id INTEGER PRIMARY KEY);
    GRANT USAGE ON SCHEMA ${schema} TO ${role};
    GRANT SELECT ON ${schema}.widgets, ${schema}.widget_names TO ${role}`)
  const expected = (await admin.query(`SELECT id,label FROM ${schema}.widgets ORDER BY id`)).rows
  const connection = new URL(process.env.MOSS_PG_TEST_URL!)
  const deployment = {
    binding: { authorityRef: 'source-acceptance', modelRef: 'model', sourceRefs: [id] }, actor: 'source-worker',
    runtime: { python: process.env.MOSS_SUDOGRAPH_COMPILER_PYTHON!, compilerRoot: root, modelDirectory: root,
      source: { dsn: `registered://${id}`, connector: { sourceType: 'postgresql', host: connection.hostname,
        port: Number(connection.port || 5432), database: decodeURIComponent(connection.pathname.slice(1)),
        username: role, params: { schema } } } }, host: '127.0.0.1', port: 0,
  }
  assert.throws(() => compilerWorkerConfiguration(deployment, {}), /injected SUDOGRAPH_SOURCE_PASSWORD/)
  assert.throws(() => compilerWorkerConfiguration({ ...deployment, runtime: { ...deployment.runtime,
    source: { ...deployment.runtime.source, connector: { ...deployment.runtime.source.connector, sourceType: 'mysql' } } } },
  { SUDOGRAPH_SOURCE_PASSWORD: password }), /MySQL scope is connector.database/)
  assert.throws(() => compilerWorkerConfiguration({ ...deployment, runtime: { ...deployment.runtime,
    source: { ...deployment.runtime.source, connector: { ...deployment.runtime.source.connector, password } } } },
  { SUDOGRAPH_SOURCE_PASSWORD: password }))
  const runtime = compilerWorkerConfiguration(deployment, { SUDOGRAPH_SOURCE_PASSWORD: password }).runtime
  const registered = await new SudographModelClient(runtime).registerSource('model', 'source-worker', {
    source: deployment.runtime.source.dsn, namespace: id, operationId: randomUUID(), language: 'en',
  })
  assert.equal(registered.registration.connection.provider, 'postgresql')
  assert.equal(registered.registration.scan.structure_complete, true)
  assert.equal(registered.registration.scan.objects, 2, 'only SELECT-visible tables and database views belong to this source scope')
  const path = join(root, 'deployment.json')
  await writeFile(path, JSON.stringify(deployment))
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./compilerContextWorkerCli.ts', import.meta.url)), path], {
    env: { ...process.env, SUDOGRAPH_WORKER_TOKEN: token, SUDOGRAPH_SOURCE_PASSWORD: password },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
  const diagnostics: string[] = []
  child.stderr.on('data', chunk => diagnostics.push(String(chunk)))
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Worker CLI readiness timed out')) }, 10000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Worker CLI exited before readiness: ' + diagnostics.join(''))) })
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      if (!buffer.includes('\n')) return
      clearTimeout(timer)
      try {
        const value = JSON.parse(buffer.split('\n')[0])
        assert.equal(value.format, 'sudograph-worker-ready/v1')
        assert.ok(Number.isSafeInteger(value.port) && value.port > 0 && value.port <= 65535)
        resolve(value.port)
      } catch (error) { child.kill(); reject(error) }
    })
  })
  const protocol = new ToolProtocol({ endpoint: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: `Bearer ${token}` }, timeoutMs: 15000 }, AbortSignal.timeout(45000))
  try {
    await protocol.connect()
    const call = async (name: string, input: Record<string, unknown>) => {
      const result = await protocol.call(name, input)
      assert.equal(result.isError, undefined, JSON.stringify(result))
      assert.ok(!JSON.stringify(result).includes(password) && !JSON.stringify(result).includes(token))
      const content = result.content[0]
      assert.ok(content?.type === 'text')
      return JSON.parse(content.text)
    }
    const packet = await call('sudograph_context', {})
    assert.ok(!packet.context.text.includes('source-row-only') && !packet.context.text.includes('concealed'))
    const pointer = { revision: packet.context.revision, context_digest: packet.context.context_digest }
    const catalog = await call('sudograph_context_read', { ...pointer, id: 'catalog' })
    const objects = catalog.sources.flatMap((item: { objects: { id: string; name: string }[] }) => item.objects) as { id: string; name: string }[]
    assert.deepEqual(objects.map(item => item.name).sort(), ['widget_names', 'widgets'])
    const review = async (request: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${port}/review`, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
      assert.equal(response.status, 200)
      const body = await response.json() as { result: Record<string, unknown> }
      assert.ok(!JSON.stringify(body).includes(password) && !JSON.stringify(body).includes(token) && !JSON.stringify(body).includes('concealed'))
      return body.result
    }
    assert.equal((await review({ operation: 'head' })).revision, packet.context.revision)
    for (const object of objects) {
      const page = await call('sudograph_context_read', { ...pointer, id: object.id, records: true, limit: 10 })
      assert.equal(page.data_kind, 'live_source_page')
      assert.deepEqual(page.rows, expected.map(row => [row.id, row.label]))
      const reviewed = await review({ operation: 'page', params: { ...pointer, id: object.id, limit: 10 } })
      assert.deepEqual(reviewed.rows, page.rows, 'the human review retains the same restricted source scope and live values')
    }
    assert.deepEqual((await admin.query(`SELECT id,label FROM ${schema}.widgets ORDER BY id`)).rows, expected)
    assert.ok(!diagnostics.join('').includes(password) && !diagnostics.join('').includes(token))
  } finally { await protocol.close() }
})
