import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeCohostConnection, resolveCohostConnection } from './cohostConnection.js'
import type { SessionConnectionConfig } from './sessionConnection.js'

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
