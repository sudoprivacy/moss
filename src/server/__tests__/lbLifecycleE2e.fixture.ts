// Real-process E2E fixture for the LB lifecycle surface (readiness / route
// cookie / graceful drain / budget stats). Bundled with `bun build
// --target=node` and spawned under node by lbLifecycleE2e.test.ts — the same
// build+runtime shape as production (deploy/server.Dockerfile runs
// `node bin/moss-server.mjs`), so the extracted readiness.ts / httpRespond.ts
// modules are exercised through their real deployment path.
import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { createServer as createTcpServer, connect as connectTcp } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { readServerConfig, ensureServerDirectories } from '../config.js'
import { DirectConnectStore } from '../db.js'
import { RuntimeService } from '../runtimeService.js'
import { createAuthService } from '../auth/service.js'
import { startServer } from '../server.js'
import type { SessionRuntimeInfo } from '../sessionManager.js'
import {
  ensureCompatibilityCoreSchema,
  ensureSqliteCompatibilityDomainSchemas,
} from '../db/compatibilitySchema.js'
import { repairConfigAvailability } from '../configuration/configAvailabilitySchema.js'

const configPath = process.env.MOSS_SERVER_CONFIG
if (!configPath) {
  throw new Error('MOSS_SERVER_CONFIG is required')
}

const { config } = await readServerConfig(configPath)
await ensureServerDirectories(config)

const store = new DirectConnectStore(config.dbPath)
const sqliteDb = store.requireSqliteDb()
ensureSqliteCompatibilityDomainSchemas(sqliteDb)
ensureCompatibilityCoreSchema(sqliteDb)
await store.ensureDefaultConfigItems()
await repairConfigAvailability(store.driver)
const { service: authService } = await createAuthService({
  db: store,
  dbPath: config.dbPath,
  tokenTtlSec: config.tokenTtlSec,
  bootstrapAdmin: config.bootstrapAdmin,
})

// Seed one session + transcript so GET /api/v1/budget/stats executes the
// budgetStats → utils/jsonl.ts (readJSONLFile) + utils/transcriptGuard.ts
// (isTranscriptMessage) production path with known numbers. The assistant
// entry carries usage 100+50=150 total tokens; the summary entry must be
// filtered out by the transcript guard; the user entry passes the guard but
// carries no usage and is skipped by the usage parser.
const { username, password } = config.bootstrapAdmin
if (!username || !password) throw new Error('Lifecycle fixture requires bootstrap credentials')
const issued = await authService.issueTokenFromPassword({ username, password })
// ServerConfig is flat (readServerConfig unfolds the server.json nesting):
// transcriptDir/dbPath/runtimeDir are top-level, there is no config.storage.
const transcriptDir = join(config.transcriptDir, 'lb-e2e-transcripts')
await mkdir(transcriptDir, { recursive: true })
const transcriptPath = join(transcriptDir, 'seed.jsonl')
const now = new Date().toISOString()
await writeFile(
  transcriptPath,
  [
    JSON.stringify({
      type: 'assistant',
      timestamp: now,
      isSidechain: false,
      parentUuid: null,
      message: { model: 'lb-e2e-model', usage: { input_tokens: 100, output_tokens: 50 } },
    }),
    JSON.stringify({ type: 'summary', timestamp: now, summary: 'not a transcript message' }),
    JSON.stringify({
      type: 'user',
      timestamp: now,
      isSidechain: false,
      parentUuid: null,
      message: { content: 'hi' },
    }),
  ].join('\n') + '\n',
  'utf8',
)
const runtimeInfo: SessionRuntimeInfo = { type: 'host', engine: 'scode' }
await store.createSession({
  sessionId: 'lb-e2e-seed-session',
  transcriptSessionId: 'lb-e2e-seed-session',
  transcriptPath,
  userId: issued.user.id,
  orgId: issued.user.orgId,
  role: issued.user.role,
  scopes: ['*'],
  cwd: config.runtimeDir,
  runtime: runtimeInfo,
  status: 'active',
  desiredState: 'active',
})

const runtime = new RuntimeService({
  config,
  store,
  authService,
  serverInstanceId: randomUUID(),
})
if (process.env.MOSS_TEST_DELAYED_RUNNER === '1') {
  const runner = createTcpServer(socket => {
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let boundary: number
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, boundary)) as { type: string; data: string }
        buffer = buffer.slice(boundary + 1)
        if (frame.type === 'stdin') {
          socket.write(`${JSON.stringify({ type: 'stdout', line: frame.data })}\n`)
        }
      }
    })
  })
  await new Promise<void>(resolve => runner.listen(0, '127.0.0.1', resolve))
  const address = runner.address()
  if (!address || typeof address === 'string') throw new Error('Missing runner address')
  const attempt = await store.createAttempt({
    sessionId: 'lb-e2e-seed-session',
    generation: 1,
    backendType: 'host',
    resumeTranscriptSessionId: 'lb-e2e-seed-session',
    serverInstanceId: 'delayed-runner-fixture',
  })
  runtime.ensureSessionReady = async () => {
    const session = await store.getSession('lb-e2e-seed-session')
    if (!session) throw new Error('Missing seed session')
    return { session, attempt }
  }
  runtime.connectToAttempt = async () => {
    await delay(1000)
    return new Promise((resolve, reject) => {
      const socket = connectTcp(address.port, '127.0.0.1', () => resolve(socket))
      socket.once('error', reject)
    })
  }
}
const server = startServer(config, runtime, authService, {
  info: () => {},
  warn: () => {},
  error: message => process.stderr.write(`LB_E2E_ERROR:${message}\n`),
  debug: () => {},
})
const port = await server.ready

if (port === null) {
  throw new Error('Server did not bind a port')
}

console.log(`LB_E2E_READY:${port}`)

// Cross-platform drain trigger for the test driver: on Windows,
// child.kill('SIGTERM') never runs the child's signal listener (verified by
// probe), so the test drives beginDrain() over stdin instead. The production
// SIGTERM → serverCli → beginDrain chain is covered by the docker E2E.
process.stdin.on('data', chunk => {
  if (String(chunk).trim() === 'DRAIN') {
    server.beginDrain()
    console.log('LB_E2E_DRAINED')
  }
})

await new Promise<void>(() => {})
