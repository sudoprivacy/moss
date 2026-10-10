import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DirectConnectStore } from '../db.js'
import { EventTriggerStore } from '../services/eventTrigger/EventTriggerStore.js'
import { createEventTriggerApi } from './eventTriggers.js'

void test('trigger conversation modes reject invalid values without persisting partial updates', async () => {
  const database = new DirectConnectStore(':memory:')
  const store = new EventTriggerStore(database.driver)
  const api = createEventTriggerApi({ store })
  const auth = { orgId: 'org', userId: 'user' }
  try {
    for (const conversation_mode of ['invalid', null, 1, true, '']) {
      const result = await api.createTrigger(auth, { name: 'invalid', prompt_template: 'Run', conversation_mode })
      assert.equal(result.success, false)
    }
    assert.equal((await store.listByOrg('org')).length, 0)
    const created = await api.createTrigger(auth, { name: 'valid', prompt_template: 'Run', enabled: false })
    assert.equal(created.success, true)
    assert.ok('trigger' in created)
    const triggerId = created.trigger.id
    const result = await api.updateTrigger(auth, triggerId, { name: 'Changed', conversation_mode: 'invalid' })
    assert.equal(result?.success, false)
    assert.equal((await store.getById(triggerId))?.name, 'valid')
    assert.equal((await store.getById(triggerId))?.conversationMode, 'new')
    assert.equal((await api.updateTrigger(auth, triggerId, { conversation_mode: 'reuse' }))?.success, true)
    assert.equal((await store.getById(triggerId))?.conversationMode, 'reuse')
    assert.equal((await api.updateTrigger({ orgId: 'other', userId: 'user' }, triggerId, { conversation_mode: 'invalid' })), null)
  } finally {
    await database.close()
  }
})
