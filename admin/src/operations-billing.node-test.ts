import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { billingOrderActions, creditApplicationActions, parseOptionalIntegerPoints } from './operations-billing.js'

describe('账务运营状态动作', () => {
  test('订单只显示状态允许的操作', () => {
    assert.deepEqual(billingOrderActions(1), ['detail', 'sync'])
    assert.deepEqual(billingOrderActions(2), ['detail', 'refund'])
    assert.deepEqual(billingOrderActions(3), ['detail', 'retry'])
    assert.deepEqual(billingOrderActions(4), ['detail'])
  })

  test('授信只在待审批时处理，同步失败只允许重试', () => {
    assert.deepEqual(creditApplicationActions('PENDING'), ['detail', 'approve', 'reject'])
    assert.deepEqual(creditApplicationActions('SYNC_FAILED'), ['detail', 'retry_sync'])
    assert.deepEqual(creditApplicationActions('APPROVED'), ['detail'])
  })

  test('可选批准积分为空时省略，填写时必须是正整数', () => {
    assert.equal(parseOptionalIntegerPoints(''), undefined)
    assert.equal(parseOptionalIntegerPoints('100'), 100)
    assert.throws(() => parseOptionalIntegerPoints('1.5'), /正整数/)
  })
})
