import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

type Authentication = 'api_key' | 'jwt'
type RequestKind = 'query' | 'json'
type Encryption = 'none' | 'hybrid_optional'
type TenantScope = 'ingestion_required' | 'administrator'
type SideEffect =
  | 'telemetry_enqueue'
  | 'crash_write'
  | 'alert_write'
  | 'notification_send'
  | 'schema_write'
  | 'system_config_write'
  | 'aggregation_write'
  | 'cleanup_write'

export interface QmsRouteSource {
  method: string
  path: string
  source_file: string
  source_line: number
}

interface QmsRouteDefinition {
  authentication: Authentication
  request_kind: RequestKind
  response_kind: 'json'
  encryption: Encryption
  tenant_scope: TenantScope
  side_effects: SideEffect[]
}

export interface QmsRouteContract extends QmsRouteSource, QmsRouteDefinition {}

export interface QmsContract {
  schema_version: 1
  source_commit: string
  routes: QmsRouteContract[]
}

const TELEMETRY = [
  'POST /api/v1/telemetry/batch',
  'POST /api/v1/telemetry/conversation',
  'POST /api/v1/telemetry/install',
  'POST /api/v1/telemetry/perf',
  'GET /api/v1/telemetry/queue/stats',
] as const

const CRASH_SUFFIXES = [
  'POST /admin/aggregate',
  'POST /admin/cleanup',
  'GET /events',
  'POST /events',
  'GET /events/:id',
  'POST /events/batch',
  'GET /issues',
  'GET /issues/:id',
  'PUT /issues/:id',
  'POST /issues/:id/ignore',
  'POST /issues/:id/resolve',
  'GET /stats/distribution',
  'GET /stats/summary',
  'GET /stats/trend',
] as const

const ADMIN_ROUTES = [
  'GET /api/v1/qms/alerts/configs',
  'POST /api/v1/qms/alerts/configs',
  'DELETE /api/v1/qms/alerts/configs/:id',
  'GET /api/v1/qms/alerts/configs/:id',
  'PUT /api/v1/qms/alerts/configs/:id',
  'POST /api/v1/qms/alerts/configs/:id/test',
  'GET /api/v1/qms/alerts/history',
  'POST /api/v1/qms/alerts/history/:id/acknowledge',
  'GET /api/v1/qms/dashboard/conversations/dimensions',
  'GET /api/v1/qms/dashboard/conversations/errors/trend',
  'GET /api/v1/qms/dashboard/conversations/trend',
  'GET /api/v1/qms/dashboard/installs/dimensions',
  'GET /api/v1/qms/dashboard/installs/trend',
  'GET /api/v1/qms/dashboard/overview',
  'GET /api/v1/qms/dashboard/perf/dimensions',
  'GET /api/v1/qms/dashboard/perf/trend',
  'GET /api/v1/qms/system/aggregation-info',
  'POST /api/v1/qms/system/aggregation/backfill',
  'POST /api/v1/qms/system/aggregation/run',
  'GET /api/v1/qms/system/config',
  'GET /api/v1/qms/system/config/:key',
  'PUT /api/v1/qms/system/config/:key',
  'GET /api/v1/qms/system/env',
  'GET /api/v1/qms/system/error-codes',
  'GET /api/v1/qms/system/health',
  'POST /api/v1/qms/system/init-schema',
  'GET /api/v1/qms/system/notifications',
  'PUT /api/v1/qms/system/notifications',
  'POST /api/v1/qms/system/notifications/test/:channel',
  'GET /api/v1/qms/system/raw-stats',
  'GET /api/v1/qms/system/stats',
  'POST /api/v1/qms/system/switch-to-continuous-aggregates',
  'GET /api/v1/qms/system/tasks',
  'GET /api/v1/qms/user-stats/conversations',
  'GET /api/v1/qms/user-stats/leaderboard/:type',
  'GET /api/v1/qms/user-stats/realtime',
  'GET /api/v1/qms/user-stats/steps',
  'GET /api/v1/qms/user-stats/turns',
  'GET /api/v1/qms/user-stats/users/:userId',
] as const

const EXPECTED_KEYS = new Set<string>([
  ...TELEMETRY,
  ...CRASH_SUFFIXES.flatMap(route => {
    const separator = route.indexOf(' ')
    const method = route.slice(0, separator)
    const suffix = route.slice(separator + 1)
    return [`${method} /api/v1/crash${suffix}`, `${method} /api/v1/qms/crash${suffix}`]
  }),
  ...ADMIN_ROUTES,
])

