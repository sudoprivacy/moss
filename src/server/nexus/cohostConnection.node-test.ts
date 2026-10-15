import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeCohostConnection, resolveCohostConnection } from './cohostConnection.js'
import type { SessionConnectionConfig } from './sessionConnection.js'
import { resolveCohostNexusConfig, resolveNexusConfigFromEnv } from './nexusEnvConfig.js'

void test('runner connection retains the owner endpoint and separate credential issuer', () => {
  const config: SessionConnectionConfig = {
    endpoint: 'https://control-plane:8443', tls: { ca: '/ca', cert: '/controller', key: '/key' }, authToken: '',
    runtimeEndpoint: 'https://127.0.0.1:40000',
  }
  const encoded = encodeCohostConnection(config)
  const decoded = resolveCohostConnection({ MOSS_COHOST_CONNECTION: encoded,
    MOSS_COHOST_NEXUS_ENDPOINT: 'https://other-endpoint' })
  assert.deepEqual(decoded, config)
  assert.throws(() => resolveCohostConnection({ MOSS_COHOST_CONNECTION: '{}',
    MOSS_NEXUS_MODE: 'external', MOSS_NEXUS_ENDPOINT: 'http://fallback' }), /endpoint/)
})

void test('a separate execution issuer does not inherit the embedded secret store zone binding', () => {
  const environment = { MOSS_NEXUS_MODE: 'embedded', MOSS_NEXUS_ZONE_ID: 'existing-secrets-zone',
    MOSS_COHOST_NEXUS_MODE: 'external', MOSS_COHOST_NEXUS_ENDPOINT: 'https://execution-issuer:8443',
    MOSS_COHOST_NEXUS_TLS_CA: '/runtime-ca', MOSS_COHOST_NEXUS_TLS_CERT: '/runtime-controller',
    MOSS_COHOST_NEXUS_TLS_KEY: '/runtime-key' }
  assert.equal(resolveNexusConfigFromEnv(environment).zoneId, 'existing-secrets-zone')
  const execution = resolveCohostNexusConfig(environment)
  assert.equal(execution.endpoint, environment.MOSS_COHOST_NEXUS_ENDPOINT)
  assert.equal(execution.zoneId, undefined)
  assert.equal(execution.tls?.cert, '/runtime-controller')
  assert.equal(environment.MOSS_NEXUS_ZONE_ID, 'existing-secrets-zone')
})
