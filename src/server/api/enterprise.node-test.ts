import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createEnterpriseApi } from './enterprise.js'

describe('企业配置 Organization 自动化策略', () => {
  it('按认证 Organization 读取和修改 Cron 开关', async () => {
    const policy = new Map([['org-a', false], ['org-b', true]])
    const db = {
      getEnterprise: () => ({ id: 'default', logo: null }),
      updateEnterprise: () => {},
    }
    const api = createEnterpriseApi(db as never, '/tmp', {
      getClientCronEnabled: orgId => policy.get(orgId) ?? true,
      setClientCronEnabled: (orgId, enabled) => policy.set(orgId, enabled),
    })

    assert.equal((await api.getConfig('org-a')).data?.client_cron_enabled, false)
    assert.equal((await api.getConfig('org-b')).data?.client_cron_enabled, true)

    await api.updateConfig('org-b', { client_cron_enabled: false })

    assert.equal(policy.get('org-a'), false)
    assert.equal(policy.get('org-b'), false)
  })
})
