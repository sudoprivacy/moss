import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  OPERATION_ROUTES,
  canSeeOperationsNavigation,
} from './operations-navigation.js'

describe('Moss Admin 运营中心导航', () => {
  test('四个运营页面均有稳定路由', () => {
    assert.deepEqual(OPERATION_ROUTES, {
      invitations: '/operations/invitations',
      billing: '/operations/billing',
      audit: '/operations/audit',
      quality: '/operations/quality',
    })
  })

  test('只向具有管理设置权限的角色展示运营入口', () => {
    assert.equal(canSeeOperationsNavigation(['*']), true)
    assert.equal(canSeeOperationsNavigation(['admin:settings']), true)
    assert.equal(canSeeOperationsNavigation(['admin:*']), true)
    assert.equal(canSeeOperationsNavigation(['sessions:list', 'cron:self']), false)
  })
})
