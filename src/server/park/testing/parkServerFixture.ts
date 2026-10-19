import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createAuthService } from '../../auth/service.js'
import { getDefaultServerConfig, readServerConfig, ensureServerDirectories } from '../../config.js'
import { DirectConnectStore } from '../../db.js'
import { ensureCompatibilityCoreSchema, ensureSqliteCompatibilityDomainSchemas } from '../../db/compatibilitySchema.js'
import { RuntimeService } from '../../runtimeService.js'
import { startServer } from '../../server.js'
import { ParkStore } from '../store.js'

const root = await mkdtemp(join(tmpdir(), 'moss-park-server-'))
let store: DirectConnectStore | undefined
let server: ReturnType<typeof startServer> | undefined
try {
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
  const park = new ParkStore(store.driver)
  await park.init()
  await park.putConfig(orgId, { display_name: '真实服务测试园区' })
  await park.grantRole(orgId, issued.user.id, 'park_system_operator', issued.user.id)
  const runtime = new RuntimeService({
    config, store, authService: auth, serverInstanceId: randomUUID(),
  })
  server = startServer(config, runtime, auth, {
    info: () => {}, warn: () => {}, debug: () => {}, error: () => {},
  })
  const port = await server.ready
  assert.ok(port)
  const base = `http://127.0.0.1:${port}`
  const context = await fetch(`${base}/public/consult/context`)
  assert.equal(context.status, 200)
  assert.equal((await context.json() as { display_name: string }).display_name, '真实服务测试园区')
  const session = await fetch(`${base}/public/consult/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(session.status, 201)
  assert.match(session.headers.get('set-cookie') ?? '', /HttpOnly/)
  const adminPath = `${base}/api/v1/parks/${encodeURIComponent(orgId)}/admin/config`
  assert.equal((await fetch(adminPath)).status, 401)
  const authorized = await fetch(adminPath, { headers: {
    authorization: `Bearer ${issued.access_token}`,
  } })
  assert.equal(authorized.status, 200)
  const audit = await fetch(`${base}/api/v1/parks/${encodeURIComponent(orgId)}/admin/audit-events`, { headers: {
    authorization: `Bearer ${issued.access_token}`,
  } })
  assert.equal(audit.status, 200)
  assert.ok((await audit.json() as Array<{ response_status: number }>).some(
    event => event.response_status === 401,
  ))
  process.stdout.write('PARK_SERVER_TEST_OK\n')
} finally {
  if (server) await server.stop()
  if (store) await store.close()
  const tempRoot = resolve(tmpdir())
  const target = resolve(root)
  if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error('Unsafe test cleanup path')
  await rm(target, { recursive: true, force: true })
}
