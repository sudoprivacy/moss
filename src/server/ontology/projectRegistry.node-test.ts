import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { Pool } from 'pg'
import { PgDriver, SqliteDriver, type PgPoolLike } from '../db/driver.js'
import { applyPgSchema } from '../db/pg_schema.js'
import { forPostgresDirectConnectStore } from '../db.js'
import { OntologyProjectRegistry, type OntologyContextPorts } from './projectRegistry.js'
import { ONTOLOGY_PROJECT_SCHEMA } from './projectSchema.js'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'moss-ontology-binding-'))
  const path = join(root, 'registry.db')
  let db = new DatabaseSync(path)
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE sessions(session_id TEXT PRIMARY KEY, org_id TEXT, user_id TEXT, deleted_at BIGINT);
    INSERT INTO sessions VALUES ('s1','org','alice',NULL),('s2','org','bob',NULL),('foreign','other','alice',NULL);`)
  db.exec(ONTOLOGY_PROJECT_SCHEMA)
  let registry = new OntologyProjectRegistry(new SqliteDriver(db))
  let isAllowed = true
  let text = 'Revision one business knowledge'
  let reads = 0
  let checks = 0
  const ports: OntologyContextPorts = {
    authorize: async () => { checks++; if (!isAllowed) throw new Error('Current access revoked') },
    readContext: async () => { reads++; return { format: 'sudograph-agent-context/v1', revision: 'a'.repeat(64), context_digest: 'b'.repeat(64), text } },
  }
  const input = { orgId: 'org', authorityRef: 'authority-1', workerRef: 'worker-1', modelRef: 'model-1', sourceRefs: ['source-1'] }
  const project = await registry.register(input)
  const binding = { sessionId: 's1', orgId: 'org', userId: 'alice', projectId: project.projectId }
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }) })
  return {
    input, project, binding, ports,
    get db() { return db }, get registry() { return registry },
    deny() { isAllowed = false }, allow() { isAllowed = true }, change(value: string) { text = value },
    get reads() { return reads }, get checks() { return checks },
    reopen() { db.close(); db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON'); registry = new OntologyProjectRegistry(new SqliteDriver(db)) },
  }
}

void test('one canonical authority is idempotent, persists, and cannot acquire a second identity', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.registry.register({ ...f.input, sourceRefs: ['source-1', 'source-1'] }), f.project)
  await assert.rejects(f.registry.register({ ...f.input, modelRef: 'another-model' }), /different canonical binding/)
  await assert.rejects(f.registry.register({ ...f.input, authorityRef: 'duplicate-authority' }), /already has a registered authority/)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM ontology_projects').get()?.n, 1)
  f.reopen()
  assert.deepEqual(await f.registry.register(f.input), f.project)
  for (const value of ['C:\\private\\source.db', '/srv/models', 'https://worker.example/path', 'user:password@database']) {
    await assert.rejects(f.registry.register({ ...f.input, authorityRef: value }), /registered reference/)
  }
})

void test('bindings require the actual session owner and tenant and cannot be retargeted by another graph', async t => {
  const f = await fixture(t)
  await assert.rejects(f.registry.bind({ ...f.binding, sessionId: 's2' }, f.ports), /unavailable/)
  await assert.rejects(f.registry.bind({ ...f.binding, sessionId: 'foreign' }, f.ports), /unavailable/)
  const bound = await f.registry.bind(f.binding, f.ports)
  assert.deepEqual(await f.registry.bind(f.binding, f.ports), bound)
  const other = await f.registry.register({ ...f.input, authorityRef: 'authority-2', modelRef: 'model-2' })
  await assert.rejects(f.registry.bind({ ...f.binding, projectId: other.projectId }, f.ports), /another canonical project/)
  await f.registry.bind({ ...f.binding, sessionId: 's2', userId: 'bob' }, f.ports)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM ontology_session_bindings').get()?.n, 2)
  f.reopen()
  assert.deepEqual(await f.registry.resolveSession('s1'), bound)
})

void test('recovered readers load current context each turn and recheck policy before and after I/O', async t => {
  const f = await fixture(t)
  await f.registry.bind(f.binding, f.ports)
  f.reopen()
  const reader = await f.registry.contextReader('s1', f.ports)
  assert.ok(reader)
  const request = { sessionId: 's1', nativeSessionId: 'native-1' }
  assert.equal(await reader(request), 'Revision one business knowledge')
  f.change('Revision two business knowledge')
  assert.equal(await reader(request), 'Revision two business knowledge')
  assert.equal(f.reads, 2)
  assert.equal(f.checks, 5)
  await assert.rejects(reader({ ...request, sessionId: 's2' }), /unavailable/)
  f.deny()
  await assert.rejects(reader(request), /revoked/)
  assert.equal(f.reads, 2)
  f.allow()
  assert.equal(await reader(request), 'Revision two business knowledge')
})

void test('disable/re-enable during admission invalidates creation before any session is committed', async t => {
  const f = await fixture(t)
  let creations = 0
  await assert.rejects(f.registry.createBoundSession({ ...f.binding, sessionId: 'new' }, async () => {
    await f.registry.setEnabled('org', f.project.projectId, false)
    await f.registry.setEnabled('org', f.project.projectId, true)
  }, async () => {
    creations++
    f.db.prepare("INSERT INTO sessions VALUES ('new','org','alice',NULL)").run()
  }), /unavailable/)
  assert.equal(creations, 0)
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sessions WHERE session_id = 'new'").get()?.n, 0)
  await assert.rejects(f.registry.createBoundSession({ ...f.binding, sessionId: 'new' }, async () => {}, async () => {
    f.db.prepare("INSERT INTO sessions VALUES ('new','org','alice',NULL)").run()
    await f.registry.setEnabled('org', f.project.projectId, false)
    await f.registry.setEnabled('org', f.project.projectId, true)
  }), /unavailable/)
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sessions WHERE session_id = 'new'").get()?.n, 0)
})

void test('revocation during a read refuses disclosure and never returns the preceding snapshot', async t => {
  const f = await fixture(t)
  await f.registry.bind(f.binding, f.ports)
  const reader = await f.registry.contextReader('s1', {
    ...f.ports, readContext: async binding => { const result = await f.ports.readContext(binding); f.deny(); return result },
  })
  assert.ok(reader)
  await assert.rejects(reader({ sessionId: 's1', nativeSessionId: 'native' }), /revoked/)
})

void test('project disable/re-enable fences an in-flight read and disabled bindings never become legacy', async t => {
  const f = await fixture(t)
  await f.registry.bind(f.binding, f.ports)
  const reader = await f.registry.contextReader('s1', {
    ...f.ports, readContext: async binding => {
      const result = await f.ports.readContext(binding)
      await f.registry.setEnabled('org', f.project.projectId, false)
      await f.registry.setEnabled('org', f.project.projectId, true)
      return result
    },
  })
  assert.ok(reader)
  await assert.rejects(reader({ sessionId: 's1', nativeSessionId: 'native' }), /unavailable/)
  await f.registry.setEnabled('org', f.project.projectId, false)
  await assert.rejects(f.registry.contextReader('s1', f.ports), /unavailable/)
  assert.equal(await f.registry.contextReader('s2', f.ports), undefined)
})

void test('session deletion or ownership changes invalidate an existing reader', async t => {
  const f = await fixture(t)
  await f.registry.bind(f.binding, f.ports)
  const reader = await f.registry.contextReader('s1', f.ports)
  assert.ok(reader)
  f.db.prepare('UPDATE sessions SET user_id = ? WHERE session_id = ?').run('bob', 's1')
  await assert.rejects(reader({ sessionId: 's1', nativeSessionId: 'native' }), /unavailable/)
  f.db.prepare('UPDATE sessions SET user_id = ?, deleted_at = 1 WHERE session_id = ?').run('alice', 's1')
  await assert.rejects(reader({ sessionId: 's1', nativeSessionId: 'native' }), /unavailable/)
  assert.equal(f.reads, 0)
})

void test('malformed worker results refuse the turn instead of becoming business instructions', async t => {
  const f = await fixture(t)
  await f.registry.bind(f.binding, f.ports)
  const reader = await f.registry.contextReader('s1', {
    ...f.ports, readContext: async binding => ({ ...await f.ports.readContext(binding), context_digest: 'invalid' }),
  })
  assert.ok(reader)
  await assert.rejects(reader({ sessionId: 's1', nativeSessionId: 'native' }), /invalid canonical context/)
})

void test('PostgreSQL registry upgrades and concurrent host bindings preserve one canonical authority',
  { skip: !process.env.MOSS_PG_TEST_URL }, async t => {
    const schema = `ontology_project_${randomUUID().replaceAll('-', '')}`
    const connectionString = process.env.MOSS_PG_TEST_URL
    const admin = new Pool({ connectionString, max: 1 })
    await admin.query(`CREATE SCHEMA ${schema}`)
    const drivers = [0, 1].map(() => new PgDriver(new Pool({ connectionString, max: 2,
      options: `-c search_path=${schema}` }) as unknown as PgPoolLike))
    t.after(async () => {
      await Promise.all(drivers.map(driver => driver.close()))
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    })
    // Exercise the real upgrade path, with existing production tables first.
    await drivers[0].exec('CREATE TABLE _migrations (version BIGINT PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)')
    const { MIGRATIONS } = await import('../db/pg_schema.js')
    for (const migration of MIGRATIONS.filter(item => item.version < 25)) {
      await drivers[0].exec(migration.sql)
      await drivers[0].run('INSERT INTO _migrations VALUES (?, ?, ?)', [migration.version, migration.name, Date.now()])
    }
    await Promise.all(drivers.map(applyPgSchema))
    const stores = drivers.map(forPostgresDirectConnectStore)
    await stores[0].createSession({ sessionId: 'shared-session', transcriptSessionId: 'history',
      transcriptPath: '/fixture/transcript', userId: 'alice', orgId: 'org', role: 'member', scopes: [],
      cwd: '/fixture', runtime: { type: 'cohost', engine: 'scode' }, status: 'active', desiredState: 'active' })
    const input = { orgId: 'org', authorityRef: 'authority', workerRef: 'worker', modelRef: 'model', sourceRefs: ['source'] }
    const registrations = await Promise.all(Array.from({ length: 8 }, (_, i) => stores[i % 2].ontologyProjects.register(input)))
    for (const registered of registrations) assert.deepEqual(registered, registrations[0])
    const other = await stores[0].ontologyProjects.register({ ...input, authorityRef: 'other', modelRef: 'other' })
    const ports: OntologyContextPorts = { authorize: async () => {},
      readContext: async () => ({ format: 'sudograph-agent-context/v1', revision: 'a'.repeat(64), context_digest: 'b'.repeat(64), text: 'Current knowledge' }) }
    const choices = [registrations[0], other]
    const results = await Promise.allSettled(choices.map((choice, i) => stores[i].ontologyProjects.bind({
      sessionId: 'shared-session', projectId: choice.projectId, orgId: 'org', userId: 'alice',
    }, ports)))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    const selected = await stores[1].ontologyProjects.resolveSession('shared-session')
    assert.ok(selected)
    const reader = await stores[0].ontologyProjects.contextReader('shared-session', ports)
    assert.ok(reader)
    assert.equal(await reader({ sessionId: 'shared-session', nativeSessionId: 'native' }), 'Current knowledge')
    const newBinding = { sessionId: 'new-session', projectId: selected.projectId, orgId: 'org', userId: 'alice' }
    const persist = () => stores[0].createSession({ ...newBinding, transcriptSessionId: 'new-history',
      transcriptPath: '/fixture/new-transcript', role: 'member', scopes: [], cwd: '/fixture',
      runtime: { type: 'cohost', engine: 'scode' }, status: 'creating', desiredState: 'active' })
    await stores[0].ontologyProjects.createBoundSession(newBinding, async () => {}, async () => {
      const session = await persist()
      assert.equal(await stores[1].getSession(newBinding.sessionId), null, 'a peer must not observe an unbound session')
      return session
    })
    assert.equal((await stores[1].ontologyProjects.resolveSession(newBinding.sessionId))?.projectId, selected.projectId)
    assert.deepEqual((await stores[1].listSessions({ orgId: 'org', userId: 'alice', ontologyProjectId: selected.projectId }))
      .map(session => session.sessionId).sort(), ['new-session', 'shared-session'])
    assert.equal((await stores[1].listSessions({ orgId: 'org', userId: 'other-owner', ontologyProjectId: selected.projectId })).length, 0)
    assert.equal((await stores[1].listSessions({ orgId: 'other-org', ontologyProjectId: selected.projectId })).length, 0)
    const failedBinding = { ...newBinding, sessionId: 'rolled-back-session' }
    await assert.rejects(stores[0].ontologyProjects.createBoundSession(failedBinding, async () => {}, async () => {
      await stores[0].createSession({ ...failedBinding, transcriptSessionId: 'failed-history', transcriptPath: '/fixture/failed',
        role: 'member', scopes: [], cwd: '/fixture', runtime: { type: 'cohost', engine: 'scode' }, status: 'creating', desiredState: 'active' })
      throw new Error('Interrupted creation')
    }), /Interrupted creation/)
    assert.equal(await stores[1].getSession(failedBinding.sessionId), null)
    assert.equal(await stores[1].latestEvent(failedBinding.sessionId, 'session_created'), null)
    await stores[1].ontologyProjects.setEnabled('org', selected.projectId, false)
    assert.equal((await stores[1].listSessions({ orgId: 'org', ontologyProjectId: selected.projectId })).length, 0)
    await assert.rejects(reader({ sessionId: 'shared-session', nativeSessionId: 'native' }), /unavailable/)
    assert.equal(Number((await drivers[0].get('SELECT count(*) AS n FROM ontology_session_bindings'))?.n), 2)
  })
