import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { FuiouAdapter, FuiouProtocolError } from './fuiouAdapter.js'

function adapter(): FuiouAdapter {
  return new FuiouAdapter({
    merchantCode: 'M100',
    decrypt: encrypted => encrypted,
    decode: decrypted => decrypted.toString('utf8'),
  })
}

describe('FuiouAdapter 回调验证', () => {
  test('拒绝错误响应码和错误商户号', async () => {
    await assert.rejects(() => adapter().verifyCallback({
      mchnt_cd: 'M100', message: '', resp_code: '1001', resp_desc: 'failed',
    }), (error: unknown) => error instanceof FuiouProtocolError && error.code === 'FUIOU_RESPONSE_FAILED')
    await assert.rejects(() => adapter().verifyCallback({
      mchnt_cd: 'OTHER', message: '', resp_code: '0000', resp_desc: 'ok',
    }), (error: unknown) => error instanceof FuiouProtocolError && error.code === 'FUIOU_MERCHANT_MISMATCH')
  })

  test('解密并严格校验回调消息，生成稳定 Provider event id', async () => {
    const message = Buffer.from(JSON.stringify({
      order_id: 'USR17NO1', order_st: '1', order_amt: '730', order_date: '20260907',
    })).toString('base64')
    const first = await adapter().verifyCallback({
      mchnt_cd: 'M100', message, resp_code: '0000', resp_desc: 'ok',
    })
    const replay = await adapter().verifyCallback({
      mchnt_cd: 'M100', message, resp_code: '0000', resp_desc: 'ok',
    })

    assert.deepEqual(replay, first)
    assert.equal(first.orderNo, 'USR17NO1')
    assert.equal(first.status, 'SUCCESS')
    assert.equal(first.amountCents, 730)
    assert.match(first.providerEventId, /^fuiou:[a-f0-9]{64}$/)
  })

  test('拒绝无效密文、未知状态和非整数金额', async () => {
    await assert.rejects(() => adapter().verifyCallback({
      mchnt_cd: 'M100', message: 'not-base64!', resp_code: '0000', resp_desc: 'ok',
    }), FuiouProtocolError)
    for (const value of [
      { order_id: 'NO1', order_st: '9', order_amt: '730', order_date: '20260907' },
      { order_id: 'NO1', order_st: '1', order_amt: '7.3', order_date: '20260907' },
    ]) {
      const message = Buffer.from(JSON.stringify(value)).toString('base64')
      await assert.rejects(() => adapter().verifyCallback({
        mchnt_cd: 'M100', message, resp_code: '0000', resp_desc: 'ok',
      }), FuiouProtocolError)
    }
  })
})

describe('FuiouAdapter 支付、查询和退款协议', () => {
  test('创建支付订单保持旧富友字段和二维码响应', async () => {
    let requestUrl = ''
    let requestMessage: Record<string, unknown> = {}
    const adapter = new FuiouAdapter({
      merchantCode: 'merchant-1', callbackUrl: 'https://api.test/api/v1/recharge/callback',
      baseUrl: 'https://pay.test', refundUrl: 'https://refund.test',
      decrypt: () => Buffer.from(JSON.stringify({ order_info: 'https://qr.test/code' })),
      decode: value => value.toString('utf8'), encode: value => Buffer.from(value),
      encrypt: value => { requestMessage = JSON.parse(value.toString('utf8')); return Buffer.from('encrypted') },
      fetch: async (url, init) => {
        requestUrl = String(url)
        assert.deepEqual(JSON.parse(String(init?.body)), { mchnt_cd: 'merchant-1', message: Buffer.from('encrypted').toString('base64') })
        return Response.json({ resp_code: '0000', message: 'YQ==' })
      },
    })

    const result = await adapter.createPayment({
      attemptId: 'attempt-1', orderId: 'order-id', orderNo: 'ORDER-1', orderDate: '20260907',
      amountCents: 730, amountUsd: 1, paymentMethod: 'ALIPAY',
    })

    assert.equal(requestUrl, 'https://pay.test/aggpos/order.fuiou')
    assert.deepEqual(requestMessage, {
      mchnt_cd: 'merchant-1', order_date: '20260907', order_id: 'ORDER-1', order_amt: '730',
      order_pay_type: 'ALIPAY', back_notify_url: 'https://api.test/api/v1/recharge/callback',
      goods_name: 'TUC1USD', goods_detail: '充值1美元 (¥7.30)', appid: '', openid: '', ver: '1.0.0',
    })
    assert.deepEqual(result, { qrCodeUrl: 'https://qr.test/code', orderInfo: 'https://qr.test/code' })
  })

  test('查询成功订单产生稳定回调事件，退款状态 5 才成功', async () => {
    const encryptedRequests: Array<Record<string, unknown>> = []
    const responses = [
      { order_id: 'ORDER-1', order_st: '1', order_amt: '730', order_date: '20260907' },
      { refund_st: '5', refund_fas_ssn: 'FUIOU-RF-1' },
    ]
    const adapter = new FuiouAdapter({
      merchantCode: 'merchant-1', callbackUrl: 'https://api.test/callback',
      baseUrl: 'https://pay.test', refundUrl: 'https://refund.test',
      decrypt: () => Buffer.from(JSON.stringify(responses.shift())),
      decode: value => value.toString('utf8'), encode: value => Buffer.from(value),
      encrypt: value => { encryptedRequests.push(JSON.parse(value.toString('utf8'))); return Buffer.from('encrypted') },
      fetch: async () => Response.json({ resp_code: '0000', message: 'YQ==' }),
    })
    const order = {
      id: 'order-id', legacyId: 7, orderNo: 'ORDER-1', userId: 'u1', orgId: 'org1', userPhone: null,
      amountUsdMicros: 1_000_000, amountCents: 730, exchangeRateMicros: 7_300_000,
      quotaUnits: 500_000, pointsUnits: 1_000, bonusUnits: 0, paymentMethod: 'ALIPAY' as const,
      orderDate: '20260907', providerOrderInfo: null, status: 'PAYING' as const,
      idempotencyKey: 'order-1', createdAt: 1, updatedAt: 1, expiredAt: 2, remark: null,
    }
    const query = await adapter.queryPayment(order)
    assert.equal(query.status, 'SUCCESS')
    assert.equal(query.event?.providerEventId.startsWith('fuiou:query:'), true)

    const refund = await adapter.refund({
      refundNo: 'RF-1', refundDate: '20260907', payOrderDate: '20260907',
      payOrderNo: 'ORDER-1', amountCents: 730,
    })
    assert.deepEqual(refund, {
      success: true, providerRefundNo: 'FUIOU-RF-1', raw: { refund_st: '5', refund_fas_ssn: 'FUIOU-RF-1' },
    })
    assert.equal(encryptedRequests[0]?.ver, '1.0.1')
    assert.equal(encryptedRequests[1]?.refund_order_id, 'RF-1')
  })
})
