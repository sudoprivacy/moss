import type { Hono } from 'hono'
import type { IdentityActor } from '../../../identity/organizationIdentityService.js'

type ActorResolver = (authorization: string | undefined) => IdentityActor | null

export interface SudoworkLegacyUsagePort {
  listModels(): Promise<unknown[]> | unknown[]
  reportUsage(input: {
    actor: IdentityActor
    inputTokens: number
    outputTokens: number
    model?: string
    idempotencyKey?: string
  }): Promise<unknown> | unknown
  getDashboard(actor: IdentityActor): Promise<unknown> | unknown
  listLedger(input: {
    actor: IdentityActor
    timeFrom?: number
    timeTo?: number
  }): Promise<{ data: unknown[]; total?: number }> | { data: unknown[]; total?: number }
  getStats(actor: IdentityActor): Promise<unknown> | unknown
  getModelUsageStats(input: {
    actor: IdentityActor
    startDate?: string
    endDate?: string
  }): Promise<unknown> | unknown
  listAdminUserLedger(input: {
    actor: IdentityActor
    legacyUserId: number
    limit: number
  }): Promise<unknown[]> | unknown[]
}

export function registerSudoworkLegacyUsageRoutes(
  app: Hono,
  options: {
    usage?: SudoworkLegacyUsagePort
    getActor: ActorResolver
    getAdminActor: ActorResolver
  },
): void {
  const usage = () => {
    if (!options.usage) throw new Error('Sudowork legacy usage service 未配置')
    return options.usage
  }
  const unauthorized = (context: any) => context.json({ success: false, msg: '未授权' }, 401)
  const actorFor = (context: any, admin = false) => (
    admin ? options.getAdminActor(context.req.header('Authorization')) : options.getActor(context.req.header('Authorization'))
  )

  app.get('/api/v1/router/models', async context => (
    context.json({ success: true, data: await usage().listModels() })
  ))

  app.post('/api/v1/usage/report', async context => {
    const actor = actorFor(context)
    if (!actor) return unauthorized(context)
    const body = await context.req.json<Record<string, unknown>>().catch(() => ({}))
    return context.json(await usage().reportUsage({
      actor,
      inputTokens: Number(body.inputTokens ?? 0),
      outputTokens: Number(body.outputTokens ?? 0),
      model: typeof body.model === 'string' ? body.model : undefined,
      idempotencyKey: context.req.header('Idempotency-Key') || undefined,
    }))
  })

  app.get('/api/v1/user/dashboard', async context => {
    const actor = actorFor(context)
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: await usage().getDashboard(actor) })
  })

  app.get('/api/v1/user/ledger', async context => {
    const actor = actorFor(context)
    if (!actor) return unauthorized(context)
    const result = await usage().listLedger({
      actor,
      timeFrom: optionalInteger(context.req.query('time_from')),
      timeTo: optionalInteger(context.req.query('time_to')),
    })
    return context.json({ success: true, data: result.data, ...(result.total === undefined ? {} : { total: result.total }) })
  })

  app.get('/api/v1/user/stats', async context => {
    const actor = actorFor(context)
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: await usage().getStats(actor) })
  })

  app.get('/api/v1/user/model-usage-stats', async context => {
    const actor = actorFor(context)
    if (!actor) return unauthorized(context)
    const startDate = context.req.query('start_date')
    const endDate = context.req.query('end_date')
    if (!startDate || !endDate) {
      return context.json({ success: false, msg: '缺少日期参数' }, 400)
    }
    if (!isValidDate(startDate) || !isValidDate(endDate)) {
      return context.json({ success: false, msg: '日期格式无效' }, 400)
    }
    if (Date.parse(startDate) > Date.parse(endDate)) {
      return context.json({ success: false, msg: '开始日期不能晚于结束日期' }, 400)
    }
    if ((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 > 30) {
      return context.json({ success: false, msg: '时间范围不能超过30天' }, 400)
    }
    return context.json({ success: true, data: await usage().getModelUsageStats({
      actor,
      startDate,
      endDate,
    }) })
  })

  app.get('/api/v1/admin/users/:id/ledger', async context => {
    const actor = actorFor(context, true)
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: await usage().listAdminUserLedger({
      actor,
      legacyUserId: Number.parseInt(context.req.param('id'), 10),
      limit: optionalInteger(context.req.query('limit')) ?? 20,
    }) })
  })
}

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
}

function optionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}
