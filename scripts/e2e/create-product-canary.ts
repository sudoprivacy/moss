/** Explicitly create one operator-owned live fixture; report its identity for cleanup. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { productConversation } from './productConversation.js'
import { assertProductConversationUrl } from './productConversationUrl.js'

const [configPath, evidence] = process.argv.slice(2)
assert(configPath && evidence && isAbsolute(configPath) && isAbsolute(evidence))
if (process.platform !== 'win32') {
  const metadata = statSync(configPath)
  assert.equal(metadata.uid, process.getuid?.())
  assert.equal(metadata.mode & 0o077, 0)
}
const config = JSON.parse(readFileSync(configPath, 'utf8'))
assert(config.bootstrapAdmin?.username && config.bootstrapAdmin?.password)
const base = `http://127.0.0.1:${config.server.port}`
mkdirSync(evidence, { mode: 0o700 })
let token = '', refresh = ''
const report: Record<string, unknown> = { fixtureCreated: false, modelSeedAccepted: false }
async function request(path: string, body?: unknown, timeoutMs = 15_000) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  if (response.status !== 200) {
    writeFileSync(join(evidence, `http-failure-${randomUUID()}.private.json`),
      JSON.stringify({ path, status: response.status, response: (await response.text()).slice(0, 65536) }), { mode: 0o600 })
  }
  assert.equal(response.status, 200, `Product canary ${path} returned ${response.status}`)
  return response.json() as Promise<any>
}
try {
  const login = await request('/api/v1/auth/login', { grant_type: 'password',
    username: config.bootstrapAdmin.username, password: config.bootstrapAdmin.password })
  token = login.access_token; refresh = login.refresh_token
  assert(token)
  const me = await request('/api/v1/auth/me')
  assert(me.user?.id)
  report.ownerId = me.user.id
  const created = await request('/api/v1/sessions', { runtime: { type: 'cohost' } }, 180_000)
  assert(typeof created.session_id === 'string' && /^[a-f0-9-]{36}$/.test(created.session_id))
  report.sessionId = created.session_id
  report.fixtureCreated = true
  writeFileSync(join(evidence, 'created.private.json'), JSON.stringify({ sessionId: created.session_id, ownerId: me.user.id }), { mode: 0o600, flag: 'wx' })
  assert.equal(created.runtime?.type, 'cohost')
  assertProductConversationUrl(created.ws_url, base, config.server.publicBaseUrl, created.session_id,
    config.server.routeCookieName ?? 'moss_route')
  const conversation = productConversation(created.ws_url, token, evidence, 'seed')
  try {
    await conversation.ready()
    const marker = `RECOVERY_SEED_${randomUUID().replaceAll('-', '')}`
    assert.equal((await conversation.turn(`Reply only ${marker}. Do not use tools.`)).trim(), marker)
    report.modelSeedAccepted = true
  } finally { conversation.close() }
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Product canary failed'
  process.exitCode = 1
} finally {
  if (token) {
    try { await request('/api/v1/auth/logout', { ...(refresh ? { refresh_token: refresh } : {}) }); report.probeTokenLoggedOut = true }
    catch { report.probeTokenLoggedOut = false; process.exitCode = 1 }
  }
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify(report))
}
