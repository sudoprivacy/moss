import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { appendSharedAgentMemory, readSharedAgentMemory, writeAssistantOverrideAgentsMd } from './sharedAgentMemory.js'
import { SessionStartupError } from './sessionStartup.js'
import { ResourceAccessError } from './catalog/resourceError.js'
import { RuntimeService } from './runtimeService.js'
import { DirectConnectStore } from './db.js'
import { DatabaseSync } from 'node:sqlite'
import { SqliteDriver } from './db/driver.js'
import { createCatalogTestRepository } from './testing/compatibilityRepositories.js'
import { withOrganizationResources, registerOrganizationCustom, updateOrganizationResource } from './catalog/organizationResources.js'
import { createUserAgent, resetUserAgentStoreForTests } from './userAgentStore.js'
import { defaultAgentName, userCreatedAgentName } from './agentIdentity.js'
import { getSessionConfigDir } from './runtimePaths.js'
import { buildWorkspaceInstructionsSecret, buildScodeSettings as buildK8sSettings } from './backends/k8sBackend.js'
import { buildScodeSettings as buildLocalSettings } from './backends/scodeBackend.js'
import { buildScodeSettings as buildDockerSettings } from './backends/dockerBackend.js'
import type { BackendSpawnOptions } from './sessionManager.js'
import type { AttemptRecord, ServerConfig, SessionRecord } from './types.js'

for (const [name, build] of [
  ['local', (input: BackendSpawnOptions) => buildLocalSettings(input, '/bundled/plugins')],
  ['docker', (input: BackendSpawnOptions) => buildDockerSettings(input, '/bundled/plugins')],
  ['kubernetes', buildK8sSettings],
] as const) {
  void test(`${name} runtime opts into MCP discovery only for authorized session servers`, () => {
    const input = { sessionId: 'fixture', enabledSkillNames: ['cabin-hardware-control'] } as BackendSpawnOptions
    for (const mcpSettings of [undefined, { mcpServers: {} }]) {
      const settings = build({ ...input, mcpSettings })
      assert.equal(settings.experimental, undefined)
      assert.equal(settings.mcpServers, undefined)
    }
    const mcpSettings = { mcpServers: {
      'authorized-remote': { type: 'http', url: 'https://qa.example/mcp', headers: { 'X-QA': 'fixture' } },
      'authorized-local': { type: 'stdio', command: 'node', args: ['qa-mcp.js'] },
    } }
    const before = JSON.stringify(mcpSettings)
    const settings = build({ ...input, mcpSettings })
    assert.deepEqual(settings.experimental, { mcpConfigServers: true })
    assert.deepEqual(settings.mcpServers, mcpSettings.mcpServers)
    assert.deepEqual(settings.sandbox, { enabled: false, enabledPlatforms: ['macos'], allowUnsandboxedCommands: true })
    if (name !== 'kubernetes') assert.deepEqual(settings.plugins, { bundledRoot: '/bundled/plugins' })
    assert.equal(JSON.stringify(mcpSettings), before)
  })
}

