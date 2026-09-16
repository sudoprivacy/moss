import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { migrationCommandContext, onlineCommandContext } from '../application/commandContext.js'
import { QmsSystemService } from './qmsSystemService.js'
import type { QmsSqlPort } from './qmsSchema.js'
import type { QmsTransactionalSqlPort } from './telemetryPostgresWriter.js'

class SystemSql implements QmsTransactionalSqlPort {
  statements: Array<{ sql: string; parameters: readonly unknown[] }> = []
  rows: readonly Record<string, unknown>[] = []
  async execute(sql: string, parameters: readonly unknown[] = []) {
    this.statements.push({ sql, parameters })
    return this.rows
  }
  async transaction<T>(operation: (client: QmsSqlPort) => Promise<T>) { return operation(this) }
}

function setup(db = new SystemSql()) {
  const secrets = new Map<string, string>([
    ['notification_lark_webhook', 'https://secret.example'],
    ['notification_email_smtp_pass', 'smtp-secret'],
  ])
  const taskCalls: string[] = []
  const service = new QmsSystemService({
    db,
    schema: {
      initialize: async () => ({ timescaleAvailable: true }),
      isTimescaleAvailable: () => true,
      switchToContinuousAggregates: async () => undefined,
      aggregationInfo: async () => ({ mode: 'continuous', usingContinuousAggregates: true }),
    },
    scheduler: {
      status: () => [{ name: 'aggregation', lastRun: null, nextRun: 10, running: false, lastError: null }],
      runTask: async name => { taskCalls.push(name); return true },
    },
    secrets: {
      get: key => secrets.get(key),
      put: async (key, value) => { secrets.set(key, value) },
    },
    notifications: { send: async () => ({ success: true }) },
    databaseHealthy: async () => true,
    environment: { NODE_ENV: 'test', PORT: 3100, HOST: '127.0.0.1', LOG_LEVEL: 'warn' },
    version: '1.0.0',
  })
  return { service, secrets, taskCalls }
}

describe('QmsSystemService', () => {
  it('reports health and keeps the legacy system envelope payload', async () => {
    const { service } = setup()
    const result = await service.health()
    assert.equal(result.status, 200)
    assert.equal(result.body.status, 'healthy')
    assert.equal(result.body.checks.database, true)
  })

  it('masks leaked secret rows and never returns notification credentials', async () => {
    const db = new SystemSql()
    db.rows = [
      { key: 'retention_days', value: '30' },
      { key: 'notification_email_smtp_pass', value: 'legacy-plain-secret' },
    ]
    const { service } = setup(db)

    const configs = await service.listConfig()
    const notifications = await service.notificationConfig()

    assert.equal(configs[1]?.value, '******')
    assert.equal(notifications.lark.webhookUrl, '******')
    assert.equal(notifications.email.smtpPass, '******')
  })

  it('writes notification secrets only through the secret port and audits without plaintext', async () => {
    const db = new SystemSql()
    const { service, secrets } = setup(db)

    await service.updateNotifications({
      userId: 'u1', input: { lark: { webhookUrl: 'https://new.example' }, email: { smtpPass: 'new-pass' } },
    })

    assert.equal(secrets.get('notification_lark_webhook'), 'https://new.example')
    assert.equal(secrets.get('notification_email_smtp_pass'), 'new-pass')
    assert.equal(db.statements.some(item => item.parameters.includes('new-pass')), false)
    assert.equal(db.statements.filter(item => item.sql.includes('INSERT INTO audit_logs')).length, 2)
  })

  it('manual aggregation delegates only to leased scheduler tasks', async () => {
    const { service, taskCalls } = setup()
    const result = await service.runAggregation()
    assert.deepEqual(taskCalls, ['aggregation', 'crash-aggregation'])
    assert.equal(result.results.every(item => item.success), true)
  })

  it('suppresses notification tests in migration context', async () => {
    const { service } = setup()
    const result = await service.testNotification('lark', migrationCommandContext('m1', 'system-test'))
    assert.deepEqual(result, { success: true, suppressed: true })
    await assert.rejects(() => service.testNotification('sms', onlineCommandContext('bad')), /INVALID_CHANNEL/)
  })

  it('keeps the frozen legacy E008 definition verbatim', () => {
    const { service } = setup()
    const error = service.errorCodes().find(item => item.code === 'E008')
    assert.deepEqual(error, {
      code: 'E008', type: '渲染进程 crash', location: 'ConversationPage.tsx',
      upstream_component: 'client', trigger_scenario: '渲染进程 JavaScript 异常崩溃',
    })
  })
})
