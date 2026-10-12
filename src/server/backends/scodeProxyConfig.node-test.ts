import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCohostProxyConfig, buildScodeProxyConfig } from './scodeProxyConfig.js'

void test('native calls use a private model mount containing the same owner key as standalone calls', () => {
  for (const apiKey of ['owner-alice-key', 'owner-bob-key']) {
    const direct = JSON.parse(buildScodeProxyConfig('https://router.example/v1', apiKey)['sudocode.json']!)
    const native = buildCohostProxyConfig('https://router.example/v1/', apiKey, 'qa-model')
    const engine = JSON.parse(native['sudocode.json']!)
    const backend = JSON.parse(native['backend-config.json']!).mounts[0]
    assert.equal(engine.auth_modes.proxy['moss-proxy'].baseUrl, 'nexus:///model')
    assert.equal(engine.auth_modes.proxy['moss-proxy'].apiKey, '')
    assert.equal(backend.path, '/model')
    assert.equal(backend.backend_params.base_url, 'https://router.example')
    assert.equal(backend.backend_params.api_key, direct.auth_modes.proxy['moss-proxy'].apiKey)
    assert.ok(!native['sudocode.json']!.includes(apiKey), 'only the private bootstrap secret carries the key')
  }
})
