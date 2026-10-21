import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createAuthService } from '../../auth/service.js'
import { getDefaultServerConfig, readServerConfig, ensureServerDirectories } from '../../config.js'
import { DirectConnectStore } from '../../db.js'
import { ensureCompatibilityCoreSchema, ensureSqliteCompatibilityDomainSchemas } from '../../db/compatibilitySchema.js'
import { DocumentStore } from '../../documentStore.js'
import { RuntimeService } from '../../runtimeService.js'
import { startServer } from '../../server.js'
import { initConfigStore } from '../../configStore/configStore.js'
import type { NexusClient } from '../../nexus/nexusClient.js'
import { ParkStore } from '../store.js'
import { recordSessionSearch } from '../parkAgentRoutes.js'
import { appendAgentInquiry } from '../agentInquiry.js'
import { FakeAgentChannel } from './fakeAgentChannel.js'

const root = await mkdtemp(join(tmpdir(), 'moss-park-server-'))
let store: DirectConnectStore | undefined
let server: ReturnType<typeof startServer> | undefined
try {
  process.env.MOSS_HOME = root
  const settings = getDefaultServerConfig()
  settings.server.host = '127.0.0.1'
  settings.server.port = 0
  settings.bootstrapAdmin.username = 'park-server-admin'
  settings.bootstrapAdmin.password = 'park-server-password'
  settings.storage = {
    rootDir: root,
    dbPath: join(root, 'moss.db'),
    transcriptDir: join(root, 'transcripts'),
    runtimeDir: join(root, 'runtime'),
  }
  settings.wikiIndex.enabled = false
  const configPath = join(root, 'server.json')
  await writeFile(configPath, JSON.stringify(settings))
  const { config } = await readServerConfig(configPath)
  await ensureServerDirectories(config)
  store = new DirectConnectStore(config.dbPath)
  ensureSqliteCompatibilityDomainSchemas(store.requireSqliteDb())
  ensureCompatibilityCoreSchema(store.requireSqliteDb())
  const { service: auth } = await createAuthService({
    db: store,
    dbPath: config.dbPath,
    tokenTtlSec: config.tokenTtlSec,
    bootstrapAdmin: config.bootstrapAdmin,
  })
  const issued = await auth.issueTokenFromPassword({
    username: settings.bootstrapAdmin.username,
    password: settings.bootstrapAdmin.password,
  })
  const orgId = issued.user.orgId
  process.env.PARK_ORG_ID = orgId
  process.env.PARK_SMS_HMAC_KEY = 'park-server-fixture-sms-hmac-key-over-32-characters'
  process.env.PARK_CAPTCHA_HMAC_KEY = 'park-server-fixture-captcha-hmac-key-over-32-characters'
  const secrets = new Map<string, string>()
  initConfigStore({
    getSecret: async (namespace: string, key: string) => {
      const value = secrets.get(`${namespace}:${key}`)
      return value === undefined ? null : { value }
    },
    putSecret: async (namespace: string, key: string, value: string) => { secrets.set(`${namespace}:${key}`, value) },
    deleteSecret: async (namespace: string, key: string) => { secrets.delete(`${namespace}:${key}`) },
  } as unknown as NexusClient)
  await auth.updateOrganizationSystemSettings(orgId, {
    model: 'fixture-model',
    apiKey: 'fixture-api-key',
    defaultModelProviderId: 'legacy-default',
    modelProviders: [{
      id: 'legacy-default', name: 'Fixture provider', kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1', discoveryUrl: 'http://127.0.0.1:1/v1/models',
      protocol: 'openai-completions', enabled: true,
    }],
  }, issued.user.id)
  const park = new ParkStore(store.driver)
  await park.init()
  await park.putConfig(orgId, { display_name: '真实服务测试园区', consent_text: '本园区承诺联系方式仅用于招商对接。' })
  await park.grantRole(orgId, issued.user.id, 'park_system_operator', issued.user.id)
  const documentStore = new DocumentStore(store)
  // Policy knowledge base: upload files, create a files-mode wiki, mark it built
  // (the real build runs through the scode-backed WikiJobExecutor and is covered
  // by the acceptance environment; this fixture pins the binding chain).
  const node = await documentStore.createNode({ orgId, parentId: null, name: '政策文件' })
  const upload = await documentStore.uploadDocument({
    orgId, nodeId: node.id, fileName: '算力政策.md', mimeType: 'text/markdown',
    content: Buffer.from('# 算力政策\n企业可申请园区算力服务。\n', 'utf8'), uploadedBy: issued.user.id,
  })
  const wiki = await documentStore.createWiki({ orgId, name: '园区政策库', sourceDocumentIds: [upload.id], sourceMode: 'files', createdBy: issued.user.id })
  await documentStore.setWikiBuildResult(wiki.id, { status: 'succeeded', lastBuiltAt: Date.now() })
  await mkdir(wiki.storagePath, { recursive: true })
  await writeFile(join(wiki.storagePath, '_moss_meta.json'), JSON.stringify({ builtAt: Date.now(), sourceDocumentIds: [upload.id], sourceDocuments: [{ id: upload.id, fileName: upload.fileName, nodeName: node.name, sizeBytes: upload.sizeBytes }] }))
  const runtime = new RuntimeService({
    config, store, authService: auth, serverInstanceId: randomUUID(),
  })
  const channel = new FakeAgentChannel()
  server = startServer(config, runtime, auth, {
    info: () => {}, warn: () => {}, debug: () => {}, error: () => {},
  }, undefined, undefined, undefined, undefined, undefined, undefined, channel)
  const port = await server.ready
  assert.ok(port)
  const base = `http://127.0.0.1:${port}`
  const adminHeaders = { authorization: `Bearer ${issued.access_token}`, 'content-type': 'application/json' }

  // Publishing the assistant binds the built policy wiki and the org skill.
  const published = await fetch(`${base}/api/v1/parks/${encodeURIComponent(orgId)}/admin/assistant`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ status: 'published', value: { policy_wiki_id: wiki.id } }),
  })
  assert.equal(published.status, 200, await published.text())
  const assistantConfig = JSON.parse((await park.config(orgId))!.assistant_config) as { assistant_id: string; policy_wiki_id: string }
  assert.equal(assistantConfig.policy_wiki_id, wiki.id)
  const skillRow = await store.driver.get('SELECT id FROM tenant_skills WHERE org_id = ? AND name = ?', [orgId, 'park-consultation-tools'])
  assert.ok(skillRow)

  const assistantPath = `${base}/api/v1/parks/${encodeURIComponent(orgId)}/admin/assistant`
  const replacement = await documentStore.createWiki({ orgId, name: '新的政策知识库', sourceDocumentIds: [upload.id], sourceMode: 'files', createdBy: issued.user.id })
  await documentStore.setWikiBuildResult(replacement.id, { status: 'succeeded', lastBuiltAt: Date.now() })
  const switched = await fetch(assistantPath, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ status: 'published', value: { policy_wiki_id: replacement.id } }) })
  assert.equal(switched.status, 200, await switched.text())
  const savedAssistant = await (await fetch(assistantPath, { headers: adminHeaders })).json() as { value: { policy_wiki_id: string } }
  assert.equal(savedAssistant.value.policy_wiki_id, replacement.id)
  const agent = await store.driver.get<{ config_json: string }>('SELECT config_json FROM tenant_assistants WHERE id = ?', [assistantConfig.assistant_id])
  assert.deepEqual((JSON.parse(agent!.config_json) as { enabledWikis: string[] }).enabledWikis, [replacement.id])
  // Return to the original fixture corpus for the remaining public-flow assertions.
  assert.equal((await fetch(assistantPath, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ status: 'published', value: { policy_wiki_id: wiki.id } }) })).status, 200)

  await auth.updateOrganizationSystemSettings(orgId, { apiKey: '' }, issued.user.id)
  const missingKey = await fetch(assistantPath, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ status: 'published', value: { policy_wiki_id: replacement.id } }) })
  assert.equal(missingKey.status, 400)
  assert.match((await missingKey.json() as { error: string }).error, /未取得.*凭据/)
  assert.equal((JSON.parse((await park.config(orgId))!.assistant_config) as { policy_wiki_id: string }).policy_wiki_id, wiki.id)
  await auth.updateOrganizationSystemSettings(orgId, { apiKey: 'fixture-api-key' }, issued.user.id)
  const currentModel = await auth.getOrganizationSystemSettings(orgId)
  await auth.updateOrganizationSystemSettings(orgId, { modelProviders: currentModel.modelProviders.map(provider => ({ ...provider, protocol: 'openai-responses' })) }, issued.user.id)
  const wrongProtocol = await fetch(assistantPath, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ status: 'published', value: { policy_wiki_id: replacement.id } }) })
  assert.equal(wrongProtocol.status, 400)
  assert.match((await wrongProtocol.json() as { error: string }).error, /协议.*openai-completions/)
  await auth.updateOrganizationSystemSettings(orgId, { modelProviders: currentModel.modelProviders }, issued.user.id)

  // Policy admin API: document listing and wiki build status are exposed.
  const documents = await fetch(`${base}/api/v1/parks/${encodeURIComponent(orgId)}/admin/policy/nodes/${node.id}/documents`, { headers: adminHeaders })
  assert.equal(documents.status, 200)
  assert.match(JSON.stringify(await documents.json()), /算力政策\.md/)
  const buildStatus = await fetch(`${base}/api/v1/parks/${encodeURIComponent(orgId)}/admin/policy/wikis/${wiki.id}/build-status`, { headers: adminHeaders })
  assert.equal(buildStatus.status, 200)
  assert.equal(((await buildStatus.json()) as { wiki_build_status: string }).wiki_build_status, 'succeeded')
  assert.equal((await fetch(`${base}/api/v1/parks/${encodeURIComponent(orgId)}/admin/policies`, { headers: adminHeaders })).status, 404)

  const sources = await fetch(`${base}/api/v1/parks/${encodeURIComponent(orgId)}/admin/policy/wikis/${wiki.id}/sources`, { headers: adminHeaders })
  assert.equal(sources.status, 200)
  assert.equal((await sources.json() as { sources: Array<{ fileName: string }> }).sources[0]!.fileName, upload.fileName)
  const logoBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="24"><rect width="80" height="24" fill="red"/></svg>')
  const currentConfig = (await park.config(orgId))!
  const logoSaved = await fetch(`${base}/api/v1/parks/${encodeURIComponent(orgId)}/admin/config`, {
    method: 'PUT', headers: adminHeaders, body: JSON.stringify({ ...currentConfig, service_catalog: JSON.parse(currentConfig.service_catalog), logo_upload: { file_name: 'park.svg', mime_type: 'image/svg+xml', content_base64: logoBytes.toString('base64') } }),
  })
  assert.equal(logoSaved.status, 200, await logoSaved.clone().text())
  const logoConfig = await logoSaved.json() as { logo_url: string }
  const publicLogo = await fetch(`${base}${logoConfig.logo_url}`)
  assert.equal(publicLogo.status, 200)
  assert.equal(publicLogo.headers.get('content-type'), 'image/svg+xml')
  assert.deepEqual(Buffer.from(await publicLogo.arrayBuffer()), logoBytes)

  // Public context carries the configured consent text and wiki-derived version.
  const context = await fetch(`${base}/public/consult/context`)
  assert.equal(context.status, 200)
  const contextBody = await context.json() as { display_name: string; consent_text: string; published_policy_version: string | null }
  assert.equal(contextBody.display_name, '真实服务测试园区')
  assert.equal(contextBody.consent_text, '本园区承诺联系方式仅用于招商对接。')
  assert.match(contextBody.published_policy_version ?? '', /^wiki-\d{4}-\d{2}-\d{2}$/)

  // Anonymous consultation through the agent channel: session creation records
  // the mapping, the streamed answer flows back, and sources come from the
  // server-recorded policy search hits.
  channel.script = ['根据《算力政策.md》第 2 行：企业可申请园区算力服务。']
  const session = await fetch(`${base}/public/consult/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(session.status, 201)
  assert.match(session.headers.get('set-cookie') ?? '', /HttpOnly/)
  const cookie = session.headers.get('set-cookie')!.split(';')[0]
  const anonymousId = (await session.json() as { session_id: string }).session_id
  const mapping = await park.db.get<{ moss_session_id: string }>('SELECT moss_session_id FROM park_sessions WHERE id = ?', [anonymousId])
  assert.ok(mapping?.moss_session_id)
  assert.equal(channel.created[0]?.assistantId, assistantConfig.assistant_id)
  recordSessionSearch(mapping!.moss_session_id!, { count: 1, refs: [{ name: '算力政策.md', version: 'wiki-v1', section: '第 2 行' }], at: Date.now() })
  const reply = await fetch(`${base}/public/sessions/${anonymousId}/messages`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ message: '算力政策是什么？', client_request_id: randomUUID() }),
  })
  assert.equal(reply.status, 200)
  const events = await reply.text()
  assert.match(events, /企业可申请园区算力服务。/)
  assert.match(events, /event: sources/)
  assert.match(events, /算力政策\.md/)
  assert.match(events, /event: done/)
  // The turn is persisted by the agent skill path (simulated as park-tools does).
  await appendAgentInquiry(park, {
    orgId, sessionId: anonymousId, question: '算力政策是什么？',
    answer: '根据《算力政策.md》第 2 行：企业可申请园区算力服务。', intent: 'policy_inquiry',
    industryTags: [], policyHitCount: 1,
    sourceRefs: [{ name: '算力政策.md', version: 'wiki-v1', section: '第 2 行' }],
  })
  const history = await fetch(`${base}/public/sessions/${anonymousId}/messages`, { headers: { cookie } })
  assert.equal(history.status, 200)
  assert.match(JSON.stringify(await history.json()), /算力服务/)

  // Contact: email path without prior CAPTCHA/SMS; consent snapshot from config.
  const contact = await fetch(`${base}/public/sessions/${anonymousId}/contact`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'visitor@example.com', consent: true }),
  })
  assert.equal(contact.status, 201)
  const leadId = await park.db.get<{ id: string }>('SELECT id FROM park_leads WHERE source_session_id = ?', [anonymousId])
  assert.ok(leadId)
  const contactRow = await park.db.get<{ consent_text: string }>('SELECT consent_text FROM park_contacts WHERE lead_id = ?', [leadId!.id])
  assert.equal(contactRow?.consent_text, '本园区承诺联系方式仅用于招商对接。')

  // Direct contact on a fresh session (R12) creates a low-score lead.
  const fresh = await fetch(`${base}/public/consult/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const freshCookie = fresh.headers.get('set-cookie')!.split(';')[0]
  const freshId = (await fresh.json() as { session_id: string }).session_id
  const direct = await fetch(`${base}/public/sessions/${freshId}/contact`, {
    method: 'POST', headers: { cookie: freshCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'direct@example.com', consent: true }),
  })
  assert.equal(direct.status, 201)
  const directLead = await park.db.get<{ score: number; source_inquiry_id: string | null }>('SELECT score, source_inquiry_id FROM park_leads WHERE source_session_id = ?', [freshId])
  assert.equal(directLead?.score, 20)
  assert.equal(directLead?.source_inquiry_id, null)

  // Both contact paths persisted their lead records in the real store.
  const leadCount = await park.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM park_leads WHERE org_id = ?', [orgId])
  assert.equal(Number(leadCount?.count), 2)

  // Unauthenticated park admin access is rejected and audited.
  const adminPath = `${base}/api/v1/parks/${encodeURIComponent(orgId)}/admin/config`
  assert.equal((await fetch(adminPath)).status, 401)
  assert.equal((await fetch(adminPath, { headers: { authorization: `Bearer ${issued.access_token}` } })).status, 200)
  const audit = await fetch(`${base}/api/v1/parks/${encodeURIComponent(orgId)}/admin/audit-events`, { headers: { authorization: `Bearer ${issued.access_token}` } })
  assert.equal(audit.status, 200)
  assert.ok(((await audit.json()) as Array<{ response_status: number }>).some(event => event.response_status === 401))
  process.stdout.write('PARK_SERVER_TEST_OK\n')
} finally {
  await server?.stop()
  await store?.close()
  const tempRoot = resolve(tmpdir())
  const target = resolve(root)
  if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error('Unsafe test cleanup path')
  await rm(target, { recursive: true, force: true })
}
