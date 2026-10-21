import http from 'node:http'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteDriver } from '../../db/driver.js'
import { HttpError, writeJson } from '../../httpRespond.js'
import { handleInternalParkRoute, recordParkAudit, parkAuditContext } from '../internalRoutes.js'
import { handlePublicParkRoute } from '../publicRoutes.js'
import { ParkStore } from '../store.js'
import { ensureIdentitySchema } from '../../identity/identityRepository.js'
import { BoxOperations } from '../boxOperations.js'
import { ParkPhoneVerification } from '../phoneVerification.js'
import { ParkCaptcha } from '../captcha.js'
import { FakeAgentChannel } from './fakeAgentChannel.js'
import { appendAgentInquiry } from '../agentInquiry.js'
import { recordSessionSearch } from '../parkAgentRoutes.js'
import { saveConsultationSources } from '../consultationSources.js'
import { extractLeadSignal } from '../rules.js'
import type { DocumentStore } from '../../documentStore.js'
import { ManagedImageStore } from '../../configuration/managedImageStore.js'

const db = new DatabaseSync(':memory:')
ensureIdentitySchema(db)
db.exec('CREATE TABLE IF NOT EXISTS compatibility_id_counters (counter_key TEXT PRIMARY KEY, last_value INTEGER NOT NULL)')
const driver = new SqliteDriver(db)
const store = new ParkStore(driver)
const boxRoot = await mkdtemp(join(tmpdir(), 'park-box-e2e-'))
const managedImages = new ManagedImageStore(join(boxRoot, 'uploads'))
const backupDir = join(boxRoot, 'backups')
const upgradeDir = join(boxRoot, 'upgrades')
await Promise.all([mkdir(backupDir), mkdir(upgradeDir)])
await writeFile(join(backupDir, 'snapshot.sqlite'), 'test archive')
const upgrade = Buffer.from('signed test upgrade')
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPath = join(boxRoot, 'upgrade-public.pem')
await Promise.all([
  writeFile(join(upgradeDir, 'upgrade.tar'), upgrade),
  writeFile(join(upgradeDir, 'upgrade.tar.sig'), sign(null, upgrade, privateKey)),
  writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' })),
])
const boxCalls: Array<{ action: string; args: string[] }> = []
const boxOperations = new BoxOperations({
  rootDir: boxRoot,
  backupDir,
  upgradeDir,
  publicKeyPath,
  version: 'park-e2e',
  hooks: Object.fromEntries(
    ['backup', 'restore', 'upgrade', 'rollback', 'reindex', 'modelCheck'].map(name => [name, join(boxRoot, `${name}.exe`)]),
  ),
  run: async (command, args) => {
    const action = basename(command, '.exe')
    boxCalls.push({ action, args })
    if (action === 'upgrade') throw new Error('Test upgrade failure')
    if (action === 'modelCheck') return JSON.stringify({ healthy: true })
    return `${action}-ok`
  },
})
const smsLog: Array<{ phone: string; code: string }> = []
const phoneVerification = new ParkPhoneVerification(store, async (phone, code) => {
  smsLog.push({ phone, code })
}, 'park-e2e-sms-hmac-key-with-more-than-32-characters')
// Realistic random CAPTCHA answers (no constant image); the latest answer is
// exposed via /__test__/captcha-answer so e2e flows can solve the challenge.
const CAPTCHA_SYMBOLS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
let lastCaptchaAnswer = ''
const captcha = new ParkCaptcha(store, 'park-e2e-captcha-key-with-more-than-32-characters', () => {
  lastCaptchaAnswer = Array.from({ length: 5 }, () => CAPTCHA_SYMBOLS[Math.floor(Math.random() * CAPTCHA_SYMBOLS.length)]).join('')
  return lastCaptchaAnswer
})
const agentChannel = new FakeAgentChannel()
agentChannel.script = ['算力服务可申请，具体以园区审核为准。']
process.env.PARK_PUBLIC_URL = 'http://127.0.0.1:4173/consult'
await store.init()
await store.grantRole('park-1', 'leader-1', 'park_leader', 'admin-1')
await store.grantRole('park-1', 'recruiter-1', 'park_recruiter', 'admin-1')
await store.grantRole('park-1', 'operator-1', 'park_system_operator', 'admin-1')
await store.putConfig('park-1', {
  display_name: '测试园区',
  welcome_text: '欢迎咨询园区政策。',
  consent_text: '本园区仅为招商对接目的处理您主动提交的联系方式。',
  assistant_status: 'published',
  assistant_config: JSON.stringify({ assistant_id: 'fixture-agent', policy_wiki_id: 'wiki-1' }),
  rate_config: JSON.stringify({ anonymous_session_max: 16, anonymous_session_idle_minutes: 30 }),
})
await store.putPolicy('park-1', { title: '算力政策', version: 'v1', section: '第一条', content: '算力服务可申请，具体以园区审核为准。', status: 'published', effectiveFrom: Date.now() - 1000, effectiveUntil: null })
await store.putQuickQuestion('park-1', { question: '有哪些算力支持？', sortOrder: 1, enabled: true })
await store.putQuickQuestion('park-1', { question: '企业入驻需要什么条件？', sortOrder: 2, enabled: true })
await store.putQuickQuestion('park-1', { question: '园区有哪些产业服务？', sortOrder: 3, enabled: true })
await store.putQuickQuestion('park-1', { question: '如何预约园区考察？', sortOrder: 4, enabled: true })

