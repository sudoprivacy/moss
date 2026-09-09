import { randomUUID } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { onlineCommandContext, type CommandContext } from '../../../application/commandContext.js'
import type { DifyAclEntry, DifyAgentSummary } from '../../../dify/difyAdministrationService.js'
import { DifyDomainError } from '../../../dify/difyConnectionService.js'
import { DifyProviderError } from '../../../dify/difyHttpAdapter.js'
import {
  hasGlobalOrganizationAccess,
  type IdentityActor,
} from '../../../identity/organizationIdentityService.js'

type JsonObject = Record<string, unknown>

interface AdministrationPort {
  buildSsoLink(input: { actor: IdentityActor; orgId: string; next?: string }): Promise<{ url: string; expiresAt: number }>
  getBinding(orgId: string): unknown
  provision(orgId: string, context: CommandContext): Promise<unknown>
  listAgents(orgId: string): DifyAgentSummary[]
  createAgent(input: JsonObject & { actor: IdentityActor; orgId: string; name: string }, context: CommandContext): Promise<unknown>
  getAgent(orgId: string, assistantId: string): DifyAgentSummary | null
  deleteAgent(orgId: string, assistantId: string, context: CommandContext): Promise<void>
  listAcl(orgId: string, assistantId: string): DifyAclEntry[]
  replaceAcl(orgId: string, assistantId: string, entries: DifyAclEntry[]): DifyAclEntry[]
  listEnterpriseAssistants(orgId: string): Promise<unknown>
  listShareableOrganizations(): unknown
  listAvailableDatasets(orgId: string): Promise<unknown>
  createEnterpriseAssistant(input: { actor: IdentityActor; orgId: string; form: FormData }, context: CommandContext): Promise<unknown>
  getEnterpriseAssistant(orgId: string, assistantId: string): Promise<unknown>
  updateEnterpriseAssistant(input: { actor: IdentityActor; orgId: string; assistantId: string; form: FormData }, context: CommandContext): Promise<unknown>
  getEnhancement(orgId: string, assistantId: string): { enabled: boolean; mode?: string }
  setEnhancement(input: { actor: IdentityActor; orgId: string; assistantId: string; enable: boolean; mode?: string; appName?: string }, context: CommandContext): Promise<unknown>
  listDatasets(orgId: string, assistantId: string): string[]
  replaceDatasets(orgId: string, assistantId: string, datasetIds: string[]): string[]
}

interface DifyAdministrationRouteOptions {
  administration: AdministrationPort
  getActor: (authorization: string | undefined) => IdentityActor | null
  resolveEnterpriseAlias: (legacyId: number) => { resourceId: string; orgId: string } | null
  idempotencyKey?: (context: Context) => string
}

