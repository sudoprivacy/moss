import { Hono } from 'hono'

import type { IdentityActor } from '../../../identity/organizationIdentityService.js'
import { decodeQmsPayload, QmsEncryptionError } from '../../../qms/hybridDecryption.js'
import { CrashServiceError } from '../../../qms/crashService.js'
import {
  QmsAuthorizationError,
  type QmsAdminScope,
  type QmsAuthorizationService,
} from '../../../qms/qmsAuthorization.js'
import { TelemetryServiceError } from '../../../qms/telemetryService.js'

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface QmsLegacyOperationPort {
  execute(input: {
    key: string
    params: Record<string, string>
    query: Record<string, string>
    body: unknown
    scope?: QmsAdminScope
  }): Promise<{ status: number; body: unknown; headers?: Record<string, string> }>
}

const TELEMETRY: Array<[HttpMethod, string]> = [
  ['POST', '/api/v1/telemetry/batch'], ['GET', '/api/v1/telemetry/queue/stats'],
  ['POST', '/api/v1/telemetry/perf'], ['POST', '/api/v1/telemetry/conversation'],
  ['POST', '/api/v1/telemetry/install'],
]
const CRASH_SUFFIXES: Array<[HttpMethod, string]> = [
  ['POST', '/events/batch'], ['POST', '/events'], ['GET', '/issues'], ['GET', '/issues/:id'],
  ['PUT', '/issues/:id'], ['POST', '/issues/:id/resolve'], ['POST', '/issues/:id/ignore'],
  ['GET', '/events'], ['GET', '/events/:id'], ['GET', '/stats/summary'], ['GET', '/stats/trend'],
  ['GET', '/stats/distribution'], ['POST', '/admin/aggregate'], ['POST', '/admin/cleanup'],
]
const ADMIN: Array<[HttpMethod, string]> = [
  ['GET', '/api/v1/qms/dashboard/overview'], ['GET', '/api/v1/qms/dashboard/perf/trend'],
  ['GET', '/api/v1/qms/dashboard/perf/dimensions'], ['GET', '/api/v1/qms/dashboard/conversations/errors/trend'],
  ['GET', '/api/v1/qms/dashboard/conversations/trend'], ['GET', '/api/v1/qms/dashboard/conversations/dimensions'],
  ['GET', '/api/v1/qms/dashboard/installs/trend'], ['GET', '/api/v1/qms/dashboard/installs/dimensions'],
  ['GET', '/api/v1/qms/user-stats/conversations'], ['GET', '/api/v1/qms/user-stats/turns'],
  ['GET', '/api/v1/qms/user-stats/steps'], ['GET', '/api/v1/qms/user-stats/leaderboard/:type'],
  ['GET', '/api/v1/qms/user-stats/users/:userId'], ['GET', '/api/v1/qms/user-stats/realtime'],
  ['GET', '/api/v1/qms/alerts/configs'], ['GET', '/api/v1/qms/alerts/configs/:id'],
  ['POST', '/api/v1/qms/alerts/configs'], ['PUT', '/api/v1/qms/alerts/configs/:id'],
  ['DELETE', '/api/v1/qms/alerts/configs/:id'], ['GET', '/api/v1/qms/alerts/history'],
  ['POST', '/api/v1/qms/alerts/history/:id/acknowledge'], ['POST', '/api/v1/qms/alerts/configs/:id/test'],
  ['GET', '/api/v1/qms/system/health'], ['GET', '/api/v1/qms/system/aggregation-info'],
  ['POST', '/api/v1/qms/system/init-schema'], ['POST', '/api/v1/qms/system/switch-to-continuous-aggregates'],
  ['GET', '/api/v1/qms/system/stats'], ['GET', '/api/v1/qms/system/config'],
  ['GET', '/api/v1/qms/system/config/:key'], ['PUT', '/api/v1/qms/system/config/:key'],
  ['GET', '/api/v1/qms/system/env'], ['GET', '/api/v1/qms/system/notifications'],
  ['PUT', '/api/v1/qms/system/notifications'], ['POST', '/api/v1/qms/system/notifications/test/:channel'],
  ['GET', '/api/v1/qms/system/tasks'], ['POST', '/api/v1/qms/system/aggregation/run'],
  ['GET', '/api/v1/qms/system/raw-stats'], ['POST', '/api/v1/qms/system/aggregation/backfill'],
  ['GET', '/api/v1/qms/system/error-codes'],
]
export const QMS_LEGACY_ROUTES: ReadonlyArray<readonly [HttpMethod, string]> = [
  ...TELEMETRY,
  ...CRASH_SUFFIXES.flatMap(([method, suffix]) => [
    [method, `/api/v1/crash${suffix}`] as [HttpMethod, string],
    [method, `/api/v1/qms/crash${suffix}`] as [HttpMethod, string],
  ]),
  ...ADMIN,
]
const API_KEY_ROUTES = new Set([
  ...TELEMETRY.map(([method, path]) => `${method} ${path}`),
  'POST /api/v1/crash/events', 'POST /api/v1/crash/events/batch',
  'POST /api/v1/qms/crash/events', 'POST /api/v1/qms/crash/events/batch',
])
const ENCRYPTED_ROUTES = new Set([
  'POST /api/v1/telemetry/batch',
  'POST /api/v1/crash/events/batch',
  'POST /api/v1/qms/crash/events/batch',
])