type FixtureNode = { id: string; orgId: string; parentId: string | null; name: string; autoManaged: boolean; description: null; sortOrder: number; createdAt: number; updatedAt: number; sourceId: null; sourcePath: null; alias: null; lastSyncedAt: null }
type FixtureDocument = { id: string; orgId: string; nodeId: string; fileName: string; mimeType: string; sizeBytes: number; storagePath: string; uploadedBy: string; uploadedAt: number; sourceId: null }
type FixtureWiki = { id: string; orgId: string; nodeId: null; name: string; description: null; storagePath: string; buildStatus: 'pending' | 'running' | 'succeeded' | 'failed'; sourceDocumentIds: string[]; lastBuiltAt: number | null; lastBuildError: string | null; createdBy: string; createdAt: number; updatedAt: number; sourceMode: 'files'; sourceNodeId: null; sourceNodeIds: string[]; sourceExcludeNodeIds: string[]; autoRebuild: boolean; needsRebuild: boolean; hasBuilt: boolean }

class FixtureDocumentStore {
  readonly nodes: FixtureNode[] = []
  readonly documents: FixtureDocument[] = []
  readonly wikis: FixtureWiki[] = []
  readonly jobs = new Map<string, { id: string; wikiId: string; status: string }>()

  async listTree(orgId: string) { return this.nodes.filter((node) => node.orgId === orgId) }
  async getNode(id: string, orgId: string) { return this.nodes.find((node) => node.id === id && node.orgId === orgId) ?? null }
  async createNode(input: { orgId: string; parentId: string | null; name: string }) {
    const now = Date.now()
    const node: FixtureNode = { id: randomUUID(), orgId: input.orgId, parentId: input.parentId, name: input.name, autoManaged: false, description: null, sortOrder: this.nodes.length, createdAt: now, updatedAt: now, sourceId: null, sourcePath: null, alias: null, lastSyncedAt: null }
    this.nodes.push(node)
    return node
  }
  async listDocumentsForNode(nodeId: string, orgId: string) { return this.documents.filter((document) => document.nodeId === nodeId && document.orgId === orgId) }
  async getDocument(id: string, orgId: string) { return this.documents.find((document) => document.id === id && document.orgId === orgId) ?? null }
  async uploadDocument(input: { orgId: string; nodeId: string; fileName: string; mimeType: string; content: Buffer; uploadedBy: string }) {
    const document: FixtureDocument = { id: randomUUID(), orgId: input.orgId, nodeId: input.nodeId, fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.content.byteLength, storagePath: `fixture/${input.fileName}`, uploadedBy: input.uploadedBy, uploadedAt: Date.now(), sourceId: null }
    this.documents.push(document)
    return document
  }
  async deleteDocument(id: string, orgId: string) {
    const index = this.documents.findIndex((document) => document.id === id && document.orgId === orgId)
    if (index >= 0) this.documents.splice(index, 1)
  }
  async listWikis(orgId: string) { return this.wikis.filter((wiki) => wiki.orgId === orgId) }
  async getWiki(id: string, orgId: string) { return this.wikis.find((wiki) => wiki.id === id && wiki.orgId === orgId) ?? null }
  async createWiki(input: { orgId: string; name: string; sourceDocumentIds: string[]; createdBy: string }) {
    const now = Date.now()
    const id = randomUUID()
    const wiki: FixtureWiki = { id, orgId: input.orgId, nodeId: null, name: input.name, description: null, storagePath: join(boxRoot, 'wikis', id), buildStatus: 'pending', sourceDocumentIds: [...input.sourceDocumentIds], lastBuiltAt: null, lastBuildError: null, createdBy: input.createdBy, createdAt: now, updatedAt: now, sourceMode: 'files', sourceNodeId: null, sourceNodeIds: [], sourceExcludeNodeIds: [], autoRebuild: false, needsRebuild: true, hasBuilt: false }
    this.wikis.push(wiki)
    return wiki
  }
  async updateWiki(id: string, orgId: string, patch: { name?: string; sourceDocumentIds?: string[] }) {
    const wiki = await this.getWiki(id, orgId)
    if (!wiki) throw new Error('Wiki not found')
    if (patch.name) wiki.name = patch.name
    if (patch.sourceDocumentIds) wiki.sourceDocumentIds = [...patch.sourceDocumentIds]
    wiki.needsRebuild = true
    wiki.updatedAt = Date.now()
    return wiki
  }
  async createBuildJob(input: { wikiId: string }) {
    const id = randomUUID()
    const job = { id, wikiId: input.wikiId, status: 'queued' }
    this.jobs.set(input.wikiId, job)
    setTimeout(() => { void (async () => {
      const wiki = this.wikis.find((item) => item.id === input.wikiId)
      if (!wiki) return
      job.status = 'succeeded'
      wiki.buildStatus = 'succeeded'
      wiki.lastBuiltAt = Date.now()
      wiki.lastBuildError = null
      wiki.needsRebuild = false
      wiki.hasBuilt = true
      await this.writeSources(wiki)
    })().catch(error => { job.status = 'failed'; console.error(error) }) }, 80)
    return job
  }
  async setWikiBuildResult(id: string, result: { status: FixtureWiki['buildStatus']; lastBuiltAt?: number | null; lastBuildError?: string | null }) {
    const wiki = this.wikis.find((item) => item.id === id)
    if (!wiki) return
    wiki.buildStatus = result.status
    if (result.lastBuiltAt !== undefined) wiki.lastBuiltAt = result.lastBuiltAt
    if (result.lastBuildError !== undefined) wiki.lastBuildError = result.lastBuildError
  }
  async getLatestBuildJob(id: string) { return this.jobs.get(id) ?? null }
  async writeSources(wiki: FixtureWiki) {
    const sourceDocuments = await Promise.all(wiki.sourceDocumentIds.map(async id => {
      const document = await this.getDocument(id, wiki.orgId)
      if (!document) return null
      const node = await this.getNode(document.nodeId, wiki.orgId)
      return { id, fileName: document.fileName, nodeName: node?.name ?? '', sizeBytes: document.sizeBytes }
    }))
    await mkdir(wiki.storagePath, { recursive: true })
    await writeFile(join(wiki.storagePath, '_moss_meta.json'), JSON.stringify({ builtAt: wiki.lastBuiltAt, sourceDocumentIds: wiki.sourceDocumentIds, sourceDocuments: sourceDocuments.filter(Boolean) }))
  }
}

