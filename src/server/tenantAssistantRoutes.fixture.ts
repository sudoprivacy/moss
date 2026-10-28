import { ensureSqliteCompatibilityDomainSchemas, ensureCompatibilityCoreSchema } from './db/compatibilitySchema.js'
import { randomUUID } from 'crypto'
import { readServerConfig, ensureServerDirectories } from './config.js'
import { DirectConnectStore } from './db.js'
import { RuntimeService } from './runtimeService.js'
import { createAuthService } from './auth/service.js'
import { startServer } from './server.js'

const configPath = process.env.MOSS_SERVER_CONFIG
if (!configPath) {
  throw new Error('MOSS_SERVER_CONFIG is required')
}

const { config } = await readServerConfig(configPath)
await ensureServerDirectories(config)

const store = new DirectConnectStore(config.dbPath)
ensureSqliteCompatibilityDomainSchemas(store.requireSqliteDb())
ensureCompatibilityCoreSchema(store.requireSqliteDb())
const { service: authService } = await createAuthService({
  db: store.requireSqliteDb(),
  dbPath: config.dbPath,
  tokenTtlSec: config.tokenTtlSec,
  bootstrapAdmin: config.bootstrapAdmin,
  phoneAuth: config.phoneAuth,
})
if (process.env.MOSS_TEST_MULTI_ORG_MEMBERSHIP === '1') {
  const person = await authService.provisionPhoneUser({ phone: '13900000001', nickname: 'Membership human', autoCreateOrg: true })
  const company = await authService.createOrganization({ name: 'Membership company' })
  for (const orgId of [person.user.orgId, company.organization.id]) {
    await authService.putOrganizationClientPolicy(orgId, { loginMethod: 'sms', loginMethodInherited: false }, 'local-http-fixture')
  }
}
if (process.env.MOSS_TEST_SHARED_MODEL_BILLING === '1') {
  const { OrganizationRouterAdapter } = await import('./billing/organizationRouterAdapter.js')
  const { RouterMock } = await import('./billing/testing/routerMock.js')
  const mock = new RouterMock({ adminToken: 'fixture-admin' })
  const secrets = new Map<string, string>()
  // This HTTP fixture exercises identity admission, not provider discovery.
  Object.assign(authService, { updateOrganizationSystemSettings: async () => ({}) })
  await authService.configureOrganizationBilling(new OrganizationRouterAdapter({
    baseUrl: 'http://fixture-router', apiToken: 'fixture-admin', adminUserId: '1', fetch: mock.fetch,
  }), {
    putSecret: async (_namespace, key, value) => { secrets.set(key, value) },
    getSecret: async (_namespace, key) => {
      const value = secrets.get(key)
      return value ? { value, status: 'enabled', version: 1 } : null
    },
  })
}
const runtime = new RuntimeService({
  config,
  store,
  authService,
  serverInstanceId: randomUUID(),
})
const server = startServer(config, runtime, authService, {
  info: () => {},
  warn: () => {},
  error: message => process.stderr.write(`TENANT_TEST_ERROR:${message}\n`),
  debug: () => {},
})
const port = await server.ready

if (port === null) {
  throw new Error('Server did not bind a port')
}

console.log(`TENANT_TEST_READY:${port}`)

await new Promise<void>(() => {})
