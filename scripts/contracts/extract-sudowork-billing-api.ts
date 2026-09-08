import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export interface BillingRouteSource {
  method: string
  path: string
  source_file: string
  source_line: number
}

type Authentication = 'public' | 'user' | 'admin' | 'fuiou_callback'
type SideEffect =
  | 'fuiou_create'
  | 'fuiou_verify'
  | 'fuiou_query'
  | 'fuiou_refund'
  | 'wallet_credit'
  | 'wallet_debit'
  | 'sudorouter_quota'
  | 'sudorouter_query'
  | 'quota_snapshot'

interface BillingRouteDefinition {
  authentication: Authentication
  query_parameters?: string[]
  body_fields?: string[]
  success_envelope: string[]
  success_content_type?: 'application/json' | 'text/plain'
  success_body?: string
  side_effects?: SideEffect[]
}

export interface BillingRouteContract extends BillingRouteSource, BillingRouteDefinition {}

export interface BillingContract {
  schema_version: 1
  source_commit?: string
  routes: BillingRouteContract[]
}

const json = (authentication: Authentication, successEnvelope: string[], options: Omit<BillingRouteDefinition, 'authentication' | 'success_envelope'> = {}): BillingRouteDefinition => ({
  authentication,
  query_parameters: [],
  body_fields: [],
  success_envelope: successEnvelope,
  success_content_type: 'application/json',
  side_effects: [],
  ...options,
})

const DEFINITIONS: Record<string, BillingRouteDefinition> = {
  'GET /api/v1/admin/credit-applications': json('admin', ['success', 'data'], {
    query_parameters: ['enterprise_id', 'keyword', 'page', 'pageSize', 'page_size', 'status'],
  }),
  'GET /api/v1/admin/credit-applications/:id': json('admin', ['success', 'data']),
  'POST /api/v1/admin/credit-applications/:id/approve': json('admin', ['success', 'msg', 'data'], {
    body_fields: ['admin_comment', 'approved_points'], side_effects: ['wallet_credit', 'sudorouter_quota'],
  }),
  'POST /api/v1/admin/credit-applications/:id/reject': json('admin', ['success', 'msg'], {
    body_fields: ['admin_comment'],
  }),
  'POST /api/v1/admin/credit-applications/:id/retry-sync': json('admin', ['success', 'msg', 'data'], {
    side_effects: ['wallet_credit', 'sudorouter_quota'],
  }),
  'GET /api/v1/admin/recharge-records': json('admin', ['success', 'data'], {
    query_parameters: ['keyword', 'page', 'pageSize', 'payment_method', 'type'],
  }),
  'GET /api/v1/admin/recharge/orders': json('admin', ['success', 'data'], {
    query_parameters: ['end_date', 'order_no', 'page', 'pageSize', 'page_size', 'start_date', 'status', 'user_phone'],
  }),
  'POST /api/v1/admin/recharge/orders/:id/retry': json('admin', ['success', 'msg'], {
    side_effects: ['wallet_credit', 'sudorouter_quota'],
  }),
  'GET /api/v1/admin/recharge/orders/:orderNo': json('admin', ['success', 'data']),
  'POST /api/v1/admin/recharge/orders/:orderNo/refund': json('admin', ['success', 'msg', 'data'], {
    body_fields: ['reason'], side_effects: ['fuiou_refund', 'wallet_debit', 'sudorouter_quota'],
  }),
  'POST /api/v1/admin/recharge/orders/:orderNo/sync': json('admin', ['success', 'data'], {
    side_effects: ['fuiou_query', 'wallet_credit', 'sudorouter_quota'],
  }),
  'GET /api/v1/admin/recharge/refund-calc/:orderNo': json('admin', ['success', 'data']),
  'POST /api/v1/admin/recharge/simulate-payment/:orderNo': json('admin', ['success', 'msg', 'data'], {
    side_effects: ['wallet_credit', 'sudorouter_quota'],
  }),
  'GET /api/v1/admin/recharge/stats': json('admin', ['success', 'data']),
  'POST /api/v1/admin/recharge/sync': json('admin', ['success', 'data'], {
    side_effects: ['fuiou_query', 'wallet_credit', 'sudorouter_quota'],
  }),
  'POST /api/v1/admin/users/:id/points': json('admin', ['success', 'msg', 'data'], {
    body_fields: ['amount', 'operation', 'reason', 'sync_sudorouter'],
    side_effects: ['wallet_credit', 'wallet_debit', 'sudorouter_quota'],
  }),
  'POST /api/v1/admin/users/:id/recharge': json('admin', ['success', 'msg', 'data'], {
    body_fields: ['payment_reference', 'points', 'reason'], side_effects: ['wallet_credit', 'sudorouter_quota'],
  }),
  'POST /api/v1/admin/users/:id/sync-quota': json('admin', ['success', 'msg', 'data'], {
    side_effects: ['sudorouter_query', 'quota_snapshot'],
  }),
  'GET /api/v1/credit-applications/': json('user', ['success', 'data'], {
    query_parameters: ['page', 'pageSize'],
  }),
  'POST /api/v1/credit-applications/': json('user', ['success', 'data'], {
    body_fields: ['reason', 'requested_points'],
  }),
  'GET /api/v1/credit-applications/:id': json('user', ['success', 'data']),
  'POST /api/v1/recharge/callback': {
    authentication: 'fuiou_callback',
    query_parameters: [],
    body_fields: ['mchnt_cd', 'message', 'resp_code', 'resp_desc'],
    success_envelope: [],
    success_content_type: 'text/plain',
    success_body: 'success',
    side_effects: ['fuiou_verify', 'wallet_credit', 'sudorouter_quota'],
  },
  'POST /api/v1/recharge/cancel/:orderNo': json('user', ['success', 'msg']),
  'POST /api/v1/recharge/create': json('user', ['success', 'data'], {
    body_fields: ['amount', 'payment_method'],
  }),
  'GET /api/v1/recharge/list': json('user', ['success', 'data'], {
    query_parameters: ['page', 'pageSize'],
  }),
  'GET /api/v1/recharge/packages': json('public', ['success', 'data']),
  'POST /api/v1/recharge/pay': json('user', ['success', 'data'], {
    body_fields: ['order_no'], side_effects: ['fuiou_create'],
  }),
  'GET /api/v1/recharge/query/:orderNo': json('user', ['success', 'data']),
}

