import { readFile, mkdir, chmod } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Pool } from 'pg'
import { SqliteDriver, PgDriver, type DbDriver, type PgPoolLike } from '../../db/driver.js'
import { AgentRunStore } from './store.js'
import { HttpAgentRuntime, immutableAgent, routerExecutor, type AgentDefinition } from './runtime.js'
import { providerServer } from './server.js'

/** Build this entry as one immutable .mjs artifact before running; no Moss server dependency. */
async function main() {
  const path = process.argv[2]
  if (!path || !import.meta.filename.endsWith('.mjs')) throw new Error('Usage: node http-agent-provider.mjs /path/to/provider.json')
  const config = JSON.parse(await readFile(path, 'utf8')) as {
    host: string; port: number; database_file?: string; database_url_file?: string;
    router_config_file: string; clients: { id: string; token_file: string; agent_ids: string[] }[];
    definitions: AgentDefinition[]; allowed_router_endpoints: string[]; concurrency?: number;
  }
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || !config.host
    || Boolean(config.database_file) === Boolean(config.database_url_file)) throw new Error('Invalid provider configuration')
  const routerConfig = JSON.parse(await readFile(config.router_config_file, 'utf8'))
  const router = routerConfig.auth_modes?.proxy?.sudorouter
  if (!router?.baseUrl || !router?.apiKey || !config.allowed_router_endpoints.includes(router.baseUrl)
    || config.definitions.some(d => d.router_endpoint !== router.baseUrl)) throw new Error('SudoRouter configuration does not match deployment allowlist')
  const artifactDigest = `sha256:${createHash('sha256').update(await readFile(import.meta.filename)).digest('hex')}`
  const agents = config.definitions.map(d => immutableAgent(d, artifactDigest, config.allowed_router_endpoints))
  let db: DbDriver
  if (config.database_url_file) {
    const connectionString = (await readFile(config.database_url_file, 'utf8')).trim()
    db = new PgDriver(new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10_000 }) as unknown as PgPoolLike)
  } else {
    const file = resolve(config.database_file!)
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const sqlite = new DatabaseSync(file)
    sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
    await chmod(file, 0o600)
    db = new SqliteDriver(sqlite)
  }
  const store = new AgentRunStore(db); await store.ready
  const runtime = new HttpAgentRuntime(store, agents, routerExecutor(router.apiKey), config.concurrency ?? 4)
  const clients = await Promise.all(config.clients.map(async c => ({ id: c.id, token: (await readFile(c.token_file, 'utf8')).trim(), agentIds: c.agent_ids })))
  const server = providerServer(runtime, clients)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve) })
  runtime.start()
  process.stdout.write(`${JSON.stringify({ event: 'ready', port: config.port, artifact_digest: artifactDigest, versions: agents.map(a => ({ agent_id: a.definition.external_agent_id, execution_revision: a.revision })) })}\n`)
  let stopping = false
  const stop = async () => {
    if (stopping) return; stopping = true
    server.closeIdleConnections()
    const closed = new Promise<void>(resolve => server.close(() => resolve()))
    await runtime.close(); await closed; await db.close()
  }
  process.once('SIGINT', () => { void stop() }); process.once('SIGTERM', () => { void stop() })
}
void main().catch(() => { process.stderr.write('HTTP agent provider startup failed; check configuration and dependencies.\n'); process.exitCode = 1 })
