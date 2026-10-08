import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { appendSharedAgentMemory, readSharedAgentMemory, writeAssistantOverrideAgentsMd } from './sharedAgentMemory.js'
import { SessionStartupError } from './sessionStartup.js'
import { ResourceAccessError } from './catalog/resourceError.js'
import { RuntimeService } from './runtimeService.js'
import { DatabaseSync } from 'node:sqlite'
import { SqliteDriver } from './db/driver.js'
import { createCatalogTestRepository } from './testing/compatibilityRepositories.js'
import { withOrganizationResources } from './catalog/organizationResources.js'
import { createUserAgent, resetUserAgentStoreForTests } from './userAgentStore.js'
import { defaultAgentName, userCreatedAgentName } from './agentIdentity.js'
import { getSessionConfigDir } from './runtimePaths.js'
import { buildWorkspaceInstructionsSecret } from './backends/k8sBackend.js'
import type { AttemptRecord, ServerConfig, SessionRecord } from './types.js'

void test('personal cloud Agents retain memory and receive pod instructions without a catalog entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moss-personal-cloud-'))
  const db = new DatabaseSync(':memory:')
  createCatalogTestRepository(db)
  resetUserAgentStoreForTests()
  const orgId = 'org-one'
  const userId = 'user-one'
  const checkpoint = new Error('stop before external model lookup')
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
      getNextGeneration: async () => 1,
      createAttempt: async (input: AttemptRecord) => ({ ...input, attemptId: 'test-attempt' }),
      setCurrentAttempt: async () => {},
    } as never,
    authService: {
      getTokenLimits: async () => ({ userLimit: null, departmentLimit: null }),
      buildVisibilityFilter: async () => ({ isAdmin: true, userId }),
      issueWikiSession: () => ({ token: 'fixture-token' }),
      getUserOrNull: async () => ({ id: userId, name: 'Fixture User', role: 'user' }),
      getUserDepartmentAncestorIds: async () => null,
      getOrganizationSystemSettings: async () => {
        throw checkpoint
      },
    } as never,
  })
  const runtime = service as unknown as {
    spawnAttempt: () => Promise<AttemptRecord>
    spawnAttemptInResourceScope: (session: SessionRecord) => Promise<AttemptRecord>
  }
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
  const runner = new SessionStartupError(new Error('secret internal path /private/key'), 's', attemptId)
  assert.equal(runner.failure.attemptId, attemptId)
  assert.equal(runner.failure.isRetryable, true)
  assert.doesNotMatch(runner.message, /private|secret/)
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
