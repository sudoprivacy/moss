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
const { service: authService } = await createAuthService({
  db: store.db,
  dbPath: config.dbPath,
  tokenTtlSec: config.tokenTtlSec,
  bootstrapAdmin: config.bootstrapAdmin,
})
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
