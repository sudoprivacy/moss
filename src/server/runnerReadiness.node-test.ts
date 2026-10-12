import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { waitForRunnerReady } from './runtimeService.js'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'moss-runner-ready-'))
  const attach = process.platform === 'win32' ? `\\\\.\\pipe\\moss-ready-${randomUUID()}` : join(root, 'runner.sock')
  const status = join(root, 'status.json')
  const stderr = join(root, 'stderr.log')
  const clients = new Set<Socket>()
  const server = createServer(socket => {
    clients.add(socket)
    socket.on('close', () => clients.delete(socket))
  })
  server.listen(attach)
  await once(server, 'listening')
  t.after(async () => {
    for (const client of clients) client.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })
  return { attach, status, stderr }
}

void test('a listening runner stays unavailable until its execution backend is running', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  await writeFile(f.status, JSON.stringify({ state: 'starting' }))
  const ready = waitForRunnerReady(f.attach, f.status, f.stderr, 5000)
  assert.equal(await Promise.race([ready.then(() => 'ready'), delay(150).then(() => 'starting')]), 'starting')
  await writeFile(f.status, JSON.stringify({ state: 'running' }))
  await ready
})

void test('a backend failure is reported even while the runner socket is still accepting connections', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  await writeFile(f.status, JSON.stringify({ state: 'starting' }))
  const ready = assert.rejects(waitForRunnerReady(f.attach, f.status, f.stderr, 5000), /Kubernetes backend unavailable/)
  await delay(50)
  await writeFile(f.status, JSON.stringify({ state: 'failed', error: 'Kubernetes backend unavailable' }))
  await ready
})

void test('malformed status never turns a listening socket into a ready execution', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  await writeFile(f.status, '{')
  await assert.rejects(waitForRunnerReady(f.attach, f.status, f.stderr, 250), /Timed out waiting/)
})
