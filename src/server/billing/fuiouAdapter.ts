import {
  constants, createHash, createPrivateKey, createPublicKey,
  privateDecrypt, publicEncrypt, type KeyObject,
} from 'node:crypto'
import iconv from 'iconv-lite'
import type { BillingOrderRecord } from './billingRepository.js'
import type { PaymentIntent } from './rechargeService.js'

export interface FuiouCallbackPayload {
  mchnt_cd: string
  message: string
  resp_code: string
  resp_desc: string
}

export interface VerifiedPaymentEvent {
  providerEventId: string
  orderNo: string
  status: 'SUCCESS' | 'FAILED'
  amountCents: number
  orderDate: string
  raw: Record<string, unknown>
}

export class FuiouProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'FuiouProtocolError'
  }
}

export interface FuiouAdapterOptions {
  merchantCode: string
  callbackUrl?: string
  baseUrl?: string
  refundUrl?: string
  timeoutMs?: number
  testMode?: boolean
  merchantPrivateKey?: string | KeyObject
  fuiouPublicKey?: string | KeyObject
  decrypt?: (encrypted: Buffer) => Buffer
  encrypt?: (plain: Buffer) => Buffer
  decode?: (decrypted: Buffer) => string
  encode?: (plain: string) => Buffer
  fetch?: typeof fetch
}

export class FuiouAdapter {
  private readonly decryptMessage: (encrypted: Buffer) => Buffer
  private readonly encryptMessage: (plain: Buffer) => Buffer
  private readonly decodeMessage: (decrypted: Buffer) => string
  private readonly encodeMessage: (plain: string) => Buffer
  private readonly fetchImpl: typeof fetch
  readonly simulationEnabled: boolean

  constructor(private readonly options: FuiouAdapterOptions) {
    if (!options.merchantCode.trim()) throw new FuiouProtocolError('FUIOU_NOT_CONFIGURED', 'Fuiou 商户号未配置')
    this.decryptMessage = options.decrypt ?? this.createPrivateDecryptor(options.merchantPrivateKey)
    this.encryptMessage = options.encrypt ?? this.createPublicEncryptor(options.fuiouPublicKey)
    this.decodeMessage = options.decode ?? (value => new TextDecoder('gbk', { fatal: true }).decode(value))
    this.encodeMessage = options.encode ?? (value => iconv.encode(value, 'gbk'))
    this.fetchImpl = options.fetch ?? fetch
    this.simulationEnabled = options.testMode === true
  }

  async createPayment(intent: PaymentIntent): Promise<{ qrCodeUrl: string; orderInfo: string }> {
    const amountCents = this.simulationEnabled ? 1 : intent.amountCents
    const message = await this.encryptedRequest(`${this.baseUrl()}/aggpos/order.fuiou`, {
      mchnt_cd: this.options.merchantCode,
      order_date: intent.orderDate,
      order_id: intent.orderNo,
      order_amt: String(amountCents),
      order_pay_type: intent.paymentMethod,
      back_notify_url: this.options.callbackUrl ?? '',
      goods_name: `TUC${intent.amountUsd}USD`,
      goods_detail: `充值${intent.amountUsd}美元 (¥${(intent.amountCents / 100).toFixed(2)})`,
      appid: '', openid: '', ver: '1.0.0',
    })
    const orderInfo = typeof message.order_info === 'string' ? message.order_info : ''
    if (!orderInfo) throw new FuiouProtocolError('FUIOU_INVALID_RESPONSE', '支付二维码获取失败')
    return { qrCodeUrl: orderInfo, orderInfo }
  }

