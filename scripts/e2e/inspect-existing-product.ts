/** Authenticate and read existing UI history. Explicit --resume-existing also
 * resumes that same product session; no new session or model turn is created.
 * Tokens stay in memory. The owning fixture/operator controls its lifecycle.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { serverFileConfigSchema } from '../../src/server/types.js'
import { sessionAgentName } from '../../src/server/agentIdentity.js'
import { readCohostSessionState } from '../../src/server/backends/cohostSessionState.js'
import { CohostSessionRepository } from '../../src/server/runtime/cohostSessionRepository.js'
import { SqliteDriver } from '../../src/server/db/driver.js'
import { DatabaseSync } from 'node:sqlite'

const [configPath, evidence, action, requestedSessionId] = process.argv.slice(2)
assert(configPath && evidence && isAbsolute(configPath) && isAbsolute(evidence), 'Use absolute existing-config and new-evidence paths')
assert((action === undefined && requestedSessionId === undefined) ||
  (action === '--resume-existing' && requestedSessionId), 'Explicit --resume-existing SESSION_ID is required for recovery')
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
  nativeHistoryRecoveryAccepted: false, modelJourneyAccepted: false, nativeExecutionResumeRequested: Boolean(action) }
let token = '', refresh = ''
let failures = 0
async function request(path: string, method = 'GET', body?: unknown, timeoutMs = 15_000) {
  const response = await fetch(base + path, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
  })
  if (response.status !== 200) {
    writeFileSync(join(evidence, `http-failure-${++failures}.private.json`), JSON.stringify({
      method,path,status:response.status,response:(await response.text()).slice(0,65536),
    }), { mode:0o600,flag:'wx' })
  }
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
  const candidates = listed.sessions.filter((session: any) =>
    (session.runtime?.type === 'cohost' || session.runtimeType === 'cohost') &&
    (!requestedSessionId || (session.sessionId ?? session.session_id) === requestedSessionId))
  if (requestedSessionId) assert.equal(candidates.length, 1, 'The existing cohost session must be visible to this account')
  const reads = []
  for (const session of candidates.slice(0, 3)) {
    const id = session.sessionId ?? session.session_id
    assert(typeof id === 'string' && id, 'Missing existing session identity')
    const result = await request(`/api/v1/sessions/${encodeURIComponent(id)}/context`)
    assert(Array.isArray(result.context?.messages), 'No persisted context returned')
    const bytes = JSON.stringify(result.context)
    const messagesSha256 = createHash('sha256').update(JSON.stringify(result.context.messages)).digest('hex')
    reads.push({ sessionId: id, messages: result.context.messages.length,
      messagesSha256, projectedContextSha256: createHash('sha256').update(bytes).digest('hex') })
    if (action === '--resume-existing') {
      assert.equal(session.userId, me.user.id, 'Recovery requires the actual existing owner')
      assert(typeof session.cwd === 'string' && session.cwd, 'Existing workspace is required')
      const legacy = await readCohostSessionState(session.cwd)
      assert(legacy?.durableSessionId && legacy.repositoryPath, 'Keep the existing native locator; never initialize a replacement')
      const expectedAgent = sessionAgentName(me.user.id, session.assistantName)
      // Match the existing deployed-session journey's REST recovery budget;
      // ordinary read/login probes retain their separate 15-second bound.
      const resumed = await request(`/api/v1/sessions/${encodeURIComponent(id)}/resume`, 'POST', {}, 180_000)
      assert.equal(resumed.session?.sessionId, id, 'Logical product session changed')
      // The full configuration resolver reaches producer-bundled feature
      // imports. Keep it out of the standalone read-only inspection path.
      const { readServerConfig } = await import('../../src/server/config.js')
      const resolved = (await readServerConfig(configPath)).config
      assert.equal(resolved.dbBackend, 'sqlite', 'This recovery journey requires the existing SQLite store')
      const db = new DatabaseSync(resolved.dbPath, { readOnly:true })
      let binding
      try { binding = await new CohostSessionRepository(new SqliteDriver(db)).get(id) } finally { db.close() }
      assert.deepEqual(binding, { ownerId:me.user.id,agentId:expectedAgent,
        durableSessionId:legacy.durableSessionId,repositoryPath:legacy.repositoryPath }, 'Native recovery binding changed')
      const after = await request(`/api/v1/sessions/${encodeURIComponent(id)}/context`)
      assert.equal(createHash('sha256').update(JSON.stringify(after.context?.messages)).digest('hex'), messagesSha256,
        'Persisted UI history changed during resume without a turn')
      report.nativeResumeAccepted = true
      report.nativeBindingPreserved = binding
      report.projectedContextPreserved = true
      report.executionLifecycleOwner = 'Moss operator or enclosing private-copy fixture'
    }
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
