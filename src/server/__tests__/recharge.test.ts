import { describe, expect, it } from 'bun:test'
import type { FuiouClient } from '../credits/fuiou.js'
import {
  ORDER_STATUS,
  cancelRechargeOrder,
  createRechargeOrder,
  handleRechargeCallback,
  retryRechargeOrderSync,
  payRechargeOrder,
  queryRechargeOrder,
  rechargePackagesWithCny,
  syncRechargeOrderStatus,
  type RechargeOrder,
  type RechargeOrderStore,
  type RefundRecord,
} from '../credits/recharge.js'
import { SudorouterError, type SudorouterClient } from '../credits/sudorouter.js'

const POLICY = {
  minAmountUsd: 1,
  maxAmountUsd: 10000,
  usdToCnyRate: 7.3,
  orderExpireMinutes: 30,
}

function makeStore(): RechargeOrderStore & { rows: RechargeOrder[]; refunds: RefundRecord[] } {
  const rows: RechargeOrder[] = []
  const refunds: RefundRecord[] = []
  let nextId = 1
  return {
    rows,
    refunds,
    create(input) {
      const now = Date.now()
      const order: RechargeOrder = {
        ...input,
        id: nextId++,
        createdAt: now,
        updatedAt: now,
        fuiouOrderInfo: null,
        status: ORDER_STATUS.PENDING,
        syncStatus: 'NONE',
        syncError: null,
        callbackData: null,
        callbackTime: null,
        callbackAmountCents: null,
        remark: null,
      }
      rows.push(order)
      return order
    },
    getByOrderNo: orderNo => rows.find(order => order.orderNo === orderNo) ?? null,
    getById: id => rows.find(order => order.id === id) ?? null,
    listForUser(userId, page, pageSize) {
      const mine = rows.filter(order => order.userId === userId)
      return { list: mine.slice((page - 1) * pageSize, page * pageSize), total: mine.length }
    },
    listForAdmin(input) {
      let list = rows.slice()
      if (input.orgId) list = list.filter(order => order.orgId === input.orgId)
      if (input.status !== undefined) list = list.filter(order => order.status === input.status)
      if (input.syncStatus) list = list.filter(order => order.syncStatus === input.syncStatus)
      return { list: list.slice((input.page - 1) * input.pageSize, input.page * input.pageSize), total: list.length }
    },
    update(id, patch) {
      const order = rows.find(item => item.id === id)
      if (order) Object.assign(order, patch, { updatedAt: Date.now() })
    },
    createRefund(input) {
      const row: RefundRecord = { ...input, id: refunds.length + 1, createdAt: Date.now() }
      refunds.push(row)
      return row
    },
    listRefundsForAdmin(input) {
      let list = refunds.slice()
      if (input.orgId) list = list.filter(refund => refund.orgId === input.orgId)
      if (input.orderNo) list = list.filter(refund => refund.orderNo.includes(input.orderNo!))
      return { list: list.slice((input.page - 1) * input.pageSize, input.page * input.pageSize), total: list.length }
    },
  }
}

function fuiou(overrides: Partial<FuiouClient> = {}): FuiouClient {
  return {
    isConfigured: () => true,
    isTestMode: () => false,
    getMerchantCode: () => 'mch',
    createOrder: async () => ({
      success: true,
      data: {
        order_date: '20260911',
        order_pay_type: 'ALIPAY',
        order_amt: '730',
        mchnt_cd: 'mch',
        order_id: 'o1',
        order_info: 'qr-url',
      },
      request: { method: 'POST', url: 'https://fuiou.example', body: {} },
      response: { status: 200, data: {} },
      duration_ms: 1,
    }),
    queryOrder: async () => ({
      success: true,
      data: null,
      request: { method: 'POST', url: 'https://fuiou.example', body: {} },
      response: { status: 200, data: {} },
      duration_ms: 1,
    }),
    refundOrder: async () => ({
      success: true,
      data: null,
      request: { method: 'POST', url: 'https://fuiou.example', body: {} },
      response: { status: 200, data: {} },
      duration_ms: 1,
    }),
    handleCallback: async payload => ({
      order_id: payload.message,
      order_st: '1',
      order_amt: '730',
      order_date: '20260911',
    }),
    ...overrides,
  }
}

