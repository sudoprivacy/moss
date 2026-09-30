import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { getDefaultServerConfig } from '../config.js'

/**
 * Knowledge spaces over HTTP, with a real admin and real normal users:
 * a user's 私有 space is managed through /api/v1/me/* (SudoWork), tenant
 * wikis through the admin routes, and /api/v1/agent/wikis* (the `wiki` CLI)
 * serves whatever the caller may use — no agent needed.
 *
 * Reuses the tenant-routes server fixture (Node, since node:sqlite).
 */

type Fixture = { baseUrl: string; rootDir: string; process: ReturnType<typeof Bun.spawn> }

let fx: Fixture
let adminToken = ''
let u1 = { id: '', token: '' }
let u2 = { id: '', token: '' }

async function api(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${fx.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, body: json }
}

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${fx.baseUrl}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const json = await res.json() as { access_token?: string }
  if (!json.access_token) throw new Error(`login failed for ${username}: ${JSON.stringify(json)}`)
  return json.access_token
}

async function createUser(name: string): Promise<{ id: string; token: string }> {
  const password = 'knowledge-test-pw-1'
  const created = await api(adminToken, 'POST', '/api/v1/users', {
    name, email: `${name}@example.com`, role: 'user', password,
  })
  expect(created.status).toBe(200)
  return { id: created.body.user.id, token: await login(name, password) }
}

const b64 = (s: string) => Buffer.from(s).toString('base64')

beforeAll(async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'moss-knowledge-routes-'))
  const config = getDefaultServerConfig()
  config.server.host = '127.0.0.1'
  config.server.port = 0
  config.bootstrapAdmin.username = 'knowledge-admin'
  config.bootstrapAdmin.password = 'knowledge-admin-pw'
  config.storage = {
    rootDir,
    dbPath: join(rootDir, 'moss.db'),
    transcriptDir: join(rootDir, 'transcripts'),
    runtimeDir: join(rootDir, 'runtime'),
  }
  config.wikiIndex.enabled = false
  const configPath = join(rootDir, 'server.json')
  await writeFile(configPath, JSON.stringify(config), 'utf8')

  const outDir = join(rootDir, 'fixture-build')
  const repoRoot = resolve(import.meta.dir, '..', '..', '..')
  const bundle = Bun.spawnSync([
    'bun', 'build', resolve(import.meta.dir, '..', 'tenantAssistantRoutes.fixture.ts'),
    '--target=node', '--format=esm', '--outdir', outDir,
    '--external=better-sqlite3', '--external=@xenova/transformers', '--external=onnxruntime-node', '--external=sharp',
  ], { cwd: repoRoot })
  if (bundle.exitCode !== 0) throw new Error(`fixture bundle failed: ${bundle.stderr.toString()}`)

  const proc = Bun.spawn(['node', join(outDir, 'tenantAssistantRoutes.fixture.js')], {
    cwd: repoRoot,
    env: { ...process.env, MOSS_HOME: join(rootDir, 'moss-home'), MOSS_SERVER_CONFIG: configPath },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let out = ''
  let port = 0
  while (!port) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`fixture exited: ${out}${await new Response(proc.stderr).text()}`)
    out += decoder.decode(chunk.value, { stream: true })
    const m = out.match(/TENANT_TEST_READY:(\d+)/)
    if (m) port = Number(m[1])
  }
  fx = { baseUrl: `http://127.0.0.1:${port}`, rootDir, process: proc }
  adminToken = await login('knowledge-admin', 'knowledge-admin-pw')
  u1 = await createUser('kuser1')
  u2 = await createUser('kuser2')
}, 120_000)

afterAll(async () => {
  if (!fx) return
  fx.process.kill()
  await fx.process.exited
  await rm(fx.rootDir, { recursive: true, force: true })
})

