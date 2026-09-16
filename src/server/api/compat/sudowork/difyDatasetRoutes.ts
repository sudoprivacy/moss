import { randomUUID } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { onlineCommandContext } from '../../../application/commandContext.js'
import { DifyDomainError } from '../../../dify/difyConnectionService.js'
import type { DifyDatasetService } from '../../../dify/difyDatasetService.js'
import { DifyProviderError } from '../../../dify/difyHttpAdapter.js'
import {
  hasGlobalOrganizationAccess,
  type IdentityActor,
} from '../../../identity/organizationIdentityService.js'

interface LegacyAliasResolution {
  resourceId: string
  orgId: string
}

interface DifyDatasetRouteOptions {
  dataset: DifyDatasetService
  getActor: (authorization: string | undefined) => IdentityActor | null
  resolveEnterpriseAlias: (legacyId: number) => LegacyAliasResolution | null
  idempotencyKey?: (context: Context) => string
}

type JsonObject = Record<string, unknown>

export function registerSudoworkDifyDatasetRoutes(app: Hono, options: DifyDatasetRouteOptions): void {
  const operationContext = (context: Context) => onlineCommandContext(
    context.req.header('X-Idempotency-Key')?.trim() || options.idempotencyKey?.(context) || randomUUID(),
  )

  app.get('/api/v1/admin/datasets', async context => withAdmin(context, options, async actor => {
    const orgId = resolveFromQuery(context, actor, options)
    if (orgId instanceof Response) return orgId
    const page = Number(context.req.query('page') ?? '1') || 1
    const limit = Math.min(100, Number(context.req.query('limit') ?? '30') || 30)
    return await jsonOperation(context, () => options.dataset.list(orgId, {
      page, limit, keyword: context.req.query('keyword'),
    }))
  }))

  app.post('/api/v1/admin/datasets', async context => withAdmin(context, options, async actor => {
    const body = await context.req.json<JsonObject>().catch(() => null)
    if (!body || !body.name) return failure(context, 400, 'name is required')
    const orgId = resolveFromBody(context, actor, options, body.enterprise_id)
    if (orgId instanceof Response) return orgId
    return await jsonOperation(context, () => options.dataset.create(orgId, {
      name: String(body.name),
      description: optionalString(body.description),
      indexingTechnique: optionalString(body.indexing_technique),
      permission: optionalString(body.permission),
    }, operationContext(context)))
  }))

  app.get('/api/v1/admin/datasets/:datasetId', async context => withAdmin(context, options, async actor => {
    const orgId = resolveFromQuery(context, actor, options)
    if (orgId instanceof Response) return orgId
    return await jsonOperation(context, () => options.dataset.get(orgId, context.req.param('datasetId')))
  }))

  app.patch('/api/v1/admin/datasets/:datasetId', async context => withAdmin(context, options, async actor => {
    const body = await context.req.json<JsonObject>().catch(() => null)
    if (!body) return failure(context, 400, 'body required')
    const orgId = resolveFromBody(context, actor, options, body.enterprise_id)
    if (orgId instanceof Response) return orgId
    return await jsonOperation(context, () => options.dataset.update(orgId, context.req.param('datasetId'), {
      name: optionalString(body.name), description: optionalString(body.description),
      permission: optionalString(body.permission),
    }, operationContext(context)))
  }))

  app.delete('/api/v1/admin/datasets/:datasetId', async context => withAdmin(context, options, async actor => {
    const orgId = resolveFromQuery(context, actor, options)
    if (orgId instanceof Response) return orgId
    return await successOperation(context, () => options.dataset.delete(
      orgId, context.req.param('datasetId'), operationContext(context),
    ))
  }))

  app.get('/api/v1/admin/datasets/:datasetId/documents', async context => withAdmin(context, options, async actor => {
    const orgId = resolveFromQuery(context, actor, options)
    if (orgId instanceof Response) return orgId
    const page = Number(context.req.query('page') ?? '1') || 1
    const limit = Math.min(100, Number(context.req.query('limit') ?? '50') || 50)
    return await jsonOperation(context, () => options.dataset.listDocuments(
      orgId, context.req.param('datasetId'), { page, limit, keyword: context.req.query('keyword') },
    ))
  }))

  app.post('/api/v1/admin/datasets/:datasetId/documents', async context => withAdmin(context, options, async actor => {
    const datasetId = context.req.param('datasetId')
    if ((context.req.header('content-type') ?? '').includes('multipart/form-data')) {
      const form = await context.req.formData().catch(() => null)
      if (!form) return failure(context, 400, 'expected multipart/form-data')
      const orgId = resolveFromBody(context, actor, options, form.get('enterprise_id'))
      if (orgId instanceof Response) return orgId
      const file = form.get('file')
      if (!(file instanceof File)) return failure(context, 400, 'file field missing or not a file')
      return await jsonOperation(context, async () => options.dataset.createDocumentByFile(orgId, datasetId, {
        fileName: file.name, contentType: file.type, bytes: file,
        indexingTechnique: optionalString(form.get('indexing_technique')),
      }, operationContext(context)))
    }

    const body = await context.req.json<JsonObject>().catch(() => null)
    if (!body || !body.name || !body.text) return failure(context, 400, 'name and text are required')
    const orgId = resolveFromBody(context, actor, options, body.enterprise_id)
    if (orgId instanceof Response) return orgId
    return await jsonOperation(context, () => options.dataset.createDocumentByText(orgId, datasetId, {
      name: String(body.name), text: String(body.text),
      indexingTechnique: optionalString(body.indexing_technique),
    }, operationContext(context)))
  }))

  app.delete('/api/v1/admin/datasets/:datasetId/documents/:documentId', async context => withAdmin(
    context, options, async actor => {
      const orgId = resolveFromQuery(context, actor, options)
      if (orgId instanceof Response) return orgId
      return await successOperation(context, () => options.dataset.deleteDocument(
        orgId, context.req.param('datasetId'), context.req.param('documentId'), operationContext(context),
      ))
    },
  ))

  app.post('/api/v1/admin/datasets/:datasetId/retrieve', async context => withAdmin(context, options, async actor => {
    const body = await context.req.json<JsonObject>().catch(() => null)
    if (!body || !body.query) return failure(context, 400, 'query required')
    const orgId = resolveFromBody(context, actor, options, body.enterprise_id)
    if (orgId instanceof Response) return orgId
    return await jsonOperation(context, () => options.dataset.retrieve(orgId, context.req.param('datasetId'), {
      query: String(body.query), retrievalModel: objectOrUndefined(body.retrieval_model),
    }))
  }))
}

