import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { productConversation } from './productConversation.js'

async function journey(redirect: boolean, resume = false, terminate = false, ownerMatches = true, inspectOnly = false) {
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
      '/api/v1/sessions': { sessions: [...(inspectOnly ? [{sessionId:'other-session',runtime:{type:'cohost'}}] : []),{ sessionId: 'old-session', runtime: { type: 'cohost' } }] },
      '/api/v1/sessions/old-session/context': { session: { sessionId:'old-session',userId:ownerMatches ? 'owner-existing' : 'other-owner',workDir:join(root,'workspace') },
        context: { messages: [{ role: 'user', content: 'private-history' }] } },
      '/api/v1/sessions/old-session/terminate': { ok:true },
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
      resolve('scripts/e2e/inspect-existing-product.ts'), config, evidence,
      ...(inspectOnly ? ['--inspect-existing','old-session'] : resume ? ['--resume-existing','old-session'] : terminate ? ['--terminate-existing','old-session'] : [])], { stdio: ['ignore','pipe','pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const [exit] = await once(child, 'close')
    assert(existsSync(join(evidence, 'receipt.json')), `Product probe exited ${exit} before its receipt: ${stderr}`)
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

void test('explicit inspection selects the original owned session without resuming or a model turn', async () => {
  const result = await journey(false,false,false,true,true)
  assert.equal(result.exit,0)
  assert.equal(result.result.nativeExecutionResumeRequested,false)
  assert.equal(result.result.turnSubmitted,false)
  assert.equal(result.result.existingHistoryReads[0].sessionId,'old-session')
  assert.deepEqual(result.calls,['POST /api/v1/auth/login','GET /api/v1/auth/me','GET /api/v1/sessions',
    'GET /api/v1/sessions/old-session/context','POST /api/v1/auth/logout'])
})

void test('explicit inspection refuses another owner before any execution request', async () => {
  const result = await journey(false,false,false,false,true)
  assert.equal(result.exit,1)
  assert.equal(result.result.turnSubmitted,false)
  assert.equal(result.result.probeTokenLoggedOut,true)
  assert(!result.calls.some(call => call.endsWith('/resume')))
})

void test('recovery reads the public workDir and refuses a missing locator before any resume request', async () => {
  const result = await journey(false,true)
  assert.equal(result.exit,1)
  assert.match(result.result.error,/Keep the existing native locator/)
  assert.equal(result.result.probeTokenLoggedOut,true)
  assert(!result.calls.some(call => call.endsWith('/resume')))
})

void test('explicit execution cleanup terminates only the selected owned product session without resume or a model turn', async () => {
  const result = await journey(false,false,true)
  assert.equal(result.exit,0)
  assert.equal(result.result.executionTerminationHttpAccepted,true)
  assert.equal(result.result.nativeExecutionResumeRequested,false)
  assert.equal(result.result.probeTokenLoggedOut,true)
  assert.deepEqual(result.calls, ['POST /api/v1/auth/login','GET /api/v1/auth/me','GET /api/v1/sessions',
    'GET /api/v1/sessions/old-session/context','POST /api/v1/sessions/old-session/terminate','POST /api/v1/auth/logout'])
})

void test('explicit cleanup refuses a session belonging to another owner before termination', async () => {
  const result = await journey(false,false,true,false)
  assert.equal(result.exit,1)
  assert.equal(result.result.probeTokenLoggedOut,true)
  assert(!result.calls.some(call => call.endsWith('/terminate')))
})

for (const control of [false,true]) void test(`shared product conversation ${control ? 'refuses a permission request without retry or approval' : 'uses the real WebSocket protocol and preserves text blocks'}`, async () => {
  const root = mkdtempSync(join(tmpdir(),'moss-product-ws-'))
  const server = new WebSocketServer({ host:'127.0.0.1',port:0 })
  const received: any[] = []
  let authorization: string | undefined
  server.on('connection',(socket,request) => {
    authorization = request.headers.authorization
    socket.send(JSON.stringify({type:'hello'}))
    socket.on('message',raw => {
      received.push(JSON.parse(raw.toString()))
      if (control) socket.send(JSON.stringify({type:'control_request',request_id:'do-not-approve'}))
      else {
        socket.send(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'\u4e2d\u6587\x00'}]}}))
        socket.send(JSON.stringify({type:'assistant',message:{content:'done'}}))
        socket.send(JSON.stringify({type:'result',status:'success'}))
      }
    })
  })
  await once(server,'listening')
  const port = (server.address() as any).port
  const conversation = productConversation(`ws://127.0.0.1:${port}`,'fixture-token',root,'case')
  try {
    await conversation.ready()
    if (control) await assert.rejects(conversation.turn('test'),/control_request/)
    else assert.equal(await conversation.turn('test'),'\u4e2d\u6587\x00done')
    assert.equal(authorization,'Bearer fixture-token')
    assert.equal(received.length,1)
    assert.equal(received[0].type,'user')
    assert.deepEqual(received[0].message,{role:'user',content:'test'})
  } finally {
    conversation.close()
    for (const client of server.clients) client.terminate()
    await new Promise<void>(done => server.close(() => done()))
    rmSync(root,{recursive:true,force:true})
  }
})
