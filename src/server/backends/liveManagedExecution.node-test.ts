import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { InternalSessionChannel } from '../internalSessionChannel.js'
import { readLiveManagedExecution } from './liveManagedExecution.js'

function channel() {
  const result = new EventEmitter() as InternalSessionChannel
  let closes = 0
  result.destroy = () => { closes++ }
  return { result, closes: () => closes }
}
const binding = { ownerId: 'owner', agentId: 'owner', durableSessionId: 'native-durable', repositoryPath: '/agents/owner/workspaces/moss-session' }
const hello = { type: 'hello', sessionId: 'moss-session', attemptId: 'attempt', runtimeType: 'cohost', state: 'running', managedProcessId: 'live-pid', cohostSessionBinding: binding }

void test('workspace attach waits through a native crash lease instead of timing out at the runner socket budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const stream = channel()
  let isSettled = false
  const pending = readLiveManagedExecution(stream.result, 'moss-session').finally(() => { isSettled = true })
  stream.result.emit('data', JSON.stringify({ ...hello, state: 'starting', managedProcessId: undefined })+'\n')
  t.mock.timers.tick(45_000)
  await Promise.resolve()
  assert.equal(isSettled, false)
  stream.result.emit('data', JSON.stringify(hello)+'\n')
  assert.deepEqual(await pending, { processId: 'live-pid', binding })
  assert.equal(stream.closes(), 1)
})

void test('live identity waits through startup and reads fragmented runner frames', async () => {
  const stream = channel()
  const pending = readLiveManagedExecution(stream.result, 'moss-session')
  stream.result.emit('data', JSON.stringify({ ...hello, state: 'starting', managedProcessId: undefined })+'\n')
  const ready = JSON.stringify(hello)+'\n'
  stream.result.emit('data', ready.slice(0, 14))
  stream.result.emit('data', ready.slice(14))
  assert.deepEqual(await pending, { processId: 'live-pid', binding })
  assert.equal(stream.closes(), 1)
  assert.equal(stream.result.listenerCount('data'), 0)
})

void test('a different session or backend cannot supply a workspace process', async () => {
  for (const update of [{ sessionId: 'another-session' }, { runtimeType: 'host' }]) {
    const stream = channel()
    const pending = readLiveManagedExecution(stream.result, 'moss-session')
    stream.result.emit('data', JSON.stringify({ ...hello, ...update })+'\n')
    await assert.rejects(pending, /does not belong/)
    assert.equal(stream.closes(), 1)
  }
})

void test('malformed identity, closed channels and missing startup completion fail without leaked listeners', async () => {
  for (const id of [undefined, '../other', '']) {
    const stream = channel()
    const pending = readLiveManagedExecution(stream.result, 'moss-session')
    stream.result.emit('data', JSON.stringify({ ...hello, managedProcessId: id })+'\n')
    await assert.rejects(pending, /not ready/)
    assert.equal(stream.closes(), 1)
  }
  const stream = channel()
  const pending = readLiveManagedExecution(stream.result, 'moss-session')
  stream.result.emit('close')
  await assert.rejects(pending, /not ready/)
  assert.equal(stream.result.listenerCount('data'), 0)
  const stalled = channel()
  await assert.rejects(readLiveManagedExecution(stalled.result, 'moss-session', 10), /not ready/)
  assert.equal(stalled.closes(), 1)
})

void test('a process alone cannot supply a durable workspace identity', async () => {
  for (const value of [undefined, { ...binding, durableSessionId: '../other' }, { ...binding, repositoryPath: 'relative' }]) {
    const stream = channel()
    const pending = readLiveManagedExecution(stream.result, 'moss-session')
    stream.result.emit('data', JSON.stringify({ ...hello, cohostSessionBinding: value })+'\n')
    await assert.rejects(pending, /not ready/)
    assert.equal(stream.closes(), 1)
  }
})