export function registerSudoworkDifyAdministrationRoutes(app: Hono, options: DifyAdministrationRouteOptions): void {
  const commandContext = (context: Context) => onlineCommandContext(
    context.req.header('X-Idempotency-Key')?.trim() || options.idempotencyKey?.(context) || randomUUID(),
  )

  app.get('/api/v1/admin/dify/sso', context => withAdmin(context, options, async actor => {
    const orgId = resolveOrganization(context, actor, options, context.req.query('enterprise_id'))
    if (orgId instanceof Response) return orgId
    try {
      const link = await options.administration.buildSsoLink({
        actor, orgId, next: context.req.query('next') ?? context.req.query('redirect'),
      })
      if (context.req.query('format') === 'redirect') return context.redirect(link.url, 302)
      return context.json({ success: true, data: { url: link.url, expires_at: link.expiresAt } })
    } catch (error) {
      return failure(context, 500, errorMessage(error, 'sso failed'))
    }
  }))

  app.get('/api/v1/admin/dify/binding', context => withAdmin(context, options, async actor => {
    const orgId = resolveOrganization(context, actor, options, context.req.query('enterprise_id'))
    if (orgId instanceof Response) return orgId
    return context.json({ success: true, data: options.administration.getBinding(orgId) })
  }))

  app.post('/api/v1/admin/dify/binding/provision', context => withAdmin(context, options, async actor => {
    const body = await context.req.json<JsonObject>().catch(() => null)
    const orgId = resolveOrganization(context, actor, options, body?.enterprise_id)
    if (orgId instanceof Response) return orgId
    return await jsonOperation(context, () => options.administration.provision(orgId, commandContext(context)), 500)
  }))

  app.get('/api/v1/admin/dify/agents', context => withAdmin(context, options, async actor => {
    const orgId = resolveOrganization(context, actor, options, context.req.query('enterprise_id'))
    if (orgId instanceof Response) return orgId
    return context.json({ success: true, data: options.administration.listAgents(orgId) })
  }))

  app.post('/api/v1/admin/dify/agents', context => withAdmin(context, options, async actor => {
    const body = await context.req.json<JsonObject>().catch(() => null)
    const orgId = resolveOrganization(context, actor, options, body?.enterprise_id)
    if (orgId instanceof Response) return orgId
    if (!body?.name) return failure(context, 400, 'name is required')
    return await jsonOperation(context, () => options.administration.createAgent({
      actor, orgId, name: String(body.name), description: optionalString(body.description),
      mode: optionalString(body.mode), icon: optionalString(body.icon),
      iconType: optionalString(body.icon_type), iconBackground: optionalString(body.icon_background),
      assistantId: optionalString(body.assistant_id),
    }, commandContext(context)), 500)
  }))

  app.get('/api/v1/admin/dify/agents/:assistantId', context => withAdmin(context, options, async actor => {
    const orgId = resolveOrganization(context, actor, options, context.req.query('enterprise_id'))
    if (orgId instanceof Response) return orgId
    const assistantId = context.req.param('assistantId')
    const agent = options.administration.getAgent(orgId, assistantId)
    if (!agent) return failure(context, 404, 'not found')
    return context.json({
      success: true,
      data: {
        ...agent,
        acl: options.administration.listAcl(orgId, assistantId),
        datasets: options.administration.listDatasets(orgId, assistantId),
      },
    })
  }))

  app.delete('/api/v1/admin/dify/agents/:assistantId', context => withAdmin(context, options, async actor => {
    const body = await context.req.json<JsonObject>().catch(() => null)
    const raw = context.req.query('enterprise_id') ?? body?.enterprise_id
    const orgId = resolveOrganization(context, actor, options, raw)
    if (orgId instanceof Response) return orgId
    return await successOperation(context, () => options.administration.deleteAgent(
      orgId, context.req.param('assistantId'), commandContext(context),
    ))
  }))

  app.put('/api/v1/admin/dify/agents/:assistantId/acl', context => withAdmin(context, options, async actor => {
    const body = await context.req.json<JsonObject>().catch(() => null)
    const orgId = resolveOrganization(context, actor, options, body?.enterprise_id)
    if (orgId instanceof Response) return orgId
    if (!Array.isArray(body?.entries)) return failure(context, 400, 'entries is required')
    const entries = body.entries.map(entry => objectValue(entry)).map(entry => ({
      subjectType: String(entry.subject_type) as DifyAclEntry['subjectType'],
      subjectId: typeof entry.subject_id === 'string' ? entry.subject_id : null,
    }))
    try {
      return context.json({
        success: true,
        data: options.administration.replaceAcl(orgId, context.req.param('assistantId'), entries),
      })
    } catch (error) {
      return providerError(context, error, 500)
    }
  }))

  app.get('/api/v1/admin/dify/enterprise-assistants', context => withResolvedQuery(
    context, options, orgId => jsonOperation(context, () => options.administration.listEnterpriseAssistants(orgId), 502),
  ))

  app.get('/api/v1/admin/dify/shareable-tenants', context => withResolvedQuery(
    context, options, async () => context.json({ success: true, data: options.administration.listShareableOrganizations() }),
  ))

  app.get('/api/v1/admin/dify/datasets', context => withResolvedQuery(
    context, options, orgId => jsonOperation(context, () => options.administration.listAvailableDatasets(orgId), 502),
  ))

  app.post('/api/v1/admin/dify/enterprise-assistants', context => withAdmin(context, options, async actor => {
    const form = await context.req.formData().catch(() => null)
    if (!form) return failure(context, 400, 'expected multipart/form-data')
    const orgId = resolveOrganization(context, actor, options, form.get('enterprise_id'))
    if (orgId instanceof Response) return orgId
    if (!formString(form, 'name') || !formString(form, 'profession')) {
      return failure(context, 400, 'name and profession are required')
    }
    const datasets = formJsonArray(form, 'dataset_ids')
    if (formString(form, 'enable_enhancement') === 'true' && datasets.length > 0) {
      return failure(context, 400, 'enable_enhancement and dataset_ids are mutually exclusive — pick one')
    }
    return await jsonOperation(context, () => options.administration.createEnterpriseAssistant(
      { actor, orgId, form }, commandContext(context),
    ), 500)
  }))

  app.get('/api/v1/admin/dify/enterprise-assistants/:assistantId', context => withResolvedQuery(
    context, options, orgId => jsonOperation(context, () => options.administration.getEnterpriseAssistant(
      orgId, context.req.param('assistantId'),
    ), 500),
  ))

  app.put('/api/v1/admin/dify/enterprise-assistants/:assistantId', context => withAdmin(context, options, async actor => {
    const form = await context.req.formData().catch(() => null)
    if (!form) return failure(context, 400, 'expected multipart/form-data')
    const orgId = resolveOrganization(context, actor, options, form.get('enterprise_id'))
    if (orgId instanceof Response) return orgId
    if (!formString(form, 'name') || !formString(form, 'profession')) {
      return failure(context, 400, 'name and profession are required')
    }
    return await jsonOperation(context, () => options.administration.updateEnterpriseAssistant({
      actor, orgId, assistantId: context.req.param('assistantId'), form,
    }, commandContext(context)), 500)
  }))

  app.put('/api/v1/admin/dify/enterprise-assistants/:assistantId/enhancement', context => withAdmin(
    context, options, async actor => {
      const body = await context.req.json<JsonObject>().catch(() => null)
      const orgId = resolveOrganization(context, actor, options, body?.enterprise_id)
      if (orgId instanceof Response) return orgId
      if (!body || typeof body.enable !== 'boolean') return failure(context, 400, 'enable (boolean) required')
      const enable = body.enable
      const current = options.administration.getEnhancement(orgId, context.req.param('assistantId'))
      const mode = optionalString(body.mode)
      const changes = current.enabled !== enable
        || (current.enabled && enable && mode !== undefined && mode !== current.mode)
      if (changes) return failure(context, 400, 'enhancement method cannot be changed after creation')
      return await jsonOperation(context, () => options.administration.setEnhancement({
        actor, orgId, assistantId: context.req.param('assistantId'), enable,
        mode, appName: optionalString(body.app_name),
      }, commandContext(context)), 500)
    },
  ))

  app.get('/api/v1/admin/dify/enterprise-assistants/:assistantId/enhancement', context => withResolvedQuery(
    context, options, async orgId => context.json({
      success: true, data: options.administration.getEnhancement(orgId, context.req.param('assistantId')),
    }),
  ))

  app.get('/api/v1/admin/dify/agents/:assistantId/datasets', context => withResolvedQuery(
    context, options, async orgId => context.json({
      success: true, data: options.administration.listDatasets(orgId, context.req.param('assistantId')),
    }),
  ))

  app.put('/api/v1/admin/dify/agents/:assistantId/datasets', context => withAdmin(context, options, async actor => {
    const body = await context.req.json<JsonObject>().catch(() => null)
    const orgId = resolveOrganization(context, actor, options, body?.enterprise_id)
    if (orgId instanceof Response) return orgId
    if (!Array.isArray(body?.dataset_ids)) return failure(context, 400, 'dataset_ids is required')
    try {
      return context.json({ success: true, data: options.administration.replaceDatasets(
        orgId, context.req.param('assistantId'), body.dataset_ids.filter((id): id is string => typeof id === 'string'),
      ) })
    } catch (error) {
      return failure(context, 400, errorMessage(error, 'bind failed'))
    }
  }))
}

