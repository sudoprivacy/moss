import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NexusSpawnHandle } from './nexusSpawnHandle.js'
import type { ManagedAgentClient } from '../nexus/managedAgentClient.js'

type ReadResult = { data: Buffer; nextOffset: string; eof: boolean; timedOut: boolean }

/** Let the pumps run a few turns of the event loop. */
const settle = (ms = 60): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A ManagedAgentClient stand-in. `reads` is scripted per path so fd/1 and fd/2
 * are independent: a frame is delivered, an `Error` entry rejects the way the
 * real client reports a closed stream or an exited writer.
 *
 * A path with nothing left scripted never resolves — that is what a healthy,
 * quiet stream looks like for the length of a test (the daemon is long-polling)
 * and it keeps one fd's script from disconnecting the handle out from under the
 * other. A pending promise holds no handle, so the process still exits.
 */
function fakeAgent(reads: Record<string, Array<ReadResult | Error>> = {}) {
  const writes: Array<{ path: string; data: string }> = []
  const cancels: string[] = []
  const pending = new Map<string, Array<ReadResult | Error>>(
    Object.entries(reads).map(([path, frames]) => [path, [...frames]]),
  )
  const agent = {
    streamWrite: async (path: string, data: Buffer) => {
      writes.push({ path, data: data.toString() })
    },
    streamReadAt: (path: string): Promise<ReadResult> => {
      const next = (pending.get(path) ?? []).shift()
      if (next === undefined) return new Promise<ReadResult>(() => {})
      if (next instanceof Error) return Promise.reject(next)
      return Promise.resolve(next)
    },
    cancel: async (sessionId: string) => {
      cancels.push(sessionId)
    },
  }
  return { agent: agent as unknown as ManagedAgentClient, writes, cancels }
}

const frame = (text: string, nextOffset: string): ReadResult => ({
  data: Buffer.from(text),
  nextOffset,
  eof: false,
  timedOut: false,
})

void test('stdout frames from fd/1 reach the stream in order', async () => {
  const { agent } = fakeAgent({
    '/proc/sid-1/fd/1': [frame('hello\n', '6'), frame('world\n', '12')],
  })
  const handle = new NexusSpawnHandle(agent, 'sid-1', 4242)

  const seen: string[] = []
  handle.stdout.on('data', (chunk: Buffer) => seen.push(chunk.toString()))
  await settle()

  assert.equal(seen.join(''), 'hello\nworld\n')
  assert.equal(handle.pid, 4242, 'os pid is carried for the auth-proxy token')
})

void test('writing stdin appends to fd/0', async () => {
  const { agent, writes } = fakeAgent()
  const handle = new NexusSpawnHandle(agent, 'sid-2', null)

  handle.stdin.write('{"jsonrpc":"2.0"}\n')
  await settle()

  assert.deepEqual(writes, [{ path: '/proc/sid-2/fd/0', data: '{"jsonrpc":"2.0"}\n' }])
})

void test('a read rejection is the disconnect, and a frame still in flight on the other fd does not throw', async () => {
  // Regression: fd/2 disconnecting ends BOTH sinks, so an fd/1 frame that
  // resolves in the same turn used to hit ERR_STREAM_WRITE_AFTER_END inside a
  // detached async pump — an uncaught exception, and the frame lost.
  const { agent } = fakeAgent({
    '/proc/sid-3/fd/2': [new Error('stream closed: writer exited')],
    '/proc/sid-3/fd/1': [frame('late\n', '5')],
  })
  const handle = new NexusSpawnHandle(agent, 'sid-3', null)

  let closes = 0
  handle.on('close', () => { closes += 1 })
  await settle()

  assert.equal(closes, 1, 'close is reported once, not once per fd')
})

void test('kill cancels the nexus session once, however many times it is called', async () => {
  const { agent, cancels } = fakeAgent()
  const handle = new NexusSpawnHandle(agent, 'sid-4', null)

  handle.kill('SIGTERM')
  handle.kill('SIGKILL')
  await settle()

  assert.deepEqual(cancels, ['sid-4'])
  assert.equal(handle.killed, true)
})

void test('a close listener registered after close still fires', async () => {
  const { agent } = fakeAgent()
  const handle = new NexusSpawnHandle(agent, 'sid-5', null)
  handle.kill()

  let fired = false
  handle.once('close', () => { fired = true })
  await settle()

  assert.equal(fired, true)
})
