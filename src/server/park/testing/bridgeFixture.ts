import http from 'node:http'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteDriver } from '../../db/driver.js'
import { HttpError, writeJson } from '../../httpRespond.js'
import { handleInternalParkRoute, recordParkAudit } from '../internalRoutes.js'
import { handlePublicParkRoute } from '../publicRoutes.js'
import { ParkStore } from '../store.js'
import { ensureIdentitySchema } from '../../identity/identityRepository.js'
import { BoxOperations } from '../boxOperations.js'
import { ParkPhoneVerification } from '../phoneVerification.js'

const db = new DatabaseSync(':memory:')
ensureIdentitySchema(db)
db.exec('CREATE TABLE IF NOT EXISTS compatibility_id_counters (counter_key TEXT PRIMARY KEY, last_value INTEGER NOT NULL)')
const driver = new SqliteDriver(db)
const store = new ParkStore(driver)
const boxRoot = await mkdtemp(join(tmpdir(), 'park-box-e2e-'))
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
process.env.PARK_PUBLIC_URL = 'http://127.0.0.1:4173/consult'
await store.init()
await store.grantRole('park-1', 'leader-1', 'park_leader', 'admin-1')
await store.grantRole('park-1', 'recruiter-1', 'park_recruiter', 'admin-1')
await store.grantRole('park-1', 'operator-1', 'park_system_operator', 'admin-1')
await store.putConfig('park-1', { display_name: '测试园区', welcome_text: '欢迎咨询园区政策。' })
await store.putPolicy('park-1', { title: '算力政策', version: 'v1', section: '第一条', content: '算力服务可申请，具体以园区审核为准。', status: 'published', effectiveFrom: Date.now() - 1000, effectiveUntil: null })
await store.putQuickQuestion('park-1', { question: '有哪些算力支持？', sortOrder: 1, enabled: true })
await store.putQuickQuestion('park-1', { question: '企业入驻需要什么条件？', sortOrder: 2, enabled: true })
await store.putQuickQuestion('park-1', { question: '园区有哪些产业服务？', sortOrder: 3, enabled: true })
await store.putQuickQuestion('park-1', { question: '如何预约园区考察？', sortOrder: 4, enabled: true })

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
    if (path === '/__test__/box-log' && req.method === 'GET') {
      writeJson(res, 200, boxCalls)
      return
    }
    if (path.startsWith('/public/')) {
      if (await handlePublicParkRoute(req, res, path, { store, orgId: 'park-1', readBody, phoneVerification })) return
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
        { store, orgId: 'park-1', authService: {} as Parameters<typeof handleInternalParkRoute>[4]['authService'], readBody, boxOperations })
    } catch (error) {
      if (error instanceof HttpError && path.startsWith('/api/v1/parks/')) {
        await recordParkAudit(store, 'park-1', path, req.method ?? 'GET', error.statusCode, actor, error.message)
      }
      throw error
    }
    if (!handled) writeJson(res, 404, { error: 'NOT_FOUND' })
  })().catch(error => writeJson(res, error instanceof HttpError ? error.statusCode : 500, { error: String(error) }))
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