  async queryPayment(order: BillingOrderRecord): Promise<{
    status: 'SUCCESS' | 'FAILED' | 'PENDING'
    event?: VerifiedPaymentEvent
  }> {
    const message = await this.encryptedRequest(`${this.baseUrl()}/aggpos/orderQuery.fuiou`, {
      mchnt_cd: this.options.merchantCode, order_date: order.orderDate,
      order_id: order.orderNo, appid: '', openid: '', ver: '1.0.1',
    })
    const orderNo = typeof message.order_id === 'string' ? message.order_id : ''
    const orderDate = typeof message.order_date === 'string' ? message.order_date : ''
    const amountText = typeof message.order_amt === 'string' ? message.order_amt : ''
    if (orderNo !== order.orderNo || orderDate !== order.orderDate || !/^\d+$/.test(amountText)) {
      throw new FuiouProtocolError('FUIOU_QUERY_MISMATCH', '富友查单响应与本地订单不一致')
    }
    const amountCents = Number(amountText)
    if (!this.simulationEnabled && amountCents !== order.amountCents) {
      throw new FuiouProtocolError('FUIOU_QUERY_MISMATCH', '富友查单金额与本地订单不一致')
    }
    const status = message.order_st === '1' ? 'SUCCESS' : message.order_st === '2' ? 'FAILED' : 'PENDING'
    if (status === 'PENDING') return { status }
    const identity = JSON.stringify([this.options.merchantCode, orderNo, orderDate, message.order_st, amountCents])
    return {
      status,
      event: {
        providerEventId: `fuiou:query:${createHash('sha256').update(identity).digest('hex')}`,
        orderNo, orderDate, amountCents, status, raw: message,
      },
    }
  }

