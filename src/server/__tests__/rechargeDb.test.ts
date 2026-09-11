// Runs under Node (AuthCenterDb uses node:sqlite): `tsx --test`.
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { AuthCenterDb } from '../authCenter/db.js'
import { AuthService } from '../auth/service.js'
import {
  ORDER_STATUS,
  createRechargeOrder,
  handleRechargeCallback,
  type RechargeOrderStore,
} from '../credits/recharge.js'
import type { FuiouClient } from '../credits/fuiou.js'
import type { SudorouterClient } from '../credits/sudorouter.js'

let raw: DatabaseSync
let auth: AuthService
let userId: string

const POLICY = {
  minAmountUsd: 1,
  maxAmountUsd: 10000,
  usdToCnyRate: 7.3,
  orderExpireMinutes: 30,
}

const fuiou: FuiouClient = {
  isConfigured: () => true,
  isTestMode: () => false,
  getMerchantCode: () => 'mch',
  createOrder: async () => {
    throw new Error('not used')
  },
  queryOrder: async () => {
    throw new Error('not used')
  },
  refundOrder: async () => {
    throw new Error('not used')
  },
  handleCallback: async payload => ({
    order_id: payload.message,
    order_st: '1',
    order_amt: '730',
    order_date: '20260911',
  }),
}

const gateway: SudorouterClient = {
  getCredits: async () => ({ remainingPoints: 0, usedPoints: 0 }),
  getModelUsage: async () => [],
  provisionAccount: async () => ({ gatewayUserId: '42', gatewayKey: 'sk', created: true }),
  addPoints: async () => {},
}

beforeEach(() => {
  raw = new DatabaseSync(':memory:')
  const db = new AuthCenterDb(raw, ':memory:')
  auth = new AuthService(db, 3600)
  const result = auth.provisionPhoneUser({
    phone: '13800138000',
    nickname: 'Tester',
    autoCreateOrg: true,
  })
  userId = result.user.id
})

afterEach(() => {
  auth.destroy()
  raw.close()
})

describe('recharge orders on the real table', () => {
  it('stores, lists, and settles an order', async () => {
    const store: RechargeOrderStore = auth.rechargeOrders
    const order = createRechargeOrder(store, POLICY, {
      userId,
      userPhone: '13800138000',
      orgId: 'org-1',
      amount: 1,
      paymentMethod: 'ALIPAY',
    })

    const listed = store.listForUser(userId, 1, 20)
    assert.equal(listed.total, 1)
    assert.equal(listed.list[0]?.orderNo, order.orderNo)
    assert.equal(listed.list[0]?.status, ORDER_STATUS.PENDING)

    await handleRechargeCallback(
      store,
      fuiou,
      gateway,
      { mchnt_cd: 'mch', message: order.orderNo, resp_code: '0000', resp_desc: 'ok' },
      () => '42',
    )

    const settled = store.getByOrderNo(order.orderNo)
    assert.equal(settled?.status, ORDER_STATUS.SUCCESS)
    assert.equal(settled?.syncStatus, 'SYNCED')
    assert.equal(settled?.callbackAmountCents, 730)
  })

  it('scopes admin order listing by org', () => {
    const store: RechargeOrderStore = auth.rechargeOrders
    createRechargeOrder(store, POLICY, {
      userId,
      userPhone: '13800138000',
      orgId: 'org-1',
      amount: 1,
      paymentMethod: 'WECHAT',
    })
    createRechargeOrder(store, POLICY, {
      userId,
      userPhone: '13800138000',
      orgId: 'org-2',
      amount: 5,
      paymentMethod: 'ALIPAY',
    })

    assert.equal(store.listForAdmin({ orgId: 'org-1', page: 1, pageSize: 20 }).total, 1)
    assert.equal(store.listForAdmin({ orgId: 'org-2', page: 1, pageSize: 20 }).total, 1)
    assert.equal(store.listForAdmin({ page: 1, pageSize: 20 }).total, 2)
  })
})
