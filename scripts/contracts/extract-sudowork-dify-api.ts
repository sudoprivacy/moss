import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

type Authentication = 'user' | 'admin'
type RequestKind = 'query' | 'json' | 'multipart' | 'json_or_multipart'
type ResponseKind = 'json' | 'sse' | 'binary' | 'redirect_or_html'
type SideEffect =
  | 'dify_chat'
  | 'dify_runtime_write'
  | 'dify_file_write'
  | 'dify_audio'
  | 'dify_provision'
  | 'dify_app_write'
  | 'dify_dataset_write'
  | 'dify_document_write'

export interface DifyRouteSource {
  method: string
  path: string
  source_file: string
  source_line: number
}

interface DifyRouteDefinition {
  authentication: Authentication
  request_kind: RequestKind
  response_kind: ResponseKind
  success_contract: string[]
  query_parameters: string[]
  body_fields: string[]
  side_effects: SideEffect[]
}

export interface DifyRouteContract extends DifyRouteSource, DifyRouteDefinition {}

export interface DifyContract {
  schema_version: 1
  source_commit: string
  routes: DifyRouteContract[]
}

const DEFINITIONS: Record<string, DifyRouteDefinition> = {}

function define(
  key: string,
  authentication: Authentication,
  requestKind: RequestKind,
  responseKind: ResponseKind = 'json',
  options: Partial<Pick<DifyRouteDefinition, 'success_contract' | 'query_parameters' | 'body_fields' | 'side_effects'>> = {},
): void {
  if (DEFINITIONS[key]) throw new Error(`Duplicate Dify contract definition: ${key}`)
  DEFINITIONS[key] = {
    authentication,
    request_kind: requestKind,
    response_kind: responseKind,
    success_contract: options.success_contract ?? (responseKind === 'json' ? ['success', 'data'] : [responseKind]),
    query_parameters: options.query_parameters ?? [],
    body_fields: options.body_fields ?? [],
    side_effects: options.side_effects ?? [],
  }
}

const user = (key: string, requestKind: RequestKind, options: Parameters<typeof define>[4] = {}, responseKind: ResponseKind = 'json') =>
  define(key, 'user', requestKind, responseKind, options)
const admin = (key: string, requestKind: RequestKind, options: Parameters<typeof define>[4] = {}, responseKind: ResponseKind = 'json') =>
  define(key, 'admin', requestKind, responseKind, options)

user('GET /api/v1/agents/visible', 'query')
user('GET /api/v1/agents/visible/bindings', 'query')
user('GET /api/v1/agents/:assistantId/enhancement', 'query')
user('POST /api/v1/agents/:assistantId/enhancement/invoke', 'json', {
  body_fields: ['query', 'inputs', 'files'], side_effects: ['dify_chat'],
})
user('POST /api/v1/agents/:assistantId/enhancement/invoke-stream', 'json', {
  body_fields: ['query', 'inputs', 'files'], side_effects: ['dify_chat'],
}, 'sse')
user('POST /api/v1/agents/:assistantId/chat', 'json', {
  body_fields: ['query', 'conversation_id', 'inputs', 'files', 'auto_generate_name'], side_effects: ['dify_chat'],
}, 'sse')
user('POST /api/v1/agents/:assistantId/chat/:taskId/stop', 'json', {
  side_effects: ['dify_runtime_write'],
})
user('GET /api/v1/agents/:assistantId/conversations', 'query', {
  query_parameters: ['last_id', 'limit', 'sort_by'],
})
user('PATCH /api/v1/agents/:assistantId/conversations/:conversationId', 'json', {
  body_fields: ['name', 'auto_generate'], side_effects: ['dify_runtime_write'],
})
user('DELETE /api/v1/agents/:assistantId/conversations/:conversationId', 'json', {
  side_effects: ['dify_runtime_write'], success_contract: ['success'],
})
user('GET /api/v1/agents/:assistantId/conversations/:conversationId/messages', 'query', {
  query_parameters: ['first_id', 'limit'],
})
user('POST /api/v1/agents/:assistantId/messages/:messageId/feedback', 'json', {
  body_fields: ['rating', 'content'], side_effects: ['dify_runtime_write'],
})
user('GET /api/v1/agents/:assistantId/messages/:messageId/suggested', 'query')
user('GET /api/v1/agents/:assistantId/parameters', 'query')
user('GET /api/v1/agents/:assistantId/meta', 'query')
user('POST /api/v1/agents/:assistantId/files', 'multipart', {
  body_fields: ['file', 'user'], side_effects: ['dify_file_write'],
})
user('POST /api/v1/agents/:assistantId/audio-to-text', 'multipart', {
  body_fields: ['file', 'user'], side_effects: ['dify_audio'],
})
user('POST /api/v1/agents/:assistantId/text-to-audio', 'json', {
  body_fields: ['message_id', 'text', 'voice', 'streaming'], side_effects: ['dify_audio'],
}, 'binary')

