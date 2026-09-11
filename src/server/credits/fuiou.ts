import { readFile } from 'fs/promises'
import forge from 'node-forge'
import iconv from 'iconv-lite'

const FUIOU_CHARSET = 'GBK'
const DEFAULT_TEST_URL = 'https://hlwnets-test.fuioupay.com'
const DEFAULT_PROD_URL = 'https://hlwnets.fuioupay.com'
const DEFAULT_REFUND_TEST_URL = 'https://refund-transfer-test.fuioupay.com'
const DEFAULT_REFUND_PROD_URL = 'https://refund-transfer.fuioupay.com'

export type FuiouConfig = {
  isTest: boolean
  merchantCode: string
  callbackUrl: string
  timeoutMs?: number
  testApiUrl?: string
  prodApiUrl?: string
  testRefundUrl?: string
  prodRefundUrl?: string
  merchantPrivateKey?: string
  merchantPrivateKeyFile?: string
  publicKey?: string
  publicKeyFile?: string
  fetchImpl?: typeof fetch
}

export type FuiouOrderRequest = {
  orderId: string
  orderDate: string
  orderAmt: string
  orderPayType: 'ALIPAY' | 'WECHAT'
  goodsName: string
  goodsDetail: string
}

export type FuiouOrderResponse = {
  order_date: string
  order_pay_type: string
  order_amt: string
  mchnt_cd: string
  order_id: string
  order_info: string
}

export type FuiouCallbackPayload = {
  mchnt_cd: string
  message: string
  resp_code: string
  resp_desc: string
}

export type FuiouCallbackMessage = {
  order_id: string
  order_st: '1' | '2' | string
  order_amt: string
  order_date: string
}

export type FuiouQueryResponse = {
  order_id: string
  order_st: string
  order_amt: string
  order_date: string
}

export type FuiouRefundRequest = {
  refund_order_date: string
  refund_order_id: string
  pay_order_date: string
  pay_order_id: string
  refund_amt: string
}

export type FuiouRefundResponse = {
  mchnt_cd: string
  refund_order_date: string
  refund_order_id: string
  pay_order_date: string
  pay_order_id: string
  refund_amt: string
  refund_st: string
  refund_fas_date?: string
  refund_fas_ssn?: string
}

export type FuiouResult<T> = {
  success: boolean
  data: T | null
  request: { method: string; url: string; body: unknown }
  response: { status: number; data: unknown }
  duration_ms: number
  error?: string
}

export class FuiouError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'FuiouError'
  }
}

class RsaCrypto {
  private publicKey: forge.pki.rsa.PublicKey | null = null
  private privateKey: forge.pki.rsa.PrivateKey | null = null
  private publicKeySize = 1024
  private privateKeySize = 1024

  private normalizeKey(key: string, type: 'public' | 'private'): string {
    let normalized = key.trim().replace(/\\n/g, '\n')
    if (!normalized.includes('-----BEGIN')) {
      const header = type === 'public' ? '-----BEGIN PUBLIC KEY-----' : '-----BEGIN PRIVATE KEY-----'
      const footer = type === 'public' ? '-----END PUBLIC KEY-----' : '-----END PRIVATE KEY-----'
      normalized = `${header}\n${normalized}\n${footer}`
    }
    return normalized
  }

  private bufferToForgeBytes(buffer: Buffer): string {
    return Array.from(buffer).map(byte => String.fromCharCode(byte)).join('')
  }

  private forgeBytesToBuffer(bytes: string): Buffer {
    return Buffer.from(bytes.split('').map(ch => ch.charCodeAt(0)))
  }

  loadPublicKey(key: string): void {
    this.publicKey = forge.pki.publicKeyFromPem(this.normalizeKey(key, 'public'))
    this.publicKeySize = this.publicKey.n.bitLength()
  }

  loadPrivateKey(key: string): void {
    const privateKey = forge.pki.decryptRsaPrivateKey(this.normalizeKey(key, 'private'))
    if (!privateKey) throw new FuiouError('Merchant private key cannot be decrypted')
    this.privateKey = privateKey
    this.privateKeySize = privateKey.n.bitLength()
  }