void test('personal cloud Agents retain memory and receive pod instructions without a catalog entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moss-personal-cloud-'))
  const db = new DatabaseSync(':memory:')
  createCatalogTestRepository(db)
  resetUserAgentStoreForTests()
  const orgId = 'org-one'
  const userId = 'user-one'
  const checkpoint = new Error('stop before external model lookup')
  let profileName = 'Fixture User'
  let created: SessionRecord
  const config = {
    runtimeDir: root,
    rootDir: root,
    defaultRuntime: 'k8s',
    engine: 'scode',
    dbBackend: 'sqlite',
    maxSessions: 0,
  } as ServerConfig
  const service = new RuntimeService({
    config,
    serverInstanceId: 'fixture',
    store: {
      driver: new SqliteDriver(db),
      listSessions: async () => [],
      createSession: async (input: SessionRecord) => {
        created = { ...input, endedAt: null, createdAt: Date.now(), lastActiveAt: Date.now() }
        return created
      },
      getSession: async () => created,
      addEvent: async () => {},
      updateSessionClientMetadata: async (_id: string, patch: Record<string, unknown>) => {
        created.clientMetadata = { ...created.clientMetadata, ...patch }
      },
      getNextGeneration: async () => 1,
      createAttempt: async (input: AttemptRecord) => ({ ...input, attemptId: 'test-attempt' }),
      setCurrentAttempt: async () => {},
    } as never,
    authService: {
      getTokenLimits: async () => ({ userLimit: null, departmentLimit: null }),
      buildVisibilityFilter: async () => ({ isAdmin: true, userId }),
      issueWikiSession: () => ({ token: 'fixture-token' }),
      getUserOrNull: async () => ({ id: userId, name: profileName, role: 'user' }),
      getUserDepartmentAncestorIds: async () => null,
      getOrganizationSystemSettings: async () => {
        throw checkpoint
      },
    } as never,
  })
  const runtime = service as unknown as {
    spawnAttempt: (session: SessionRecord) => Promise<AttemptRecord>
    spawnAttemptInResourceScope: (session: SessionRecord) => Promise<AttemptRecord>
  }
  const spawnAttempt = runtime.spawnAttempt.bind(service)
  runtime.spawnAttempt = async () => ({}) as AttemptRecord
  try {
    const own = await createUserAgent({ orgId, userId, displayName: 'Project Assistant' })
    for (const ref of [userCreatedAgentName(own.id), defaultAgentName(userId)]) {
      const session = await service.createSession({
        orgId,
        userId,
        role: 'user',
        scopes: [],
        assistantName: ref,
        dangerouslySkipPermissions: false,
      })
      assert.equal(session.runtime.k8sMode, 'user')
      const home = session.runtime.configDir!
      assert.equal(home, getSessionConfigDir(config, 'different-session', userId, 'user', orgId))
      assert.notEqual(
        home,
        getSessionConfigDir(config, 'different-session', userId, 'user', 'other-org'),
      )
      await appendSharedAgentMemory({
        configDir: home,
        assistantName: ref,
        content: 'My project color is olive-fixture',
        source: 'explicit',
      })
      await withOrganizationResources(
        { orgId, userId, snapshot: { orgId, resources: [] } },
        async () => {
          await assert.rejects(
            runtime.spawnAttemptInResourceScope(session),
            (error) => error === checkpoint,
          )
        },
      )
      const manifest = JSON.parse(
        await readFile(
          join(root, 'sessions', session.sessionId, 'attempt-0001', 'manifest.json'),
          'utf8',
        ),
      )
      assert.match(manifest.session.sharedMemory, /olive-fixture/)
      const secret = await buildWorkspaceInstructionsSecret(session.cwd, ref)
      assert.match(secret.data['AGENTS.md']!, /olive-fixture/)
      if (ref === userCreatedAgentName(own.id))
        assert.match(secret.data['AGENTS.md']!, /Project Assistant/)
      const controllerInstructions = await readFile(join(session.cwd, 'AGENTS.md'), 'utf8')
      profileName = 'Native Profile'
      await withOrganizationResources({ orgId, userId, snapshot: { orgId, resources: [] } }, async () => {
        await assert.rejects(runtime.spawnAttemptInResourceScope({ ...session,
          runtime: { ...session.runtime, type: 'cohost' } }), error => error === checkpoint)
      })
      const nativeManifest = JSON.parse(await readFile(
        join(root, 'sessions', session.sessionId, 'attempt-0001', 'manifest.json'), 'utf8'))
      assert.equal(nativeManifest.session.sharedMemory, null)
      assert.match(nativeManifest.session.agentInstructions, /Current user profile/)
      assert.match(nativeManifest.session.agentInstructions, /Native Profile/)
      assert(!nativeManifest.session.agentInstructions.includes('olive-fixture'), 'native memory has its own authoritative Agent store')
      assert.equal(await readFile(join(session.cwd, 'AGENTS.md'), 'utf8'), controllerInstructions)
      assert(!(await readSharedAgentMemory(home, ref))!.includes('Native Profile'))
      profileName = 'Fixture User'
    }
    const templateDir = join(root, 'recruiter-template')
    await mkdir(templateDir)
    await writeFile(join(templateDir, '_moss_meta.json'), '{}')
    const scope = { orgId, userId, driver: new SqliteDriver(db) }
    await withOrganizationResources(scope, () => registerOrganizationCustom('agent', templateDir, {
      id: 'recruiter-template', name: 'Recruiter', visible_to: { user_ids: [userId] }, enabled: true, rules: 'Evaluate recruitment candidates.', enabledSkills: [], memory_mode: 'session',
    }))
    const personalRef = userCreatedAgentName(own.id)
    const composed = await service.createSession({ orgId, userId, role: 'user', scopes: [], assistantName: personalRef, templateRef: 'recruiter-template', dangerouslySkipPermissions: false })
    assert.equal(composed.assistantName, personalRef)
    assert.equal(composed.clientMetadata?.session_template_ref, 'recruiter-template')
    assert.equal(composed.runtime.configDir, getSessionConfigDir(config, 'any-session', userId, 'user', orgId))
    await withOrganizationResources(scope, async () => {
      await assert.rejects(runtime.spawnAttemptInResourceScope({ ...composed, runtime: { ...composed.runtime, type: 'cohost' } }), error => error === checkpoint)
    })
    const composedManifest = JSON.parse(await readFile(join(root, 'sessions', composed.sessionId, 'attempt-0001', 'manifest.json'), 'utf8'))
    assert.match(composedManifest.session.agentInstructions, /Evaluate recruitment candidates/)
    assert.match(composedManifest.session.agentInstructions, /Project Assistant/)
    assert.equal(composedManifest.session.assistantName, personalRef)
    assert.match((await readSharedAgentMemory(composed.runtime.configDir!, personalRef))!, /olive-fixture/)
    await assert.rejects(service.createSession({ orgId, userId: 'other-user', role: 'user', scopes: [], assistantName: personalRef, templateRef: 'recruiter-template', dangerouslySkipPermissions: false }), SessionStartupError)
    await withOrganizationResources(scope, () => updateOrganizationResource('agent', 'recruiter-template', { enabled: false }))
    await assert.rejects(spawnAttempt(composed), (error: unknown) => error instanceof SessionStartupError && error.statusCode === 404 && error.failure.code === 'RESOURCE_UNAVAILABLE')
    for (const templateRef of ['recruiter-template', 'removed-template']) {
      await assert.rejects(service.createSession({ orgId, userId, role: 'user', scopes: [], assistantName: personalRef, templateRef, dangerouslySkipPermissions: false }), SessionStartupError)
    }
    const other = await createUserAgent({ orgId, userId, displayName: 'Other Assistant' })
    assert.equal(
      await readSharedAgentMemory(
        getSessionConfigDir(config, 'any-session', userId, 'user', orgId),
        userCreatedAgentName(other.id),
      ),
      null,
    )
  } finally {
    resetUserAgentStoreForTests()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

void test('application role separates model identity and preserves user AGENTS.md', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'moss-role-'))
  try {
    await writeAssistantOverrideAgentsMd({ workspace, assistantName: 'quote', assistantDisplayName: '物料报价助手', assistantRules: 'Calculate a 7.5% service fee.' })
    const role = await readFile(join(workspace, 'AGENTS.md'), 'utf8')
    assert.match(role, /If those rules do not specify an identity, use 物料报价助手 as your assistant name/)
    assert.match(role, /model identity truthfully/)
    assert.doesNotMatch(role, /override any default|Do not answer that you are|MUST answer/)
    await writeFile(join(workspace, 'AGENTS.md'), '# User rules\nKeep this file.')
    await writeAssistantOverrideAgentsMd({ workspace, assistantName: 'other' })
    assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), '# User rules\nKeep this file.')
    await writeFile(join(workspace, 'AGENTS.md'), '# Moss Assistant Override\nold generated rules')
    await writeAssistantOverrideAgentsMd({ workspace, assistantName: 'updated' })
    assert.match(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), /If those rules do not specify an identity, use updated as your assistant name/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

