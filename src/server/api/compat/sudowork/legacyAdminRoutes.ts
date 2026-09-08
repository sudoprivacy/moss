import type { Hono } from 'hono'
import type { IdentityActor } from '../../../identity/organizationIdentityService.js'
import type { SudoworkBillingPort } from './billingService.js'

type ActorResolver = (authorization: string | undefined) => IdentityActor | null

export interface SudoworkLegacyAdminPort {
  getFeatureFlags(actor: IdentityActor): unknown
  listOperationLogs(input: { actor: IdentityActor; query: Record<string, string | undefined> }): unknown
  listMembers(actor: IdentityActor): unknown
  getAdminStats(actor: IdentityActor): unknown
  approveUser(input: { actor: IdentityActor; legacyUserId: number; idempotencyKey?: string }): Promise<void> | void
  rejectUser(input: { actor: IdentityActor; legacyUserId: number; idempotencyKey?: string }): Promise<void> | void
  deletePendingUser(input: { actor: IdentityActor; legacyUserId: number; idempotencyKey?: string }): Promise<void> | void
}

export function registerSudoworkLegacyAdminRoutes(
  app: Hono,
  options: {
    administration?: SudoworkLegacyAdminPort
    billing?: SudoworkBillingPort
    getAdminActor: ActorResolver
  },
): void {
  const administration = () => {
    if (!options.administration) throw new Error('Sudowork legacy administration service 未配置')
    return options.administration
  }
  const billing = () => {
    if (!options.billing) throw new Error('Sudowork Billing 未配置')
    return options.billing
  }
  const actorFor = (context: any) => options.getAdminActor(context.req.header('Authorization'))
  const unauthorized = (context: any) => context.json({ success: false, msg: '未授权' }, 401)
  const body = async (context: any): Promise<Record<string, unknown>> => context.req.json().catch(() => ({}))
  const query = (context: any): Record<string, string | undefined> => ({
    user_id: context.req.query('user_id'),
    action: context.req.query('action'),
    date_from: context.req.query('date_from'),
    date_to: context.req.query('date_to'),
    page: context.req.query('page'),
    page_size: context.req.query('page_size'),
  })

  app.get('/api/v1/admin/features', context => {
    const actor = actorFor(context)
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: administration().getFeatureFlags(actor) })
  })
  app.get('/api/v1/admin/logs', context => {
    const actor = actorFor(context)
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: administration().listOperationLogs({ actor, query: query(context) }) })
  })
  app.get('/api/v1/admin/members', context => {
    const actor = actorFor(context)
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: administration().listMembers(actor) })
  })
  app.get('/api/v1/admin/stats', context => {
    const actor = actorFor(context)
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: administration().getAdminStats(actor) })
  })
  app.post('/api/v1/admin/members/:id/sync-quota', async context => {
    const actor = actorFor(context)
    if (!actor) return unauthorized(context)
    const legacyUserId = Number.parseInt(context.req.param('id'), 10)
    return context.json({ success: true, msg: '额度同步成功', data: await billing().syncUserQuota({
      actor,
      legacyUserId,
      idempotencyKey: context.req.header('Idempotency-Key') || undefined,
    }) })
  })
  app.post('/api/v1/admin/approve', async context => mutateUser(context, 'approve'))
  app.post('/api/v1/admin/reject', async context => mutateUser(context, 'reject'))
  app.post('/api/v1/admin/delete', async context => mutateUser(context, 'delete'))

  async function mutateUser(context: any, action: 'approve' | 'reject' | 'delete') {
    const actor = actorFor(context)
    if (!actor) return unauthorized(context)
    const value = await body(context)
    const legacyUserId = Number(value.userId)
    const input = {
      actor,
      legacyUserId,
      idempotencyKey: context.req.header('Idempotency-Key') || undefined,
    }
    if (action === 'approve') await administration().approveUser(input)
    if (action === 'reject') await administration().rejectUser(input)
    if (action === 'delete') await administration().deletePendingUser(input)
    return context.json({
      success: true,
      msg: action === 'approve' ? '审批成功' : action === 'reject' ? '已拒绝申请' : '用户已删除',
    })
  }
}