  encryptWithPublicKey(data: Buffer): Buffer {
    if (!this.publicKey) throw new FuiouError('Fuiou public key is not loaded')
    const blockSize = Math.floor(this.publicKeySize / 8) - 11
    const chunks: string[] = []
    for (let i = 0; i < data.length; i += blockSize) {
      const chunk = data.subarray(i, Math.min(i + blockSize, data.length))
      chunks.push(this.publicKey.encrypt(this.bufferToForgeBytes(chunk), 'RSAES-PKCS1-V1_5'))
    }
    return this.forgeBytesToBuffer(chunks.join(''))
  }

  decryptWithPrivateKey(data: Buffer): Buffer {
    if (!this.privateKey) throw new FuiouError('Merchant private key is not loaded')
    const blockSize = Math.floor(this.privateKeySize / 8)
    const chunks: string[] = []
    for (let i = 0; i < data.length; i += blockSize) {
      const chunk = data.subarray(i, Math.min(i + blockSize, data.length))
      chunks.push(this.privateKey.decrypt(this.bufferToForgeBytes(chunk), 'RSAES-PKCS1-V1_5'))
    }
    return this.forgeBytesToBuffer(chunks.join(''))
  }
}

async function loadKey(value: string | undefined, file: string | undefined): Promise<string | null> {
  if (value?.trim()) return value.trim()
  if (file?.trim()) return (await readFile(file.trim(), 'utf8')).trim()
  return null
}

export type FuiouClient = {
  isConfigured(): boolean
  isTestMode(): boolean
  getMerchantCode(): string
  createOrder(request: FuiouOrderRequest): Promise<FuiouResult<FuiouOrderResponse>>
  queryOrder(orderId: string, orderDate: string): Promise<FuiouResult<FuiouQueryResponse>>
  refundOrder(request: FuiouRefundRequest): Promise<FuiouResult<FuiouRefundResponse>>
  handleCallback(payload: FuiouCallbackPayload): Promise<FuiouCallbackMessage>
}

