import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { migrationCommandContext, onlineCommandContext, replayCommandContext } from '../application/commandContext.js'
import { QmsAlertService, type QmsNotificationPort } from './alertService.js'
import type { QmsSqlPort } from './qmsSchema.js'
import type { QmsTransactionalSqlPort } from './telemetryPostgresWriter.js'

class AlertSql implements QmsTransactionalSqlPort {
  statements: Array<{ sql: string; parameters: readonly unknown[] }> = []
  async execute(sql: string, parameters: readonly unknown[] = []): Promise<readonly Record<string, unknown>[]> {
    this.statements.push({ sql, parameters })
    if (sql.includes('RETURNING *')) return [{ id: parameters[0], tenant_id: parameters[1] }]
    return []
  }
  async transaction<T>(operation: (client: QmsSqlPort) => Promise<T>): Promise<T> { return operation(this) }
}

class Notifications implements QmsNotificationPort {
  sent: Array<{ channel: string; payload?: Record<string, unknown> }> = []
  async send(channel: string, payload?: Record<string, unknown>) {
    this.sent.push({ channel, payload })
    return { success: true }
  }
}

describe('QmsAlertService', () => {
  it('creates tenant-scoped config and audit in one transaction', async () => {
    const db = new AlertSql()
    const service = new QmsAlertService({ db, notifications: new Notifications(), createId: () => 'alert-1' })

    await service.createConfig({ tenantId: 'tenant-a', userId: 'u1', input: {
      name: '高错误率', type: 'conversation', metric: 'error_rate', threshold: 10,
      comparison: 'gt', level: 'error', channels: ['lark'],
    } })

    assert.equal(db.statements.length, 2)
    assert.match(db.statements[0]!.sql, /INSERT INTO alert_config/)
    assert.equal(db.statements[0]!.parameters[1], 'tenant-a')
    assert.match(db.statements[1]!.sql, /INSERT INTO audit_logs/)
  })

  it('suppresses external notification for migration and replay contexts', async () => {
    const db = new AlertSql()
    const notifications = new Notifications()
    const service = new QmsAlertService({ db, notifications })

    await service.testNotification('lark', migrationCommandContext('m1', 'm1-alert'))
    await service.testNotification('email', replayCommandContext('e1', 'r1-alert'))
    await service.testNotification('lark', onlineCommandContext('o1-alert'))

    assert.deepEqual(notifications.sent.map(item => item.channel), ['lark'])
  })

  it('updates and deletes only a tenant-scoped config with an audit record', async () => {
    const db = new AlertSql()
    db.execute = async (sql, parameters = []) => {
      db.statements.push({ sql, parameters })
      if (sql.includes('UPDATE alert_config')) return [{ id: 'alert-1', tenant_id: 'tenant-a', channels: '["email"]' }]
      if (sql.includes('DELETE FROM alert_config')) return [{ id: 'alert-1', name: '错误率' }]
      return []
    }
    const service = new QmsAlertService({ db, notifications: new Notifications() })

    await service.updateConfig({
      id: 'alert-1', tenantId: 'tenant-a', userId: 'u1', input: { channels: ['email'], enabled: true },
    })
    await service.deleteConfig({ id: 'alert-1', tenantId: 'tenant-a', userId: 'u1' })

    const update = db.statements.find(item => item.sql.includes('UPDATE alert_config'))!
    const remove = db.statements.find(item => item.sql.includes('DELETE FROM alert_config'))!
    assert.match(update.sql, /tenant_id =/)
    assert.match(remove.sql, /tenant_id =/)
    assert.equal(db.statements.filter(item => item.sql.includes('INSERT INTO audit_logs')).length, 2)
  })

  it('rejects an empty config update before opening a transaction', async () => {
    const db = new AlertSql()
    const service = new QmsAlertService({ db, notifications: new Notifications() })

    await assert.rejects(
      () => service.updateConfig({ id: 'alert-1', tenantId: 'tenant-a', userId: 'u1', input: {} }),
      /No fields to update/,
    )
    assert.equal(db.statements.length, 0)
  })

  it('evaluates a tenant metric, sends configured channels, and records delivery', async () => {
    const db = new AlertSql()
    db.execute = async (sql, parameters = []) => {
      db.statements.push({ sql, parameters })
      if (sql.includes('FROM alert_config') && sql.includes('enabled = TRUE')) return [{
        id: 'alert-1', tenant_id: 'tenant-a', name: '错误率', type: 'conversation', metric: 'error_rate',
        threshold: 10, comparison: 'gt', level: 'critical', channels: '["lark","email"]',
        cooldown_minutes: 30, enabled: true,
      }]
      if (sql.includes('COUNT(*) FILTER')) return [{ matched: 2, total: 10 }]
      if (sql.includes('FROM alert_history')) return []
      if (sql.includes('INSERT INTO alert_history')) return [{ id: 1 }]
      return []
    }
    const notifications = new Notifications()
    const service = new QmsAlertService({ db, notifications })

    const result = await service.evaluateType({
      type: 'conversation', context: onlineCommandContext('alert-run-1'), now: new Date('2026-09-07T00:00:00Z'),
    })

    assert.deepEqual(result, { checked: 1, triggered: 1, suppressed: 0 })
    assert.deepEqual(notifications.sent.map(item => item.channel), ['lark', 'email'])
    const metric = db.statements.find(item => item.sql.includes('COUNT(*) FILTER'))!
    assert.match(metric.sql, /tenant_id =/)
    assert.ok(db.statements.some(item => item.sql.includes('INSERT INTO alert_history')))
  })

  it('honors cooldown and suppresses migration evaluation side effects', async () => {
    const db = new AlertSql()
    db.execute = async (sql, parameters = []) => {
      db.statements.push({ sql, parameters })
      if (sql.includes('FROM alert_config') && sql.includes('enabled = TRUE')) return [{
        id: 'alert-1', tenant_id: 'tenant-a', name: '崩溃数', type: 'crash', metric: 'crash_count',
        threshold: 0, comparison: 'gt', level: 'warning', channels: '["lark"]',
        cooldown_minutes: 30, enabled: true,
      }]
      if (sql.includes('COUNT(*) AS value')) return [{ value: 1 }]
      if (sql.includes('FROM alert_history')) return [{ sent_at: new Date('2026-09-07T00:00:00Z') }]
      return []
    }
    const notifications = new Notifications()
    const service = new QmsAlertService({ db, notifications })

    const cooldown = await service.evaluateType({
      type: 'crash', context: onlineCommandContext('alert-run-2'), now: new Date('2026-09-07T00:05:00Z'),
    })
    const migration = await service.evaluateType({
      type: 'crash', context: migrationCommandContext('m1', 'alert-run-3'), now: new Date('2026-09-07T01:00:00Z'),
    })

    assert.deepEqual(cooldown, { checked: 1, triggered: 0, suppressed: 1 })
    assert.deepEqual(migration, { checked: 1, triggered: 0, suppressed: 1 })
    assert.equal(notifications.sent.length, 0)
  })

  it('applies every legacy history filter and keeps pagination separate from filter parameters', async () => {
    const db = new AlertSql()
    db.execute = async (sql, parameters = []) => {
      db.statements.push({ sql, parameters })
      return []
    }
    const service = new QmsAlertService({ db, notifications: new Notifications() })

    await service.history({
      tenantId: 'tenant-a', configId: 'alert-1', type: 'test', level: 'warning',
      success: false, acknowledged: true, startTime: 1_000, endTime: 2_000, limit: 20, offset: 5,
    })

    const list = db.statements[0]!
    assert.match(list.sql, /tenant_id = \$1/)
    assert.match(list.sql, /config_id = \$2/)
    assert.match(list.sql, /type = \$3/)
    assert.match(list.sql, /level = \$4/)
    assert.match(list.sql, /success = \$5/)
    assert.match(list.sql, /acknowledged = \$6/)
    assert.match(list.sql, /sent_at >= \$7/)
    assert.match(list.sql, /sent_at < \$8/)
    assert.deepEqual(list.parameters.slice(-4), [new Date(1_000), new Date(2_000), 20, 5])
  })

  it('distinguishes missing and already acknowledged alerts', async () => {
    const db = new AlertSql()
    db.execute = async (sql, parameters = []) => {
      db.statements.push({ sql, parameters })
      if (sql.includes('SELECT acknowledged')) return [{ acknowledged: true }]
      return []
    }
    const service = new QmsAlertService({ db, notifications: new Notifications() })

    assert.deepEqual(await service.acknowledge({ id: 1, tenantId: 'tenant-a', userId: 'u1' }), {
      status: 'already_acknowledged',
    })
    assert.equal(db.statements.some(item => item.sql.includes('UPDATE alert_history')), false)
  })

  it('audits and records a test alert while sending the legacy payload', async () => {
    const db = new AlertSql()
    db.execute = async (sql, parameters = []) => {
      db.statements.push({ sql, parameters })
      if (sql.includes('SELECT * FROM alert_config')) return [{
        id: 'alert-1', tenant_id: 'tenant-a', name: '错误率', type: 'conversation', metric: 'error_rate',
        threshold: 10, comparison: 'gt', level: 'warning', channels: '["lark","email"]', description: null,
      }]
      if (sql.includes('INSERT INTO alert_history')) return [{ id: 1 }]
      return []
    }
    const notifications = new Notifications()
    const service = new QmsAlertService({ db, notifications })

    const result = await service.testConfig({
      id: 'alert-1', tenantId: 'tenant-a', userId: 'u1',
      context: onlineCommandContext('alert-test-1'), now: new Date('2026-09-07T00:00:00Z'),
    })

    assert.equal(result?.success, true)
    assert.deepEqual(notifications.sent.map(item => item.payload?.title), ['[TEST] 错误率', '[TEST] 错误率'])
    assert.ok(db.statements.some(item => item.sql.includes('INSERT INTO audit_logs') && item.parameters.includes('alert_test')))
    const history = db.statements.find(item => item.sql.includes('INSERT INTO alert_history'))!
    assert.ok(history)
    assert.equal(history.parameters[2], 'test')
  })
})
