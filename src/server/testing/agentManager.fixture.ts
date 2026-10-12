/** Real HTTP/auth/storage with only runtime placement and execution replaced. */
import { randomUUID } from 'node:crypto'
import { readServerConfig, ensureServerDirectories } from '../config.js'
import { DirectConnectStore } from '../db.js'
import { ensureSqliteCompatibilityDomainSchemas, ensureCompatibilityCoreSchema } from '../db/compatibilitySchema.js'
import { createAuthService } from '../auth/service.js'
import { RuntimeService } from '../runtimeService.js'
import { startServer } from '../server.js'

if (process.env.MOSS_AGENT_MANAGER_FIXTURE !== '1') throw new Error('Explicit Agent manager fixture selection is required')
const { config } = await readServerConfig(process.env.MOSS_SERVER_CONFIG!)
await ensureServerDirectories(config)
const store = new DirectConnectStore(config.dbPath)
ensureSqliteCompatibilityDomainSchemas(store.requireSqliteDb())
ensureCompatibilityCoreSchema(store.requireSqliteDb())
const { service: authService } = await createAuthService({ db: store.requireSqliteDb(),
  dbPath: config.dbPath, tokenTtlSec: config.tokenTtlSec, bootstrapAdmin: config.bootstrapAdmin })
const runtime = new RuntimeService({ config, store, authService, serverInstanceId: randomUUID() })
runtime.readAgentNamespace = async ownerId => ({ isOwnerConfined: true,
  names: ['persistent-agent', 'worker-agent'], managedNames: ['persistent-agent'],
  executions: [{ name: 'worker-agent', ownerId, state: 'ready', kind: 'worker' }] })
runtime.createSession = async input => {
  const sessionId = randomUUID()
  return store.createSession({ ...input, sessionId, transcriptSessionId: sessionId,
    transcriptPath: '', cwd: '/', runtime: { type: 'cohost', engine: 'scode' }, status: 'detached', desiredState: 'active' })
}
const server = startServer(config, runtime, authService, {
  info: () => {}, warn: () => {}, debug: () => {}, error: message => process.stderr.write(`AGENT_TEST_ERROR:${message}\n`),
})
console.log(`AGENT_TEST_READY:${await server.ready}`)
await new Promise<void>(() => {})
