// Runs under Node (the store uses node:sqlite, which Bun lacks): `tsx --test`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createEnterpriseApi } from '../api/enterprise.js'
import { DirectConnectStore } from '../db.js'

describe('enterprise configuration isolation', () => {
  it('stores independent branding and client policy per organization', async () => {
    const store = new DirectConnectStore(':memory:')
    const api = createEnterpriseApi(store, '/tmp')

    const orgA = await api.updateConfig({
      app_name: 'Organization A',
      client_cron_enabled: false,
      client_show_tool_calls: false,
      workspace_upload_limit_bytes: 1024,
    }, 'org-a')
    const orgB = await api.updateConfig({
      app_name: 'Organization B',
      client_cron_enabled: true,
      client_show_tool_calls: true,
      workspace_upload_limit_bytes: 2048,
    }, 'org-b')

    assert.equal(orgA.success, true)
    assert.equal(orgB.success, true)
    assert.equal(orgA.data?.app_name, 'Organization A')
    assert.equal(orgB.data?.app_name, 'Organization B')
    assert.equal(orgA.data?.client_cron_enabled, false)
    assert.equal(orgB.data?.client_cron_enabled, true)
    assert.equal(orgA.data?.workspace_upload_limit_bytes, 1024)
    assert.equal(orgB.data?.workspace_upload_limit_bytes, 2048)
  })

  it('inherits the deployment default until an organization saves an override', async () => {
    const store = new DirectConnectStore(':memory:')
    const api = createEnterpriseApi(store, '/tmp')

    await api.updateConfig({ app_name: 'Deployment Default' })
    const inherited = await api.getConfig('org-without-overrides')

    assert.equal(inherited.success, true)
    assert.equal(inherited.data?.id, 'default')
    assert.equal(inherited.data?.app_name, 'Deployment Default')
  })

  it('rejects invalid organization upload limits', async () => {
    const store = new DirectConnectStore(':memory:')
    const api = createEnterpriseApi(store, '/tmp')

    const result = await api.updateConfig({ workspace_upload_limit_bytes: 0 }, 'org-a')

    assert.equal(result.success, false)
    assert.match(result.message ?? '', /must be an integer/)
  })
})