admin('GET /api/v1/admin/dify/binding', 'query', { query_parameters: ['enterprise_id'] })
admin('POST /api/v1/admin/dify/binding/provision', 'json', {
  body_fields: ['enterprise_id'], side_effects: ['dify_provision'],
})
admin('GET /api/v1/admin/dify/sso', 'query', {
  query_parameters: ['enterprise_id', 'redirect'], success_contract: ['location_or_html'],
}, 'redirect_or_html')
admin('GET /api/v1/admin/dify/agents', 'query', { query_parameters: ['enterprise_id'] })
admin('POST /api/v1/admin/dify/agents', 'json', {
  body_fields: ['enterprise_id', 'assistant_id', 'name', 'description', 'mode', 'icon', 'acl'], side_effects: ['dify_app_write'],
})
admin('GET /api/v1/admin/dify/agents/:assistantId', 'query', { query_parameters: ['enterprise_id'] })
admin('DELETE /api/v1/admin/dify/agents/:assistantId', 'query', {
  query_parameters: ['enterprise_id'], side_effects: ['dify_app_write'], success_contract: ['success'],
})
admin('PUT /api/v1/admin/dify/agents/:assistantId/acl', 'json', {
  body_fields: ['enterprise_id', 'rules'], side_effects: ['dify_app_write'],
})
admin('GET /api/v1/admin/dify/datasets', 'query', { query_parameters: ['enterprise_id'] })
admin('GET /api/v1/admin/dify/agents/:assistantId/datasets', 'query', { query_parameters: ['enterprise_id'] })
admin('PUT /api/v1/admin/dify/agents/:assistantId/datasets', 'json', {
  body_fields: ['enterprise_id', 'dataset_ids'], side_effects: ['dify_app_write'],
})
admin('GET /api/v1/admin/dify/shareable-tenants', 'query', { query_parameters: ['enterprise_id'] })
admin('GET /api/v1/admin/dify/enterprise-assistants', 'query', { query_parameters: ['enterprise_id'] })
admin('POST /api/v1/admin/dify/enterprise-assistants', 'json_or_multipart', {
  body_fields: ['enterprise_id', 'file', 'metadata', 'tenant_ids', 'visible_to_all', 'enhancement'], side_effects: ['dify_app_write'],
})
admin('GET /api/v1/admin/dify/enterprise-assistants/:assistantId', 'query', { query_parameters: ['enterprise_id'] })
admin('PUT /api/v1/admin/dify/enterprise-assistants/:assistantId', 'json_or_multipart', {
  body_fields: ['enterprise_id', 'file', 'metadata', 'tenant_ids', 'visible_to_all'], side_effects: ['dify_app_write'],
})
admin('PUT /api/v1/admin/dify/enterprise-assistants/:assistantId/enhancement', 'json', {
  body_fields: ['enterprise_id', 'enable', 'mode', 'app_name'], side_effects: ['dify_app_write'],
})
admin('GET /api/v1/admin/dify/enterprise-assistants/:assistantId/enhancement', 'query', { query_parameters: ['enterprise_id'] })

