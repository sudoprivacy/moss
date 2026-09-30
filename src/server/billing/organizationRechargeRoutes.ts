import { OrganizationBillingError, type OrganizationBillingActor } from './organizationBillingService.js'
import type { OrganizationRechargeService } from './organizationRechargeService.js'

export async function dispatchOrganizationRecharge(service: OrganizationRechargeService | undefined, actor: OrganizationBillingActor,
  method: string, url: URL, body: Record<string, unknown>, reference?: string): Promise<{ status: number; body: unknown }> {
  try {
    if (!service) throw new OrganizationBillingError('UNAVAILABLE', '组织充值服务未配置', 503)
    const path = url.pathname.replace(/\/$/, '')
    let data: unknown
    if (method === 'GET' && path === '/api/v1/model-billing/packages') data = { items: await service.packages(actor) }
    else if (method === 'GET' && path === '/api/v1/model-billing/orders') data = await service.list(actor, Number(url.searchParams.get('page') ?? 1), Number(url.searchParams.get('page_size') ?? 20))
    else if (method === 'POST' && path === '/api/v1/model-billing/orders') {
      if (typeof body.purchase_amount_usd !== 'string' || body.payment_method !== 'ALIPAY' && body.payment_method !== 'WECHAT') throw new OrganizationBillingError('INVALID_ORDER', '充值金额或支付方式无效')
      data = await service.createOrder(actor, body.purchase_amount_usd, body.payment_method, reference ?? '')
    } else {
      const match = path.match(/^\/api\/v1\/model-billing\/orders\/([^/]+)(?:\/(pay|sync|cancel))?$/)
      if (!match) throw new OrganizationBillingError('NOT_FOUND', '接口不存在', 404)
      const orderNo = decodeURIComponent(match[1]!)
      if (method === 'GET' && !match[2]) data = await service.get(actor, orderNo)
      else if (method === 'POST' && match[2] === 'pay') data = await service.pay(actor, orderNo)
      else if (method === 'POST' && match[2] === 'sync') data = await service.sync(actor, orderNo)
      else if (method === 'POST' && match[2] === 'cancel') { await service.cancel(actor, orderNo); data = { cancelled: true } }
      else throw new OrganizationBillingError('METHOD_NOT_ALLOWED', '请求方法无效', 405)
    }
    return { status: 200, body: { success: true, data } }
  } catch (error) {
    if (error instanceof OrganizationBillingError) return { status: error.statusCode, body: { success: false, error: { code: error.code, message: error.message } } }
    return { status: 503, body: { success: false, error: { code: 'PAYMENT_UNAVAILABLE', message: '充值请求未完成，请查询订单状态' } } }
  }
}

/** Fuiou may post either a JSON envelope or an encoded form envelope. */
export function parseOrganizationPaymentCallback(raw: string, contentType: string): Record<string, unknown> {
  if (raw.length > 1_048_576) throw new OrganizationBillingError('INVALID_CALLBACK', '支付回调内容过长')
  if (contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw))
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OrganizationBillingError('INVALID_CALLBACK', '支付回调格式无效')
  return value as Record<string, unknown>
}