const fixtureDocuments = new FixtureDocumentStore()
const policyNode = await fixtureDocuments.createNode({ orgId: 'park-1', parentId: null, name: '政策文件' })
const policyDocument = await fixtureDocuments.uploadDocument({ orgId: 'park-1', nodeId: policyNode.id, fileName: '算力政策.md', mimeType: 'text/markdown', content: Buffer.from('算力服务可申请，具体以园区审核为准。'), uploadedBy: 'operator-1' })
const initialWiki = await fixtureDocuments.createWiki({ orgId: 'park-1', name: '园区政策库', sourceDocumentIds: [policyDocument.id], createdBy: 'operator-1' })
initialWiki.id = 'wiki-1'
initialWiki.buildStatus = 'succeeded'
initialWiki.lastBuiltAt = Date.now()
initialWiki.needsRebuild = false
initialWiki.hasBuilt = true
await fixtureDocuments.writeSources(initialWiki)

agentChannel.beforeSend = async () => {
  const sent = agentChannel.sent.at(-1)
  if (!sent) return
  const index = Number(sent.mossSessionId.replace('fake-agent-', '')) - 1
  const anonymousSessionId = agentChannel.created[index]?.anonymousSessionId
  if (!anonymousSessionId) return
  const refs = await saveConsultationSources(store.db, 'park-1', anonymousSessionId,
    [{ file: '算力政策.md', document_id: policyDocument.id, wiki_id: initialWiki.id, version: 'wiki-fixture', line_no: 1, end_line: 1, line: '算力服务可申请，具体以园区审核为准。' }],
    [{ source: { id: policyDocument.id, fileName: '算力政策.md', nodeName: '政策文件', sizeBytes: 1 }, version: 'wiki-fixture', markdown: '算力服务可申请，具体以园区审核为准。' }])
  recordSessionSearch(sent.mossSessionId, { count: 1, refs, at: Date.now() })
  const config = await store.config('park-1')
  const redactionConfig = JSON.parse(config?.redaction_config || '{}') as { extra_terms?: string[]; summary_max_length?: number }
  const inquiryId = await appendAgentInquiry(store, { orgId: 'park-1', sessionId: anonymousSessionId, question: sent.question, answer: agentChannel.script.join(''), intent: 'policy_inquiry', industryTags: [], policyHitCount: 1, sourceRefs: refs, redactionConfig })
  const signal = extractLeadSignal(sent.question)
  if (signal.score >= 40) await store.saveLead('park-1', anonymousSessionId, inquiryId, signal)
}

