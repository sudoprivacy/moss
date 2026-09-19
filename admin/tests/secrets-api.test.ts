import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { dcClient } from '../lib/api/client'
import {
  createConfigItem,
  deleteConfigItem,
  disableSecret,
  enableSecret,
  getAuditLog,
  getConfigItems,
  getEnterpriseSecrets,
  getRotationAlerts,
  getSecretMetadata,
  putSecret,
  updateConfigItem,
  updateConfigItemStatus,
  updateSecretMetadata,
  uploadConfigItemIcon,
} from '../lib/api/secrets'

const originalGet = dcClient.get
const originalPost = dcClient.post
const originalPut = dcClient.put
const originalDelete = dcClient.delete
const originalFetch = globalThis.fetch
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

const failure = (message: string) => ({
  success: false,
  error: { code: 'test_failure', message },
})

function mockGet(response: unknown, calls: string[]): void {
  dcClient.get = (async (path: string) => {
    calls.push(path)
    return response
  }) as typeof dcClient.get
}

function installTestStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      clear() {},
      getItem() { return null },
      key() { return null },
      removeItem() {},
      setItem() {},
      get length() { return 0 },
    } satisfies Storage,
  })
}

afterEach(() => {
  dcClient.get = originalGet
  dcClient.post = originalPost
  dcClient.put = originalPut
  dcClient.delete = originalDelete
  globalThis.fetch = originalFetch
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage)
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

describe('credential API semantic failures', () => {
  test('does not normalize failed credential list responses', async () => {
    const calls: string[] = []
    mockGet(failure('credential list rejected'), calls)

    await assert.rejects(getConfigItems({ page: 2, page_size: 50, scope: 'system', status: '1' }), /credential list rejected/)
    await assert.rejects(getEnterpriseSecrets([]), /credential list rejected/)
    await assert.rejects(getSecretMetadata([]), /credential list rejected/)
    await assert.rejects(getAuditLog({ page: 2, action: 'enabled' }), /credential list rejected/)
    await assert.rejects(getRotationAlerts(), /credential list rejected/)

    assert.deepEqual(calls, [
      '/api/v1/config-items?page=2&page_size=50&scope=system&status=1',
      '/api/v1/secrets',
      '/api/v1/secret-metadata',
      '/api/v1/secrets-audit?page=2&action=enabled',
      '/api/v1/secret-rotation/alerts',
    ])
  })

  test('rejects failed supporting config-item lookups', async () => {
    const calls: string[] = []
    dcClient.get = (async (path: string) => {
      calls.push(path)
      return path === '/api/v1/secrets' || path === '/api/v1/secret-metadata'
        ? { success: true, data: [] }
        : failure('config item lookup rejected')
    }) as typeof dcClient.get

    await assert.rejects(getEnterpriseSecrets(), /config item lookup rejected/)
    await assert.rejects(getSecretMetadata(), /config item lookup rejected/)

    assert.deepEqual(calls, [
      '/api/v1/secrets',
      '/api/v1/config/items',
      '/api/v1/secret-metadata',
      '/api/v1/config/items',
    ])
  })

  test('rejects failed config and credential mutations without changing their requests', async () => {
    const putCalls: Array<[string, unknown]> = []
    const postCalls: Array<[string, unknown]> = []
    const deleteCalls: string[] = []

    dcClient.put = (async (path: string, body?: unknown) => {
      putCalls.push([path, body])
      return failure('mutation rejected')
    }) as typeof dcClient.put
    dcClient.post = (async (path: string, body?: unknown) => {
      postCalls.push([path, body])
      return failure('mutation rejected')
    }) as typeof dcClient.post
    dcClient.delete = (async (path: string) => {
      deleteCalls.push(path)
      return failure('mutation rejected')
    }) as typeof dcClient.delete

    await assert.rejects(createConfigItem({ name: 'Test config', scope: 'system' }), /mutation rejected/)
    await assert.rejects(updateConfigItem(7, { description: 'Updated config' }), /mutation rejected/)
    await assert.rejects(updateConfigItemStatus(7, 0), /mutation rejected/)
    await assert.rejects(deleteConfigItem(7), /mutation rejected/)
    await assert.rejects(putSecret('system:demo', 'credential', 'test-value'), /mutation rejected/)
    await assert.rejects(enableSecret('system:demo', 'credential'), /mutation rejected/)
    await assert.rejects(disableSecret('system:demo', 'credential'), /mutation rejected/)
    await assert.rejects(updateSecretMetadata(7, null), /mutation rejected/)

    assert.deepEqual(postCalls, [
      ['/api/v1/config-items', { name: 'Test config', scope: 'system' }],
      ['/api/v1/secrets/system%3Ademo/credential/enable', undefined],
      ['/api/v1/secrets/system%3Ademo/credential/disable', undefined],
    ])
    assert.deepEqual(putCalls, [
      ['/api/v1/config-items/7', { description: 'Updated config' }],
      ['/api/v1/config-items/7/status', { status: 0 }],
      ['/api/v1/secrets/system%3Ademo/credential', { value: 'test-value' }],
      ['/api/v1/secret-metadata/7', { expires_at: null }],
    ])
    assert.deepEqual(deleteCalls, ['/api/v1/config-items/7'])
  })

  test('preserves successful paginated config and audit responses and their query params', async () => {
    const calls: string[] = []
    const configItems = [{ id: 7, name: 'Demo config' }]
    const auditItems = [{ id: 'audit-1', action: 'enabled' }]
    dcClient.get = (async (path: string) => {
      calls.push(path)
      if (path.startsWith('/api/v1/config-items')) {
        return { success: true, data: configItems, total: 31, page: 3, page_size: 25 }
      }
      return { success: true, data: auditItems, total: 12, page: 4, page_size: 10 }
    }) as typeof dcClient.get

    const configResult = await getConfigItems({ page: 3, page_size: 25, name: 'Demo', scope: 'system', status: '1' })
    const auditResult = await getAuditLog({
      page: 4,
      page_size: 10,
      actor_id: 'actor-1',
      config_item_id: 7,
      action: 'enabled',
      since: 100,
      until: 200,
    })

    assert.deepEqual(configResult, { items: configItems, total: 31, page: 3, page_size: 25 })
    assert.deepEqual(auditResult, { items: auditItems, total: 12, page: 4, page_size: 10 })
    assert.deepEqual(calls, [
      '/api/v1/config-items?page=3&page_size=25&name=Demo&scope=system&status=1',
      '/api/v1/secrets-audit?page=4&page_size=10&actor_id=actor-1&config_item_id=7&action=enabled&since=100&until=200',
    ])
  })

  test('maps preloaded enterprise secrets, retains expiry requests, and propagates transport failures', async () => {
    const configItem = {
      id: 7,
      name: 'Demo config',
      description: 'Test config',
      icon: null,
      icon_url: null,
      pinyin: 'demo',
      scope: 'system' as const,
      url_pattern: null,
      scheme: 'bearer' as const,
      bearer_prefix: null,
      auth_type: null,
      token_url: null,
      token_request_json: null,
      mint_script: null,
      body_auth_check: null,
      status: 1,
      entries: [],
      created_at: 1,
      updated_at: 1,
    }
    const getCalls: string[] = []
    const putCalls: Array<[string, unknown]> = []
    dcClient.get = (async (path: string) => {
      getCalls.push(path)
      return {
        success: true,
        data: [{
          namespace: 'org:acme:system:demo',
          key: 'credential',
          value: 'dummy-legacy-value-must-be-discarded',
          enabled: true,
          version: 2,
        }],
      }
    }) as typeof dcClient.get
    dcClient.put = (async (path: string, body?: unknown) => {
      putCalls.push([path, body])
      return { success: true }
    }) as typeof dcClient.put

    const secrets = await getEnterpriseSecrets([configItem])
    await updateSecretMetadata(7, 1_700_000_000_000)
    await updateSecretMetadata(7, null)

    assert.deepEqual(secrets, [{
      namespace: 'org:acme:system:demo',
      key: 'credential',
      status: 'enabled',
      version: 2,
      config_item: configItem,
    }])
    assert.deepEqual(getCalls, ['/api/v1/secrets'])
    assert.deepEqual(putCalls, [
      ['/api/v1/secret-metadata/7', { expires_at: 1_700_000_000_000 }],
      ['/api/v1/secret-metadata/7', { expires_at: null }],
    ])

    dcClient.get = (async () => {
      throw new Error('transport rejected')
    }) as typeof dcClient.get
    await assert.rejects(getConfigItems(), /transport rejected/)
  })

  test('rejects a successful HTTP icon upload response with success false', async () => {
    installTestStorage()
    globalThis.fetch = (async () => new Response(JSON.stringify(failure('icon upload rejected')), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    await assert.rejects(
      uploadConfigItemIcon(new File(['test icon'], 'icon.svg', { type: 'image/svg+xml' })),
      /icon upload rejected/,
    )
  })
})
