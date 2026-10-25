/** Real HTTP/auth/storage with only runtime placement and execution replaced. */
import { randomUUID } from 'node:crypto'
import { mossAgentName, sessionAgentName } from '../agentIdentity.js'
import { once } from 'node:events'
import { createServer, createConnection } from 'node:net'
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
const reservedAgentNames = ['mine', 'install', 'visible', 'create', 'tenant', 'private-archives']
runtime.readAgentNamespace = async ownerId => {
  const orgId = await store.getUserOrgId(ownerId)
  if (!orgId) throw new Error('Fixture owner organization is missing')
  const moss = sessionAgentName(ownerId, mossAgentName(orgId, ownerId))
  return { isOwnerConfined: true,
    names: ['persistent-agent', 'worker-agent', moss, ...reservedAgentNames],
    managedNames: ['persistent-agent', moss, ...reservedAgentNames],
    executions: [{ name: 'worker-agent', ownerId, state: 'ready', kind: 'worker' }] }
}
runtime.upgradeUserRuntime = async ownerId => {
  const allocation = { ownerId, allocationId: 'primary', isPresent: true, isDrifted: false,
    phase: 'Running', expectedImage: 'fixture:verified', observedImageDigest: null, releaseId: null }
  return { ...allocation, allocations: [allocation] }
}
runtime.createSession = async input => {
  await runtime.requireSessionAgentAccess({ ...input, assistantName: input.assistantName ?? null })
  if (input.source === 'agent-manager' && input.runtime?.engine !== 'scode') throw new Error('Managed Agents require the shared engine')
  const sessionId = randomUUID()
  return store.createSession({ ...input, sessionId, transcriptSessionId: sessionId,
    transcriptPath: '', cwd: '/', runtime: { type: 'cohost', engine: 'scode' }, status: 'detached', desiredState: 'active' })
}
const runner = createServer(socket => {
  socket.on('data', bytes => {
    socket.write(`${JSON.stringify({ type: 'stdout', line: bytes.toString().trim() })}\n`)
  })
})
runner.listen(0, '127.0.0.1')
await once(runner, 'listening')
const runnerAddress = runner.address()
if (!runnerAddress || typeof runnerAddress === 'string') throw new Error('Fixture runner address is missing')
runtime.ensureSessionReady = async sessionId => ({ session: (await store.getSession(sessionId))!,
  attempt: { attemptId: 'fixture-attempt', attachPath: 'fixture' },
} as Awaited<ReturnType<RuntimeService['ensureSessionReady']>>)
runtime.connectToAttempt = async () => {
  const socket = createConnection(runnerAddress.port, '127.0.0.1')
  await once(socket, 'connect')
  return socket
}
const server = startServer(config, runtime, authService, {
  info: () => {}, warn: () => {}, debug: () => {}, error: message => process.stderr.write(`AGENT_TEST_ERROR:${message}\n`),
})
console.log(`AGENT_TEST_READY:${await server.ready}`)
await new Promise<void>(() => {})