function gateway(addPoints: SudorouterClient['addPoints']): SudorouterClient {
  return {
    getCredits: async () => ({ remainingPoints: 0, usedPoints: 0 }),
    getModelUsage: async () => [],
    provisionAccount: async () => ({ gatewayUserId: '42', gatewayKey: 'sk', created: true }),
    addPoints,
  }
}

describe('recharge packages and orders', () => {
  it('returns legacy packages with CNY amounts', () => {
    expect(rechargePackagesWithCny(7.3)[1]).toEqual({
      amount: 5,
      points: 5000,
      bonus: 500,
      description: '充5送500积分',
      amount_cny: 36.5,
      exchange_rate: 7.3,
    })
  })

  it('creates an order using points plus package bonus', () => {
    const store = makeStore()
    const order = createRechargeOrder(store, POLICY, {
      userId: 'user-1',
      userPhone: '13800138000',
      orgId: 'org-1',
      amount: 5,
      paymentMethod: 'ALIPAY',
    })
    expect(order.amountCents).toBe(3650)
    expect(order.pointsAmount).toBe(5500)
    expect(order.quotaAmount).toBe(2_750_000)
    expect(queryRechargeOrder(store, 'user-1', order.orderNo)).toMatchObject({
      order_no: order.orderNo,
      status: ORDER_STATUS.PENDING,
    })
  })

  it('moves an order to paying after Fuiou returns a QR code', async () => {
    const store = makeStore()
    const order = createRechargeOrder(store, POLICY, {
      userId: 'user-1',
      orgId: 'org-1',
      amount: 1,
      paymentMethod: 'ALIPAY',
    })
    const result = await payRechargeOrder(store, fuiou(), 'user-1', order.orderNo)
    expect(result.qr_code_url).toBe('qr-url')
    expect(store.getByOrderNo(order.orderNo)?.status).toBe(ORDER_STATUS.PAYING)
  })

  it('cancels only open orders', () => {
    const store = makeStore()
    const order = createRechargeOrder(store, POLICY, {
      userId: 'user-1',
      orgId: 'org-1',
      amount: 1,
      paymentMethod: 'WECHAT',
    })
    cancelRechargeOrder(store, 'user-1', order.orderNo)
    expect(store.getByOrderNo(order.orderNo)?.status).toBe(ORDER_STATUS.CANCELLED)
  })
})

describe('recharge callback settlement', () => {
  it('credits SudoRouter once and marks success', async () => {
    const store = makeStore()
    const order = createRechargeOrder(store, POLICY, {
      userId: 'user-1',
      orgId: 'org-1',
      amount: 1,
      paymentMethod: 'ALIPAY',
    })
    let credited = 0
    await handleRechargeCallback(
      store,
      fuiou(),
      gateway(async (_id, points) => { credited += points }),
      { mchnt_cd: 'mch', message: order.orderNo, resp_code: '0000', resp_desc: 'ok' },
      () => '42',
    )
    expect(credited).toBe(1000)
    expect(store.getByOrderNo(order.orderNo)).toMatchObject({
      status: ORDER_STATUS.SUCCESS,
      syncStatus: 'SYNCED',
    })

    await handleRechargeCallback(
      store,
      fuiou(),
      gateway(async (_id, points) => { credited += points }),
      { mchnt_cd: 'mch', message: order.orderNo, resp_code: '0000', resp_desc: 'ok' },
      () => '42',
    )
    expect(credited).toBe(1000)
  })

  it('records a safe retry state when SudoRouter refuses', async () => {
    const store = makeStore()
    const order = createRechargeOrder(store, POLICY, {
      userId: 'user-1',
      orgId: 'org-1',
      amount: 1,
      paymentMethod: 'ALIPAY',
    })
    await expect(handleRechargeCallback(
      store,
      fuiou(),
      gateway(async () => { throw new SudorouterError('quota limit', 400) }),
      { mchnt_cd: 'mch', message: order.orderNo, resp_code: '0000', resp_desc: 'ok' },
      () => '42',
    )).rejects.toThrow(/quota limit/)
    expect(store.getByOrderNo(order.orderNo)).toMatchObject({
      status: ORDER_STATUS.FAILED,
      syncStatus: 'SYNC_FAILED',
    })
  })

  it('records an unsafe retry state when the gateway answer is lost', async () => {
    const store = makeStore()
    const order = createRechargeOrder(store, POLICY, {
      userId: 'user-1',
      orgId: 'org-1',
      amount: 1,
      paymentMethod: 'ALIPAY',
    })
    let calls = 0
    await expect(handleRechargeCallback(
      store,
      fuiou(),
      gateway(async () => {
        calls += 1
        throw new SudorouterError('SudoRouter unreachable: timeout')
      }),
      { mchnt_cd: 'mch', message: order.orderNo, resp_code: '0000', resp_desc: 'ok' },
      () => '42',
    )).rejects.toThrow(/timeout/)
    expect(store.getByOrderNo(order.orderNo)).toMatchObject({
      status: ORDER_STATUS.FAILED,
      syncStatus: 'SYNC_UNKNOWN',
    })

    await handleRechargeCallback(
      store,
      fuiou(),
      gateway(async () => {
        calls += 1
      }),
      { mchnt_cd: 'mch', message: order.orderNo, resp_code: '0000', resp_desc: 'ok' },
      () => '42',
    )
    expect(calls).toBe(1)
  })
})

