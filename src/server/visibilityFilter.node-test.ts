import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isVisibleTo } from './visibilityFilter.js'

describe('统一资源可见性角色规则', () => {
  test('allows a matching role and rejects a different role', () => {
    const rule = { role_ids: ['dept_admin'] }
    assert.equal(isVisibleTo(rule, {
      isAdmin: false, userId: 'u1', role: 'dept_admin', departmentId: null, visibleDepartmentIds: new Set(),
    }), true)
    assert.equal(isVisibleTo(rule, {
      isAdmin: false, userId: 'u1', role: 'user', departmentId: null, visibleDepartmentIds: new Set(),
    }), false)
  })

  test('keeps user, department, all-user and administrator behavior unchanged', () => {
    assert.equal(isVisibleTo(null, {
      isAdmin: false, userId: 'u1', role: 'user', departmentId: null, visibleDepartmentIds: new Set(),
    }), true)
    assert.equal(isVisibleTo({ user_ids: [] }, {
      isAdmin: true, userId: 'admin', role: 'admin', departmentId: null, visibleDepartmentIds: null,
    }), true)
  })
})