let statusOverride: SessionStatusOverride | null = null
interface SessionStatusOverride { closing_at: number | null; closed: boolean }

const readBody = async (request: http.IncomingMessage): Promise<Record<string, unknown>> => {
  let raw = ''
  for await (const chunk of request) raw += String(chunk)
  return raw ? JSON.parse(raw) as Record<string, unknown> : {}
}

const fixtureActors: Record<string, string> = {
  leader: 'leader-1', recruiter: 'recruiter-1', operator: 'operator-1', visitor: 'visitor-1',
}

function fixtureTokens(actor: string) {
  return {
    access_token: `${actor}-token`,
    refresh_token: `fixture-refresh-${actor}`,
    token_type: 'Bearer',
    expires_in: 3600,
  }
}

const server = http.createServer((req, res) => {
  void (async () => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/api/v1/auth/login' && req.method === 'POST') {
      const body = await readBody(req)
      const username = String(body.username ?? '')
      if (body.grant_type !== 'password' || !fixtureActors[username] || body.password !== 'park-test-password') {
        writeJson(res, 401, { error: 'INVALID_CREDENTIALS' })
        return
      }
      writeJson(res, 200, fixtureTokens(username))
      return
    }
    if (path === '/api/v1/auth/token' && req.method === 'POST') {
      const body = await readBody(req)
      const actor = String(body.refresh_token ?? '').replace(/^fixture-refresh-/, '')
      if (body.grant_type !== 'refresh_token' || !fixtureActors[actor]) {
        writeJson(res, 401, { error: 'INVALID_REFRESH_TOKEN' })
        return
      }
      writeJson(res, 200, fixtureTokens(actor))
      return
    }
    if (path === '/api/v1/auth/me' && req.method === 'GET') {
      const actor = String(req.headers.authorization ?? '').replace(/^Bearer /, '').replace(/-token$/, '')
      if (!fixtureActors[actor]) {
        writeJson(res, 401, { error: 'UNAUTHORIZED' })
        return
      }
      writeJson(res, 200, {
        user: { id: fixtureActors[actor], name: `园区${actor}` },
        organization: { id: 'park-1', name: '测试园区' },
        role: 'USER',
        scopes: [],
      })
      return
    }
    if (path === '/__test__/sms-log' && req.method === 'GET') {
      writeJson(res, 200, smsLog)
      return
    }
    if (path === '/__test__/captcha-answer' && req.method === 'GET') {
      writeJson(res, 200, { answer: lastCaptchaAnswer })
      return
    }
    if (path === '/__test__/box-log' && req.method === 'GET') {
      writeJson(res, 200, boxCalls)
      return
    }
    if (path === '/__test__/status-override' && req.method === 'POST') {
      const body = await readBody(req)
      statusOverride = {
        closing_at: typeof body.closing_at === 'number' ? body.closing_at : null,
        closed: body.closed === true,
      }
      writeJson(res, 200, statusOverride)
      return
    }
    if (path === '/__test__/contact-config' && req.method === 'POST') {
      const body = await readBody(req)
      await store.putConfig('park-1', { consent_text: String(body.consent_text ?? '') })
      writeJson(res, 200, { ok: true })
      return
    }
    if (/^\/public\/sessions\/[^/]+\/status$/.test(path) && req.method === 'GET' && statusOverride) {
      writeJson(res, 200, statusOverride)
      return
    }
    if (path.startsWith('/public/')) {
      if (await handlePublicParkRoute(req, res, path, {
        store,
        orgId: 'park-1',
        readBody,
        phoneVerification,
        captcha,
        agentChannel,
        documentStore: fixtureDocuments as unknown as DocumentStore,
        managedImages,
      })) return
    }
    const actorName = String(req.headers.authorization ?? '').replace(/^Bearer /, '').replace(/-token$/, '')
    const actor = fixtureActors[actorName]
    if (!actor) {
      if (path.startsWith('/api/v1/parks/')) await recordParkAudit(store, 'park-1', path, req.method ?? 'GET', 401, null, 'Unauthorized')
      throw new HttpError(401, 'Unauthorized')
    }
    let handled: boolean
    try {
      handled = await handleInternalParkRoute(req, res, path,
        { userId: actor, orgId: 'park-1', role: 'user', scopes: [] } as unknown as Parameters<typeof handleInternalParkRoute>[3],
        {
          store,
          orgId: 'park-1',
          authService: {
            getUserName: async (id: string) => ({ 'operator-1': 'operator', 'leader-1': 'leader', 'recruiter-1': 'recruiter' })[id as 'operator-1' | 'leader-1' | 'recruiter-1'],
            getOrganizationSystemSettings: async () => ({
              model: 'fixture-model', apiKey: 'fixture-key', defaultModelProviderId: 'legacy-default',
              modelProviders: [{ id: 'legacy-default', name: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://fixture.invalid/v1', discoveryUrl: 'http://fixture.invalid/v1/models', protocol: 'openai-completions', enabled: true }],
            }),
          } as unknown as Parameters<typeof handleInternalParkRoute>[4]['authService'],
          readBody,
          boxOperations,
          documentStore: fixtureDocuments as unknown as DocumentStore,
          parkSkillEntries: Promise.resolve([]),
          managedImages,
        })
    } catch (error) {
      if (error instanceof HttpError && path.startsWith('/api/v1/parks/')) {
        await recordParkAudit(store, 'park-1', path, req.method ?? 'GET', error.statusCode, actor, error.message, parkAuditContext(req))
      }
      throw error
    }
    if (!handled) writeJson(res, 404, { error: 'NOT_FOUND' })
  })().catch(error => {
    if (!res.headersSent) writeJson(res, error instanceof HttpError ? error.statusCode : 500, { error: error instanceof HttpError ? error.message : String(error) })
    else res.end()
  })
})

server.listen(Number(process.env.PARK_FIXTURE_PORT ?? 0), '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Park fixture listener unavailable')
  process.stdout.write(`PORT:${address.port}\n`)
})

process.on('SIGTERM', () => {
  server.closeAllConnections()
  server.close(() => {
    const tempRoot = resolve(tmpdir())
    const target = resolve(boxRoot)
    if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error('Unsafe fixture cleanup path')
    void Promise.all([driver.close(), rm(target, { recursive: true, force: true })]).finally(() => process.exit(0))
  })
})
