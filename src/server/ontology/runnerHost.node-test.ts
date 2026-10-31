import { createReviewHostFixture as fixture } from './reviewHostFixture.js'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { ISudographReviewHostOptions, ShareoneReviewAssets } from '@sudowork/sudograph-runtime'
import { test } from 'node:test'
import { RuntimeService } from '../runtimeService.js'
import { NexusClient } from '../nexus/nexusClient.js'
import { orgScopedNamespace, secretSubject } from '../secrets/secretSubject.js'
import { createSharedModelReviewHost } from './sharedReviewHost.js'
import { createSessionRunnerHost } from './runnerHost.js'
import { createModelSession, getSessionProject, listProjectSessions, listSessionProjects, parseOntologyProjectId, withSessionProjectAccess } from './sessionProjects.js'

void test('the production shared review composition mounts current host policy and durable browser grants', async t => {
  const f = await fixture(t, true)
  let current: Awaited<ReturnType<typeof createSharedModelReviewHost>>
  const server = createServer((req, res) => {
    void current.handleRequest(req, res).then(handled => { if (!handled) res.writeHead(404).end() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const comments: NonNullable<ISudographReviewHostOptions['comments']> = {
    assets: { shell: (_prefix: string, config: unknown) => JSON.stringify(config), get: () => undefined } as unknown as ShareoneReviewAssets,
    prepare: async () => ({ shareId: 'private-comment-space' }), proxy: async () => ({ status: 200, body: {} }),
    status: async () => ({ delivered: 0 }),
  }
  const make = () => createSharedModelReviewHost(f.store, { origin, comments })
  current = await make()
  t.after(async () => { await current.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  await assert.rejects(createSharedModelReviewHost(f.store, { origin, comments: undefined! }), /requires the existing comment provider/)
  await assert.rejects(current.open({ orgId: 'org', userId: 'bob' }, 'session'), /authorization is unavailable/)
  await assert.rejects(current.open({ orgId: 'foreign', userId: 'alice' }, 'session'), /authorization is unavailable/)
  const launch = await current.open({ orgId: 'org', userId: 'alice' }, 'session')
  assert.equal((await fetch(launch.url)).status, 403)
  const headers = { Cookie: launch.cookie.name + '=' + launch.cookie.value }
  const shell = await (await fetch(launch.url, { headers })).json() as { allow_comments: boolean }
  assert.equal(shell.allow_comments, true)
  const readHead = async () => {
    const response = await fetch(launch.url + 'v1', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ view: f.project.projectId, operation: 'head' }) })
    assert.equal(response.status, 200)
    return (await response.json() as { result: { revision: string } }).result.revision
  }
  assert.equal(await readHead(), 'a'.repeat(64))
  const previous = current
  current = await make()
  await previous.close()
  f.state.revision = 'c'.repeat(64)
  assert.equal(await readHead(), f.state.revision, 'model changes and host replacement retain the same durable grant')
  await f.store.ontologyProjects.setEnabled('org', f.project.projectId, false)
  await f.store.ontologyProjects.setEnabled('org', f.project.projectId, true)
  const calls = f.state.reviewCalls
  assert.equal((await fetch(launch.url, { headers })).status, 403)
  assert.equal(f.state.reviewCalls, calls, 'a stale generation cannot dispatch a worker read')
  const fresh = await current.open({ orgId: 'org', userId: 'alice' }, 'session')
  assert.ok((await f.store.driver.get('SELECT count(*) AS n FROM ontology_review_grants'))?.n)
  await fresh.revoke()
  assert.equal((await fetch(fresh.url, { headers: { Cookie: fresh.cookie.name + '=' + fresh.cookie.value } })).status, 403)
})

void test('project discovery returns only current authorized canonical references without reading business context', async t => {
  const f = await fixture(t)
  await f.store.ontologyProjects.register({ orgId: 'org', authorityRef: 'hidden', workerRef: 'unreviewed-worker', modelRef: 'hidden', sourceRefs: ['hidden-source'] })
  await f.store.ontologyProjects.register({ orgId: 'other', authorityRef: 'foreign', workerRef: f.server.id, modelRef: 'foreign', sourceRefs: ['foreign-source'] })
  assert.deepEqual(await listSessionProjects(f.store, { orgId: 'org', userId: 'alice' }), { projects: [{
    project_id: f.project.projectId, authority_ref: 'authority', model_ref: 'model', source_refs: ['source'],
  }] })
  assert.equal(f.state.calls, 0)
  await f.mcp.updateMcpServer('org', f.server.id, { visible_to: { user_ids: [] } }, 'manager')
  assert.deepEqual(await listSessionProjects(f.store, { orgId: 'org', userId: 'alice' }), { projects: [] })
})

void test('project filtering narrows existing session ownership and excludes unbound, stale and deleted sessions', async t => {
  const f = await fixture(t)
  const other = await f.store.ontologyProjects.register({ orgId: 'org', authorityRef: 'other',
    workerRef: f.server.id, modelRef: 'other', sourceRefs: ['source'] })
  const create = async (sessionId: string, userId: string, projectId?: string) => {
    await f.store.createSession({ sessionId, transcriptSessionId: sessionId, transcriptPath: '/unused/transcript',
      orgId: 'org', userId, role: 'member', scopes: [], cwd: '/unused',
      runtime: { type: 'cohost', engine: 'scode' }, status: 'active', desiredState: 'active' })
    if (projectId) await f.store.ontologyProjects.bind({ sessionId, orgId: 'org', userId, projectId }, { authorize: async () => {} })
  }
  await create('ordinary', 'alice')
  await create('different-project', 'alice', other.projectId)
  await create('another-owner', 'bob', f.project.projectId)
  await create('deleted', 'alice', f.project.projectId)
  await create('changed-owner', 'alice', f.project.projectId)
  await f.store.driver.run("UPDATE sessions SET deleted_at = 1 WHERE session_id = 'deleted'")
  await f.store.driver.run("UPDATE sessions SET user_id = 'bob' WHERE session_id = 'changed-owner'")
  const owner = { orgId: 'org', userId: 'alice' }
  // Exercise the runtime's forwarding method against real SQL without starting agent backends.
  const runtime = Object.assign(Object.create(RuntimeService.prototype) as RuntimeService, { store: f.store })
  const read = () => runtime.listSessions({ ...owner, ontologyProjectId: f.project.projectId })
  const result = await listProjectSessions(f.store, owner, f.project.projectId, read)
  assert.equal(result.ontology_project_id, f.project.projectId)
  assert.deepEqual(result.sessions.map(item => item.sessionId), ['session'])
  const ordinary = await listProjectSessions(f.store, owner, undefined, () => runtime.listSessions(owner))
  assert.equal('ontology_project_id' in ordinary, false)
  assert.equal(ordinary.sessions.length, 3)
  assert.equal((await f.store.listSessions(owner)).length, 3, 'ordinary discovery retains its existing scope')
  assert.deepEqual((await f.store.listSessions({ ...owner, ontologyProjectId: other.projectId })).map(item => item.sessionId), ['different-project'])
  assert.equal((await f.store.listSessions({ ...owner, orgId: 'foreign', ontologyProjectId: f.project.projectId })).length, 0)
  await f.store.ontologyProjects.setEnabled('org', f.project.projectId, false)
  assert.equal((await read()).length, 0)
  assert.equal(f.state.calls, 0, 'discovery never loads business context or records')
})

void test('project session discovery refuses revoked access before and after listing and ordinary discovery stays independent', async t => {
  const f = await fixture(t)
  const owner = { orgId: 'org', userId: 'alice' }
  let reads = 0
  const read = async () => { reads++; return ['private-session'] }
  await f.mcp.updateMcpServer('org', f.server.id, { visible_to: { user_ids: [] } }, 'manager')
  await assert.rejects(withSessionProjectAccess(f.store, owner, f.project.projectId, read), error =>
    error instanceof Error && 'statusCode' in error && error.statusCode === 403)
  await assert.rejects(withSessionProjectAccess(f.store, { ...owner, orgId: 'foreign' }, f.project.projectId, read), /unavailable/)
  assert.equal(reads, 0)
  assert.deepEqual(await withSessionProjectAccess(f.store, owner, undefined, read), ['private-session'])
  assert.equal(reads, 1)
  await f.mcp.updateMcpServer('org', f.server.id, { visible_to: { user_ids: ['alice'] } }, 'manager')
  await assert.rejects(listProjectSessions(f.store, owner, f.project.projectId, async () => {
    await f.mcp.updateMcpServer('org', f.server.id, { visible_to: { user_ids: [] } }, 'manager')
    return ['must-not-be-returned']
  }), error => error instanceof Error && 'statusCode' in error && error.statusCode === 403)
  assert.equal(f.state.calls, 0)
})

void test('project lifecycle changes fence an in-flight session listing', async t => {
  const f = await fixture(t)
  const owner = { orgId: 'org', userId: 'alice' }
  await assert.rejects(withSessionProjectAccess(f.store, owner, f.project.projectId, async () => {
    await f.store.ontologyProjects.setEnabled('org', f.project.projectId, false)
    await f.store.ontologyProjects.setEnabled('org', f.project.projectId, true)
    return ['must-not-be-returned']
  }), /unavailable/)
  assert.equal(f.state.calls, 0)
})

void test('a new canonical session is atomically bound before returning and can recover its owning project', async t => {
  const f = await fixture(t)
  const owner = { orgId: 'org', userId: 'alice' }
  assert.equal(parseOntologyProjectId(f.project.projectId), f.project.projectId)
  const input = { ...owner, sessionId: 'new-session', projectId: f.project.projectId }
  const created = await createModelSession(f.store, input, () => f.store.createSession({
    ...owner, sessionId: input.sessionId, transcriptSessionId: 'new-history', transcriptPath: '/unused/new-transcript',
    role: 'admin', scopes: ['*'], cwd: '/unused', runtime: { type: 'cohost', engine: 'scode' }, status: 'creating', desiredState: 'active',
  }))
  assert.equal(created.currentAttemptId, null)
  const bound = await f.store.ontologyProjects.resolveSession(created.sessionId)
  assert.equal(bound?.projectId, f.project.projectId)
  assert.equal(bound?.userId, owner.userId)
  assert.deepEqual(await getSessionProject(f.store, created.sessionId, owner), { project: {
    project_id: f.project.projectId, authority_ref: 'authority', model_ref: 'model', source_refs: ['source'],
  } })
  await assert.rejects(getSessionProject(f.store, created.sessionId, { ...owner, userId: 'bob' }), /unavailable/)
  await f.store.driver.run("UPDATE users SET status = 'disabled' WHERE id = 'alice'")
  await assert.rejects(getSessionProject(f.store, created.sessionId, owner), error =>
    error instanceof Error && 'statusCode' in error && error.statusCode === 403)
  assert.equal(f.state.calls, 0, 'entry does not load records or business context into client state')
})

void test('denied and interrupted canonical creation leave no ordinary session, creation event or binding', async t => {
  const f = await fixture(t)
  const owner = { orgId: 'org', userId: 'alice' }
  const input = { ...owner, sessionId: 'failed-session', projectId: f.project.projectId }
  const persist = () => f.store.createSession({ ...owner, sessionId: input.sessionId, transcriptSessionId: 'failed-history',
    transcriptPath: '/unused/failed', role: 'admin', scopes: ['*'], cwd: '/unused', runtime: { type: 'cohost', engine: 'scode' },
    status: 'creating', desiredState: 'active' })
  await assert.rejects(createModelSession(f.store, input, async () => { await persist(); throw new Error('Interrupt after session insert') }), /Interrupt after session insert/)
  assert.equal(await f.store.getSession(input.sessionId), null)
  assert.equal(await f.store.latestEvent(input.sessionId, 'session_created'), null)
  assert.equal(await f.store.ontologyProjects.resolveSession(input.sessionId), undefined)
  await f.mcp.updateMcpServer('org', f.server.id, { visible_to: { user_ids: [] } }, 'manager')
  let writes = 0
  await assert.rejects(createModelSession(f.store, input, async () => { writes++; return persist() }), error =>
    error instanceof Error && 'statusCode' in error && error.statusCode === 403)
  await assert.rejects(createModelSession(f.store, { ...input, orgId: 'other' }, async () => { writes++; return persist() }), /unavailable/)
  assert.equal(writes, 0)
  assert.equal(await f.store.getSession(input.sessionId), null)
  assert.equal(await f.store.ontologyProjects.resolveSession(input.sessionId), undefined)
  for (const value of [null, '', {}, '/srv/source.db', 'https://worker.invalid', { projectId: f.project.projectId }]) {
    assert.throws(() => parseOntologyProjectId(value), /Invalid ontology_project_id/)
  }
  assert.equal(parseOntologyProjectId(undefined), undefined)
})

void test('the production composition reads current DB policy and worker output without injected ports', async t => {
  const f = await fixture(t)
  assert.equal(await f.read(), 'Current policy A')
  f.state.text = 'Current policy B'
  assert.equal(await f.read(), 'Current policy B')
  await f.store.driver.run("UPDATE users SET status = 'disabled' WHERE id = 'alice'")
  await assert.rejects(f.read(), { code: 'TOOL_USER_DENIED' })
  assert.equal(f.state.calls, 2)
  assert.equal((await f.store.getSession('session'))?.transcriptSessionId, 'native-history')
})

for (const change of ['account', 'visibility', 'policy'] as const) {
  void test(`production ${change} revocation during I/O refuses output even for an admin session snapshot`, async t => {
    const f = await fixture(t)
    f.state.beforeReply = async () => {
      if (change === 'account') await f.store.driver.run("UPDATE human_accounts SET status = 'locked' WHERE id = 'alice'")
      if (change === 'visibility') await f.mcp.updateMcpServer('org', f.server.id, { visible_to: { user_ids: [] } }, 'manager')
      if (change === 'policy') await f.mcp.upsertMcpPolicy('org', { allow_external_network: false }, 'manager')
    }
    await assert.rejects(f.read())
    assert.equal(f.state.calls, 1)
    assert.equal((await f.mcp.queryAuditLog('org')).items[0]?.status, 'error')
  })
}

void test('production credentials use the configured external Nexus and current organization definitions', async t => {
  const f = await fixture(t)
  const previous = { mode: process.env.MOSS_NEXUS_MODE, endpoint: process.env.MOSS_NEXUS_ENDPOINT }
  t.after(() => {
    for (const [name, value] of [['MOSS_NEXUS_MODE', previous.mode], ['MOSS_NEXUS_ENDPOINT', previous.endpoint]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  })
  const id = await f.store.createConfigItem({ name: 'Worker credential', pinyin: 'model-worker', scope: 'system',
    scheme: 'bearer', bearer_prefix: 'Bearer', org_id: 'org' })
  await f.store.replaceConfigEntries(id, [{ config_key: 'token', name: 'Token', required: true }])
  await f.mcp.updateMcpServer('org', f.server.id, { auth_type: 'secret_ref', secret_ref: 'model-worker' }, 'manager')
  process.env.MOSS_NEXUS_MODE = 'embedded'
  await assert.rejects(f.read(), /configured external Nexus cluster/)
  assert.equal(f.state.calls, 0)
  process.env.MOSS_NEXUS_MODE = 'external'
  process.env.MOSS_NEXUS_ENDPOINT = 'http://127.0.0.1:19999'
  let secret: string | null = 'fixture-current-token'
  let secretReads = 0
  let closes = 0
  t.mock.method(NexusClient.prototype, 'listSecrets', async (namespace: string, subject: string) => {
    assert.equal(namespace, orgScopedNamespace('system:model-worker', 'org'))
    assert.equal(subject, secretSubject(namespace, ''))
    secretReads++
    return [{ namespace, key: 'token', value: secret, status: 'enabled', version: 1 }]
  })
  t.mock.method(NexusClient.prototype, 'close', () => { closes++ })
  f.state.token = secret
  assert.equal(await f.read(), 'Current policy A')
  const priorSecretReads = secretReads
  await f.store.updateConfigItem(id, { status: 0 })
  await assert.rejects(f.read(), { code: 'TOOL_CREDENTIAL_UNAVAILABLE' })
  assert.equal(secretReads, priorSecretReads, 'disabled credential definitions must not read Vault values')
  await f.store.updateConfigItem(id, { status: 1 })
  secret = null
  await assert.rejects(f.read(), { code: 'TOOL_CREDENTIAL_UNAVAILABLE' })
  assert.equal(f.state.calls, 1)
  assert.ok(secretReads >= 2)
  await f.production.close?.()
  assert.equal(closes, 1)
  await assert.rejects(f.read(), /host is closed/)
  const audit = JSON.stringify(await f.mcp.queryAuditLog('org'))
  assert.ok(!audit.includes('fixture-current-token') && !audit.includes('Current policy'))
})
