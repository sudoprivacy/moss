/** Authenticate to the configured local Moss and read one existing UI history.
 * No account, Agent, session or model turn is created. Tokens stay in memory.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { serverFileConfigSchema } from '../../src/server/types.js'

const [configPath, evidence] = process.argv.slice(2)
assert(configPath && evidence && isAbsolute(configPath) && isAbsolute(evidence), 'Use absolute existing-config and new-evidence paths')
if (process.platform !== 'win32') {
  const metadata = statSync(configPath)
  assert.equal(metadata.uid, process.getuid?.(), 'Use the current owner configuration')
  assert.equal(metadata.mode & 0o077, 0, 'Configuration with credentials must be owner-only')
}
const raw = JSON.parse(readFileSync(configPath, 'utf8'))
const config = serverFileConfigSchema().parse(raw)
// Never try a parser's default credential or a credential for a different app.
assert(typeof raw.bootstrapAdmin?.username === 'string' && raw.bootstrapAdmin.username &&
  typeof raw.bootstrapAdmin?.password === 'string' && raw.bootstrapAdmin.password,
'An explicitly configured existing Moss credential is required')
const base = `http://127.0.0.1:${config.server.port}`
mkdirSync(evidence, { mode: 0o700 })
const report: Record<string, unknown> = { schemaVersion: 1, baseUrl: base, accountCreated: false,
  agentCreated: false, sessionCreated: false, turnSubmitted: false,
  nativeHistoryRecoveryAccepted: false, modelJourneyAccepted: false }
let token = '', refresh = ''
async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + path, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15_000),
  })
  assert.equal(response.status, 200, `${method} ${path.split('?')[0]} returned ${response.status}`)
  return response.json() as Promise<any>
}
try {
  const login = await request('/api/v1/auth/login', 'POST', {
    grant_type: 'password', username: raw.bootstrapAdmin.username, password: raw.bootstrapAdmin.password,
  })
  assert(typeof login.access_token === 'string' && login.access_token, 'No native login token returned')
  token = login.access_token; refresh = login.refresh_token
  const me = await request('/api/v1/auth/me')
  assert(me.user?.id, 'No authenticated owner returned')
  report.ownerId = me.user.id
  const listed = await request('/api/v1/sessions')
  assert(Array.isArray(listed.sessions), 'No native session list returned')
  report.visibleSessionCount = listed.sessions.length
  const candidates = listed.sessions.filter((session: any) => session.runtime?.type === 'cohost' || session.runtimeType === 'cohost')
  const reads = []
  for (const session of candidates.slice(0, 3)) {
    const id = session.sessionId ?? session.session_id
    assert(typeof id === 'string' && id, 'Missing existing session identity')
    const result = await request(`/api/v1/sessions/${encodeURIComponent(id)}/context`)
    assert(Array.isArray(result.context?.messages), 'No persisted context returned')
    const bytes = JSON.stringify(result.context)
    reads.push({ sessionId: id, messages: result.context.messages.length,
      projectedContextSha256: createHash('sha256').update(bytes).digest('hex') })
    if (result.context.messages.length > 0) break
  }
  report.existingHistoryReads = reads
  assert(reads.some(value => value.messages > 0), 'No existing cohost UI history was read')
  report.authenticatedProductReadAccepted = true
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Product inspection failed'
  process.exitCode = 1
} finally {
  if (token) {
    try { await request('/api/v1/auth/logout', 'POST', { ...(refresh ? { refresh_token: refresh } : {}) }); report.probeTokenLoggedOut = true }
    catch { report.probeTokenLoggedOut = false; process.exitCode = 1 }
  }
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify(report))
}
