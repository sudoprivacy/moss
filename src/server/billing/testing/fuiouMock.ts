import { constants, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, type KeyObject } from 'node:crypto'
import iconv from 'iconv-lite'

export interface MockPaymentOrder {
  orderNo: string; orderDate: string; amountCents: number; method: string; goods: string
  status: 'pending' | 'paid'; callbackAttempts: number; lastCallbackStatus?: number; createdAt: number
}
export interface FuiouMockOptions {
  merchantCode: string; providerPrivateKey: string; merchantPublicKey: string; controlToken: string
  baseUrl: string; callbackUrl: string; orders?: MockPaymentOrder[]
  save?: (orders: MockPaymentOrder[]) => void
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

/** Development-only peer for the existing RSA/GBK Fuiou protocol; never calls a payment network. */
export class FuiouMock {
  private readonly orders: MockPaymentOrder[]
  private readonly privateKey: KeyObject
  private readonly publicKey: KeyObject
  constructor(private readonly options: FuiouMockOptions) {
    for (const value of [options.baseUrl, options.callbackUrl]) {
      const url = new URL(value)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Fuiou mock requires explicit loopback URLs')
    }
    if (options.controlToken.length < 24) throw new Error('Fuiou mock control token is too short')
    this.orders = options.orders ?? []
    this.privateKey = createPrivateKey(options.providerPrivateKey)
    this.publicKey = createPublicKey(options.merchantPublicKey)
  }
  snapshot(): MockPaymentOrder[] { return structuredClone(this.orders) }
  private save(): void { this.options.save?.(this.snapshot()) }
  async handle(request: Request): Promise<Response> {
    try { return await this.route(request) } catch { return json({ resp_code: '9999', resp_desc: 'Invalid local payment request' }, 400) }
  }
  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') return json({ mode: 'local-fuiou-simulation', real_payment: false })
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/pay/'))) {
      const orderNo = url.pathname.startsWith('/pay/') ? decodeURIComponent(url.pathname.slice(5)) : undefined
      return new Response(this.html(orderNo), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } })
    }
    if (request.method === 'GET' && url.pathname === '/__mock/orders') {
      if (!this.authorized(request)) return json({ error: 'Unauthorized' }, 403)
      return json({ items: this.snapshot() })
    }
    const action = url.pathname.match(/^\/__mock\/orders\/([^/]+)\/(pay|pay-without-callback|replay)$/)
    if (request.method === 'POST' && action) {
      const isForm = request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')
      const body = isForm ? Object.fromEntries(new URLSearchParams(await request.text())) : await request.json() as Record<string, unknown>
      if (!this.authorized(request, body.csrf)) return json({ error: 'Unauthorized' }, 403)
      const order = this.requireOrder(decodeURIComponent(action[1]!))
      if (action[2] !== 'replay') { order.status = 'paid'; this.save() }
      else if (order.status !== 'paid') return json({ error: 'Order has not been paid' }, 409)
      if (action[2] !== 'pay-without-callback') await this.callback(order)
      return isForm ? new Response(null, { status: 303, headers: { Location: '/' } }) : json({ order: { ...order } })
    }
    if (request.method !== 'POST' || !['/aggpos/order.fuiou', '/aggpos/orderQuery.fuiou'].includes(url.pathname)) return json({ error: 'Not found' }, 404)
    const envelope = await request.json() as Record<string, unknown>
    if (envelope.mchnt_cd !== this.options.merchantCode || typeof envelope.message !== 'string') throw new Error('Invalid merchant')
    const body = JSON.parse(iconv.decode(rsa(Buffer.from(envelope.message, 'base64'), this.privateKey, false), 'gbk')) as Record<string, unknown>
    if (body.mchnt_cd !== this.options.merchantCode || typeof body.order_id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(body.order_id) || typeof body.order_date !== 'string' || !/^\d{8}$/.test(body.order_date)) throw new Error('Invalid order')
    if (url.pathname === '/aggpos/order.fuiou') {
      if (body.back_notify_url !== this.options.callbackUrl || typeof body.order_amt !== 'string' || !/^\d+$/.test(body.order_amt) || !Number.isSafeInteger(Number(body.order_amt)) || Number(body.order_amt) <= 0 || !['ALIPAY', 'WECHAT'].includes(String(body.order_pay_type))) throw new Error('Invalid payment')
      const existing = this.orders.find(order => order.orderNo === body.order_id)
      if (existing && (existing.orderDate !== body.order_date || existing.amountCents !== Number(body.order_amt) || existing.method !== body.order_pay_type)) throw new Error('Conflicting order')
      if (!existing) {
        this.orders.push({ orderNo: body.order_id, orderDate: body.order_date, amountCents: Number(body.order_amt), method: String(body.order_pay_type), goods: String(body.goods_detail ?? ''), status: 'pending', callbackAttempts: 0, createdAt: Date.now() })
        this.save()
      }
      return json(this.envelope({ order_info: `${this.options.baseUrl}/pay/${encodeURIComponent(body.order_id)}` }))
    }
    const order = this.requireOrder(body.order_id)
    if (body.order_date !== order.orderDate) throw new Error('Date mismatch')
    return json(this.envelope(this.paymentMessage(order)))
  }
  private authorized(request: Request, csrf?: unknown): boolean {
    const origin = request.headers.get('origin')
    if (origin && origin !== this.options.baseUrl) return false
    return request.headers.get('authorization') === `Bearer ${this.options.controlToken}` || csrf === this.options.controlToken
  }
  private requireOrder(orderNo: string): MockPaymentOrder {
    const order = this.orders.find(order => order.orderNo === orderNo)
    if (!order) throw new Error('Unknown order')
    return order
  }
  private paymentMessage(order: MockPaymentOrder): Record<string, string> {
    return { order_id: order.orderNo, order_date: order.orderDate, order_amt: String(order.amountCents), order_st: order.status === 'paid' ? '1' : '0' }
  }
  private envelope(message: Record<string, unknown>): Record<string, string> {
    return { mchnt_cd: this.options.merchantCode, resp_code: '0000', resp_desc: 'Local simulation', message: rsa(iconv.encode(JSON.stringify(message), 'gbk'), this.publicKey, true).toString('base64') }
  }
  private async callback(order: MockPaymentOrder): Promise<void> {
    order.callbackAttempts++; this.save()
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.callbackUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(this.envelope(this.paymentMessage(order))).toString(), signal: AbortSignal.timeout(10_000), redirect: 'error',
      })
      order.lastCallbackStatus = response.status
      await response.text()
    } catch { order.lastCallbackStatus = 0 }
    this.save()
  }
  private html(orderNo?: string): string {
    const orders = this.orders.filter(order => !orderNo || order.orderNo === orderNo).slice().reverse()
    const form = (order: MockPaymentOrder, action: string, label: string) => `<form method="post" action="/__mock/orders/${encodeURIComponent(order.orderNo)}/${action}"><input type="hidden" name="csrf" value="${escape(this.options.controlToken)}"><button>${label}</button></form>`
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>富友本地支付模拟</title><style>body{font:15px system-ui;background:#f4f6f8;color:#17212e;max-width:1100px;margin:40px auto;padding:0 24px}h1{font-size:26px}.notice,article{background:white;border:1px solid #d9e0e7;border-radius:12px;padding:20px;margin:16px 0}.notice{background:#fff8df}code{overflow-wrap:anywhere}form{display:inline-block;margin:8px 8px 0 0}button,a{color:#154c85}button{padding:9px 14px;border:1px solid #bbc9d8;border-radius:7px;background:white;cursor:pointer}small{color:#5e6e7d}</style><h1>富友本地支付模拟</h1><p class="notice">仅用于本地联调，无真实扣款。模拟成功回调会给所连接的 SudoRouter 测试账户增加额度。请先在 Sudowork 充值中心创建订单。</p><a href="/">刷新全部订单</a>${orders.length ? orders.map(order => `<article><h3><code>${escape(order.orderNo)}</code></h3><p>${escape(order.goods)} · ${escape(order.method)}</p><p>模拟应付 ¥${(order.amountCents / 100).toFixed(2)} · ${order.status === 'paid' ? '已支付' : '待支付'}</p><small>回调次数 ${order.callbackAttempts} · 最近回调 HTTP ${order.lastCallbackStatus ?? '—'}</small><div>${form(order, 'pay', '模拟支付并回调')}${form(order, 'pay-without-callback', '仅支付，等待查单')}${order.status === 'paid' ? form(order, 'replay', '重复发送回调') : ''}</div></article>`).join('') : '<article>暂无支付订单。请先在 Sudowork 充值中心下单并获取二维码，然后刷新这里。</article>'}</html>`
  }
}
function rsa(input: Buffer, key: KeyObject, encrypt: boolean): Buffer {
  const size = Math.ceil(key.asymmetricKeyDetails!.modulusLength! / 8)
  const chunkSize = encrypt ? size - 11 : size
  if (!input.length || !encrypt && input.length % size) throw new Error('Invalid RSA block')
  const chunks: Buffer[] = []
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    const options = { key, padding: constants.RSA_PKCS1_PADDING }
    chunks.push(encrypt ? publicEncrypt(options, input.subarray(offset, offset + chunkSize)) : privateDecrypt(options, input.subarray(offset, offset + chunkSize)))
  }
  return Buffer.concat(chunks)
}
function json(value: unknown, status = 200): Response { return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } }) }
function escape(value: string): string { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!) }
