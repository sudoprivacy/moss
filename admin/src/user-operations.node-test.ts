import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  accountStatusLabel,
  availableUserOperations,
  parsePositiveIntegerPoints,
} from './user-operations.js'

describe('Moss 用户运营动作', () => {
  test('完整映射统一账号四态', () => {
    assert.equal(accountStatusLabel('pending'), '待审批')
    assert.equal(accountStatusLabel('active'), '启用')
    assert.equal(accountStatusLabel('locked'), '锁定')
    assert.equal(accountStatusLabel('disabled'), '禁用')
  })

  test('待审批用户只能审批、拒绝或删除，后台充值仅超级管理员可用', () => {
    assert.deepEqual(availableUserOperations('pending', true), ['approve', 'reject', 'delete_pending'])
    assert.deepEqual(availableUserOperations('active', true), ['recharge', 'adjust', 'sync_quota', 'ledger'])
    assert.deepEqual(availableUserOperations('active', false), ['adjust', 'sync_quota', 'ledger'])
    assert.deepEqual(availableUserOperations('locked', true), ['ledger'])
  })

  test('财务积分严格使用正整数', () => {
    assert.equal(parsePositiveIntegerPoints('1000'), 1000)
    assert.throws(() => parsePositiveIntegerPoints('0'), /正整数/)
    assert.throws(() => parsePositiveIntegerPoints('1.5'), /正整数/)
    assert.throws(() => parsePositiveIntegerPoints('abc'), /正整数/)
  })
})
