import assert from 'node:assert/strict'
import http from 'node:http'
import { afterEach, describe, it } from 'node:test'

import { DirectConnectStore } from '../db.js'
import { createEventTriggerApi, createEventTriggerIngest } from './eventTriggers.js'
import { EventTriggerStore } from '../services/eventTrigger/EventTriggerStore.js'

const databases: DirectConnectStore[] = []
const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  for (const database of databases.splice(0)) database.close()
})

function createContext() {
  const database = new DirectConnectStore(':memory:')
  databases.push(database)
  const store = new EventTriggerStore(database.db)
  return {
    store,
    api: createEventTriggerApi({ store }),
  }
}

describe('Event Trigger API Organization 隔离', () => {
  it('管理端创建固定认证身份，跨 Organization 查询和变更均不可探测', () => {
    const { api } = createContext()
    const owner = { orgId: 'org-a', userId: 'user-a' }
    const foreign = { orgId: 'org-b', userId: 'user-a' }
    const created = api.createTrigger(owner, {
      name: 'incoming order',
      prompt_template: 'Process order.',
    })
    assert.equal(created.success, true)
    if (!created.success) return

    assert.equal(created.trigger.org_id, 'org-a')
    assert.equal(created.trigger.user_id, 'user-a')
    assert.equal(api.getTrigger(foreign, created.trigger.id), null)
    assert.equal(api.updateTrigger(foreign, created.trigger.id, { name: 'hijacked' }), null)
    assert.equal(api.rotateSecret(foreign, created.trigger.id), null)
    assert.equal(api.listRuns(foreign, created.trigger.id), null)
    assert.equal(api.deleteTrigger(foreign, created.trigger.id), null)
    assert.equal(api.getTrigger(owner, created.trigger.id)?.trigger.name, 'incoming order')
  })

  it('HTTP 入站忽略载荷中的身份字段，幂等重试返回原 run', async () => {
    const { store, api } = createContext()
    const created = api.createTrigger({ orgId: 'org-a', userId: 'user-a' }, {
      name: 'incoming order',
      prompt_template: 'Process order.',
    })
    assert.equal(created.success, true)
    if (!created.success) return

    const ingest = createEventTriggerIngest({ getStore: () => store } as never)
    const server = http.createServer(async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      if (!(await ingest.handle(req, res, pathname))) {
        res.writeHead(404).end()
      }
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const url = `http://127.0.0.1:${address.port}/api/v1/triggers/${created.trigger.id}/events`
    const options = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${created.secret}`,
        'content-type': 'application/json',
        'x-moss-idempotency-key': 'order-1',
      },
      body: JSON.stringify({ org_id: 'org-evil', user_id: 'user-evil', order_id: 1 }),
    }

    const first = await fetch(url, options)
    const firstBody = await first.json() as { run_id: string; status: string }
    const retry = await fetch(url, options)
    const retryBody = await retry.json() as { run_id: string; duplicate: boolean }

    assert.equal(first.status, 202)
    assert.equal(retry.status, 200)
    assert.equal(retryBody.duplicate, true)
    assert.equal(retryBody.run_id, firstBody.run_id)
    const run = store.getRunById(firstBody.run_id)
    assert.equal(run?.orgId, 'org-a')
    assert.equal(run?.userId, 'user-a')
    assert.equal(store.listRunsByTrigger(created.trigger.id).length, 1)
  })
})
