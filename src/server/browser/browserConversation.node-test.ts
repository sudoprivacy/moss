import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserConversationIntent, changeBrowserConversationControl } from './browserConversation.js'
import type { BrowserWorkerPort } from './browserGateway.js'

void test('conversation intent cannot carry a role, foreign identity or coerced action', () => {
  for (const invalid of [null, [], { intent: ['interrupt'] }, { intent: true }, { intent: 'continue', userId: 'other' }, { intent: 'take' }]) {
    assert.throws(() => browserConversationIntent(invalid), /Invalid browser conversation intent/)
  }
  assert.equal(browserConversationIntent({ intent: 'interrupt' }), 'interrupt')
})

void test('interrupt then normal chat preserve epochs and never generate an extra model turn', async () => {
  const binding = { orgId: 'org', userId: 'user', sessionId: 'conversation' }
  const calls: Record<string, unknown>[] = []
  const state = { state: 'ai', controlEpoch: 3, targetEpoch: 7, isController: false }
  const worker: BrowserWorkerPort = { invoke: async (_binding, _controller, action) => {
    calls.push(action)
    if (action.kind === 'take') { state.state = 'human'; state.isController = true; state.controlEpoch++ }
    if (action.kind === 'return') { state.state = 'ai'; state.isController = false; state.controlEpoch++ }
    return { session: { ...state } }
  } }
  assert.deepEqual(await changeBrowserConversationControl(worker, binding, 'owner', 'interrupt'), { changed: true })
  assert.deepEqual(await changeBrowserConversationControl(worker, binding, 'owner', 'interrupt'), { changed: false })
  assert.deepEqual(await changeBrowserConversationControl(worker, binding, 'owner', 'continue'), { changed: true })
  assert.deepEqual(calls.filter(action => action.kind !== 'state'), [
    { kind: 'take', controlEpoch: 3, targetEpoch: 7 },
    { kind: 'return', controlEpoch: 4, targetEpoch: 7 },
  ])
  state.state = 'human'
  await assert.rejects(changeBrowserConversationControl(worker, binding, 'other', 'continue'), /browser_control_not_owned/)
  state.state = 'pausing'
  await assert.rejects(changeBrowserConversationControl(worker, binding, 'owner', 'continue'), /browser_control_not_owned/)
})
