import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
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
  const assistantDir = join(fixture.rootDir, 'moss-home', 'assistants', 'custom', name)
  await mkdir(assistantDir, { recursive: true })
  await writeFile(join(assistantDir, '_moss_meta.json'), JSON.stringify({
    id: name,
    name,
    display_name: name,
    ruleFile,
    source_type: 'tenant',
  }), 'utf8')
  await writeFile(join(assistantDir, 'system.md'), rules, 'utf8')

  const response = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant/publish`, {
    method: 'POST',
    headers: { ...authHeaders(fixture), 'Content-Type': 'application/json' },
    body: JSON.stringify({ assistantId: name }),
  })
  expect(response.status).toBe(200)
  const result = await response.json() as { id: string }
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

  const fixtureOutputDir = join(rootDir, 'fixture-build')
  const fixturePath = resolve(import.meta.dir, 'tenantAssistantRoutes.fixture.ts')
  const bundle = Bun.spawnSync([
    'bun', 'build', fixturePath,
    '--target=node',
    '--format=esm',
    '--outdir', fixtureOutputDir,
    '--external=better-sqlite3',
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
  it('fixture smoke', async () => {
    const fixture = await startFixture()
    const response = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant`, {
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

    const getResponse = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant/${id}/rules`, {
      headers: authHeaders(fixture),
    })
    expect(getResponse.status, fixture.stderrOutput.join('')).toBe(400)

    const patchResponse = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant/${id}`, {
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
    const createResponse = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant/create`, {
      method: 'POST',
      headers: { ...authHeaders(fixture), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'json-agent',
        display_name: 'JSON Agent',
        avatar: 'https://example.test/avatar.png',
        skills: ['skill-a'],
        visible_to: null,
        workflow: null,
        promptsI18n: { 'zh-CN': ['示例'] },
        categories: ['分类'],
      }),
    })
    expect(createResponse.status, fixture.stderrOutput.join('')).toBe(200)
    const created = await createResponse.json() as { data: { id: string; avatar: string } }
    expect(created.data.avatar).toBe('https://example.test/avatar.png')

    const patchResponse = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant/${created.data.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(fixture), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: 'Updated JSON Agent',
        avatar: 'https://example.test/updated.png',
        enabled: false,
        skills: ['skill-b'],
        visible_to: null,
        workflow: null,
      }),
    })
    expect(patchResponse.status, fixture.stderrOutput.join('')).toBe(200)

    const listResponse = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant`, {
      headers: authHeaders(fixture),
    })
    const assistants = await listResponse.json() as Array<{ id: string; avatar: string; display_name: string; enabled: number }>
    expect(assistants.find(assistant => assistant.id === created.data.id)).toMatchObject({
      avatar: 'https://example.test/updated.png',
      display_name: 'Updated JSON Agent',
      enabled: 0,
    })
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

    const createResponse = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant/create`, {
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

    const listResponse = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant`, {
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
    const createResponse = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant/create`, {
      method: 'POST',
      headers: authHeaders(fixture),
      body: createForm,
    })
    expect(createResponse.status).toBe(200)
    const created = await createResponse.json() as { data: { id: string; avatar: string } }

    const removeForm = new FormData()
    removeForm.set('remove_avatar', 'true')
    const removeResponse = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant/${created.data.id}`, {
      method: 'PATCH',
      headers: authHeaders(fixture),
      body: removeForm,
    })
    expect(removeResponse.status, fixture.stderrOutput.join('')).toBe(200)

    const listResponse = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant`, {
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
    const response = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant/${id}`, {
      method: 'PATCH',
      headers: authHeaders(fixture),
      body: form,
    })
    expect(response.status).toBe(400)
  })

  it('preserves a new avatar file when metadata persistence fails', async () => {
    const fixture = await startFixture()
    const { id, assistantDir } = await createPendingTenantAssistant(fixture, 'metadata-failure-agent', 'system.md')
    const metaPath = join(assistantDir, '_moss_meta.json')
    await chmod(metaPath, 0o444)

    const form = new FormData()
    form.set('avatar', new File([
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
    ], 'avatar.png', { type: 'image/png' }))
    const response = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant/${id}`, {
      method: 'PATCH',
      headers: authHeaders(fixture),
      body: form,
    })
    expect(response.status).toBe(500)

    await chmod(metaPath, 0o644)
    const listResponse = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant`, {
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
    const response = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant/create`, {
      method: 'POST',
      headers: { ...authHeaders(fixture), 'Content-Type': 'text/plain' },
      body: 'not supported',
    })
    expect(response.status).toBe(415)
  })

  it('reads and writes a valid pending tenant rule file', async () => {
    const fixture = await startFixture()
    const { id, assistantDir } = await createPendingTenantAssistant(fixture, 'safe-agent', 'system.md')

    const getResponse = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant/${id}/rules`, {
      headers: authHeaders(fixture),
    })
    expect(getResponse.status, fixture.stderrOutput.join('')).toBe(200)
    expect((await getResponse.json() as { rules: string }).rules).toBe('initial rules')

    const patchResponse = await fetch(`${fixture.baseUrl}/api/v1/agents/tenant/${id}`, {
      method: 'PATCH',
      headers: authHeaders(fixture),
      body: (() => {
        const form = new FormData()
        form.set('rules', 'updated rules')
        return form
      })(),
    })
    expect(patchResponse.status, fixture.stderrOutput.join('')).toBe(200)
    expect(await readFile(join(assistantDir, 'system.md'), 'utf8')).toBe('updated rules')
  })
})
