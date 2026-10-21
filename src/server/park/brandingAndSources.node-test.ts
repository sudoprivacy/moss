import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { DirectConnectStore } from '../db.js'
import { SqliteDriver } from '../db/driver.js'
import { ensureIdentitySchema } from '../identity/identityRepository.js'
import { ManagedImageStore } from '../configuration/managedImageStore.js'
import { DocumentStore } from '../documentStore.js'
import { HttpError, writeJson } from '../httpRespond.js'
import { ParkStore } from './store.js'
import { handleInternalParkRoute, recordParkAudit } from './internalRoutes.js'
import { handlePublicParkRoute } from './publicRoutes.js'
import { getParkWikiSources } from './wikiSources.js'
import { policySamples } from './testing/policySamples.js'
import { validatePolicyUpload, POLICY_FILE_MAX_BYTES } from './policyUpload.js'
import { redactInquiry } from './rules.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'park-brand-sources-'))
  const sqlite = new DatabaseSync(':memory:')
  ensureIdentitySchema(sqlite)
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS compatibility_id_counters (counter_key TEXT PRIMARY KEY, last_value INTEGER NOT NULL)',
  )
  const store = new ParkStore(new SqliteDriver(sqlite))
  await store.init()
  await store.putConfig('park', { display_name: 'Test park' })
  await store.grantRole('park', 'operator', 'park_system_operator', 'operator')
  await store.grantRole('park', 'leader', 'park_leader', 'operator')
  const connect = new DirectConnectStore(join(root, 'documents.db'))
  const documents = new DocumentStore(connect)
  const images = new ManagedImageStore(join(root, 'uploads'))
  const server = http.createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url!, 'http://localhost').pathname
      const deps = {
        store,
        orgId: 'park',
        documentStore: documents,
        managedImages: images,
        readBody: async () => {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          return JSON.parse(Buffer.concat(chunks).toString() || '{}')
        },
      }
      if (path.startsWith('/public/')) {
        if (await handlePublicParkRoute(req, res, path, deps)) return
      } else {
        const userId = String(req.headers['x-user'] ?? 'operator')
        if (
          await handleInternalParkRoute(
            req,
            res,
            path,
            { userId, orgId: 'park', role: 'user', scopes: [] } as never,
            { ...deps, authService: { getUserName: async (id: string) => id === 'operator' ? '园区管理员' : id === 'leader' ? 'leader-account' : undefined } as never },
          )
        )
          return
      }
      writeJson(res, 404, {})
    })().catch((error) =>
      writeJson(res, error instanceof HttpError ? error.statusCode : 500, {
        error: String(error.message),
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    root,
    store,
    documents,
    connect,
    images,
    request: (suffix: string, method = 'GET', body?: unknown, user = 'operator') =>
      fetch(
        `http://127.0.0.1:${port}${suffix.startsWith('/public/') ? suffix : '/api/v1/parks/park/' + suffix}`,
        {
          method,
          headers: { 'content-type': 'application/json', 'x-user': user },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      ),
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await connect.close()
      await store.db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

void test('park logo upload accepts all formats, preserves config and enforces content and size', async () => {
  const f = await fixture()
  try {
    const png = await sharp({
      create: { width: 80, height: 24, channels: 4, background: '#aa8245' },
    })
      .png()
      .toBuffer()
    const jpeg = await sharp(png).jpeg().toBuffer()
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="24"><rect width="80" height="24" fill="red"/></svg>',
    )
    let previous = ''
    for (const [name, mime, bytes] of [
      ['logo.png', 'image/png', png],
      ['logo.jpg', 'image/jpeg', jpeg],
      ['logo.jpeg', 'image/jpeg', jpeg],
      ['logo.svg', 'image/svg+xml', svg],
    ] as const) {
      const result = await f.request('admin/config', 'PUT', {
        display_name: 'Test park',
        logo_upload: { file_name: name, mime_type: mime, content_base64: bytes.toString('base64') },
      })
      assert.equal(result.status, 200, await result.clone().text())
      const config = (await result.json()) as { logo_url: string }
      const image = await f.request(config.logo_url)
      assert.equal(image.status, 200)
      assert.equal(image.headers.get('content-type'), mime)
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes)
      if (previous) assert.equal((await f.request(previous)).status, 404)
      previous = config.logo_url
    }
    assert.equal((await f.request('admin/config', 'PUT', { display_name: 'Updated' })).status, 200)
    assert.equal((await f.store.config('park'))!.logo_url, previous)
    const before = (await f.store.config('park'))!.logo_url
    for (const upload of [
      { file_name: 'fake.jpg', mime_type: 'image/jpeg', content_base64: png.toString('base64') },
      { file_name: 'empty.png', mime_type: 'image/png', content_base64: '' },
      { file_name: 'bad.png', mime_type: 'image/png', content_base64: '!!!!' },
      { file_name: 'bad.gif', mime_type: 'image/gif', content_base64: png.toString('base64') },
      {
        file_name: 'active.svg',
        mime_type: 'image/svg+xml',
        content_base64: Buffer.from(
          '<svg width="8" height="8"><script>alert(1)</script></svg>',
        ).toString('base64'),
      },
      {
        file_name: 'large.png',
        mime_type: 'image/png',
        content_base64: Buffer.alloc(500 * 1024 + 1).toString('base64'),
      },
    ]) {
      assert.equal((await f.request('admin/config', 'PUT', { logo_upload: upload })).status, 400)
      assert.equal((await f.store.config('park'))!.logo_url, before)
    }
    const boundary = Buffer.concat([png, Buffer.alloc(500 * 1024 - png.length)])
    const boundaryResponse = await f.request('admin/config', 'PUT', {
      display_name: 'Boundary park',
      logo_upload: {
        file_name: 'boundary.png',
        mime_type: 'image/png',
        content_base64: boundary.toString('base64'),
      },
    })
    assert.equal(boundaryResponse.status, 200, await boundaryResponse.text())
    assert.equal(
      (
        await f.request(
          'admin/config',
          'PUT',
          {
            logo_upload: {
              file_name: 'logo.png',
              mime_type: 'image/png',
              content_base64: png.toString('base64'),
            },
          },
          'leader',
        )
      ).status,
      403,
    )
    assert.equal((await f.request('/public/consult/logo/secret.png')).status, 404)
    const oldLogo = (await f.store.config('park'))!.logo_url
    const beforeFiles = await readdir(join(f.root, 'uploads', 'park-logos'))
    const saveConfig = f.store.putConfig.bind(f.store)
    f.store.putConfig = async () => {
      throw new Error('Simulated config failure')
    }
    const failedSave = await f.request('admin/config', 'PUT', {
      display_name: 'Test',
      logo_upload: {
        file_name: 'logo.png',
        mime_type: 'image/png',
        content_base64: png.toString('base64'),
      },
    })
    assert.equal(failedSave.status, 500)
    f.store.putConfig = saveConfig
    assert.equal((await f.store.config('park'))!.logo_url, oldLogo)
    assert.deepEqual(await readdir(join(f.root, 'uploads', 'park-logos')), beforeFiles)
  } finally {
    await f.close()
  }
})

void test('wiki sources preserve names after deletion and distinguish missing history from deletion', async () => {
  const f = await fixture()
  try {
    const node = await f.documents.createNode({ orgId: 'park', parentId: null, name: 'Policies' })
    const document = await f.documents.uploadDocument({
      orgId: 'park',
      nodeId: node.id,
      fileName: 'policy.md',
      mimeType: 'text/markdown',
      content: Buffer.from('# Policy'),
      uploadedBy: 'operator',
    })
    const wiki = await f.documents.createWiki({
      orgId: 'park',
      name: 'Wiki',
      sourceDocumentIds: [document.id],
      createdBy: 'operator',
      sourceMode: 'files',
    })
    const metaPath = join(wiki.storagePath, '_moss_meta.json')
    await mkdir(wiki.storagePath, { recursive: true })
    await writeFile(
      metaPath,
      JSON.stringify({
        builtAt: 123,
        sourceDocumentIds: [document.id, 'unknown', 'historically-deleted'],
      }),
    )
    await recordParkAudit(
      f.store,
      'park',
      '/api/v1/parks/park/admin/policy/documents/historically-deleted',
      'DELETE',
      204,
      'operator',
    )
    const original = await readFile(metaPath, 'utf8')
    const remember = f.store.rememberDocument.bind(f.store)
    f.store.rememberDocument = async () => {
      throw new Error('Simulated history failure')
    }
    assert.equal((await f.request(`admin/policy/documents/${document.id}`, 'DELETE')).status, 500)
    assert.ok(await f.documents.getDocument(document.id, 'park'))
    f.store.rememberDocument = remember
    assert.equal((await f.request(`admin/policy/documents/${document.id}`, 'DELETE')).status, 204)
    assert.equal(await readFile(metaPath, 'utf8'), original)
    assert.deepEqual((await f.documents.getWiki(wiki.id, 'park'))!.sourceDocumentIds, [])
    const result = await getParkWikiSources(f.store, f.documents, 'park', wiki.id)
    assert.equal(result.sources[0]!.fileName, 'policy.md')
    assert.equal(result.sources[0]!.nodeName, 'Policies')
    assert.equal(result.sources[0]!.status, 'deleted')
    assert.equal(result.sources[1]!.fileName, null)
    assert.equal(result.sources[1]!.status, 'unavailable')
    assert.equal(result.sources[2]!.fileName, null)
    assert.equal(result.sources[2]!.status, 'deleted')
    await writeFile(
      metaPath,
      JSON.stringify({
        builtAt: 123,
        sourceDocumentIds: [document.id],
        sourceDocuments: [
          {
            id: document.id,
            fileName: 'built-policy.md',
            nodeName: 'Original directory',
            sizeBytes: 8,
          },
        ],
      }),
    )
    assert.equal(
      (await getParkWikiSources(f.store, f.documents, 'park', wiki.id)).sources[0]!.fileName,
      'built-policy.md',
    )
    assert.equal(
      (await f.request(`admin/policy/wikis/${wiki.id}/sources`, 'GET', undefined, 'leader')).status,
      403,
    )
    await assert.rejects(
      getParkWikiSources(f.store, f.documents, 'other-park', wiki.id),
      /Wiki not found/,
    )
    await writeFile(metaPath, '{}')
    assert.equal(
      (await getParkWikiSources(f.store, f.documents, 'park', wiki.id)).record_status,
      'unavailable',
    )
    await rm(wiki.storagePath, { recursive: true, force: true })
  } finally {
    await f.close()
  }
})

void test('public link deletion requires disabled state and operator role', async () => {
  const f = await fixture()
  try {
    assert.equal(
      (await f.request('admin/public-links', 'POST', { channel: 'test', label: 'Test' })).status,
      200,
    )
    const link = await f.store.db.get('SELECT id FROM park_public_links WHERE org_id = ?', ['park'])
    const suffix = `admin/public-links/${link!.id}`
    assert.equal((await f.request(suffix, 'DELETE')).status, 409)
    assert.equal((await f.request(suffix, 'DELETE', undefined, 'leader')).status, 403)
    assert.equal(await f.store.deletePublicLink('other-park', String(link!.id)), 'missing')
    await f.request('admin/public-links', 'POST', {
      channel: 'test',
      label: 'Test',
      enabled: false,
    })
    await f.request('admin/public-links', 'POST', { channel: 'test', label: 'Test', enabled: true })
    assert.equal((await f.request(suffix, 'DELETE')).status, 409)
    await f.request('admin/public-links', 'POST', {
      channel: 'test',
      label: 'Test',
      enabled: false,
    })
    assert.equal((await f.request(suffix, 'DELETE')).status, 204)
    assert.equal((await f.request(suffix, 'DELETE')).status, 404)
    assert.ok(
      await f.store.db.get(
        "SELECT id FROM operation_audit_events WHERE method = 'DELETE' AND response_status = 204 AND path LIKE '%/public-links/%'",
      ),
    )
  } finally {
    await f.close()
  }
})

void test('policy uploads require a supported parseable source and audit records retain business names', async () => {
  const f = await fixture()
  try {
    const nodeResponse = await f.request('admin/policy/tree/nodes', 'POST', { name: '政策上传验证' })
    assert.equal(nodeResponse.status, 200)
    const node = await nodeResponse.json() as { id: string }
    const samples = await policySamples()
    const uploaded: string[] = []
    for (const file of samples.files) {
      const response = await f.request(`admin/policy/nodes/${node.id}/documents`, 'POST', {
        file_name: file.name, content_base64: file.content.toString('base64'),
      })
      assert.equal(response.status, 201, `${file.name}: ${await response.clone().text()}`)
      uploaded.push((await response.json() as { id: string }).id)
    }
    for (const file of [
      { name: 'video.mp4', content: Buffer.from('unsupported') },
      { name: 'fake.docx', content: Buffer.from('plain text') },
      { name: 'fake.pdf', content: Buffer.from('plain text') },
      { name: 'binary.txt', content: Buffer.from([0, 255, 0]) },
      { name: 'renamed.md', content: samples.files[3]!.content },
      { name: 'empty.txt', content: Buffer.from('   ') },
      { name: 'blank.pdf', content: samples.blankPdf },
    ]) {
      const response = await f.request(`admin/policy/nodes/${node.id}/documents`, 'POST', { file_name: file.name, content_base64: file.content.toString('base64') })
      assert.equal(response.status, 400, file.name)
      assert.equal(typeof (await response.json() as { error: unknown }).error, 'string')
    }
    assert.equal((await f.documents.listDocumentsForNode(node.id, 'park')).length, 5)
    const wikiResponse = await f.request('admin/policy/wikis', 'POST', { name: '原政策库', source_document_ids: uploaded })
    assert.equal(wikiResponse.status, 201)
    const wiki = await wikiResponse.json() as { id: string }
    assert.equal((await f.request(`admin/policy/wikis/${wiki.id}`, 'PATCH', { name: '新的政策知识库' })).status, 200)
    assert.equal((await f.request(`admin/policy/wikis/${wiki.id}`, 'PATCH', { source_document_ids: [] })).status, 400)
    assert.equal((await f.request(`admin/policy/documents/${uploaded[0]}`, 'DELETE')).status, 204)
    const rows = await (await f.request('admin/audit-events')).json() as Array<{ actor_name: string; action_label: string; object_label: string; path: string; method: string }>
    assert.equal(rows.filter(row => row.action_label === '创建政策目录').length, 1)
    assert.equal(rows.filter(row => row.action_label === '修改知识库').length, 1)
    assert.ok(rows.some(row => row.action_label === '修改知识库' && row.object_label === '新的政策知识库'))
    assert.ok(rows.some(row => row.action_label === '删除政策文件' && row.object_label === 'policy.txt'))
    assert.ok(rows.every(row => row.actor_name === '园区管理员'))
    assert.ok(rows.every(row => row.path.startsWith('/api/v1/parks/park/') && row.method))
    await recordParkAudit(f.store, 'park', '/api/v1/parks/park/admin/redaction', 'PUT', 200, 'leader')
    await recordParkAudit(f.store, 'park', '/api/v1/parks/park/admin/assistant', 'PUT', 401, null)
    const history = await (await f.request('admin/audit-events')).json() as Array<{ actor_user_id: string | null; actor_name: string | null }>
    assert.ok(history.some(row => row.actor_user_id === 'leader' && row.actor_name === 'leader-account'))
    assert.ok(history.some(row => row.actor_user_id === null && row.actor_name === null))
  } finally { await f.close() }
})

void test('redaction API defaults agree with execution and preserve explicit limits', async () => {
  const f = await fixture()
  try {
    const original = await (await f.request('admin/redaction')).json() as { value: { summary_max_length: number } }
    assert.equal(original.value.summary_max_length, 4000)
    assert.equal(redactInquiry('a'.repeat(5000)).length, 4000)
    assert.equal((await f.request('admin/redaction', 'PUT', { value: { summary_max_length: 1000 } })).status, 200)
    const configured = await (await f.request('admin/redaction')).json() as { value: { summary_max_length: number } }
    assert.equal(configured.value.summary_max_length, 1000)
    assert.equal(redactInquiry('a'.repeat(5000), configured.value).length, 1000)
    const full = Buffer.alloc(POLICY_FILE_MAX_BYTES, 32)
    full.write('policy')
    await validatePolicyUpload('boundary.TXT', full)
    await assert.rejects(validatePolicyUpload('boundary.txt', Buffer.alloc(POLICY_FILE_MAX_BYTES + 1)), (error: unknown) => error instanceof HttpError && error.statusCode === 413)
  } finally { await f.close() }
})
