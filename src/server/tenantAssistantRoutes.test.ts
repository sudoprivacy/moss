import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { getDefaultServerConfig } from './config.js'

type TenantFixture = {
  baseUrl: string
  token: string
  rootDir: string
  output: string[]
  stderrOutput: string[]
  process: ReturnType<typeof Bun.spawn>
}

const fixtures: TenantFixture[] = []

function authHeaders(fixture: TenantFixture): HeadersInit {
  return { Authorization: `Bearer ${fixture.token}` }
}

async function createPendingTenantAssistant(
  fixture: TenantFixture,
  name: string,
  ruleFile: string,
  rules = 'initial rules',
): Promise<{ id: string; assistantDir: string }> {
  const create = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/create`, {
    method: 'POST', headers: { ...authHeaders(fixture), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, displayName: name, rules }),
  })
  expect(create.status).toBe(200)
  const installed = await (await fetch(`${fixture.baseUrl}/api/v1/agent-templates/installed`, { headers: authHeaders(fixture) })).json() as Array<{ id: string; name: string; source: string }>
  const custom = installed.find(agent => agent.name === name)!
  const metaPath = join(custom.source, '_moss_meta.json')
  const meta = JSON.parse(await readFile(metaPath, 'utf8'))
  await writeFile(metaPath, JSON.stringify({ ...meta, ruleFile }), 'utf8')
  await writeFile(join(custom.source, 'system.md'), rules, 'utf8')
  const response = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/publish`, {
    method: 'POST',
    headers: { ...authHeaders(fixture), 'Content-Type': 'application/json' },
    body: JSON.stringify({ assistantId: custom.id }),
  })
  expect(response.status).toBe(200)
  const result = await response.json() as { id: string }
  const rows = await (await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant`, { headers: authHeaders(fixture) })).json() as Array<{ id: string; file_path: string }>
  const assistantDir = rows.find(row => row.id === result.id)!.file_path
  // Simulate an imported ruleFile at the effective metadata boundary.
  const db = new Database(join(fixture.rootDir, 'moss.db'))
  const stored = db.query('SELECT config_json FROM tenant_assistants WHERE id = ?').get(result.id) as { config_json: string }
  db.query('UPDATE tenant_assistants SET config_json = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(stored.config_json || '{}'), ruleFile }), result.id)
  db.close()
  return { id: result.id, assistantDir }
}

async function startFixture(publicBaseUrl = ''): Promise<TenantFixture> {
  const rootDir = await mkdtemp(join(tmpdir(), 'moss-tenant-routes-'))
  const config = getDefaultServerConfig()
  config.server.host = '127.0.0.1'
  config.server.port = 0
  config.server.publicBaseUrl = publicBaseUrl
  config.bootstrapAdmin.username = 'tenant-test-admin'
  config.bootstrapAdmin.password = 'tenant-test-password'
  config.storage = {
    rootDir,
    dbPath: join(rootDir, 'moss.db'),
    transcriptDir: join(rootDir, 'transcripts'),
    runtimeDir: join(rootDir, 'runtime'),
  }
  config.wikiIndex.enabled = false

  const configPath = join(rootDir, 'server.json')
  await writeFile(configPath, JSON.stringify(config), 'utf8')

  await symlink(resolve(import.meta.dir, '../../node_modules'), join(rootDir, 'node_modules'), 'junction')
  const fixtureOutputDir = join(rootDir, 'fixture-build')
  const fixturePath = resolve(import.meta.dir, 'tenantAssistantRoutes.fixture.ts')
  const bundle = Bun.spawnSync([
    'bun', 'build', fixturePath,
    '--target=node',
    '--format=esm',
    '--outdir', fixtureOutputDir,
    '--external=better-sqlite3',
    '--external=@sudo/contracts/common/v1/resource-ref',
    '--external=@xenova/transformers',
    '--external=onnxruntime-node',
    '--external=sharp',
  ], { cwd: resolve(import.meta.dir, '..', '..') })
  if (bundle.exitCode !== 0) {
    throw new Error(`Fixture bundle failed: ${bundle.stderr.toString()}`)
  }
  const fixtureProcess = Bun.spawn(['node', join(fixtureOutputDir, 'tenantAssistantRoutes.fixture.js')], {
    cwd: resolve(import.meta.dir, '..', '..'),
    env: {
      ...globalThis.process.env,
      MOSS_HOME: join(rootDir, 'moss-home'),
      MOSS_SERVER_CONFIG: configPath,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stderrReader = fixtureProcess.stderr.getReader()
  const stderrOutput: string[] = []
  void (async () => {
    const decoder = new TextDecoder()
    while (true) {
      const result = await stderrReader.read()
      if (result.done) return
      stderrOutput.push(decoder.decode(result.value, { stream: true }))
    }
  })()

  const stdoutReader = fixtureProcess.stdout.getReader()
  const output: string[] = []
  let combinedOutput = ''
  const readReady = async (): Promise<number> => {
    const decoder = new TextDecoder()
    while (true) {
      const result = await stdoutReader.read()
      if (result.done) throw new Error(`Fixture did not become ready: ${combinedOutput}`)
      const chunk = decoder.decode(result.value, { stream: true })
      output.push(chunk)
      combinedOutput += chunk
      const errorMatch = combinedOutput.match(/TENANT_TEST_ERROR:([^\r\n]+)/)
      if (errorMatch) throw new Error(`Fixture request error: ${errorMatch[1]}`)
      const match = combinedOutput.match(/TENANT_TEST_READY:(\d+)/)
      if (match) return Number(match[1])
    }
  }
  const port = await Promise.race([
    readReady(),
    fixtureProcess.exited.then(async () => {
      const stderr = await new Response(fixtureProcess.stderr).text()
      throw new Error(`Fixture exited before readiness: ${stderr}`)
    }),
  ])

  const baseUrl = `http://127.0.0.1:${port}`
  const response = await fetch(`${baseUrl}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: config.bootstrapAdmin.username,
      password: config.bootstrapAdmin.password,
    }),
  })
  const tokenResult = await response.json() as { access_token?: string }
  if (!response.ok || !tokenResult.access_token) {
    fixtureProcess.kill()
    throw new Error(`Fixture authentication failed: ${JSON.stringify(tokenResult)}`)
  }

  const fixture = { baseUrl, token: tokenResult.access_token, rootDir, output, stderrOutput, process: fixtureProcess }
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async fixture => {
    fixture.process.kill()
    await fixture.process.exited
    await rm(fixture.rootDir, { recursive: true, force: true })
  }))
})

describe('tenant assistant routes fixture', () => {

  it('keeps the published version live during review, then advances the same catalog ID atomically', async () => {
    const fixture = await startFixture()
    const headers = { ...authHeaders(fixture), 'Content-Type': 'application/json' }
    const create = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/create`, { method: 'POST', headers, body: JSON.stringify({ name: 'revision-agent', display_name: 'Original', rules: 'original prompt' }) })
    expect(create.status).toBe(200)
    const original = (await create.json() as { data: { id: string } }).data
    expect((await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/publish`, { method: 'POST', headers, body: JSON.stringify({ assistantId: original.id }) })).status).toBe(200)
    expect((await fetch(`${fixture.baseUrl}/api/v1/admin/agent-templates/tenant/${original.id}/approve`, { method: 'POST', headers, body: JSON.stringify({ approved: true }) })).status).toBe(200)
    const edit = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/${original.id}`, { method: 'PATCH', headers, body: JSON.stringify({ display_name: 'Revised', rules: 'revised prompt' }) })
    expect(edit.status, fixture.stderrOutput.join('')).toBe(200)
    const draft = await edit.json() as { id: string; status: string }
    expect(draft.status).toBe('draft')
    const read = async () => await (await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant`, { headers })).json() as Array<{ id: string; status: string; display_name: string; isAvailable: boolean; version: string }>
    expect((await read()).find(row => row.id === original.id)).toMatchObject({ status: 'approved', display_name: 'Original', isAvailable: true })
    expect((await read()).find(row => row.id === draft.id)).toMatchObject({ status: 'draft', display_name: 'Revised', isAvailable: false })
    expect((await fetch(`${fixture.baseUrl}/api/v1/admin/agent-templates/tenant/${draft.id}/approve`, { method: 'POST', headers, body: JSON.stringify({ approved: true }) })).status).toBe(409)
    await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/publish`, { method: 'POST', headers, body: JSON.stringify({ assistantId: draft.id }) })
    const approve = await fetch(`${fixture.baseUrl}/api/v1/admin/agent-templates/tenant/${draft.id}/approve`, { method: 'POST', headers, body: JSON.stringify({ approved: true, visible_to: null }) })
    expect(approve.status, await approve.clone().text()).toBe(200)
    expect(await approve.json()).toMatchObject({ id: original.id, status: 'approved' })
    expect((await read()).filter(row => row.isAvailable)).toEqual([expect.objectContaining({ id: original.id, display_name: 'Revised', version: '1.0.1' })])
    const rules = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/${original.id}/rules`, { headers })
    expect(await rules.json()).toMatchObject({ rules: 'revised prompt' })
    expect((await read()).find(row => row.id === draft.id)).toMatchObject({ status: 'superseded', display_name: 'Original' })
  })

  it('publishes skill edits under the same ID and rejects stale revisions', async () => {
    const fixture = await startFixture()
    const headers = { ...authHeaders(fixture), 'Content-Type': 'application/json' }
    const content = '---\nname: versioned-skill\ndescription: fixture\nversion: 1.0.0\n---\nOriginal content'
    const upload = await fetch(`${fixture.baseUrl}/api/v1/skills/tenant/upload`, { method: 'POST', headers, body: JSON.stringify({ entries: [{ path: 'SKILL.md', contentBase64: Buffer.from(content).toString('base64') }] }) })
    expect(upload.status).toBe(200)
    const original = await upload.json() as { id: string }
    expect((await fetch(`${fixture.baseUrl}/api/v1/skills/tenant/publish`, { method: 'POST', headers, body: JSON.stringify({ skillId: original.id }) })).status).toBe(200)
    expect((await fetch(`${fixture.baseUrl}/api/v1/admin/skills/tenant/${original.id}/approve`, { method: 'POST', headers, body: JSON.stringify({ approved: true }) })).status).toBe(200)
    const edit = async (name: string) => {
      const response = await fetch(`${fixture.baseUrl}/api/v1/skills/tenant/${original.id}`, { method: 'PATCH', headers, body: JSON.stringify({ display_name: name, content: content.replace('Original content', name) }) })
      expect(response.status, await response.clone().text()).toBe(200)
      return await response.json() as { id: string }
    }
    const first = await edit('First revision')
    const stale = await edit('Stale revision')
    const readContent = async () => (await (await fetch(`${fixture.baseUrl}/api/v1/skills/tenant/${original.id}/content`, { headers })).json() as { content: string }).content
    expect(await readContent()).toBe(content)
    for (const id of [first.id, stale.id]) await fetch(`${fixture.baseUrl}/api/v1/skills/tenant/publish`, { method: 'POST', headers, body: JSON.stringify({ skillId: id }) })
    const publish = (id: string) => fetch(`${fixture.baseUrl}/api/v1/admin/skills/tenant/${id}/approve`, { method: 'POST', headers, body: JSON.stringify({ approved: true }) })
    const approved = await publish(first.id)
    expect(approved.status, await approved.clone().text()).toBe(200)
    expect(await approved.json()).toMatchObject({ id: original.id, status: 'approved' })
    expect(await readContent()).toContain('First revision')
    expect((await publish(stale.id)).status).toBe(409)
    expect(await readContent()).toContain('First revision')
  })

  it('keeps visibility-only edits private until the replacement version is published', async () => {
    const fixture = await startFixture()
    const headers = { ...authHeaders(fixture), 'Content-Type': 'application/json' }
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${fixture.baseUrl}/api/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      expect(response.status, await response.clone().text()).toBe(200)
      return await response.json() as any
    }
    for (const kind of ['agent-templates', 'skills']) {
      const created = kind === 'agent-templates'
        ? await request('POST', `${kind}/tenant/create`, { name: 'visibility-agent', rules: 'original prompt', visible_to: null })
        : await request('POST', `${kind}/tenant/upload`, { entries: [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: visibility-skill\ndescription: visibility\n---\nOriginal content').toString('base64') }], visible_to: null })
      const id = created.data?.id ?? created.id
      const submission = (assetId: string) => kind === 'agent-templates' ? { assistantId: assetId } : { skillId: assetId }
      await request('POST', `${kind}/tenant/publish`, submission(id))
      await request('POST', `admin/${kind}/tenant/${id}/approve`, { approved: true })
      const scope = { department_ids: [], user_ids: [] }
      const draft = await request('PATCH', `${kind}/tenant/${id}`, { visible_to: scope })
      expect(draft.id).not.toBe(id)
      expect(draft.status).toBe('draft')
      let rows = await request('GET', `${kind}/tenant`)
      expect(rows.find((row: any) => row.id === id)).toMatchObject({ status: 'approved', visible_to: null })
      expect(rows.find((row: any) => row.id === draft.id)).toMatchObject({ status: 'draft', visible_to: scope })
      await request('POST', `${kind}/tenant/publish`, submission(draft.id))
      await request('POST', `admin/${kind}/tenant/${draft.id}/approve`, { approved: true })
      rows = await request('GET', `${kind}/tenant`)
      expect(rows.find((row: any) => row.id === id)).toMatchObject({ status: 'approved', visible_to: scope })
      const next = await request('PATCH', `${kind}/tenant/${id}`, { visible_to: null })
      await request('POST', `${kind}/tenant/publish`, submission(next.id))
      await request('PATCH', `${kind}/tenant/${next.id}`, { visible_to: scope })
      rows = await request('GET', `${kind}/tenant`)
      expect(rows.find((row: any) => row.id === next.id).status).toBe('draft')
    }
  })

  it('fixture smoke', async () => {
    const fixture = await startFixture()
    const response = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant`, {
      headers: authHeaders(fixture),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  it('rejects ruleFile traversal before reading or writing rules', async () => {
    const fixture = await startFixture()
    const { id, assistantDir } = await createPendingTenantAssistant(fixture, 'traversal-agent', '../outside.md')
    const outsidePath = join(assistantDir, '..', 'outside.md')
    await writeFile(outsidePath, 'outside content', 'utf8')

    const getResponse = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/${id}/rules`, {
      headers: authHeaders(fixture),
    })
    expect(getResponse.status, fixture.stderrOutput.join('')).toBe(400)

    const patchResponse = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/${id}`, {
      method: 'PATCH',
      headers: authHeaders(fixture),
      body: (() => {
        const form = new FormData()
        form.set('rules', 'attacker content')
        return form
      })(),
    })
    expect(patchResponse.status, fixture.stderrOutput.join('')).toBe(400)
    expect(await readFile(outsidePath, 'utf8')).toBe('outside content')
  })

  it('accepts legacy JSON create and patch requests', async () => {
    const fixture = await startFixture()
    const skillIds: string[] = []
    for (const name of ['skill-a', 'skill-b']) {
      const uploaded = await fetch(`${fixture.baseUrl}/api/v1/skills/tenant/upload`, {
        method: 'POST', headers: { ...authHeaders(fixture), 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: [{ path: 'SKILL.md', contentBase64: Buffer.from(`---\nname: ${name}\ndescription: fixture\n---\nSkill`).toString('base64') }] }),
      })
      expect(uploaded.status).toBe(200)
      skillIds.push((await uploaded.json() as { id: string }).id)
    }
    const createResponse = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/create`, {
      method: 'POST',
      headers: { ...authHeaders(fixture), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'json-agent',
        display_name: 'JSON Agent',
        avatar: 'https://example.test/avatar.png',
        skills: [skillIds[0]],
        visible_to: null,
        workflow: null,
        promptsI18n: { 'zh-CN': ['示例'] },
        categories: ['分类'],
      }),
    })
    expect(createResponse.status, fixture.stderrOutput.join('')).toBe(200)
    const created = await createResponse.json() as { data: { id: string; avatar: string } }
    expect(created.data.avatar).toBe('https://example.test/avatar.png')

    const patchResponse = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/${created.data.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(fixture), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: 'Updated JSON Agent',
        avatar: 'https://example.test/updated.png',
        enabled: false,
        skills: [skillIds[1]],
        visible_to: null,
        workflow: null,
      }),
    })
    expect(patchResponse.status, fixture.stderrOutput.join('')).toBe(200)

    const listResponse = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant`, {
      headers: authHeaders(fixture),
    })
    const assistants = await listResponse.json() as Array<{ id: string; avatar: string; display_name: string; enabled: number }>
    expect(assistants.find(assistant => assistant.id === created.data.id)).toMatchObject({
      avatar: 'https://example.test/updated.png',
      display_name: 'Updated JSON Agent',
      enabled: 0,
    })
  })

  it('accepts multipart null values for visible_to and workflow', async () => {
    const fixture = await startFixture()
    const createForm = new FormData()
    createForm.set('name', 'null-object-agent')
    createForm.set('display_name', 'Null Object Agent')
    createForm.set('visible_to', 'null')
    createForm.set('workflow', 'null')
    const createResponse = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/create`, {
      method: 'POST',
      headers: authHeaders(fixture),
      body: createForm,
    })
    expect(createResponse.status, fixture.stderrOutput.join('')).toBe(200)
    const created = await createResponse.json() as { data: { id: string } }

    const patchForm = new FormData()
    patchForm.set('visible_to', 'null')
    patchForm.set('workflow', 'null')
    const patchResponse = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/${created.data.id}`, {
      method: 'PATCH',
      headers: authHeaders(fixture),
      body: patchForm,
    })
    expect(patchResponse.status, fixture.stderrOutput.join('')).toBe(200)
  })

  it('returns structured create fields and public tenant avatar URLs', async () => {
    const fixture = await startFixture('https://api.example.test')
    const form = new FormData()
    form.set('name', 'response-agent')
    form.set('display_name', 'Response Agent')
    form.set('promptsI18n', JSON.stringify({ 'zh-CN': ['示例'] }))
    form.set('categories', JSON.stringify(['分类']))
    form.set('avatar', new File([
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
    ], 'avatar.png', { type: 'image/png' }))

    const createResponse = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/create`, {
      method: 'POST',
      headers: authHeaders(fixture),
      body: form,
    })
    expect(createResponse.status, fixture.stderrOutput.join('')).toBe(200)
    const created = await createResponse.json() as {
      data: { id: string; prompts_i18n: Record<string, string[]>; categories: string[]; avatar: string }
    }
    expect(created.data.prompts_i18n).toEqual({ 'zh-CN': ['示例'] })
    expect(created.data.categories).toEqual(['分类'])
    expect(created.data.avatar).toStartWith('https://api.example.test/uploads/tenant-assistant-avatars/')

    const listResponse = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant`, {
      headers: authHeaders(fixture),
    })
    const assistants = await listResponse.json() as Array<{ id: string; avatar: string }>
    expect(assistants.find(assistant => assistant.id === created.data.id)?.avatar).toBe(created.data.avatar)
  })

  it('removes an existing tenant avatar', async () => {
    const fixture = await startFixture()
    const createForm = new FormData()
    createForm.set('name', 'remove-avatar-agent')
    createForm.set('display_name', 'Remove Avatar Agent')
    createForm.set('avatar', new File([
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
    ], 'avatar.png', { type: 'image/png' }))
    const createResponse = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/create`, {
      method: 'POST',
      headers: authHeaders(fixture),
      body: createForm,
    })
    expect(createResponse.status).toBe(200)
    const created = await createResponse.json() as { data: { id: string; avatar: string } }

    const removeForm = new FormData()
    removeForm.set('remove_avatar', 'true')
    const removeResponse = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/${created.data.id}`, {
      method: 'PATCH',
      headers: authHeaders(fixture),
      body: removeForm,
    })
    expect(removeResponse.status, fixture.stderrOutput.join('')).toBe(200)

    const listResponse = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant`, {
      headers: authHeaders(fixture),
    })
    const assistants = await listResponse.json() as Array<{ id: string; avatar: string | null }>
    expect(assistants.find(assistant => assistant.id === created.data.id)?.avatar).toBeNull()
  })

  it('rejects tenant avatar removal combined with an avatar file', async () => {
    const fixture = await startFixture()
    const { id } = await createPendingTenantAssistant(fixture, 'avatar-conflict-agent', 'system.md')
    const form = new FormData()
    form.set('remove_avatar', 'true')
    form.set('avatar', new File([
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
    ], 'avatar.png', { type: 'image/png' }))
    const response = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/${id}`, {
      method: 'PATCH',
      headers: authHeaders(fixture),
      body: form,
    })
    expect(response.status).toBe(400)
  })

  it('updates database configuration when the shared package is read-only', async () => {
    const fixture = await startFixture()
    const { id, assistantDir } = await createPendingTenantAssistant(fixture, 'metadata-failure-agent', 'system.md')
    const metaPath = join(assistantDir, '_moss_meta.json')
    await chmod(metaPath, 0o444)

    const form = new FormData()
    form.set('avatar', new File([
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
    ], 'avatar.png', { type: 'image/png' }))
    const response = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/${id}`, {
      method: 'PATCH',
      headers: authHeaders(fixture),
      body: form,
    })
    expect(response.status).toBe(200)

    await chmod(metaPath, 0o644)
    const listResponse = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant`, {
      headers: authHeaders(fixture),
    })
    const assistants = await listResponse.json() as Array<{ id: string; avatar: string }>
    const avatar = assistants.find(assistant => assistant.id === id)?.avatar
    expect(avatar).toStartWith('/uploads/tenant-assistant-avatars/')
    const filename = avatar!.slice('/uploads/tenant-assistant-avatars/'.length)
    expect(await readFile(join(fixture.rootDir, 'runtime', 'uploads', 'tenant-assistant-avatars', filename))).toBeInstanceOf(Uint8Array)
  })

  it('returns 415 for unsupported tenant request content types', async () => {
    const fixture = await startFixture()
    const response = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/create`, {
      method: 'POST',
      headers: { ...authHeaders(fixture), 'Content-Type': 'text/plain' },
      body: 'not supported',
    })
    expect(response.status).toBe(415)
  })

  it('reads and writes a valid pending tenant rule file', async () => {
    const fixture = await startFixture()
    const { id, assistantDir } = await createPendingTenantAssistant(fixture, 'safe-agent', 'system.md')

    const getResponse = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/${id}/rules`, {
      headers: authHeaders(fixture),
    })
    expect(getResponse.status, fixture.stderrOutput.join('')).toBe(200)
    expect((await getResponse.json() as { rules: string }).rules).toBe('initial rules')

    const patchResponse = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/${id}`, {
      method: 'PATCH',
      headers: authHeaders(fixture),
      body: (() => {
        const form = new FormData()
        form.set('rules', 'updated rules')
        return form
      })(),
    })
    expect(patchResponse.status, fixture.stderrOutput.join('')).toBe(200)
    expect(await patchResponse.json()).toMatchObject({ status: 'draft' })
    const approval = await fetch(`${fixture.baseUrl}/api/v1/admin/agent-templates/tenant/${id}/approve`, { method: 'POST', headers: { ...authHeaders(fixture), 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: true }) })
    expect(approval.status).toBe(409)
    expect(await readFile(join(assistantDir, 'system.md'), 'utf8')).toBe('initial rules')
    const updated = await fetch(`${fixture.baseUrl}/api/v1/agent-templates/tenant/${id}/rules`, { headers: authHeaders(fixture) })
    expect((await updated.json() as { rules: string }).rules).toBe('updated rules')
  })
})