admin('GET /api/v1/admin/datasets', 'query', { query_parameters: ['enterprise_id', 'page', 'limit', 'keyword'] })
admin('POST /api/v1/admin/datasets', 'json', {
  body_fields: ['enterprise_id', 'name', 'description', 'indexing_technique', 'permission'], side_effects: ['dify_dataset_write'],
})
admin('GET /api/v1/admin/datasets/:datasetId', 'query', { query_parameters: ['enterprise_id'] })
admin('PATCH /api/v1/admin/datasets/:datasetId', 'json', {
  body_fields: ['enterprise_id', 'name', 'description', 'permission'], side_effects: ['dify_dataset_write'],
})
admin('DELETE /api/v1/admin/datasets/:datasetId', 'query', {
  query_parameters: ['enterprise_id'], side_effects: ['dify_dataset_write'], success_contract: ['success'],
})
admin('GET /api/v1/admin/datasets/:datasetId/documents', 'query', {
  query_parameters: ['enterprise_id', 'page', 'limit', 'keyword'],
})
admin('POST /api/v1/admin/datasets/:datasetId/documents', 'json_or_multipart', {
  body_fields: ['enterprise_id', 'file', 'name', 'text', 'indexing_technique'], side_effects: ['dify_document_write'],
})
admin('DELETE /api/v1/admin/datasets/:datasetId/documents/:documentId', 'query', {
  query_parameters: ['enterprise_id'], side_effects: ['dify_document_write'], success_contract: ['success'],
})
admin('POST /api/v1/admin/datasets/:datasetId/retrieve', 'json', {
  body_fields: ['enterprise_id', 'query', 'retrieval_model'],
})

interface RouteManifest {
  source_commit: string
  routes: DifyRouteSource[]
}

function isDifyRoute(route: DifyRouteSource): boolean {
  return route.source_file === 'src/routes/agents.ts'
    || route.source_file === 'src/routes/admin-dify.ts'
    || route.source_file === 'src/routes/admin-datasets.ts'
}

export function extractDifyContract(sourceRoot: string, routesPath: string): DifyContract {
  const manifest = JSON.parse(readFileSync(routesPath, 'utf8')) as RouteManifest
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
  if (sourceHead !== manifest.source_commit) {
    throw new Error(`Sudowork Server source drift: expected ${manifest.source_commit}, found ${sourceHead}`)
  }

  const seen = new Set<string>()
  const routes = manifest.routes.filter(isDifyRoute).map(route => {
    const key = `${route.method.toUpperCase()} ${route.path}`
    if (seen.has(key)) throw new Error(`Duplicate Dify route: ${key}`)
    seen.add(key)
    const definition = DEFINITIONS[key]
    if (!definition) throw new Error(`Missing Dify contract definition: ${key}`)
    return { ...route, method: route.method.toUpperCase(), ...definition }
  }).sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`))

  const missing = Object.keys(DEFINITIONS).filter(key => !seen.has(key))
  if (routes.length !== 45 || missing.length > 0) {
    throw new Error(`Expected 45 Dify routes, found ${routes.length}; missing: ${missing.join(', ')}`)
  }
  return { schema_version: 1, source_commit: manifest.source_commit, routes }
}

function main(): void {
  const args = process.argv.slice(2)
  const sourceIndex = args.indexOf('--source')
  const sourceRoot = args[sourceIndex + 1]
  if (sourceIndex < 0 || !sourceRoot) throw new Error('Usage: --source <sudowork-server-repository> [--check]')
  if (!isAbsolute(sourceRoot)) throw new Error('--source must be an absolute path')
  const output = resolve('contracts/sudowork/dify-api.json')
  const contract = extractDifyContract(sourceRoot, resolve('contracts/sudowork/routes.json'))
  const serialized = `${JSON.stringify(contract, null, 2)}\n`
  if (args.includes('--check')) {
    if (readFileSync(output, 'utf8') !== serialized) throw new Error('Sudowork Dify API contract is stale')
    console.log(`Sudowork Dify API contract is current: ${contract.routes.length} routes`)
    return
  }
  writeFileSync(output, serialized)
  console.log(`Wrote ${contract.routes.length} Sudowork Dify routes to ${output}`)
}

if (import.meta.main) main()