async function withAdmin(
  context: Context,
  options: DifyDatasetRouteOptions,
  operation: (actor: IdentityActor) => Promise<Response>,
): Promise<Response> {
  const actor = options.getActor(context.req.header('Authorization'))
  if (!actor) return failure(context, 401, '未授权，请先登录')
  if (actor.role !== 'admin' && actor.role !== 'super_admin') return failure(context, 403, '权限不足')
  return await operation(actor)
}

function resolveFromQuery(context: Context, actor: IdentityActor, options: DifyDatasetRouteOptions): string | Response {
  return resolveOrganization(context, actor, options, context.req.query('enterprise_id'))
}

function resolveFromBody(
  context: Context,
  actor: IdentityActor,
  options: DifyDatasetRouteOptions,
  raw: unknown,
): string | Response {
  return resolveOrganization(context, actor, options, raw)
}

function resolveOrganization(
  context: Context,
  actor: IdentityActor,
  options: DifyDatasetRouteOptions,
  raw: unknown,
): string | Response {
  const legacyId = parseEnterpriseId(raw)
  if (hasGlobalOrganizationAccess(actor)) {
    if (legacyId === null) return failure(context, 400, 'super admin must specify enterprise_id')
    const resolved = options.resolveEnterpriseAlias(legacyId)
    if (!resolved) return failure(context, 400, `enterprise ${legacyId} not found`)
    return resolved.resourceId
  }
  if (legacyId !== null) {
    const resolved = options.resolveEnterpriseAlias(legacyId)
    if (!resolved || resolved.resourceId !== actor.orgId) {
      return failure(context, 403, 'cannot operate on another enterprise')
    }
  }
  return actor.orgId
}

async function jsonOperation(context: Context, operation: () => Promise<unknown>): Promise<Response> {
  try {
    return context.json({ success: true, data: await operation() })
  } catch (error) {
    return providerError(context, error)
  }
}

async function successOperation(context: Context, operation: () => Promise<unknown>): Promise<Response> {
  try {
    await operation()
    return context.json({ success: true })
  } catch (error) {
    return providerError(context, error)
  }
}

function providerError(context: Context, error: unknown): Response {
  if (error instanceof DifyProviderError) {
    return context.json({ success: false, msg: error.message, detail: error.detail }, error.status as 400)
  }
  if (error instanceof DifyDomainError) return failure(context, error.status, error.message)
  return failure(context, 500, error instanceof Error ? error.message : String(error))
}

function parseEnterpriseId(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function objectOrUndefined(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function failure(context: Context, status: number, msg: string): Response {
  return context.json({ success: false, msg }, status as 400)
}
