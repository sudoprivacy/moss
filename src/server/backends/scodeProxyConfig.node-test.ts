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
    assert.equal(backend.backend_params.openai_base_url, 'https://router.example/v1')
    assert.equal(backend.backend_params.api_key, direct.auth_modes.proxy['moss-proxy'].apiKey)
    assert.ok(!native['sudocode.json']!.includes(apiKey), 'only the private bootstrap secret carries the key')
  }
})

void test('the shared engine chooses the wire protocol for initial and switched models', () => {
  for (const model of ['claude-haiku-4-5', 'gpt-4o-mini', 'gpt-5-codex']) {
    const configuration = buildCohostProxyConfig('https://router.example/v1/', 'owner-key', model)
    const engine = JSON.parse(configuration['sudocode.json']!)
    assert.deepEqual(engine.models[model].providers.proxy, { model })
    assert.equal(engine.auth_modes.proxy['moss-proxy'].baseUrl, 'nexus:///model')
    assert.ok(!configuration['sudocode.json']!.includes('owner-key'))
    const backend = JSON.parse(configuration['backend-config.json']!).mounts[0]
    assert.equal(new URL(backend.backend_params.base_url).origin,
      new URL(backend.backend_params.openai_base_url).origin)
  }
})
