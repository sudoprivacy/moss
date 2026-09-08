import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { QmsRuntimeConfig } from './config.js'
import { QmsNexusSecretAdapter } from './qmsSecretAdapter.js'

function config(): QmsRuntimeConfig {
  return {
    enabled: true,
    apiKeyHeader: 'X-API-Key',
    queue: { flushIntervalMs: 3_000, batchSize: 50, visibilityTimeoutMs: 60_000 },
    retention: { perfDays: 90, conversationDays: 180, crashDays: 90, aggregateDays: 365 },
    encryptionRequired: false,
    secrets: {
      larkWebhookUrl: 'https://open.feishu.cn/old',
      smtpUrl: 'smtps://old-user:old-pass@mail.example:465?from=old%40example.com&to=ops%40example.com',
    },
  }
}

describe('QmsNexusSecretAdapter', () => {
  it('projects one SMTP URL into the frozen legacy notification fields', () => {
    const adapter = new QmsNexusSecretAdapter(config(), { get: () => undefined, put: async () => undefined })

    assert.equal(adapter.get('notification_lark_webhook'), 'https://open.feishu.cn/old')
    assert.equal(adapter.get('notification_email_smtp_host'), 'mail.example')
    assert.equal(adapter.get('notification_email_smtp_port'), '465')
    assert.equal(adapter.get('notification_email_smtp_user'), 'old-user')
    assert.equal(adapter.get('notification_email_smtp_pass'), 'old-pass')
    assert.equal(adapter.get('notification_email_from'), 'old@example.com')
    assert.equal(adapter.get('notification_email_to'), 'ops@example.com')
  })

  it('merges one legacy notification update into two Nexus secrets without plaintext SQL storage', async () => {
    const runtimeConfig = config()
    const writes: Array<[string, string]> = []
    const adapter = new QmsNexusSecretAdapter(runtimeConfig, {
      get: () => undefined,
      put: async (key, value) => { writes.push([key, value]) },
    })

    await adapter.updateNotifications({
      lark: { webhookUrl: 'https://open.feishu.cn/new' },
      email: {
        smtpHost: 'smtp.example.com', smtpPort: 587, smtpUser: 'sender', smtpPass: 'new pass',
        from: 'sender@example.com', to: 'alerts@example.com',
      },
    })

    assert.deepEqual(writes.map(([key]) => key), ['server.qms-lark-webhook-url', 'server.qms-smtp-url'])
    assert.equal(runtimeConfig.secrets.larkWebhookUrl, 'https://open.feishu.cn/new')
    const smtp = new URL(runtimeConfig.secrets.smtpUrl!)
    assert.equal(smtp.protocol, 'smtps:')
    assert.equal(decodeURIComponent(smtp.username), 'sender')
    assert.equal(decodeURIComponent(smtp.password), 'new pass')
    assert.equal(smtp.hostname, 'smtp.example.com')
    assert.equal(smtp.port, '587')
    assert.equal(smtp.searchParams.get('from'), 'sender@example.com')
    assert.equal(smtp.searchParams.get('to'), 'alerts@example.com')
  })
})