async function withResolvedQuery(
  context: Context,
  options: DifyAdministrationRouteOptions,
  operation: (orgId: string, actor: IdentityActor) => Promise<Response>,
): Promise<Response> {
  return await withAdmin(context, options, async actor => {
    const orgId = resolveOrganization(context, actor, options, context.req.query('enterprise_id'))
    return orgId instanceof Response ? orgId : await operation(orgId, actor)
  })
}

async function withAdmin(
  context: Context,
  options: DifyAdministrationRouteOptions,
  operation: (actor: IdentityActor) => Promise<Response>,
): Promise<Response> {
  const actor = options.getActor(context.req.header('Authorization'))
  if (!actor) return failure(context, 401, '未授权，请先登录')
  if (actor.role !== 'admin' && actor.role !== 'super_admin') return failure(context, 403, '权限不足')
  return await operation(actor)
}

function resolveOrganization(
  context: Context,
  actor: IdentityActor,
  options: DifyAdministrationRouteOptions,
  raw: unknown,
): string | Response {
  const legacyId = parseEnterpriseId(raw)
  if (hasGlobalOrganizationAccess(actor)) {
    if (legacyId === null) return failure(context, 400, 'super admin must specify enterprise_id')
    const resolved = options.resolveEnterpriseAlias(legacyId)
    return resolved?.resourceId ?? failure(context, 400, `enterprise ${legacyId} not found`)
  }
  if (legacyId !== null) {
    const resolved = options.resolveEnterpriseAlias(legacyId)
    if (!resolved || resolved.resourceId !== actor.orgId) return failure(context, 403, 'cannot operate on another enterprise')
  }
  return actor.orgId
}

async function jsonOperation(context: Context, operation: () => Promise<unknown>, fallbackStatus: number): Promise<Response> {
  try {
    return context.json({ success: true, data: await operation() })
  } catch (error) {
    return providerError(context, error, fallbackStatus)
  }
}

async function successOperation(context: Context, operation: () => Promise<unknown>): Promise<Response> {
  try {
    await operation()
    return context.json({ success: true })
  } catch (error) {
    return providerError(context, error, 500)
  }
}

function providerError(context: Context, error: unknown, fallbackStatus: number): Response {
  if (error instanceof DifyProviderError) {
    return context.json({ success: false, msg: error.message, detail: error.detail }, error.status as 400)
  }
  if (error instanceof DifyDomainError) return failure(context, error.status, error.message)
  return failure(context, fallbackStatus, errorMessage(error, 'operation failed'))
}

function parseEnterpriseId(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function formString(form: FormData, key: string): string | undefined {
  const value = form.get(key)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function formJsonArray(form: FormData, key: string): string[] {
  const raw = formString(form, key)
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message || fallback : fallback
}

function failure(context: Context, status: number, msg: string): Response {
  return context.json({ success: false, msg }, status as 400)
}
