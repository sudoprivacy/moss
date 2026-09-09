import type { Hono } from 'hono'
import type { IdentityActor } from '../../../identity/organizationIdentityService.js'
import { SudoworkBillingError, type SudoworkBillingPort } from './billingService.js'

type ActorResolver = (authorization: string | undefined) => IdentityActor | null

export function registerSudoworkBillingRoutes(
  app: Hono,
  options: {
    billing?: SudoworkBillingPort
    getActor: ActorResolver
    getAdminActor: ActorResolver
  },
): void {
  const billing = () => {
    if (!options.billing) throw new SudoworkBillingError(503, 'Sudowork Billing 未配置')
    return options.billing
  }
  const user = (authorization: string | undefined) => options.getActor(authorization)
  const admin = (authorization: string | undefined) => options.getAdminActor(authorization)
  const unauthorized = (context: any) => context.json({ success: false, msg: '未授权' }, 401)
  const body = async (context: any): Promise<Record<string, unknown>> => context.req.json().catch(() => ({}))
  const idempotencyKey = (context: any) => context.req.header('Idempotency-Key') || undefined
  const page = (value: string | undefined, fallback: number) => Number.parseInt(value || String(fallback), 10)

  app.get('/api/v1/recharge/packages', context => (
    context.json({ success: true, data: billing().listPackages() })
  ))

  app.post('/api/v1/recharge/create', async context => {
    const actor = user(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    const value = await body(context)
    if (!value.amount || !value.payment_method) {
      return context.json({ success: false, msg: '金额和支付方式不能为空' }, 400)
    }
    if (value.payment_method !== 'ALIPAY' && value.payment_method !== 'WECHAT') {
      return context.json({ success: false, msg: '支付方式无效' }, 400)
    }
    return context.json({ success: true, data: billing().createOrder({
      actor, amount: Number(value.amount), paymentMethod: value.payment_method,
      idempotencyKey: idempotencyKey(context),
    }) })
  })

  app.post('/api/v1/recharge/pay', async context => {
    const actor = user(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    const value = await body(context)
    const orderNo = typeof value.order_no === 'string' ? value.order_no : ''
    if (!orderNo) return context.json({ success: false, msg: '订单号不能为空' }, 400)
    return context.json({ success: true, data: await billing().payOrder({
      actor, orderNo, idempotencyKey: idempotencyKey(context),
    }) })
  })

  app.post('/api/v1/recharge/callback', async context => {
    try {
      await billing().handlePaymentCallback(await body(context))
      return context.text('success')
    } catch {
      return context.text('fail', 500)
    }
  })

  app.get('/api/v1/recharge/query/:orderNo', context => {
    const actor = user(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: billing().queryOrder(actor, context.req.param('orderNo')) })
  })

  app.get('/api/v1/recharge/list', context => {
    const actor = user(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: billing().listUserOrders({
      actor, page: page(context.req.query('page'), 1), pageSize: page(context.req.query('pageSize'), 20),
    }) })
  })

  app.post('/api/v1/recharge/cancel/:orderNo', context => {
    const actor = user(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    billing().cancelOrder({ actor, orderNo: context.req.param('orderNo'), idempotencyKey: idempotencyKey(context) })
    return context.json({ success: true, msg: '订单已取消' })
  })

  app.get('/api/v1/admin/recharge/orders', context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: billing().listAdminOrders({ actor, query: queryRecord(context) }) })
  })
  app.get('/api/v1/admin/recharge/orders/:orderNo', context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: billing().getAdminOrder(actor, context.req.param('orderNo')) })
  })
  app.get('/api/v1/admin/recharge/stats', context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: billing().getRechargeStats(actor) })
  })
  app.get('/api/v1/admin/recharge/refund-calc/:orderNo', context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: billing().calculateRefund(actor, context.req.param('orderNo')) })
  })
  app.post('/api/v1/admin/recharge/orders/:orderNo/refund', async context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    const value = await body(context)
    const result = await billing().requestRefund({
      actor, orderNo: context.req.param('orderNo'),
      reason: typeof value.reason === 'string' && value.reason ? value.reason : '用户申请退款',
      idempotencyKey: idempotencyKey(context),
    }) as any
    return context.json({ success: true, msg: '退款成功', data: result })
  })
  app.post('/api/v1/admin/recharge/simulate-payment/:orderNo', async context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    const result = await billing().simulatePayment({
      actor, orderNo: context.req.param('orderNo'), idempotencyKey: idempotencyKey(context),
    })
    return context.json({ success: true, msg: '模拟支付成功', data: result })
  })
  app.get('/api/v1/admin/recharge-records', context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: billing().listRechargeRecords({ actor, query: queryRecord(context) }) })
  })
  app.post('/api/v1/admin/recharge/orders/:id/retry', async context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    await billing().retryOrder({
      actor, legacyOrderId: Number(context.req.param('id')), idempotencyKey: idempotencyKey(context),
    })
    return context.json({ success: true, msg: '订单重试成功' })
  })
  app.post('/api/v1/admin/recharge/sync', async context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: await billing().syncPendingOrders({ actor, idempotencyKey: idempotencyKey(context) }) })
  })
  app.post('/api/v1/admin/recharge/orders/:orderNo/sync', async context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: await billing().syncOrder({
      actor, orderNo: context.req.param('orderNo'), idempotencyKey: idempotencyKey(context),
    }) })
  })

  app.post('/api/v1/admin/users/:id/points', async context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    const value = await body(context)
    if (!value.amount || Number(value.amount) <= 0) {
      return context.json({ success: false, msg: '积分数量必须大于 0' }, 400)
    }
    const data = await billing().adjustUserPoints({
      actor, legacyUserId: Number(context.req.param('id')), amount: Number(value.amount),
      operation: value.operation, reason: typeof value.reason === 'string' ? value.reason : undefined,
      syncSudorouter: value.sync_sudorouter === true, idempotencyKey: idempotencyKey(context),
    })
    return context.json({ success: true, msg: '积分调整成功', data })
  })
  app.post('/api/v1/admin/users/:id/recharge', async context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    if (actor.role !== 'super_admin') return context.json({ success: false, msg: '只有超级管理员可以为用户充值' }, 403)
    const value = await body(context)
    if (!value.points || Number(value.points) <= 0) {
      return context.json({ success: false, msg: '充值积分必须大于 0' }, 400)
    }
    const data = await billing().rechargeUser({
      actor, legacyUserId: Number(context.req.param('id')), points: Number(value.points),
      reason: typeof value.reason === 'string' ? value.reason : undefined,
      paymentReference: typeof value.payment_reference === 'string' ? value.payment_reference : undefined,
      idempotencyKey: idempotencyKey(context),
    })
    return context.json({ success: true, msg: '充值成功', data })
  })
  app.post('/api/v1/admin/users/:id/sync-quota', async context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    const data = await billing().syncUserQuota({
      actor, legacyUserId: Number(context.req.param('id')), idempotencyKey: idempotencyKey(context),
    })
    return context.json({ success: true, msg: '额度同步成功', data })
  })

  app.post('/api/v1/credit-applications/', async context => {
    const actor = user(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    const value = await body(context)
    return context.json({ success: true, data: billing().createCreditApplication({
      actor, requestedPoints: Number(value.requested_points), reason: value.reason,
      idempotencyKey: idempotencyKey(context),
    }) })
  })
  app.get('/api/v1/credit-applications/', context => {
    const actor = user(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: billing().listUserCreditApplications({
      actor, page: page(context.req.query('page'), 1), pageSize: page(context.req.query('pageSize'), 20),
    }) })
  })
  app.get('/api/v1/credit-applications/:id', context => {
    const actor = user(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: billing().getUserCreditApplication(actor, Number(context.req.param('id'))) })
  })
  app.get('/api/v1/admin/credit-applications', context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: billing().listAdminCreditApplications({ actor, query: queryRecord(context) }) })
  })
  app.get('/api/v1/admin/credit-applications/:id', context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    return context.json({ success: true, data: billing().getAdminCreditApplication(actor, Number(context.req.param('id'))) })
  })
  app.post('/api/v1/admin/credit-applications/:id/approve', async context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    const value = await body(context)
    const data = await billing().approveCreditApplication({
      actor, legacyApplicationId: Number(context.req.param('id')),
      approvedPoints: value.approved_points === undefined ? undefined : Number(value.approved_points),
      adminComment: typeof value.admin_comment === 'string' ? value.admin_comment : undefined,
      idempotencyKey: idempotencyKey(context),
    })
    return context.json({ success: true, msg: '审批通过', data })
  })
  app.post('/api/v1/admin/credit-applications/:id/reject', async context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    const value = await body(context)
    billing().rejectCreditApplication({
      actor, legacyApplicationId: Number(context.req.param('id')), adminComment: value.admin_comment,
      idempotencyKey: idempotencyKey(context),
    })
    return context.json({ success: true, msg: '已拒绝' })
  })
  app.post('/api/v1/admin/credit-applications/:id/retry-sync', async context => {
    const actor = admin(context.req.header('Authorization'))
    if (!actor) return unauthorized(context)
    const data = await billing().retryCreditApplication({
      actor, legacyApplicationId: Number(context.req.param('id')), idempotencyKey: idempotencyKey(context),
    })
    return context.json({ success: true, msg: '重试成功', data })
  })
}

function queryRecord(context: any): Record<string, string | undefined> {
  const url = new URL(context.req.url)
  const result: Record<string, string> = {}
  for (const [key, value] of url.searchParams) result[key] = value
  return result
}
