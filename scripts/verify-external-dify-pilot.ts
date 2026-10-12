/** Opt-in live verification; credentials arrive on stdin and stay in memory. Never run against customer data. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { createInterface } from 'node:readline/promises'
import { randomUUID, randomBytes } from 'node:crypto'
import { issueAccessToken } from '../src/server/auth/token.js'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { writeFile, unlink, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { NexusManager } from '../src/server/nexus/nexusManager.js'
import { NexusClient } from '../src/server/nexus/nexusClient.js'
import { AuthCenterDb } from '../src/server/authCenter/db.js'
import { AuthService } from '../src/server/auth/service.js'
import { createCatalogTestRepository, createIdentityTestRepository } from '../src/server/testing/compatibilityRepositories.js'
import { dispatchExternalProvider } from '../src/server/externalProviders/routes.js'
import { digest } from '../src/server/externalProviders/store.js'
import { ExternalProviderError } from '../src/server/externalProviders/policy.js'

async function main() {
  const prompt = createInterface({ input: process.stdin })
  const input = JSON.parse(await prompt.question('')) as { email: string; password: string; baseUrl?: string; appId?: string; sudoworkPath: string; preview?: boolean; ui?: boolean }
  prompt.close()
  const base = input.baseUrl ?? 'http://10.0.1.158:8089'
  const appId = input.appId ?? '6a5b8645-dfdb-4d43-bc24-e8b628ce8b86'
  const login = await fetch(`${base}/console/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: input.email, password: Buffer.from(input.password).toString('base64'), remember_me: false, language: 'zh-Hans' }), signal: AbortSignal.timeout(10000) })
  assert.equal(login.status, 200, 'Console login failed')
  const cookies = login.headers.getSetCookie().map(value => value.split(';')[0])
  const csrf = cookies.find(value => value.startsWith('csrf_token='))?.slice('csrf_token='.length) ?? ''
  const headers = { Cookie: cookies.join('; '), 'X-CSRF-Token': decodeURIComponent(csrf) }
  async function consoleRead(path: string) {
    const response = await fetch(`${base}/console/api${path}`, { headers, signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error(`Console read failed (${response.status}): ${path}`)
    return response.json() as Promise<Record<string, any>>
  }
  const app = await consoleRead(`/apps/${appId}`)
  assert.equal(app.mode, 'advanced-chat', 'Pilot requires Chatflow')
  const workflow = await consoleRead(`/apps/${appId}/workflows/publish`)
  const nodes = workflow.graph?.nodes as Array<{ data?: { type?: string } }>
  assert(nodes?.length && nodes.every(node => ['start', 'llm', 'answer'].includes(node.data?.type ?? '')), 'Live check refuses tool/HTTP/action workflows')
  const keys = await consoleRead(`/apps/${appId}/api-keys`)
  const key = keys.data?.[0]?.token
  assert(typeof key === 'string' && key.length, 'An existing App key is required; this check never creates one')
  const workspaces = await consoleRead('/workspaces')
  const workspaceId = app.tenant_id ?? workspaces.current_workspace?.id ?? workspaces.current_workspace ?? workspaces.workspaces?.find((w: { current?: boolean; is_current?: boolean }) => w.current || w.is_current)?.id ?? (workspaces.workspaces?.length === 1 ? workspaces.workspaces[0].id : undefined)
  if (typeof workspaceId !== 'string') console.log(JSON.stringify({ phase: 'workspace-shape', appFields: Object.keys(app), fields: Object.keys(workspaces), workspaces: workspaces.workspaces }))
  assert(typeof workspaceId === 'string')
  console.log(JSON.stringify({ phase: 'provider-review', name: app.name, appId, mode: app.mode, nodeTypes: nodes.map(node => node.data?.type), sourceDigest: digest(JSON.stringify(workflow.graph)) }))

  const db = new DatabaseSync(':memory:'), authDb = new AuthCenterDb(db)
  const orgId = `pilot-${randomUUID()}`, userId = 'synthetic-admin'
  await authDb.createOrganization(orgId, 'Synthetic local pilot', Date.now())
  createIdentityTestRepository(db, {}, authDb.driver); createCatalogTestRepository(db, authDb.driver)
  await authDb.createUser({ id: userId, orgId, email: 'synthetic@example.test', name: userId, displayName: null, departmentId: null, role: 'super_admin', status: 'active', localAuth: true, tokenLimit: null, createdAt: Date.now(), passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null })
  await authDb.createUser({ id: 'synthetic-user', orgId, email: 'user@example.test', name: 'Synthetic user', displayName: null, departmentId: null, role: 'user', status: 'active', localAuth: true, tokenLimit: null, createdAt: Date.now(), passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null })
  const auth = new AuthService(authDb, 3600)
  process.env.MOSS_EXTERNAL_PILOT_ORGS = input.ui ? '' : orgId
  process.env.MOSS_EXTERNAL_PILOT_ENDPOINTS = input.ui ? '' : `${base}/v1`
  const runtimeDir = await mkdtemp(resolve(tmpdir(), 'dify-ui-nexus-'))
  process.env.NEXUS_IDENTITY_DIR = resolve(runtimeDir, 'identity')
  const reservation = createServer()
  await new Promise<void>(done => reservation.listen(0, '127.0.0.1', done))
  const grpcPort = (reservation.address() as { port: number }).port
  await new Promise<void>(done => reservation.close(() => done()))
  const manager = new NexusManager({ nexusDir: resolve(runtimeDir, 'data'), config: { mode: 'embedded', grpcPort } })
  await manager.start()
  const secrets = new NexusClient(manager.grpcUrl)
  if (!input.ui) await secrets.putSecret(`org:${orgId}:system:dify`, 'app-key', key)
  const service = auth.createExternalProviderService(secrets)
  await authDb.setConfig('issuer', 'synthetic-local-pilot')
  await authDb.setConfig('jwt_secret', randomBytes(32).toString('base64url'))
  const accessToken = issueAccessToken({ iss: authDb.getIssuer(), sub: userId, org_id: orgId, role: 'super_admin', scopes: ['*'], key_id: 'synthetic-pilot-fixture' }, authDb.getJwtSecret()).token
  const userToken = issueAccessToken({ iss: authDb.getIssuer(), sub: 'synthetic-user', org_id: orgId, role: 'user', scopes: ['*'], key_id: 'synthetic-user-fixture' }, authDb.getJwtSecret()).token
  assert(typeof accessToken === 'string', 'Local token missing')
  const server = createServer((req, res) => { void (async () => {
    try {
      const actor = await auth.verifyAccessToken(req.headers.authorization?.replace(/^Bearer /, '') ?? '')
      if (!actor) { res.writeHead(401); res.end(); return }
      let body = ''
      for await (const chunk of req) body += chunk
      const result = await dispatchExternalProvider(service, actor, req.method ?? 'GET', new URL(req.url ?? '/', 'http://localhost'), body ? JSON.parse(body) : {}, () => {
        if (!['admin', 'super_admin'].includes(actor.role)) throw new ExternalProviderError(403, 'ADMIN_REQUIRED')
      }, () => { if (actor.role !== 'super_admin') throw new ExternalProviderError(403, 'PLATFORM_ADMIN_REQUIRED') })
      res.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result.body))
    } catch { res.writeHead(401); res.end() }
  })() })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  const origin = `http://127.0.0.1:${port}`
  try {
    const { createMossExternalProviderPort } = await import(pathToFileURL(resolve(input.sudoworkPath, 'packages/moss-client/dist/MossExternalProviderClient.js')).href)
    const request = async ({ path, method, body }: { path: string; method: string; body?: unknown }) => {
      const response = await fetch(`${origin}${path}`, { method, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const data = await response.json()
      assert(response.ok, `Task API rejected: ${response.status} ${JSON.stringify(data)}`)
      return data
    }
    if (input.ui) {
      await preview(input.sudoworkPath, origin, accessToken, { endpoint: `${base}/v1`, apiKey: key, appId, workspaceId, definition: JSON.stringify({ workflow: { graph: workflow.graph } }), userToken })
      const binding = (await service.store.bindings({ orgId, userId }))[0]
      assert(binding, 'UI did not register a binding')
      await manager.stop(); await manager.start()
      const restoredSecret = await new NexusClient(manager.grpcUrl).getSecret(`org:${orgId}:external:${binding.id}`, 'app-key')
      assert.equal(restoredSecret?.value, key)
      const persistenceEvidence = { phase: 'nexus-persistence-passed', secretPort: 'real local Nexus vault', restarted: true, plainKeyInBinding: JSON.stringify(binding).includes(key) }
      assert.equal(persistenceEvidence.plainKeyInBinding, false)
      await writeFile(resolve('docs/external-provider-pilot/evidence/nexus-persistence.json'), JSON.stringify(persistenceEvidence, null, 2) + '\n')
      console.log(JSON.stringify(persistenceEvidence))
      return
    }
    const registered = await request({ method: 'POST', path: '/api/v1/external-agents', body: { name: app.name, endpoint: `${base}/v1`, app_id: appId, workspace_id: workspaceId, credential_ref: `nexus://org:${orgId}:system:dify/app-key`, source_digest: digest(JSON.stringify(workflow.graph)), decoder: 'reply_actions_v1', allowed_user_ids: [userId], review_expires_at: Date.now() + 3600000, review_note: 'Synthetic live check; published Start/LLM/Answer only; no provider-side actions' } })
    await request({ method: 'POST', path: `/api/v1/external-agents/${registered.data.id}/review`, body: { approved: true } })
    const client = createMossExternalProviderPort(request)
    const agents = await client.agents(); assert.equal(agents.length, 1)
    let sessionId: string | undefined, conversationId: string | undefined
    for (const [query, expected] of [['请计算 6 乘以 7。reply 只返回计算结果数字，不需要执行任何操作。', '42'], ['把上次结果加上 8。reply 只返回计算结果数字，不需要执行任何操作。', '50']]) {
      const input = { agent_id: agents[0].id, session_id: sessionId, query, idempotency_key: randomUUID() }
      const accepted = await client.create(input)
      assert.equal((await client.create(input)).id, accepted.id)
      let final = accepted, cursor = 0, events = 0
      const deadline = Date.now() + 130000
      while (!['succeeded', 'failed', 'unknown', 'rejected'].includes(final.status) && Date.now() < deadline) {
        const page = await client.events(accepted.id, cursor)
        final = page.task; cursor = page.next_cursor; events += page.events.length
        if (!['succeeded', 'failed', 'unknown', 'rejected'].includes(final.status)) await new Promise(done => setTimeout(done, 500))
      }
      console.log(JSON.stringify({ phase: 'live-task', taskId: final.id, sessionId: final.session_id, status: final.status, answer: final.answer, outputStatus: final.output_status, errorCode: final.error_code, events, providerRefs: final.provider_refs }))
      assert.equal(final.status, 'succeeded'); assert.equal(final.answer.trim(), expected)
      if (conversationId) assert.equal(final.provider_refs.conversation_id, conversationId)
      sessionId = final.session_id; conversationId = final.provider_refs.conversation_id
    }
    assert.equal((await client.history(sessionId)).length, 2)
    assert.equal((await client.sessions()).length, 1)
    const restored = createMossExternalProviderPort(request)
    assert.equal((await restored.history(sessionId))[1].answer.trim(), '50')
    assert.equal((await fetch(`${origin}/api/v1/external-sessions`)).status, 401)
    console.log(JSON.stringify({ phase: 'passed', chain: 'SudoWork shared client -> authenticated Moss HTTP task dispatcher/AuthService/DbDriver -> real Dify Chatflow', turns: 2, idempotency: true, historyReload: true, unauthenticatedDenied: true, secretPort: 'real local Nexus vault', store: 'isolated SQLite memory fixture' }))
    if (input.preview) await preview(input.sudoworkPath, origin, accessToken)
  } finally { await service.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); auth.destroy(); db.close(); await manager.stop(); await rm(runtimeDir, { recursive: true, force: true }) }
}
async function preview(sudoworkPath: string, origin: string, accessToken: string, browserInput?: { endpoint: string; apiKey: string; appId: string; workspaceId: string; definition: string; userToken: string }) {
  const webRoot = resolve(sudoworkPath, 'apps/webui')
  const requireWeb = createRequire(resolve(webRoot, 'package.json'))
  const { default: express } = await import(pathToFileURL(requireWeb.resolve('express')).href)
  const { createServer: createViteServer } = await import(pathToFileURL(requireWeb.resolve('vite')).href)
  const { createExternalProviderRouter } = await import(pathToFileURL(resolve(webRoot, 'src/server/features/externalProviders/externalProviderRoutes.ts')).href)
  const { encryptToken } = await import(pathToFileURL(resolve(webRoot, 'src/server/security/tokenCipher.ts')).href)
  const { mossRequest } = await import(pathToFileURL(resolve(sudoworkPath, 'packages/moss-client/dist/MossHttpClient.js')).href)
  const key = randomBytes(32), cookie = randomUUID()
  const encrypted = encryptToken(JSON.stringify({ accessToken, refreshToken: '', expiresAt: Date.now() + 3600000 }), key)
  const webSession = { id: 1, principalId: 'synthetic-admin', mossBaseUrl: origin, encryptedMossTokens: encrypted.ciphertext, tokenIv: encrypted.iv, tokenAuthTag: encrypted.authTag }
  const ordinary = encryptToken(JSON.stringify({ accessToken: browserInput?.userToken ?? accessToken, refreshToken: '', expiresAt: Date.now() + 3600000 }), key)
  const userCookie = randomUUID()
  const userSession = { ...webSession, id: 2, principalId: 'synthetic-user', encryptedMossTokens: ordinary.ciphertext, tokenIv: ordinary.iv, tokenAuthTag: ordinary.authTag }
  const app = express()
  app.use(express.json())
  app.use((req: any, _res: any, next: () => void) => { if (req.headers.cookie?.includes(`pilot_session=${cookie}`)) req.webSession = webSession; if (req.headers.cookie?.includes(`pilot_session=${userCookie}`)) req.webSession = userSession; next() })
  app.use('/api/v1', createExternalProviderRouter({ auth: { config: { tokenAesKey: key, moss: { baseUrl: origin } } }, request: mossRequest }))
  app.get('/verify/user', (_req: any, res: any) => { res.setHeader('Set-Cookie', `pilot_session=${userCookie}; HttpOnly; SameSite=Strict; Path=/`); res.redirect('/.external-pilot.html') })
  app.get('/', (_req: any, res: any) => { res.setHeader('Set-Cookie', `pilot_session=${cookie}; HttpOnly; SameSite=Strict; Path=/`); res.redirect('/.external-pilot.html') })
  const htmlPath = resolve(webRoot, '.external-pilot.html'), entryPath = resolve(webRoot, '.external-pilot.tsx')
  await writeFile(htmlPath, '<!doctype html><html><head><meta charset="UTF-8"><title>SudoWork external pilot verification</title></head><body><div id="root"></div><script type="module" src="/.external-pilot.tsx"></script></body></html>')
  await writeFile(entryPath, `import './src/client/bridgeAdapter/mossAdapter';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import agent from '@renderer/i18n/locales/zh-CN/agent.json';
import '@arco-design/web-react/dist/css/arco.css';
import 'virtual:uno.css';
await i18n.use(initReactI18next).init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: { agent } } }, interpolation: { escapeValue: false } });
const { default: ExternalAgents } = await import('@renderer/pages/external-agents');
createRoot(document.getElementById('root')!).render(<BrowserRouter><ExternalAgents /></BrowserRouter>);
`)
  const vite = await createViteServer({ root: webRoot, configFile: resolve(webRoot, 'vite.config.ts'), server: { middlewareMode: true, proxy: {}, watch: null, hmr: false }, appType: 'mpa' })
  app.use(vite.middlewares)
  const webServer = app.listen(0, '127.0.0.1')
  await new Promise<void>(done => webServer.on('listening', done))
  console.log(JSON.stringify({ phase: 'browser-preview', url: `http://127.0.0.1:${webServer.address().port}/`, auth: 'ephemeral encrypted WebUI session; production getMossContext + requireSession + proxy + bridge + renderer', note: 'Ctrl-C after verification; fixture files are removed' }))
  try {
    if (browserInput) {
      const { userToken: _userToken, ...payload } = browserInput
      await new Promise<void>((done, reject) => {
        const child = spawn('python3', [resolve('scripts/verify-external-dify-ui.py')], { stdio: ['pipe', 'inherit', 'inherit'] })
        child.stdin.end(JSON.stringify({ ...payload, url: `http://127.0.0.1:${webServer.address().port}/`, evidenceDir: resolve('docs/external-provider-pilot/evidence') }))
        child.once('error', reject)
        child.once('exit', code => code === 0 ? done() : reject(new Error(`Browser verification failed (${code})`)))
      })
    } else await new Promise<void>(done => { const timeout = setTimeout(done, 10 * 60000); process.once('SIGINT', () => { clearTimeout(timeout); done() }) })
  } finally {
  await vite.close(); webServer.closeAllConnections(); await new Promise<void>(done => webServer.close(() => done()))
  await unlink(htmlPath); await unlink(entryPath)
  }
}

main().then(() => process.exit(0), error => { console.error(error instanceof Error ? error.message : 'Live verification failed'); process.exit(1) })
