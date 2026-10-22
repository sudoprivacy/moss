import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { SqliteDriver } from '../db/driver.js'
import { ParkStore } from './store.js'
import {
  groupPolicyMatches,
  mergeSourceRanges,
  readConsultationPreview,
  saveConsultationSources,
} from './consultationSources.js'
import { searchParkPolicySources, type PolicyMatch } from './policySearch.js'
import { handlePublicParkRoute } from './publicRoutes.js'
import { HttpError, writeJson } from '../httpRespond.js'
import { appendAgentInquiry } from './agentInquiry.js'
import { ConsultationTurns } from './consultationTurns.js'
import { presentParkAudit, presentStoredParkAudit, recordParkAudit } from './audit.js'
import { ensureIdentitySchema } from '../identity/identityRepository.js'
import { createCatalogTestRepository } from '../testing/compatibilityRepositories.js'
import { dispatchParkAgentApi, peekSessionSearch } from './parkAgentRoutes.js'
import type { AuthContext } from '../auth/token.js'
import type { DocumentStore } from '../documentStore.js'

void test('agent search carries retained source identities through inquiry persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'park-search-preview-'))
  const db = new DatabaseSync(':memory:')
  const driver = new SqliteDriver(db)
  const store = new ParkStore(driver)
  await store.init()
  createCatalogTestRepository(db, driver)
  const markdown = '# Policy\nOriginal\n## Conditions\nSix months'
  await mkdir(join(root, '_sources'))
  await writeFile(join(root, '_sources/doc.md'), markdown)
  await writeFile(
    join(root, '_moss_meta.json'),
    JSON.stringify({
      wikiId: 'wiki',
      builtAt: 1,
      sourceDocuments: [
        {
          id: 'doc',
          fileName: 'policy.md',
          markdownPath: '_sources/doc.md',
          markdownSha256: createHash('sha256').update(markdown).digest('hex'),
        },
      ],
    }),
  )
  await store.putConfig('park', {
    display_name: 'Search test',
    assistant_status: 'published',
    assistant_config: JSON.stringify({ assistant_id: 'agent' }),
  })
  const session = await store.createSession('park', 'web', 60_000)
  await driver.run('UPDATE park_sessions SET moss_session_id = ? WHERE id = ?', [
    'moss',
    session.id,
  ])
  await driver.run(
    `INSERT INTO tenant_assistants (id, name, author_id, status, source_type, file_path, org_id, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'agent',
      'agent',
      'owner',
      'approved',
      'tenant',
      root,
      'park',
      JSON.stringify({ enabledWikis: ['wiki'] }),
      1,
      1,
    ],
  )
  const auth = { assistantId: 'agent', sessionId: 'moss' } as AuthContext
  const deps = {
    store,
    orgId: 'park',
    documentStore: { getWiki: async () => ({ storagePath: root }) } as unknown as DocumentStore,
    readBody: async () => ({ question: 'policy', answer: 'answer', intent: 'policy_inquiry' }),
    vectorOptions: null,
  }
  try {
    const turns = new ConsultationTurns(store)
    const { turn } = await turns.begin('park', session.id, 'request', 'policy')
    const url = new URL('http://localhost/api/v1/agent/park/policies/search?q=policy')
    const result = await dispatchParkAgentApi(deps, auth, 'GET', url.pathname, url, {} as never)
    assert.ok(result && result.status === 200)
    const record = peekSessionSearch('moss')!
    assert.equal(record.count, 2)
    assert.equal(record.refs.length, 1)
    assert.equal(record.refs[0].document_id, 'doc')
    assert.equal(record.refs[0].wiki_id, 'wiki')
    assert.equal(record.refs[0].preview_status, 'available')
    const inquiryUrl = new URL('http://localhost/api/v1/agent/park/inquiries')
    await dispatchParkAgentApi(deps, auth, 'POST', inquiryUrl.pathname, inquiryUrl, {} as never)
    assert.equal(await driver.get('SELECT id FROM park_inquiries LIMIT 1'), undefined)
    await turns.complete(turn, 'policy', 'answer', record.refs)
    const row = await driver.get<{ source_refs_json: string }>(
      'SELECT source_refs_json FROM park_inquiries LIMIT 1',
    )
    assert.deepEqual(JSON.parse(row!.source_refs_json), record.refs)
    await rm(join(root, '_sources'), { recursive: true, force: true })
    assert.equal(
      (await readConsultationPreview(driver, 'park', session.id, record.refs[0].source_id!))
        .markdown,
      markdown,
    )
  } finally {
    await driver.close()
    await rm(root, { recursive: true, force: true })
  }
})

void test('source grouping keeps distinct identities and complete disjoint ranges', () => {
  const match = (id: string, start: number, end: number, version = 'v1'): PolicyMatch => ({
    file: 'same.md',
    document_id: id,
    wiki_id: 'wiki',
    version,
    line_no: start,
    end_line: end,
    line: 'clause',
  })
  const refs = groupPolicyMatches([
    match('a', 8, 10),
    match('a', 1, 3),
    match('a', 2, 5),
    match('a', 6, 6),
    match('a', 8, 10),
    match('b', 1, 2),
    match('a', 1, 2, 'v2'),
  ])
  assert.equal(refs.length, 3)
  assert.deepEqual(refs[0].ranges, [
    { start: 1, end: 6 },
    { start: 8, end: 10 },
  ])
  assert.deepEqual(mergeSourceRanges([]), [])
})

void test('verified source previews survive rebuild, deletion and database reopen; access is session scoped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'park-preview-'))
  let db = new DatabaseSync(join(root, 'park.db'))
  let store = new ParkStore(new SqliteDriver(db))
  await store.init()
  await store.putConfig('park', { display_name: 'Preview test' })
  const wiki = join(root, 'wiki')
  await mkdir(join(wiki, '_sources'), { recursive: true })
  const markdown = Array.from(
    { length: 25 },
    (_, i) => `## Section ${i}\nOriginal clause ${i}`,
  ).join('\n')
  const body = {
    id: 'doc',
    fileName: 'policy.md',
    nodeName: 'policies',
    sizeBytes: Buffer.byteLength(markdown),
    markdownPath: '_sources/doc.md',
    markdownSha256: createHash('sha256').update(markdown).digest('hex'),
  }
  await writeFile(join(wiki, '_sources/doc.md'), markdown)
  await writeFile(
    join(wiki, '_moss_meta.json'),
    JSON.stringify({ wikiId: 'wiki', builtAt: 1, sourceDocuments: [body] }),
  )
  let sourceId = ''
  let server: http.Server | undefined
  try {
    const hits = await searchParkPolicySources(wiki, 'wiki', 'policy', async (matches, sources) => {
      const refs = await saveConsultationSources(store.db, 'park', 'session', matches, sources)
      assert.equal(refs.length, 1)
      assert.equal(refs[0].ranges?.[0].end, 50)
      sourceId = refs[0].source_id!
      const id = await appendAgentInquiry(store, {
        orgId: 'park',
        sessionId: 'session',
        question: 'policy',
        answer: 'answer',
        intent: 'policy_inquiry',
        industryTags: [],
        policyHitCount: matches.length,
        sourceRefs: refs,
      })
      const inquiry = await store.db.get<{ source_refs_json: string }>(
        'SELECT source_refs_json FROM park_inquiries WHERE id = ?',
        [id],
      )
      assert.equal(JSON.parse(inquiry!.source_refs_json)[0].source_id, sourceId)
    })
    assert.equal(hits.length, 25)
    await writeFile(join(wiki, '_sources/doc.md'), 'New generation')
    assert.equal(
      (await readConsultationPreview(store.db, 'park', 'session', sourceId)).markdown,
      markdown,
    )
    await rm(wiki, { recursive: true, force: true })
    await store.db.close()
    db = new DatabaseSync(join(root, 'park.db'))
    store = new ParkStore(new SqliteDriver(db))
    await store.init()
    assert.equal(
      (await readConsultationPreview(store.db, 'park', 'session', sourceId)).markdown,
      markdown,
    )
    await assert.rejects(readConsultationPreview(store.db, 'other', 'session', sourceId), {
      statusCode: 404,
    })
    await assert.rejects(readConsultationPreview(store.db, 'park', 'other', sourceId), {
      statusCode: 404,
    })
    await store.db.run(
      `INSERT INTO park_sessions (id, org_id, source_channel, started_at, last_active_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ['session', 'park', 'web', Date.now(), Date.now(), Date.now() + 60_000],
    )
    server = http.createServer((req, res) => {
      void handlePublicParkRoute(req, res, new URL(req.url!, 'http://localhost').pathname, {
        orgId: 'park',
        store,
        readBody: async () => ({}),
      })
        .then((isHandled) => {
          if (!isHandled) writeJson(res, 404, {})
        })
        .catch((error) =>
          writeJson(res, error instanceof HttpError ? error.statusCode : 500, {
            error: String(error.message),
          }),
        )
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/public/sessions/session/sources/${sourceId}/preview`
    assert.equal((await fetch(url)).status, 401)
    assert.equal((await fetch(url, { headers: { cookie: 'park_session=other' } })).status, 401)
    assert.equal((await fetch(url, { headers: { cookie: 'park_session=session' } })).status, 200)
    await store.db.run('UPDATE park_source_bodies SET markdown = ?', ['corrupt'])
    assert.equal((await fetch(url, { headers: { cookie: 'park_session=session' } })).status, 503)
    await store.db.run('UPDATE park_sessions SET expires_at = 1')
    assert.equal((await fetch(url, { headers: { cookie: 'park_session=session' } })).status, 401)
  } finally {
    server?.closeAllConnections()
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    await store.db.close()
    await rm(root, { recursive: true, force: true })
  }
})

