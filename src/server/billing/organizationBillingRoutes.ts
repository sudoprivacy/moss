import { OrganizationBillingError, type OrganizationBillingActor, type OrganizationBillingService } from './organizationBillingService.js'
import { RouterRequestError } from './organizationRouterAdapter.js'

export async function dispatchOrganizationBilling(
  service: OrganizationBillingService | undefined, actor: OrganizationBillingActor, method: string, url: URL,
  body: Record<string, unknown>, reference?: string,
): Promise<{ status: number; body: unknown }> {
  try {
    if (!service) throw new OrganizationBillingError('UNAVAILABLE', '组织模型服务未配置', 503)
    const path = url.pathname.replace(/\/$/, '')
    const base = '/api/v1/model-account'
    let data: unknown
    if (method === 'GET' && path === base) data = await service.dashboard(actor)
    else if (method === 'GET' && path === `${base}/access`) data = await service.access(actor)
    else if (method === 'GET' && path === `${base}/logs`) data = await service.logs(actor, Number(url.searchParams.get('page') ?? 1), Number(url.searchParams.get('page_size') ?? 20))
    else if (method === 'GET' && path === `${base}/members`) data = { items: await service.listMembers(actor) }
    else if (method === 'PATCH' && path === `${base}/status`) {
      if (body.status !== 'enabled' && body.status !== 'disabled') throw new OrganizationBillingError('INVALID_STATUS', '状态无效')
      await service.setAccountStatus(actor, body.status, reference ?? ''); data = { updated: true }
    } else if (path === `${base}/service/status` && method === 'PATCH' || path === `${base}/service/limit` && method === 'POST') {
      let change: { status: 'enabled' | 'disabled' } | { amountUsd: string; direction: 'increase' | 'decrease' }
      if (method === 'PATCH') {
        if (body.status !== 'enabled' && body.status !== 'disabled') throw new OrganizationBillingError('INVALID_STATUS', '状态无效')
        change = { status: body.status }
      } else {
        if (typeof body.amount_usd !== 'string' || body.direction !== 'increase' && body.direction !== 'decrease') throw new OrganizationBillingError('INVALID_LIMIT', '限额调整参数无效')
        change = { amountUsd: body.amount_usd, direction: body.direction }
      }
      data = service.projectToken(await service.manageService(actor, reference ?? '', change), await service.requireAccount(actor.orgId))
    } else if (method === 'PATCH' && path === `${base}/defaults`) {
      if (body.member_limit_usd !== null && typeof body.member_limit_usd !== 'string') throw new OrganizationBillingError('INVALID_LIMIT', '限额必须为美元金额或不限额')
      await service.setDefaults(actor, body.member_limit_usd as string | null); data = { updated: true }
    } else if (method === 'POST' && path === `${base}/retry`) {
      await service.assertAdmin(actor, actor.orgId)
      const org = await service.db.get('SELECT name FROM organizations WHERE id = ?', [actor.orgId])
      const account = await service.retryOrganization(actor.orgId, String(org?.name ?? actor.orgId))
      data = { account_status: account.status }
    } else {
      const match = path.match(/^\/api\/v1\/model-account\/members\/([^/]+)\/(limit|limit-mode|usage|status|provision)$/)
      if (!match) throw new OrganizationBillingError('NOT_FOUND', '接口不存在', 404)
      const member = decodeURIComponent(match[1]!)
      const operationReference = reference ?? (typeof body.reference === 'string' ? body.reference : '')
      if (match[2] === 'usage' && method === 'GET') {
        data = await service.memberUsage(actor, member, Number(url.searchParams.get('page') ?? 1), Number(url.searchParams.get('page_size') ?? 20))
      } else if (match[2] === 'limit-mode' && method === 'PATCH') {
        if (typeof body.unlimited !== 'boolean' || !body.unlimited && typeof body.remaining_limit_usd !== 'string') throw new OrganizationBillingError('INVALID_LIMIT', '请选择限额模式并填写剩余限额')
        const token = await service.setMemberLimitMode(actor, member, body.unlimited ? null : body.remaining_limit_usd as string, operationReference)
        data = service.projectToken(token, await service.requireAccount(actor.orgId))
      } else if (match[2] === 'provision' && method === 'POST') {
        await service.assertAdmin(actor, actor.orgId)
        // Retries reuse the recorded creation limit; callers cannot change it through this endpoint.
        const token = await service.ensureMember(actor.orgId, member)
        data = { user_id: member, provisioning_status: token.status }
      } else if (match[2] === 'status' && method === 'PATCH') {
        if (body.status !== 'enabled' && body.status !== 'disabled') throw new OrganizationBillingError('INVALID_STATUS', '状态无效')
        const token = await service.setMemberStatus(actor, member, body.status, operationReference)
        data = service.projectToken(token, await service.requireAccount(actor.orgId))
      } else if (match[2] === 'limit' && method === 'POST') {
        if (typeof body.amount_usd !== 'string' || !['increase', 'decrease'].includes(String(body.direction))) throw new OrganizationBillingError('INVALID_LIMIT', '限额调整参数无效')
        const token = await service.adjustMemberLimit(actor, member, body.amount_usd, body.direction as 'increase' | 'decrease', operationReference)
        data = service.projectToken(token, await service.requireAccount(actor.orgId))
      } else throw new OrganizationBillingError('METHOD_NOT_ALLOWED', '请求方法无效', 405)
    }
    return { status: 200, body: { success: true, data } }
  } catch (error) {
    if (error instanceof OrganizationBillingError) return { status: error.statusCode, body: { success: false, error: { code: error.code, message: error.message } } }
    if (error instanceof RouterRequestError) return { status: error.outcome === 'unknown' ? 503 : 422, body: { success: false, error: { code: error.code, message: error.outcome === 'unknown' ? '模型服务结果待核对，请勿重复调整限额' : '模型服务拒绝了请求，请核对 Key 状态和剩余限额' } } }
    return { status: 400, body: { success: false, error: { code: 'INVALID_REQUEST', message: '请求参数无效或服务暂不可用' } } }
  }
}