export function isBillingRoute(route: Pick<BillingRouteSource, 'method' | 'path'>): boolean {
  const key = `${route.method.toUpperCase()} ${route.path}`
  return key in DEFINITIONS || route.path.startsWith('/api/v1/recharge/')
    || route.path.startsWith('/api/v1/credit-applications')
    || /^\/api\/v1\/admin\/users\/:id\/(?:points|recharge|sync-quota)$/.test(route.path)
    || route.path.startsWith('/api/v1/admin/recharge')
    || route.path.startsWith('/api/v1/admin/credit-applications')
}

export function extractBillingContract(
  routes: BillingRouteSource[],
  sourceCommit?: string,
): BillingContract {
  const billingRoutes = routes.filter(isBillingRoute)
  const seen = new Set<string>()
  const contracts = billingRoutes.map((route) => {
    const key = `${route.method.toUpperCase()} ${route.path}`
    if (seen.has(key)) throw new Error(`Duplicate billing route: ${key}`)
    seen.add(key)
    const definition = DEFINITIONS[key]
    if (!definition) throw new Error(`Missing billing contract definition: ${key}`)
    return {
      ...route,
      method: route.method.toUpperCase(),
      ...definition,
      query_parameters: [...(definition.query_parameters ?? [])],
      body_fields: [...(definition.body_fields ?? [])],
      side_effects: [...(definition.side_effects ?? [])],
    }
  }).sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`))

  return { schema_version: 1, ...(sourceCommit ? { source_commit: sourceCommit } : {}), routes: contracts }
}

interface RouteManifest {
  source_commit: string
  routes: BillingRouteSource[]
}

function main(): void {
  const args = process.argv.slice(2)
  const sourceIndex = args.indexOf('--source')
  if (sourceIndex < 0 || !args[sourceIndex + 1]) {
    throw new Error('Usage: --source <sudowork-server-repository> [--check]')
  }
  const source = args[sourceIndex + 1]
  if (!isAbsolute(source)) throw new Error('--source must be an absolute path')

  const routeManifest = JSON.parse(
    readFileSync(resolve('contracts/sudowork/routes.json'), 'utf8'),
  ) as RouteManifest
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
  if (sourceHead !== routeManifest.source_commit) {
    throw new Error(`Sudowork Server source drift: expected ${routeManifest.source_commit}, found ${sourceHead}`)
  }

  const contract = extractBillingContract(routeManifest.routes, routeManifest.source_commit)
  if (contract.routes.length !== Object.keys(DEFINITIONS).length || contract.routes.length !== 28) {
    const actual = new Set(contract.routes.map(route => `${route.method} ${route.path}`))
    const missing = Object.keys(DEFINITIONS).filter(key => !actual.has(key))
    throw new Error(`Expected 28 billing routes, found ${contract.routes.length}; missing: ${missing.join(', ')}`)
  }
  const serialized = `${JSON.stringify(contract, null, 2)}\n`
  const output = resolve('contracts/sudowork/billing-api.json')
  if (args.includes('--check')) {
    if (readFileSync(output, 'utf8') !== serialized) throw new Error('Sudowork Billing API contract is stale')
    console.log(`Sudowork Billing API contract is current: ${contract.routes.length} routes`)
    return
  }
  writeFileSync(output, serialized)
  console.log(`Wrote ${contract.routes.length} Sudowork Billing routes to ${output}`)
}

if (import.meta.main) main()