describe('manual recharge reconciliation', () => {
  it('retries a safe failed SudoRouter sync once', async () => {
    const store = makeStore()
    const order = createRechargeOrder(store, POLICY, {
      userId: 'user-1',
      orgId: 'org-1',
      amount: 1,
      paymentMethod: 'ALIPAY',
    })
    store.update(order.id, {
      status: ORDER_STATUS.FAILED,
      syncStatus: 'SYNC_FAILED',
      syncError: 'gateway refused',
    })
    let credited = 0
    await retryRechargeOrderSync(
      store,
      gateway(async (_id, points) => { credited += points }),
      { orderNo: order.orderNo, getGatewayUserId: () => '42' },
    )
    expect(credited).toBe(1000)
    expect(store.getByOrderNo(order.orderNo)).toMatchObject({
      status: ORDER_STATUS.SUCCESS,
      syncStatus: 'SYNCED',
    })
  })

  it('does not retry an unknown SudoRouter sync', async () => {
    const store = makeStore()
    const order = createRechargeOrder(store, POLICY, {
      userId: 'user-1',
      orgId: 'org-1',
      amount: 1,
      paymentMethod: 'ALIPAY',
    })
    store.update(order.id, {
      status: ORDER_STATUS.FAILED,
      syncStatus: 'SYNC_UNKNOWN',
      syncError: 'timeout',
    })
    let credited = 0
    await expect(retryRechargeOrderSync(
      store,
      gateway(async (_id, points) => { credited += points }),
      { orderNo: order.orderNo, getGatewayUserId: () => '42' },
    )).rejects.toThrow(/人工核对/)
    expect(credited).toBe(0)
  })

  it('syncs a paid Fuiou order and settles it through SudoRouter', async () => {
    const store = makeStore()
    const order = createRechargeOrder(store, POLICY, {
      userId: 'user-1',
      orgId: 'org-1',
      amount: 1,
      paymentMethod: 'ALIPAY',
    })
    store.update(order.id, { status: ORDER_STATUS.PAYING })
    let credited = 0
    await syncRechargeOrderStatus(
      store,
      fuiou({
        queryOrder: async () => ({
          success: true,
          data: {
            order_id: order.orderNo,
            order_st: '1',
            order_amt: '730',
            order_date: order.orderDate,
          },
          request: { method: 'POST', url: 'https://fuiou.example', body: {} },
          response: { status: 200, data: {} },
          duration_ms: 1,
        }),
      }),
      gateway(async (_id, points) => { credited += points }),
      { orderNo: order.orderNo, getGatewayUserId: () => '42' },
    )
    expect(credited).toBe(1000)
    expect(store.getByOrderNo(order.orderNo)?.syncStatus).toBe('SYNCED')
  })
})