  async refund(input: {
    refundNo: string
    refundDate: string
    payOrderDate: string
    payOrderNo: string
    amountCents: number
  }): Promise<{ success: boolean; providerRefundNo?: string; raw?: Record<string, unknown>; error?: string }> {
    try {
      const message = await this.encryptedRequest(`${this.refundUrl()}/refund_transfer/aggposRefund.fuiou`, {
        mchnt_cd: this.options.merchantCode,
        refund_order_date: input.refundDate,
        refund_order_id: input.refundNo,
        pay_order_date: input.payOrderDate,
        pay_order_id: input.payOrderNo,
        refund_amt: String(input.amountCents),
        ver: '1.0.0',
      })
      if (message.refund_st !== '5') {
        return { success: false, raw: message, error: '退款状态异常' }
      }
      return {
        success: true,
        providerRefundNo: typeof message.refund_fas_ssn === 'string' ? message.refund_fas_ssn : undefined,
        raw: message,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async verifyCallback(input: Record<string, unknown>): Promise<VerifiedPaymentEvent> {
    const payload: FuiouCallbackPayload = {
      mchnt_cd: typeof input.mchnt_cd === 'string' ? input.mchnt_cd : '',
      message: typeof input.message === 'string' ? input.message : '',
      resp_code: typeof input.resp_code === 'string' ? input.resp_code : '',
      resp_desc: typeof input.resp_desc === 'string' ? input.resp_desc : '',
    }
    if (payload.resp_code !== '0000') {
      throw new FuiouProtocolError('FUIOU_RESPONSE_FAILED', `Callback failed: ${payload.resp_code} - ${payload.resp_desc}`)
    }
    if (payload.mchnt_cd !== this.options.merchantCode) {
      throw new FuiouProtocolError('FUIOU_MERCHANT_MISMATCH', 'Fuiou 商户号不匹配')
    }
    if (!payload.message || payload.message.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.message)) {
      throw new FuiouProtocolError('FUIOU_INVALID_MESSAGE', 'Fuiou 回调密文无效')
    }

    let raw: unknown
    try {
      const decrypted = this.decryptMessage(Buffer.from(payload.message, 'base64'))
      raw = JSON.parse(this.decodeMessage(decrypted))
    } catch (error) {
      throw new FuiouProtocolError(
        'FUIOU_DECRYPT_FAILED',
        `Fuiou 回调解密失败: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new FuiouProtocolError('FUIOU_INVALID_MESSAGE', 'Fuiou 回调消息格式无效')
    }
    const message = raw as Record<string, unknown>
    const orderNo = typeof message.order_id === 'string' ? message.order_id.trim() : ''
    const orderDate = typeof message.order_date === 'string' ? message.order_date.trim() : ''
    const statusCode = message.order_st
    const amountText = message.order_amt
    if (!orderNo || !/^\d{8}$/.test(orderDate) || (statusCode !== '1' && statusCode !== '2')
      || typeof amountText !== 'string' || !/^\d+$/.test(amountText)) {
      throw new FuiouProtocolError('FUIOU_INVALID_MESSAGE', 'Fuiou 回调业务字段无效')
    }
    const amountCents = Number(amountText)
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
      throw new FuiouProtocolError('FUIOU_INVALID_AMOUNT', 'Fuiou 回调金额无效')
    }
    const identity = JSON.stringify([
      this.options.merchantCode, orderNo, orderDate, statusCode, amountCents,
    ])
    return {
      providerEventId: `fuiou:${createHash('sha256').update(identity).digest('hex')}`,
      orderNo,
      status: statusCode === '1' ? 'SUCCESS' : 'FAILED',
      amountCents,
      orderDate,
      raw: message,
    }
  }

  private createPrivateDecryptor(key: string | KeyObject | undefined): (encrypted: Buffer) => Buffer {
    if (!key) throw new FuiouProtocolError('FUIOU_NOT_CONFIGURED', 'Fuiou 商户私钥未配置')
    const privateKey = typeof key === 'string' ? createPrivateKey(key.replaceAll('\\n', '\n')) : key
    const modulusLength = privateKey.asymmetricKeyDetails?.modulusLength
    if (!modulusLength) throw new FuiouProtocolError('FUIOU_INVALID_KEY', 'Fuiou 商户私钥无法识别')
    const blockSize = Math.ceil(modulusLength / 8)
    return encrypted => {
      if (encrypted.length === 0 || encrypted.length % blockSize !== 0) {
        throw new Error('encrypted message length does not match RSA block size')
      }
      const chunks: Buffer[] = []
      for (let offset = 0; offset < encrypted.length; offset += blockSize) {
        chunks.push(privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, encrypted.subarray(offset, offset + blockSize)))
      }
      return Buffer.concat(chunks)
    }
  }

  private createPublicEncryptor(key: string | KeyObject | undefined): (plain: Buffer) => Buffer {
    if (!key) return () => { throw new FuiouProtocolError('FUIOU_NOT_CONFIGURED', 'Fuiou 公钥未配置') }
    const publicKey = typeof key === 'string' ? createPublicKey(key.replaceAll('\\n', '\n')) : key
    const modulusLength = publicKey.asymmetricKeyDetails?.modulusLength
    if (!modulusLength) throw new FuiouProtocolError('FUIOU_INVALID_KEY', 'Fuiou 公钥无法识别')
    const blockSize = Math.ceil(modulusLength / 8)
    const inputBlockSize = blockSize - 11
    return plain => {
      const chunks: Buffer[] = []
      for (let offset = 0; offset < plain.length; offset += inputBlockSize) {
        chunks.push(publicEncrypt(
          { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
          plain.subarray(offset, offset + inputBlockSize),
        ))
      }
      return Buffer.concat(chunks)
    }
  }

  private async encryptedRequest(url: string, message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const encrypted = this.encryptMessage(this.encodeMessage(JSON.stringify(message))).toString('base64')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000)
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({ mchnt_cd: this.options.merchantCode, message: encrypted }),
      })
      const envelope = await response.json() as Record<string, unknown>
      if (!response.ok || envelope.resp_code !== '0000' || typeof envelope.message !== 'string') {
        throw new FuiouProtocolError(
          'FUIOU_RESPONSE_FAILED',
          `Fuiou request failed: ${String(envelope.resp_code ?? response.status)} - ${String(envelope.resp_desc ?? '')}`,
        )
      }
      const decoded = JSON.parse(this.decodeMessage(this.decryptMessage(Buffer.from(envelope.message, 'base64')))) as unknown
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new FuiouProtocolError('FUIOU_INVALID_RESPONSE', '富友响应消息格式无效')
      }
      return decoded as Record<string, unknown>
    } finally {
      clearTimeout(timeout)
    }
  }

  private baseUrl(): string {
    return (this.options.baseUrl ?? (this.simulationEnabled ? 'https://hlwnets-test.fuioupay.com' : 'https://hlwnets.fuioupay.com')).replace(/\/+$/, '')
  }

  private refundUrl(): string {
    return (this.options.refundUrl ?? (this.simulationEnabled ? 'https://refund-transfer-test.fuioupay.com' : 'https://refund-transfer.fuioupay.com')).replace(/\/+$/, '')
  }
}