void test('startup failures are actionable, safe, and distinct for new attempts', () => {
  const first = new SessionStartupError(new ResourceAccessError(404, 'Bound skill not available'))
  const second = new SessionStartupError(new ResourceAccessError(404, 'Bound skill not available'))
  assert.equal(first.failure.isRetryable, false)
  assert.match(first.message, /organization administrator/)
  assert.notEqual(first.failure.attemptId, second.failure.attemptId)
  const attemptId = '00000000-0000-4000-8000-000000000001'
  const cause = new Error('secret internal path /private/key')
  const runner = new SessionStartupError(cause, 's', attemptId)
  assert.equal(runner.cause, cause)
  assert.equal(runner.failure.attemptId, attemptId)
  assert.equal(runner.failure.isRetryable, true)
  assert.doesNotMatch(runner.message, /private|secret/)
  assert.doesNotMatch(JSON.stringify(runner.failure), /private|secret/)
})

void test('a committed Session survives compute startup failure and resumes under its original identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-created-session-'))
  const store = new DirectConnectStore(':memory:')
  createCatalogTestRepository(store.requireSqliteDb())
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const service = new RuntimeService({
    config: { runtimeDir: root, rootDir: root, defaultRuntime: 'host', engine: 'scode',
      maxSessions: 0, resumeOnMissingRuntime: true, heartbeatTimeoutMs: 30_000 } as ServerConfig,
    store, serverInstanceId: 'fixture',
    authService: {
      getTokenLimits: async () => ({ userLimit: null, departmentLimit: null }),
      buildVisibilityFilter: async () => ({ isAdmin: false, userId: 'owner' }),
    } as never,
  })
  let launches = 0
  const mutable = service as unknown as { spawnAttempt(session: SessionRecord): Promise<AttemptRecord> }
  mutable.spawnAttempt = async session => {
    launches++
    if (launches === 1) {
      const failure = new SessionStartupError(new Error('compute unavailable'), session.sessionId)
      await store.addEvent(session.sessionId, null, 'startup_failed', failure.failure as unknown as Record<string, unknown>)
      throw failure
    }
    const attempt = await store.createAttempt({ sessionId: session.sessionId, generation: 1,
      backendType: 'host', resumeTranscriptSessionId: session.transcriptSessionId,
      serverInstanceId: 'fixture', attachPath: join(root, 'fixture.sock') })
    await store.setCurrentAttempt(session.sessionId, attempt.attemptId)
    await store.setSessionLifecycle(session.sessionId, 'active', 'active')
    return attempt
  }
  const created = await service.createSession({ userId: 'owner', orgId: 'org', role: 'user',
    scopes: [], dangerouslySkipPermissions: false })
  assert.equal(created.status, 'failed')
  assert.equal(created.desiredState, 'active')
  assert.equal(created.assistantName, defaultAgentName('owner'))
  assert.equal((await store.listSessions({ orgId: 'org', userId: 'owner' })).length, 1)
  assert.equal((await store.latestEvent(created.sessionId, 'startup_failed'))?.payload.sessionId, created.sessionId)
  const resumed = await service.ensureSessionReady(created.sessionId)
  assert.equal(resumed.session.sessionId, created.sessionId)
  assert.equal(resumed.session.taskId, created.taskId)
  assert.equal(resumed.session.status, 'active')
  assert.equal(launches, 2)
  assert.equal((await store.listSessions({ orgId: 'org', userId: 'owner' })).length, 1)
  await assert.rejects(service.createSession({ userId: 'owner', orgId: 'org', role: 'user',
    scopes: [], assistantName: defaultAgentName('foreign-owner'), dangerouslySkipPermissions: false }),
  error => error instanceof SessionStartupError && !error.failure.sessionId)
  assert.equal((await store.listSessions({ orgId: 'org', userId: 'owner' })).length, 1,
    'authorization and resource validation must still refuse before creation')
})

void test('artifact MCP protocol rejects invalid JSON and accepts valid declarations', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'moss-mcp-'))
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, resolve('src/server/artifactMcp.ts')], cwd: workspace, stderr: 'pipe' })
  const client = new Client({ name: 'regression-test', version: '1' })
  try {
    await client.connect(transport)
    assert((await client.listTools()).tools.some(tool => tool.name === 'moss_declare_artifacts'))
    await writeFile(join(workspace, 'data.json'), '// @final\n{}')
    const invalid = await client.callTool({ name: 'moss_declare_artifacts', arguments: { files: [{ path: 'data.json', intent: 'final' }] } })
    assert.equal(invalid.isError, true)
    await writeFile(join(workspace, 'data.json'), '{"amount":90.3}')
    const valid = await client.callTool({ name: 'moss_declare_artifacts', arguments: { files: [{ path: 'data.json', intent: 'final' }] } })
    assert.notEqual(valid.isError, true)
    const outside = await client.callTool({ name: 'moss_declare_artifacts', arguments: { files: [{ path: '../outside.json', intent: 'final' }] } })
    assert.equal(outside.isError, true)
  } finally { await client.close(); await transport.close(); await rm(workspace, { recursive: true, force: true }) }
})
