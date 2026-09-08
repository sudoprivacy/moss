import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SUDOWORK_LOGIN_METHODS } from './sudowork-settings.js'

test('Sudowork 登录方式数值保持旧客户端契约', () => {
  assert.deepEqual(SUDOWORK_LOGIN_METHODS, [
    { value: '0', label: '手机验证码' },
    { value: '1', label: '用户名密码' },
    { value: '2', label: 'CAS 三方认证' },
  ])
})