function requiresAdmin(key: string): boolean {
  return key.includes('/qms/alerts/')
    || (/\/crash\/(issues\/[^/]+(?:\/resolve|\/ignore)?|admin\/)/.test(key) && !key.startsWith('GET '))
    || (key.includes('/qms/system/') && !key.endsWith('/health') && !key.endsWith('/error-codes'))
}

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  return header.slice(7).trim() || null
}

async function requestBody(context: { req: { text(): Promise<string> } }): Promise<unknown> {
  const value = await context.req.text()
  if (!value) return undefined
  return JSON.parse(value) as unknown
}

export function createSudoworkQmsRoutes(options: {
  apiKeyHeader: string
  authorization: QmsAuthorizationService
  getActor(authorization: string | undefined): IdentityActor | null
  encryption: { encryptionRequired: boolean; privateKeyPem?: string }
  operations: QmsLegacyOperationPort
}): Hono {
  const app = new Hono()
  for (const [method, path] of QMS_LEGACY_ROUTES) {
    app.on(method, path, async context => {
      const key = `${method} ${path}`
      let operationStarted = false
      try {
        let scope: QmsAdminScope | undefined
        if (API_KEY_ROUTES.has(key)) {
          options.authorization.requireApiKey(context.req.header(options.apiKeyHeader))
        } else {
          const actor = options.getActor(bearer(context.req.header('Authorization')) ?? undefined)
          scope = options.authorization.adminScope(actor, context.req.query('tenant_id'))
          if (requiresAdmin(key) && scope.qmsRole !== 'admin') {
            throw new QmsAuthorizationError(403, 'FORBIDDEN', 'Insufficient permissions')
          }
        }
        let body = method === 'GET' ? undefined : await requestBody(context)
        if (ENCRYPTED_ROUTES.has(key)) body = decodeQmsPayload(body, options.encryption)
        operationStarted = true
        const result = await options.operations.execute({
          key,
          params: context.req.param(),
          query: Object.fromEntries(new URL(context.req.url).searchParams.entries()),
          body,
          scope,
        })
        return context.json(result.body as never, result.status as 200, result.headers)
      } catch (error) {
        if (error instanceof QmsAuthorizationError) {
          const message = error.code === 'MISSING_API_KEY'
            ? `Missing ${options.apiKeyHeader} header`
            : error.message
          return context.json({ success: false, error: { code: error.code, message } }, error.status as 400)
        }
        if (error instanceof QmsEncryptionError) {
          return context.json({ code: error.code, message: error.message }, 400)
        }
        if (error instanceof TelemetryServiceError) {
          return context.json({
            success: false,
            error: {
              code: error.code,
              message: error.message,
              ...(error.items.length > 0 ? { items: error.items } : {}),
            },
          }, error.status as 400)
        }
        if (error instanceof CrashServiceError) {
          return context.json({
            success: false,
            error: {
              code: error.code,
              message: error.message,
              ...(error.items.length > 0 ? { items: error.items } : {}),
            },
          }, error.status as 400)
        }
        if (operationStarted && key.startsWith('POST /api/v1/telemetry/')) {
          const event = key.endsWith('/batch') ? 'telemetry data'
            : key.endsWith('/perf') ? 'perf event'
              : key.endsWith('/conversation') ? 'conversation event'
                : 'install event'
          return context.json({
            success: false,
            error: { code: 'QUEUE_ERROR', message: `Failed to queue ${event}` },
          }, 500)
        }
        return context.json({ success: false, error: String(error) }, 500)
      }
    })
  }
  return app
}
