import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { downloadWithFallback } from '../fetch-nexus-runtime.js'

test('runtime downloads recover from truncated or stalled responses and enforce the pinned checksum', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-artifact-download-'))
  const body = Buffer.from('the complete pinned runtime')
  const sha = createHash('sha256').update(body).digest('hex')
  const hits = []
  const server = createServer((request, response) => {
    hits.push(request.url)
    if (request.url === '/stall') return
    if (request.url === '/truncated') {
      response.writeHead(200, { 'content-length': body.length })
      response.flushHeaders()
      response.write(body.subarray(0, 3))
      setImmediate(() => response.destroy())
      return
    }
    if (request.url === '/bad') { response.end('wrong artifact'); return }
    response.end(body)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  for (const failure of ['truncated', 'stall', 'bad']) {
    const destination = join(root, failure)
    await downloadWithFallback([
      { label: 'first', url: `${base}/${failure}` },
      { label: 'mirror', url: `${base}/complete` },
    ], sha, destination, { timeoutMs: 2000 })
    assert.deepEqual(await readFile(destination), body)
  }
  assert.deepEqual(hits, ['/truncated', '/complete', '/stall', '/complete', '/bad', '/complete'])
  const rejected = join(root, 'rejected')
  await assert.rejects(downloadWithFallback([{ label: 'bad', url: `${base}/bad` }], sha, rejected), /sha256 mismatch/)
  await assert.rejects(readFile(rejected), { code: 'ENOENT' })
})
