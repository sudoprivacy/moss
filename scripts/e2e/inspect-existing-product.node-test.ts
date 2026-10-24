import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

async function journey(redirect: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'moss-product-inspect-'))
  const calls: string[] = []
  let redirectedCalls = 0
  const untrusted = createServer((_req, res) => { redirectedCalls++; res.end('{}') })
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`)
    if (redirect && req.url === '/api/v1/auth/login') {
      res.writeHead(307, { location: `http://127.0.0.1:${(untrusted.address() as any).port}/credential-sink` }); res.end(); return
    }
    const routes: Record<string, unknown> = {
      '/api/v1/auth/login': { access_token: 'private-token', refresh_token: 'private-refresh' },
      '/api/v1/auth/me': { user: { id: 'owner-existing' } },
      '/api/v1/sessions': { sessions: [{ sessionId: 'old-session', runtime: { type: 'cohost' } }] },
      '/api/v1/sessions/old-session/context': { context: { messages: [{ role: 'user', content: 'private-history' }] } },
      '/api/v1/auth/logout': { ok: true },
    }
    assert(req.url && req.url in routes)
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(routes[req.url]))
  })
  try {
    untrusted.listen(0, '127.0.0.1'); await once(untrusted, 'listening')
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const config = join(root, 'server.json'), evidence = join(root, 'evidence')
    writeFileSync(config, JSON.stringify({ server: { port: (server.address() as any).port },
      bootstrapAdmin: { username: 'existing', password: 'private-password' } }), { mode: 0o600 })
    const child = spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'),
      resolve('scripts/e2e/inspect-existing-product.ts'), config, evidence], { stdio: ['ignore','pipe','pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const [exit] = await once(child, 'close')
    const result = JSON.parse(readFileSync(join(evidence, 'receipt.json'), 'utf8'))
    for (const secret of ['private-password','private-token','private-refresh','private-history']) {
      assert(!JSON.stringify(result).includes(secret)); assert(!stdout.includes(secret)); assert(!stderr.includes(secret))
    }
    return { exit, result, calls, redirectedCalls }
  } finally {
    server.closeAllConnections(); untrusted.closeAllConnections()
    await Promise.all([new Promise<void>(done => server.close(() => done())),new Promise<void>(done => untrusted.close(() => done()))])
    rmSync(root, { recursive: true, force: true })
  }
}

void test('product inspection reads history, creates no execution and logs out only its token', async () => {
  const result = await journey(false)
  assert.equal(result.exit, 0)
  assert.equal(result.result.authenticatedProductReadAccepted, true)
  assert.equal(result.result.nativeHistoryRecoveryAccepted, false)
  assert.equal(result.result.probeTokenLoggedOut, true)
  assert.deepEqual(result.calls, ['POST /api/v1/auth/login','GET /api/v1/auth/me','GET /api/v1/sessions',
    'GET /api/v1/sessions/old-session/context','POST /api/v1/auth/logout'])
})

void test('product inspection refuses redirects before credentials reach another endpoint', async () => {
  const result = await journey(true)
  assert.equal(result.exit, 1)
  assert.equal(result.redirectedCalls, 0)
  assert.deepEqual(result.calls, ['POST /api/v1/auth/login'])
})
