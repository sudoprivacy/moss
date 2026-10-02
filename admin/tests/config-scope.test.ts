import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { authClient } from '../lib/api/client'
import { createOperationsApi } from '../lib/api/operations-core'
import { getSystemSettings, refreshModelCache, updateSystemSettings } from '../lib/api/settings'
import { buildSudoworkConfigPatch } from '../src/sudowork-settings'

const originalGet = authClient.get
const originalPatch = authClient.patch
const originalPost = authClient.post
afterEach(() => {
  authClient.get = originalGet
  authClient.patch = originalPatch
  authClient.post = originalPost
})

test('system settings and model cache requests default to organization and carry explicit platform scope', async () => {
  const calls: unknown[] = []
  authClient.get = (async path => { calls.push(['GET', path]); return {} }) as typeof authClient.get
  authClient.patch = (async (path, body) => { calls.push(['PATCH', path, body]); return {} }) as typeof authClient.patch
  authClient.post = (async path => { calls.push(['POST', path]); return {} }) as typeof authClient.post
  for (const scope of [undefined, 'organization', 'platform'] as const) {
    await getSystemSettings(scope)
    await updateSystemSettings({ model: 'next' }, scope)
    await refreshModelCache(scope)
  }
  assert.deepEqual(calls, ['organization', 'organization', 'platform'].flatMap(scope => [
    ['GET', `/api/v1/settings/system?scope=${scope}`],
    ['PATCH', `/api/v1/settings/system?scope=${scope}`, { model: 'next' }],
    ['POST', `/api/v1/models/refresh-cache?scope=${scope}`],
  ]))
})

test('Sudowork requests retain the scope query when mapped to native operations routes', async () => {
  const calls: unknown[] = []
  const api = createOperationsApi({
    get: async path => { calls.push(['GET', path]); return {} },
    put: async (path, body) => { calls.push(['PUT', path, body]); return {} },
    post: async () => { throw new Error('Unexpected POST') },
    delete: async () => { throw new Error('Unexpected DELETE') },
  })
  for (const scope of [undefined, 'organization', 'platform'] as const) {
    await api.getSudoworkSystemConfig(scope)
    await api.updateSudoworkSystemConfig({ login_method: 1 }, scope)
  }
  assert.deepEqual(calls, ['organization', 'organization', 'platform'].flatMap(scope => [
    ['GET', `/api/moss/v1/operations/system-config?scope=${scope}`],
    ['PUT', `/api/moss/v1/operations/system-config?scope=${scope}`, { login_method: 1 }],
  ]))
})

test('organization policies cannot submit infrastructure, log secrets, or response metadata', () => {
  const config = {
    scope_type: 'platform', organization_id: '', restart_required: true, sms_configured: true,
    login_method: 1, scode_auto_model: 'org-model',
    log_report: { enabled: 1, protocol: 'https', domain: 'logs.example.invalid', key: 'platform-key', key_set: true },
    sms: { provider: 'tencent' }, billing: { enabled: true },
  }
  const dirtyKeys = new Set(Object.keys(config))
  const expected = {
    login_method: 1, scode_auto_model: 'org-model',
    log_report: { enabled: 1, protocol: 'https', domain: 'logs.example.invalid' },
  }
  assert.deepEqual(buildSudoworkConfigPatch(config, dirtyKeys), expected)
  assert.deepEqual(buildSudoworkConfigPatch(config, dirtyKeys, 'organization'), expected)
  assert.deepEqual(buildSudoworkConfigPatch(config, dirtyKeys, 'platform'), {
    ...expected, log_report: { ...expected.log_report, key: 'platform-key' },
    sms: config.sms, billing: config.billing,
  })
  assert.deepEqual(buildSudoworkConfigPatch(config, new Set(['scode_auto_model'])), { scode_auto_model: 'org-model' })
  assert.equal(config.log_report.key, 'platform-key')
})

test('explicitly choosing the inherited login method persists it; follow-default removes the choice', () => {
  assert.deepEqual(buildSudoworkConfigPatch({ login_method: 1, inherit_login_method: false }, new Set(['inherit_login_method']), 'organization'), { login_method: 1, inherit_login_method: false })
  assert.deepEqual(buildSudoworkConfigPatch({ login_method: 1, inherit_login_method: true }, new Set(['login_method', 'inherit_login_method']), 'organization'), { inherit_login_method: true })
})