const API_KEY_KEYS = new Set<string>([
  ...TELEMETRY,
  'POST /api/v1/crash/events',
  'POST /api/v1/crash/events/batch',
  'POST /api/v1/qms/crash/events',
  'POST /api/v1/qms/crash/events/batch',
])

const ENCRYPTED_KEYS = new Set<string>([
  'POST /api/v1/telemetry/batch',
  'POST /api/v1/crash/events/batch',
  'POST /api/v1/qms/crash/events/batch',
])

function sideEffects(key: string): SideEffect[] {
  if (key.startsWith('POST /api/v1/telemetry/')) return ['telemetry_enqueue']
  if (/^POST \/api\/v1\/(qms\/)?crash\/events(?:\/batch)?$/.test(key)) return ['crash_write']
  if (/^(PUT|POST) \/api\/v1\/(qms\/)?crash\/issues\//.test(key)) return ['crash_write']
  if (key.endsWith('/crash/admin/aggregate')) return ['aggregation_write']
  if (key.endsWith('/crash/admin/cleanup')) return ['cleanup_write']
  if (/^(POST|PUT|DELETE) \/api\/v1\/qms\/alerts\//.test(key)) {
    return key.endsWith('/test') ? ['notification_send'] : ['alert_write']
  }
  if (key.endsWith('/system/init-schema') || key.endsWith('/system/switch-to-continuous-aggregates')) return ['schema_write']
  if (key === 'PUT /api/v1/qms/system/config/:key' || key === 'PUT /api/v1/qms/system/notifications') return ['system_config_write']
  if (key.includes('/system/notifications/test/')) return ['notification_send']
  if (key.includes('/system/aggregation/')) return ['aggregation_write']
  return []
}

function definitionFor(key: string): QmsRouteDefinition {
  if (!EXPECTED_KEYS.has(key)) throw new Error(`Missing QMS contract definition: ${key}`)
  const authentication: Authentication = API_KEY_KEYS.has(key) ? 'api_key' : 'jwt'
  return {
    authentication,
    request_kind: key.startsWith('GET ') ? 'query' : 'json',
    response_kind: 'json',
    encryption: ENCRYPTED_KEYS.has(key) ? 'hybrid_optional' : 'none',
    tenant_scope: authentication === 'api_key' ? 'ingestion_required' : 'administrator',
    side_effects: sideEffects(key),
  }
}

interface RouteManifest {
  source_commit: string
  routes: Array<QmsRouteSource & { domain?: string }>
}

export function extractQmsContract(sourceRoot: string, routesPath: string): QmsContract {
  const manifest = JSON.parse(readFileSync(routesPath, 'utf8')) as RouteManifest
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
  if (sourceHead !== manifest.source_commit) {
    throw new Error(`Sudowork Server source drift: expected ${manifest.source_commit}, found ${sourceHead}`)
  }

  const seen = new Set<string>()
  const routes = manifest.routes.filter(route => route.domain === 'qms').map(route => {
    const method = route.method.toUpperCase()
    const key = `${method} ${route.path}`
    if (seen.has(key)) throw new Error(`Duplicate mounted QMS route: ${key}`)
    seen.add(key)
    return { ...route, method, ...definitionFor(key) }
  }).sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`))

  const missing = [...EXPECTED_KEYS].filter(key => !seen.has(key))
  if (routes.length !== 72 || missing.length > 0) {
    throw new Error(`Expected 72 QMS routes, found ${routes.length}; missing: ${missing.join(', ')}`)
  }
  return { schema_version: 1, source_commit: manifest.source_commit, routes }
}

function main(): void {
  const args = process.argv.slice(2)
  const sourceIndex = args.indexOf('--source')
  const sourceRoot = args[sourceIndex + 1]
  if (sourceIndex < 0 || !sourceRoot) throw new Error('Usage: --source <sudowork-server-repository> [--check]')
  if (!isAbsolute(sourceRoot)) throw new Error('--source must be an absolute path')
  const output = resolve('contracts/sudowork/qms-api.json')
  const contract = extractQmsContract(sourceRoot, resolve('contracts/sudowork/routes.json'))
  const serialized = `${JSON.stringify(contract, null, 2)}\n`
  if (args.includes('--check')) {
    if (readFileSync(output, 'utf8') !== serialized) throw new Error('Sudowork QMS API contract is stale')
    console.log(`Sudowork QMS API contract is current: ${contract.routes.length} routes`)
    return
  }
  writeFileSync(output, serialized)
  console.log(`Wrote ${contract.routes.length} Sudowork QMS routes to ${output}`)
}

if (import.meta.main) main()
