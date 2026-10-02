import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { QmsConfigurationError, resolveQmsConfig } from './config.js'

void describe('QMS runtime configuration', () => {
  void it('keeps QMS disabled without configuring additional services', () => {
    const config = resolveQmsConfig({ enabled: false }, {})

    assert.equal(config.enabled, false)
    assert.equal(config.queue.batchSize, 50)
    assert.equal(config.retention.perfDays, 90)
    assert.equal(config.retention.conversationDays, 180)
  })

  void it('requires the ingestion API key without separate database or queue credentials', () => {
    assert.throws(
      () => resolveQmsConfig({ enabled: true }, {}),
      (error: unknown) => error instanceof QmsConfigurationError
        && error.missing.sort().join(',') === 'QMS_API_KEY',
    )
  })

  void it('enables QMS with only shared Moss storage and ingestion credentials', () => {
    const config = resolveQmsConfig({ enabled: true }, { QMS_API_KEY: 'key' })
    assert.equal(config.queue.maxItems, 10000)
    assert.equal(config.queue.maxBytes, 16 * 1024 * 1024)
    assert.equal('postgresUrl' in config.secrets, false)
    assert.equal('redisUrl' in config.secrets, false)
  })

  void it('ignores retired encryption flags and keys without changing API key authentication', () => {
    const legacyInput = { enabled: true, encryptionRequired: true }
    const legacyEnvironment = {
      QMS_API_KEY: 'a-production-key',
      QMS_TELEMETRY_ENCRYPTION_REQUIRED: 'true',
      QMS_TELEMETRY_PRIVATE_KEY: 'unused-private',
      QMS_TELEMETRY_PUBLIC_KEY: 'unused-public',
    }
    const config = resolveQmsConfig(legacyInput, legacyEnvironment)
    assert.equal(config.enabled, true)
    assert.equal(config.secrets.apiKey, 'a-production-key')
    assert.equal('encryptionRequired' in config, false)
    assert.equal('privateKeyPem' in config.secrets, false)
    assert.equal('publicKeyPem' in config.secrets, false)
  })

  void it('resolves non-secret policy with secrets supplied only by runtime providers', () => {
    const config = resolveQmsConfig({
      enabled: true,
      apiKeyHeader: 'X-Custom-Key',
      queueFlushIntervalMs: 1_500,
      queueBatchSize: 25,
      perfRetentionDays: 30,
      conversationRetentionDays: 60,
    }, {
      QMS_API_KEY: 'a-production-key',
    })

    assert.equal(config.apiKeyHeader, 'X-Custom-Key')
    assert.equal(config.queue.flushIntervalMs, 1_500)
    assert.equal(config.queue.batchSize, 25)
    assert.equal(config.retention.perfDays, 30)
    assert.equal(config.retention.conversationDays, 60)
    assert.equal(config.secrets.apiKey, 'a-production-key')
  })
})

void it('honors legacy QMS environment switches and the legacy API key alias', () => {
  const config = resolveQmsConfig({ enabled: false }, {
    QMS_ENABLED: 'true', QMS_DEFAULT_API_KEY: 'legacy-key',
  })
  assert.equal(config.enabled, true)
  assert.equal(config.secrets.apiKey, 'legacy-key')
})
