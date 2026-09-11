import { describe, expect, it } from 'bun:test'
import forge from 'node-forge'
import iconv from 'iconv-lite'
import { createFuiouClient } from '../credits/fuiou.js'

function forgeBytesToBuffer(bytes: string): Buffer {
  return Buffer.from(bytes.split('').map(ch => ch.charCodeAt(0)))
}

function bufferToForgeBytes(buffer: Buffer): string {
  return Array.from(buffer).map(byte => String.fromCharCode(byte)).join('')
}

function decrypt(privateKey: forge.pki.rsa.PrivateKey, encoded: string): Record<string, unknown> {
  const encrypted = Buffer.from(encoded, 'base64')
  const blockSize = Math.floor(privateKey.n.bitLength() / 8)
  const chunks: string[] = []
  for (let i = 0; i < encrypted.length; i += blockSize) {
    chunks.push(privateKey.decrypt(bufferToForgeBytes(encrypted.subarray(i, i + blockSize)), 'RSAES-PKCS1-V1_5'))
  }
  return JSON.parse(iconv.decode(forgeBytesToBuffer(chunks.join('')), 'GBK')) as Record<string, unknown>
}

function encrypt(publicKey: forge.pki.rsa.PublicKey, message: Record<string, string>): string {
  const data = iconv.encode(JSON.stringify(message), 'GBK')
  const blockSize = Math.floor(publicKey.n.bitLength() / 8) - 11
  const chunks: string[] = []
  for (let i = 0; i < data.length; i += blockSize) {
    chunks.push(publicKey.encrypt(bufferToForgeBytes(data.subarray(i, i + blockSize)), 'RSAES-PKCS1-V1_5'))
  }
  return forgeBytesToBuffer(chunks.join('')).toString('base64')
}

describe('Fuiou RSA adapter', () => {
  it('keeps public and private key block sizes separate', async () => {
    const merchantKeys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
    const fuiouKeys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 })
    const client = createFuiouClient({
      isTest: true,
      merchantCode: 'mch',
      callbackUrl: 'https://moss.example/api/v1/recharge/callback',
      merchantPrivateKey: forge.pki.privateKeyToPem(merchantKeys.privateKey),
      publicKey: forge.pki.publicKeyToPem(fuiouKeys.publicKey),
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { message?: string }
        const request = decrypt(fuiouKeys.privateKey, body.message ?? '')
        expect(request.order_id).toBe('order-1')
        return new Response(JSON.stringify({
          resp_code: '0000',
          message: encrypt(merchantKeys.publicKey, {
            order_date: '20260911',
            order_pay_type: 'ALIPAY',
            order_amt: '730',
            mchnt_cd: 'mch',
            order_id: 'order-1',
            order_info: 'qr-url',
          }),
        }), { status: 200 })
      },
    })

    const result = await client.createOrder({
      orderId: 'order-1',
      orderDate: '20260911',
      orderAmt: '730',
      orderPayType: 'ALIPAY',
      goodsName: 'TUC1USD',
      goodsDetail: '充值1美元 (￥7.30)',
    })

    expect(result.success).toBe(true)
    expect(result.data?.order_info).toBe('qr-url')
  })
})
