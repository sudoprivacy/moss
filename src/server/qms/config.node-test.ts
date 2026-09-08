import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { QmsConfigurationError, resolveQmsConfig } from './config.js'

describe('QMS runtime configuration', () => {
  it('keeps external stores optional while QMS is disabled', () => {
    const config = resolveQmsConfig({ enabled: false }, {})

    assert.equal(config.enabled, false)
    assert.equal(config.queue.batchSize, 50)
    assert.equal(config.retention.perfDays, 90)
    assert.equal(config.retention.conversationDays, 180)
  })

  it('requires PostgreSQL, Redis and API key when QMS is enabled', () => {
    assert.throws(
      () => resolveQmsConfig({ enabled: true }, {}),
      (error: unknown) => error instanceof QmsConfigurationError
        && error.missing.sort().join(',') === 'QMS_API_KEY,QMS_POSTGRES_URL,QMS_REDIS_URL',
    )
  })

  it('rejects the legacy postgres/postgres default credential', () => {
    assert.throws(
      () => resolveQmsConfig({ enabled: true }, {
        QMS_POSTGRES_URL: 'postgres://postgres:postgres@localhost:5432/sudowork',
        QMS_REDIS_URL: 'redis://localhost:6379/0',
        QMS_API_KEY: 'a-production-key',
      }),
      /unsafe legacy PostgreSQL credentials/,
    )
  })

  it('requires both RSA keys when encrypted ingestion is mandatory', () => {
    assert.throws(
      () => resolveQmsConfig({ enabled: true, encryptionRequired: true }, {
        QMS_POSTGRES_URL: 'postgres://qms:strong@db.internal:5432/qms',
        QMS_REDIS_URL: 'redis://cache.internal:6379/3',
        QMS_API_KEY: 'a-production-key',
        QMS_TELEMETRY_PRIVATE_KEY: 'private-only',
      }),
      (error: unknown) => error instanceof QmsConfigurationError
        && error.missing.join(',') === 'QMS_TELEMETRY_PUBLIC_KEY',
    )
  })

  it('resolves non-secret policy with secrets supplied only by runtime providers', () => {
    const config = resolveQmsConfig({
      enabled: true,
      apiKeyHeader: 'X-Custom-Key',
      queueFlushIntervalMs: 1_500,
      queueBatchSize: 25,
      perfRetentionDays: 30,
      conversationRetentionDays: 60,
      encryptionRequired: true,
    }, {
      QMS_POSTGRES_URL: 'postgres://qms:strong@db.internal:5432/qms',
      QMS_REDIS_URL: 'redis://cache.internal:6379/3',
      QMS_API_KEY: 'a-production-key',
      QMS_TELEMETRY_PRIVATE_KEY: 'private-key',
      QMS_TELEMETRY_PUBLIC_KEY: 'public-key',
    })

    assert.equal(config.apiKeyHeader, 'X-Custom-Key')
    assert.equal(config.queue.flushIntervalMs, 1_500)
    assert.equal(config.queue.batchSize, 25)
    assert.equal(config.retention.perfDays, 30)
    assert.equal(config.retention.conversationDays, 60)
    assert.equal(config.secrets.apiKey, 'a-production-key')
    assert.equal(config.secrets.privateKeyPem, 'private-key')
  })
})