export function createFuiouClient(config: FuiouConfig): FuiouClient {
  const fetchImpl = config.fetchImpl ?? fetch
  const baseUrl = (config.isTest ? config.testApiUrl : config.prodApiUrl) ||
    (config.isTest ? DEFAULT_TEST_URL : DEFAULT_PROD_URL)
  const refundUrl = (config.isTest ? config.testRefundUrl : config.prodRefundUrl) ||
    (config.isTest ? DEFAULT_REFUND_TEST_URL : DEFAULT_REFUND_PROD_URL)
  const timeoutMs = config.timeoutMs ?? 10_000
  const rsa = new RsaCrypto()
  let initialized = false

  async function initialize(): Promise<void> {
    if (initialized) return
    const privateKey = await loadKey(config.merchantPrivateKey, config.merchantPrivateKeyFile)
    const publicKey = await loadKey(config.publicKey, config.publicKeyFile)
    if (!config.merchantCode.trim()) throw new FuiouError('Fuiou merchant code is not configured')
    if (!privateKey) throw new FuiouError('Fuiou merchant private key is not configured')
    if (!publicKey) throw new FuiouError('Fuiou public key is not configured')
    rsa.loadPrivateKey(privateKey)
    rsa.loadPublicKey(publicKey)
    initialized = true
  }

  async function postEncrypted<T>(
    url: string,
    message: Record<string, string>,
    errorPrefix: string,
  ): Promise<FuiouResult<T>> {
    await initialize()
    const requestBody = {
      mchnt_cd: config.merchantCode,
      message: rsa.encryptWithPublicKey(iconv.encode(JSON.stringify(message), FUIOU_CHARSET)).toString('base64'),
    }
    const start = Date.now()
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const data = await response.json() as { resp_code?: string; resp_desc?: string; message?: string }
      const duration = Date.now() - start
      if (data.resp_code !== '0000') {
        return {
          success: false,
          data: null,
          request: { method: 'POST', url, body: requestBody },
          response: { status: response.status, data },
          duration_ms: duration,
          error: `${errorPrefix}: ${data.resp_code ?? response.status} - ${data.resp_desc ?? ''}`.trim(),
        }
      }
      if (!data.message) {
        return {
          success: false,
          data: null,
          request: { method: 'POST', url, body: requestBody },
          response: { status: response.status, data },
          duration_ms: duration,
          error: `${errorPrefix}: empty encrypted message`,
        }
      }
      const decrypted = rsa.decryptWithPrivateKey(Buffer.from(data.message, 'base64'))
      return {
        success: true,
        data: JSON.parse(iconv.decode(decrypted, FUIOU_CHARSET)) as T,
        request: { method: 'POST', url, body: requestBody },
        response: { status: response.status, data },
        duration_ms: duration,
      }
    } catch (error) {
      return {
        success: false,
        data: null,
        request: { method: 'POST', url, body: requestBody },
        response: { status: 0, data: null },
        duration_ms: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return {
    isConfigured(): boolean {
      return Boolean(
        config.merchantCode.trim() &&
        (config.merchantPrivateKey?.trim() || config.merchantPrivateKeyFile?.trim()) &&
        (config.publicKey?.trim() || config.publicKeyFile?.trim()),
      )
    },
    isTestMode(): boolean {
      return config.isTest
    },
    getMerchantCode(): string {
      return config.merchantCode
    },
    async createOrder(request): Promise<FuiouResult<FuiouOrderResponse>> {
      return postEncrypted<FuiouOrderResponse>(`${baseUrl.replace(/\/+$/, '')}/aggpos/order.fuiou`, {
        mchnt_cd: config.merchantCode,
        order_date: request.orderDate,
        order_id: request.orderId,
        order_amt: request.orderAmt,
        order_pay_type: request.orderPayType,
        back_notify_url: config.callbackUrl,
        goods_name: request.goodsName,
        goods_detail: request.goodsDetail,
        appid: '',
        openid: '',
        ver: '1.0.0',
      }, 'Fuiou payment failed')
    },
    async queryOrder(orderId, orderDate): Promise<FuiouResult<FuiouQueryResponse>> {
      return postEncrypted<FuiouQueryResponse>(`${baseUrl.replace(/\/+$/, '')}/aggpos/orderQuery.fuiou`, {
        mchnt_cd: config.merchantCode,
        order_date: orderDate,
        order_id: orderId,
        appid: '',
        openid: '',
        ver: '1.0.1',
      }, 'Fuiou query failed')
    },
    async refundOrder(request): Promise<FuiouResult<FuiouRefundResponse>> {
      return postEncrypted<FuiouRefundResponse>(
        `${refundUrl.replace(/\/+$/, '')}/refund_transfer/aggposRefund.fuiou`,
        {
          mchnt_cd: config.merchantCode,
          refund_order_date: request.refund_order_date,
          refund_order_id: request.refund_order_id,
          pay_order_date: request.pay_order_date,
          pay_order_id: request.pay_order_id,
          refund_amt: request.refund_amt,
          ver: '1.0.0',
        },
        'Fuiou refund failed',
      )
    },
    async handleCallback(payload): Promise<FuiouCallbackMessage> {
      await initialize()
      if (payload.resp_code !== '0000') {
        throw new FuiouError(`Callback failed: ${payload.resp_code} - ${payload.resp_desc}`)
      }
      if (payload.mchnt_cd !== config.merchantCode) {
        throw new FuiouError(`Merchant code mismatch: expected ${config.merchantCode}, got ${payload.mchnt_cd}`)
      }
      const decrypted = rsa.decryptWithPrivateKey(Buffer.from(payload.message, 'base64'))
      return JSON.parse(iconv.decode(decrypted, FUIOU_CHARSET)) as FuiouCallbackMessage
    },
  }
}
