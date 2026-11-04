import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AcpRequestTracker, AcpRpcError } from './acpRequestTracker.js'

void test('numeric zero and string zero correlate independently; reverse calls do not consume replies', () => {
  const tracker = new AcpRequestTracker(), replies: unknown[] = []
  const callbacks = { onReply: (value: unknown) => replies.push(value), onError: () => assert.fail(), onTimeout: () => assert.fail() }
  tracker.track(0, callbacks); tracker.track('0', callbacks)
  assert.equal(tracker.handleResponse({ jsonrpc: '2.0', id: 0, method: 'session/request_permission', params: {} }), false)
  assert.equal(tracker.handleResponse({ jsonrpc: '2.0', id: '0', result: 'string' }), true)
  assert.equal(tracker.handleResponse({ jsonrpc: '2.0', id: 0, result: 'number' }), true)
  assert.deepEqual(replies, ['string', 'number']); assert.equal(tracker.size, 0)
})

void test('timeout retains a request and its late remote error without retry', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const tracker = new AcpRequestTracker(), errors: Error[] = []; let timeouts = 0
  tracker.track('request', { onReply: () => assert.fail(), onError: error => errors.push(error), onTimeout: () => { timeouts++ } }, 10)
  t.mock.timers.tick(10); assert.equal(timeouts, 1); assert.equal(tracker.size, 1)
  assert.throws(() => tracker.track('request', { onReply() {}, onError() {}, onTimeout() {} }), /already pending/)
  tracker.handleResponse({ jsonrpc: '2.0', id: 'request', error: { code: -32602, message: 'Rejected' } })
  assert(errors[0] instanceof AcpRpcError); assert.equal(errors[0].rpcError.code, -32602)
  t.mock.timers.tick(100); assert.equal(timeouts, 1); assert.equal(tracker.size, 0)
})

void test('disconnect clears every deadline and settles each pending callback once', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const tracker = new AcpRequestTracker(), errors: Error[] = [], failure = new Error('Disconnected')
  for (const id of ['a', 'b']) tracker.track(id, { onReply: () => assert.fail(), onError: error => errors.push(error), onTimeout: () => assert.fail() })
  tracker.failAll(failure); tracker.failAll(failure); t.mock.timers.tick(60000)
  assert.deepEqual(errors, [failure, failure]); assert.equal(tracker.size, 0)
})

void test('no-deadline requests stay live until their actual result', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const tracker = new AcpRequestTracker(); let result: unknown
  tracker.track('long-turn', { onReply: value => { result = value }, onError: () => assert.fail(), onTimeout: () => assert.fail() }, null)
  t.mock.timers.tick(3600000); assert.equal(tracker.size, 1)
  tracker.handleResponse({ jsonrpc: '2.0', id: 'long-turn', result: { stopReason: 'end_turn' } })
  assert.deepEqual(result, { stopReason: 'end_turn' }); assert.equal(tracker.size, 0)
})
