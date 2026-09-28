import { describe, expect, it } from 'bun:test'
import { createConfigItemsApi } from '../api/configItems.js'

/**
 * Where a login-type 凭据 injects its minted token (scheme + token_param) is
 * validated and persisted by the config-items API. These pin the rules the
 * auth proxy relies on: header/query need a sane name, basic is not a token
 * placement, and token_param is cleared when it no longer applies.
 */

type Row = Record<string, unknown>

function makeApi() {
  const rows = new Map<number, Row>()
  let nextId = 1
  const api = createConfigItemsApi({
    listConfigItems: () => ({ items: [...rows.values()], total: rows.size }),
    getConfigItem: id => rows.get(id) ?? null,
    getConfigItemByPinyin: pinyin => [...rows.values()].find(r => r.pinyin === pinyin) ?? null,
    createConfigItem: row => {
      const id = nextId++
      rows.set(id, { id, status: 1, ...row })
      return id
    },
    updateConfigItem: (id, updates) => {
      const existing = rows.get(id)!
      const next = { ...existing }
      for (const [k, v] of Object.entries(updates)) if (v !== undefined) next[k] = v
      rows.set(id, next)
    },
    deleteConfigItem: id => { rows.delete(id) },
    getConfigEntries: () => [],
    replaceConfigEntries: () => {},
    getAllActiveConfigItems: () => [...rows.values()],
    getDepartmentPolicies: () => [],
  })
  return { api, rows }
}

const loginBody = {
  name: 'rbox',
  pinyin: 'rbox',
  scope: 'system',
  url_pattern: 'http://rbox.example.com/*',
  auth_type: 'script',
  entries: [
    { config_key: 'username', name: '用户名' },
    { config_key: 'password', name: '密码' },
  ],
}

describe('config items: login-type token placement', () => {
  it('stores a custom header placement', () => {
    const { api, rows } = makeApi()
    const res = api.create('org1', 'u1', { ...loginBody, scheme: 'header', token_param: ' Token ' })
    expect(res.success).toBe(true)
    expect(rows.get(1)).toMatchObject({ scheme: 'header', token_param: 'Token' })
  })

  it('rejects header/query without a valid name, and basic', () => {
    const { api } = makeApi()
    expect(api.create('org1', 'u1', { ...loginBody, scheme: 'header' }).success).toBe(false)
    expect(api.create('org1', 'u1', { ...loginBody, scheme: 'header', token_param: 'Bad Name' }).success).toBe(false)
    expect(api.create('org1', 'u1', { ...loginBody, scheme: 'header', token_param: 'Host' }).success).toBe(false)
    expect(api.create('org1', 'u1', { ...loginBody, scheme: 'query', token_param: 'a&b' }).success).toBe(false)
    expect(api.create('org1', 'u1', { ...loginBody, scheme: 'basic' }).success).toBe(false)
  })

  it('still accepts a login item with no placement (Bearer default)', () => {
    const { api, rows } = makeApi()
    expect(api.create('org1', 'u1', loginBody).success).toBe(true)
    expect(rows.get(1)?.token_param).toBeUndefined()
  })

  it('validates a partial update against the merged state', () => {
    const { api } = makeApi()
    api.create('org1', 'u1', loginBody)
    // Switching to header without supplying a name must fail.
    expect(api.update('org1', 'u1', 1, { scheme: 'header' }).success).toBe(false)
    expect(api.update('org1', 'u1', 1, { scheme: 'header', token_param: 'Token' }).success).toBe(true)
  })

  it('clears token_param when switching back to Bearer or to static', () => {
    const { api, rows } = makeApi()
    api.create('org1', 'u1', { ...loginBody, scheme: 'header', token_param: 'Token' })
    api.update('org1', 'u1', 1, { scheme: 'bearer' })
    expect(rows.get(1)?.token_param).toBeNull()

    api.update('org1', 'u1', 1, { scheme: 'header', token_param: 'Token' })
    api.update('org1', 'u1', 1, { auth_type: 'static', scheme: 'header' })
    expect(rows.get(1)?.token_param).toBeNull()
  })
})
