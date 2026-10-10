/** Real provider through the deployed REST, WebSocket and persisted context APIs. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'

const [baseUrl, credentialsFile, evidence, ...runtimes] = process.argv.slice(2)
assert.equal(process.env.MOSS_COHOST_LIVE, '1', 'Explicit live-provider opt-in is required')
assert(baseUrl && credentialsFile && evidence && runtimes.length)
assert(runtimes.every(type => ['cohost', 'k8s'].includes(type)))
const credentials = JSON.parse(readFileSync(credentialsFile, 'utf8'))
assert.equal(credentials.fixture_owner, 'pc3-production-acceptance-20261010', 'Use an isolated acceptance account')
mkdirSync(evidence, { recursive: true, mode: 0o700 })
const legacyRuntime = process.env.MOSS_SESSION_LEGACY_RUNTIME === '1'
let token = ''
async function request(path: string, method = 'GET', body?: unknown, expected = 200) {
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180_000),
  })
  if (response.status !== expected) {
    writeFileSync(join(evidence, 'http-failure.private.json'), JSON.stringify({ method, path, status: response.status, response: await response.text() }), { mode: 0o600 })
  }
  assert.equal(response.status, expected, `${method} ${path} returned ${response.status}`)
  return response.json() as Promise<any>
}
function conversation(url: string, name: string) {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
  const events: any[] = []
  let resolveHello: (() => void) | undefined
  let rejectHello: ((error: Error) => void) | undefined
  const hello = new Promise<void>((resolve, reject) => { resolveHello = resolve; rejectHello = reject })
  let pending: { resolve(value: string): void, reject(error: Error): void, text: string } | undefined
  const fail = (error: Error) => { rejectHello?.(error); pending?.reject(error); pending = undefined }
  socket.on('error', fail)
  socket.on('close', () => { if (pending) fail(new Error('WebSocket closed during a live turn')) })
  socket.on('message', bytes => {
    try {
      const event = JSON.parse(bytes.toString())
      events.push(event)
      if (event.type === 'hello') resolveHello?.()
      if (event.type === 'error' || event.type === 'control_request') throw new Error(`Unexpected live event: ${event.type}`)
      if (event.type === 'assistant' && pending) {
        const content = event.message?.content
        pending.text += typeof content === 'string' ? content : Array.isArray(content)
          ? content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('') : ''
      }
      if (event.type === 'result' && pending) {
        assert.equal(event.status, 'success')
        pending.resolve(pending.text); pending = undefined
      }
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
  })
  return {
    ready: () => Promise.race([hello, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('WebSocket hello timed out')), 30_000).unref())]),
    async turn(text: string) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await new Promise<string>((resolve, reject) => {
          assert(!pending)
          pending = { resolve, reject, text: '' }
          timer = setTimeout(() => fail(new Error('Live WebSocket turn timed out')), 180_000)
          socket.send(JSON.stringify({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: text } }))
        })
      } finally { clearTimeout(timer) }
    },
    close() { writeFileSync(join(evidence, `${name}.private.json`), JSON.stringify(events)); socket.close() },
  }
}
const parseReply = (text: string) => JSON.parse(text.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim())
const login = await request('/api/v1/auth/login', 'POST', { grant_type: 'password', username: credentials.username, password: credentials.password })
token = login.access_token
assert(token)
const me = await request('/api/v1/auth/me')
assert(me.user.id)
await request('/api/v1/users/me/model', 'PUT', { modelId: 'gpt-6-luna' })
const reports = []
for (const type of runtimes) {
  let sessionId: string | undefined
  let controller: ReturnType<typeof conversation> | undefined
  const code = `QUOTE_${randomUUID().replaceAll('-', '')}`
  const units = 7 + Math.floor(Math.random() * 13)
  const subtotal = units * 29 + 47
  try {
    const created = await request('/api/v1/sessions', 'POST', { ...(legacyRuntime ? { runtime_type: type } : { runtime: { type } }), title: `PC3 live acceptance ${code}` })
    sessionId = created.session_id
    assert(sessionId); assert.equal(created.runtime.type, type)
    controller = conversation(created.ws_url, `${type}-first`)
    await controller.ready()
    assert.deepEqual(parseReply(await controller.turn(`Order code ${code}: ${units} units, unit price 29, delivery 47. Calculate subtotal as units times unit price plus delivery. Reply only JSON with code and subtotal. Do not use tools.`)), { code, subtotal })
    assert.deepEqual(parseReply(await controller.turn('Add a handling fee of 13 to that subtotal. Use the order code from this conversation. Reply only JSON with code and total. Do not use tools.')), { code, total: subtotal + 13 })
    controller.close(); controller = undefined
    const resumed = await request(`/api/v1/sessions/${sessionId}/resume`, 'POST', {})
    assert.equal(resumed.session.sessionId, sessionId)
    controller = conversation(resumed.ws_url, `${type}-reattached`)
    await controller.ready()
    assert.deepEqual(parseReply(await controller.turn('Recall the order code and final total from this conversation. Reply only JSON with code and total. Do not use tools.')), { code, total: subtotal + 13 })
    const context = await request(`/api/v1/sessions/${sessionId}/context`)
    assert(JSON.stringify(context.context.messages).includes(code), 'HTTP transcript must contain this fresh conversation')
    reports.push({ runtime: type, runtime_image: type === 'k8s' ? context.session.runtime.k8sImage : undefined, sessionId, code, dependent_turn_verified: true, reattach_verified: true, persisted_http_context_verified: true })
  } finally {
    controller?.close()
    if (sessionId) await request(`/api/v1/sessions/${sessionId}/terminate`, 'POST', {})
  }
}
const proof = { passed: true, real_model: true, user_id: me.user.id, base_url: baseUrl, request_format: legacyRuntime ? 'runtime_type' : 'runtime.type', runtimes: reports }
writeFileSync(join(evidence, 'acceptance.json'), JSON.stringify(proof, null, 2))
console.log(JSON.stringify(proof))