void test('snapshot writes deduplicate bodies and report failure without advertising a preview', async () => {
  const db = new DatabaseSync(':memory:')
  const store = new ParkStore(new SqliteDriver(db))
  await store.init()
  const matches: PolicyMatch[] = Array.from({ length: 21 }, (_, i) => ({
    file: `${i}.md`,
    document_id: String(i),
    wiki_id: 'wiki',
    version: 'v1',
    line_no: 1,
    end_line: 2,
    line: 'text',
  }))
  const bodies = matches.map((hit) => ({
    source: { id: hit.document_id, fileName: hit.file, nodeName: '', sizeBytes: 4 },
    version: 'v1',
    markdown: 'text',
  }))
  try {
    const refs = await saveConsultationSources(store.db, 'park', 'session', matches, bodies)
    assert.equal(refs.length, 21)
    assert.equal(
      (await store.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM park_source_bodies'))!
        .count,
      1,
    )
    const id = await appendAgentInquiry(store, {
      orgId: 'park',
      sessionId: 'session',
      question: 'q',
      answer: 'a',
      intent: 'policy_inquiry',
      industryTags: [],
      policyHitCount: 21,
      sourceRefs: refs,
    })
    const row = await store.db.get<{ source_refs_json: string }>(
      'SELECT source_refs_json FROM park_inquiries WHERE id = ?',
      [id],
    )
    assert.equal(JSON.parse(row!.source_refs_json).length, 21)
    await store.db.exec('DROP TABLE park_session_sources')
    const failed = await saveConsultationSources(
      store.db,
      'park',
      'session',
      matches.slice(0, 1),
      bodies,
    )
    assert.equal(failed[0].preview_status, 'unavailable')
    assert.equal(failed[0].source_id, undefined)
  } finally {
    await store.db.close()
  }
})

void test('audit distinguishes retained names, request names, query objects and missing history', async () => {
  const db = new DatabaseSync(':memory:')
  ensureIdentitySchema(db)
  db.exec(
    'CREATE TABLE compatibility_id_counters (counter_key TEXT PRIMARY KEY, last_value INTEGER NOT NULL)',
  )
  const store = new ParkStore(new SqliteDriver(db))
  await store.init()
  const base = {
    action: 'park.DELETE',
    method: 'DELETE',
    path: '/api/v1/parks/park/admin/policy/documents/doc',
    resource_id: null,
    response_status: 204,
  }
  try {
    await store.rememberDocument('park', {
      id: 'doc',
      fileName: 'original.md',
      nodeName: '',
      sizeBytes: 1,
    })
    assert.equal(
      (await presentStoredParkAudit(store, 'park', base)).object_label,
      'original.md（历史文件名称）',
    )
    assert.equal(
      (await presentStoredParkAudit(store, 'other', base)).object_label,
      '历史记录未保存对象名称（doc）',
    )
    assert.equal(
      presentParkAudit({ ...base, request_data_json: '{"object_name":"snapshot.md"}' })
        .object_label,
      'snapshot.md',
    )
    assert.equal(
      presentParkAudit({
        action: 'park.GET',
        method: 'GET',
        path: '/api/v1/parks/park/admin/policy/tree',
        response_status: 401,
      }).object_label,
      '政策文件目录',
    )
    await recordParkAudit(
      store,
      'park',
      '/api/v1/parks/park/admin/policy/nodes/parent/documents',
      'POST',
      400,
      'actor',
      'invalid',
      { requestedName: 'attempt.md', parentId: 'parent', parentName: 'Policies' },
    )
    const row = await store.db.get<{
      action: string
      resource_id: string | null
      method: string
      path: string
      request_data_json: string
    }>('SELECT * FROM operation_audit_events LIMIT 1')
    assert.equal(row!.resource_id, null)
    assert.equal(JSON.parse(row!.request_data_json).parent_id, 'parent')
    assert.match(presentParkAudit(row!).object_label, /attempt.md.*请求名称/)
  } finally {
    await store.db.close()
  }
})