describe('knowledge spaces over HTTP', () => {
  let rootId = ''
  let folderId = ''
  let privateWikiId = ''

  it('a user gets a private root and can upload a folder into it', async () => {
    const tree = await api(u1.token, 'GET', '/api/v1/me/documents/tree')
    expect(tree.status).toBe(200)
    rootId = tree.body.root_id
    expect(tree.body.nodes.map((n: any) => n.id)).toEqual([rootId])

    const bad = await api(u1.token, 'POST', `/api/v1/me/documents/nodes/${rootId}/folder`, {
      folder_name: 'x', files: [{ relative_path: '../escape.md', content_base64: b64('x') }],
    })
    expect(bad.status).toBe(400)

    const up = await api(u1.token, 'POST', `/api/v1/me/documents/nodes/${rootId}/folder`, {
      folder_name: 'handbook',
      files: [
        { relative_path: 'intro.md', mime_type: 'text/markdown', content_base64: b64('# intro') },
        { relative_path: 'faq/refunds.md', mime_type: 'text/markdown', content_base64: b64('# refunds') },
      ],
    })
    expect(up.status).toBe(200)
    expect(up.body.documents).toHaveLength(2)
    folderId = up.body.node_id

    // re-upload replaces same-named files in place — same document id, so a
    // files-mode wiki built from it keeps it (and is flagged to rebuild)
    const introId = up.body.documents.find((d: any) => d.fileName === 'intro.md').id
    const picked = await api(u1.token, 'POST', '/api/v1/me/wikis', {
      name: 'intro only', source_mode: 'files', source_document_ids: [introId],
    })
    expect(picked.status).toBe(200)
    const again = await api(u1.token, 'POST', `/api/v1/me/documents/nodes/${rootId}/folder`, {
      folder_name: 'handbook',
      files: [{ relative_path: 'intro.md', content_base64: b64('# intro v2') }],
    })
    expect(again.body.node_id).toBe(folderId)
    expect(again.body.documents[0].id).toBe(introId)
    expect(again.body.documents[0].sizeBytes).toBe('# intro v2'.length)
    const pickedAfter = await api(u1.token, 'GET', `/api/v1/me/wikis/${picked.body.id}`)
    expect(pickedAfter.body.sourceDocumentIds).toEqual([introId])
    expect(pickedAfter.body.needsRebuild).toBe(true)
    await api(u1.token, 'DELETE', `/api/v1/me/wikis/${picked.body.id}`)
    const docs = await api(u1.token, 'GET', `/api/v1/me/documents/nodes/${folderId}/documents?recursive=1`)
    expect(docs.body.documents.map((d: any) => d.fileName).sort()).toEqual(['intro.md', 'refunds.md'])

    // another user can't reach it, and plain users can't use the admin tree
    expect((await api(u2.token, 'GET', `/api/v1/me/documents/nodes/${folderId}/documents`)).status).toBe(404)
    expect((await api(u1.token, 'GET', '/api/v1/documents/tree')).status).toBe(403)
    // the admin tree never lists private folders
    const adminTree = await api(adminToken, 'GET', '/api/v1/documents/tree')
    expect(adminTree.body.nodes.some((n: any) => n.id === rootId || n.id === folderId)).toBe(false)
  })

  it('creates a private wiki that defaults to only me', async () => {
    const created = await api(u1.token, 'POST', '/api/v1/me/wikis', {
      name: 'My handbook', source_mode: 'dir', source_node_ids: [folderId],
    })
    expect(created.status).toBe(200)
    privateWikiId = created.body.id
    expect(created.body.scope).toBe('private')
    expect(created.body.ownerId).toBe(u1.id)
    expect(created.body.visibleTo).toEqual({ department_ids: null, user_ids: [u1.id] })

    const mine = await api(u1.token, 'GET', '/api/v1/wikis/usable')
    expect(mine.body.wikis.map((w: any) => w.id)).toContain(privateWikiId)
    const theirs = await api(u2.token, 'GET', '/api/v1/wikis/usable')
    expect(theirs.body.wikis.map((w: any) => w.id)).not.toContain(privateWikiId)
  })

  it('admins see a private wiki but can neither edit, rebuild nor use it', async () => {
    const list = await api(adminToken, 'GET', '/api/v1/wikis?scope=private')
    const row = list.body.wikis.find((w: any) => w.id === privateWikiId)
    expect(row).toBeTruthy()
    expect(row.canManage).toBe(false)
    expect(row.canAdminister).toBe(true)
    expect(row.usable).toBe(false)
    expect((await api(adminToken, 'GET', '/api/v1/wikis')).body.wikis.some((w: any) => w.id === privateWikiId)).toBe(false)

    expect((await api(adminToken, 'PATCH', `/api/v1/wikis/${privateWikiId}`, { name: 'hijack' })).status).toBe(403)
    expect((await api(adminToken, 'POST', `/api/v1/wikis/${privateWikiId}/build`)).status).toBe(403)
    const agentList = await api(adminToken, 'GET', '/api/v1/agent/wikis')
    expect(agentList.body.wikis.some((w: any) => w.id === privateWikiId)).toBe(false)
  })

  it('the owner shares it; the wiki CLI then serves it without an agent', async () => {
    expect((await api(u2.token, 'GET', `/api/v1/me/wikis/${privateWikiId}`)).status).toBe(404)
    const shared = await api(u1.token, 'PATCH', `/api/v1/me/wikis/${privateWikiId}`, {
      visible_to: { department_ids: null, user_ids: [u2.id] },
    })
    expect(shared.status).toBe(200)
    const usable = await api(u2.token, 'GET', '/api/v1/wikis/usable')
    expect(usable.body.wikis.map((w: any) => w.id)).toContain(privateWikiId)
    // still not u2's to manage
    expect((await api(u2.token, 'PATCH', `/api/v1/me/wikis/${privateWikiId}`, { name: 'x' })).status).toBe(404)

    const cli = await api(u2.token, 'GET', '/api/v1/agent/wikis')
    expect(cli.status).toBe(200)
    expect(cli.body.wikis.map((w: any) => w.id)).toContain(privateWikiId)
  })

  it('an admin may disable and delete a private wiki', async () => {
    const off = await api(adminToken, 'PATCH', `/api/v1/wikis/${privateWikiId}/enabled`, { enabled: false })
    expect(off.status).toBe(200)
    expect(off.body.enabled).toBe(false)
    const cli = await api(u2.token, 'GET', '/api/v1/agent/wikis')
    expect(cli.body.wikis.some((w: any) => w.id === privateWikiId)).toBe(false)
    expect((await api(u2.token, 'PATCH', `/api/v1/wikis/${privateWikiId}/enabled`, { enabled: true })).status).toBe(403)
    expect((await api(adminToken, 'DELETE', `/api/v1/wikis/${privateWikiId}`)).status).toBe(200)
    expect((await api(u1.token, 'GET', `/api/v1/me/wikis/${privateWikiId}`)).status).toBe(404)
  })

  it('tenant wikis: scope decides direct use, and never read private folders', async () => {
    const node = await api(adminToken, 'POST', '/api/v1/documents/tree/nodes', { name: 'SOP' })
    expect(node.status).toBe(200)
    const upload = await api(adminToken, 'POST', `/api/v1/documents/tree/nodes/${node.body.id}/documents`, {
      file_name: 'sop.md', mime_type: 'text/markdown', content_base64: b64('# sop'),
    })
    expect(upload.status).toBe(200)

    const crossSpace = await api(adminToken, 'POST', '/api/v1/wikis', {
      name: 'leak', source_mode: 'dir', source_node_ids: [folderId],
    })
    expect(crossSpace.status).toBe(400)

    const everyone = await api(adminToken, 'POST', '/api/v1/wikis', {
      name: 'SOP for all', source_mode: 'dir', source_node_ids: [node.body.id],
    })
    expect(everyone.status).toBe(200)
    expect(everyone.body.visibleTo).toBeNull()
    const adminOnly = await api(adminToken, 'POST', '/api/v1/wikis', {
      name: 'SOP admins', source_mode: 'dir', source_node_ids: [node.body.id],
      visible_to: { department_ids: [], user_ids: [] },
    })
    expect(adminOnly.body.visibleTo).toEqual({ department_ids: [], user_ids: [] })

    const usable = (await api(u1.token, 'GET', '/api/v1/wikis/usable')).body.wikis.map((w: any) => w.id)
    expect(usable).toContain(everyone.body.id)
    expect(usable).not.toContain(adminOnly.body.id)
    expect((await api(u1.token, 'GET', `/api/v1/agent/wikis/${adminOnly.body.id}/files`)).status).toBe(403)

    // the agent editor's warning: an everyone-agent reaches beyond admin-only
    const check = await api(adminToken, 'POST', '/api/v1/wikis/scope-check', {
      agent_visible_to: null, wiki_ids: [everyone.body.id, adminOnly.body.id],
    })
    const covered = Object.fromEntries(check.body.results.map((r: any) => [r.wiki_id, r.covered]))
    expect(covered[everyone.body.id]).toBe(true)
    expect(covered[adminOnly.body.id]).toBe(false)
  })

  it('an uploaded agent package cannot bring its own wiki / corp-app grants', async () => {
    const { zipSync, strToU8 } = await import('fflate')
    const zip = zipSync({
      'smuggler/_moss_meta.json': strToU8(JSON.stringify({
        name: 'smuggler', enabledWikis: ['some-admin-only-wiki'], enabledCorpApps: ['app-1'], enableCorpAuth: true,
      })),
      'smuggler/system.md': strToU8('rules'),
    })
    const uploaded = await api(u1.token, 'POST', '/api/v1/agents/custom', {
      name: 'smuggler', displayName: 'smuggler', file: Buffer.from(zip).toString('base64'),
    })
    expect(uploaded.status).toBe(200)
    const installed = await api(u1.token, 'GET', '/api/v1/agents/installed')
    const mine = (installed.body.assistants ?? installed.body.agents ?? installed.body)
      .find((a: any) => a.id === uploaded.body.id || a.meta?.id === uploaded.body.id)
    expect(mine?.meta).toBeTruthy()
    expect(mine.meta.name ?? mine.meta.display_name).toBe('smuggler')
    expect(mine.meta.enabledWikis ?? []).toEqual([])
    expect(mine.meta?.enabledCorpApps ?? []).toEqual([])
    expect(mine.meta?.enableCorpAuth ?? false).toBe(false)
  })

  it('caps a private build at one at a time per user', async () => {
    const w = await api(u1.token, 'POST', '/api/v1/me/wikis', {
      name: 'second', source_mode: 'dir', source_node_ids: [folderId], build: true,
    })
    expect(w.status).toBe(200)
    expect(typeof w.body.build_job_id).toBe('string')
    const again = await api(u1.token, 'POST', `/api/v1/me/wikis/${w.body.id}/build`)
    expect(again.status).toBe(409)
    const cancel = await api(u1.token, 'POST', `/api/v1/me/wiki-build-jobs/${w.body.build_job_id}/cancel`)
    expect([200, 409]).toContain(cancel.status)
  })
})
