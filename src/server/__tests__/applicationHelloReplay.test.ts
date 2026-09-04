import { describe, expect, it } from 'bun:test'
import { ApplicationHelloReplayBuffer } from '../applicationHelloReplay.js'
import type { RunnerServerMessage } from '../runnerProtocol.js'

const sessionId = 'session-1'
const helloLine = `${JSON.stringify({
  type: 'hello',
  session_id: sessionId,
  runtimeType: 'host',
  state: 'running',
})}\n`

function createRelayHarness() {
  const replayBuffer = new ApplicationHelloReplayBuffer(sessionId)
  const clients = new Set<(message: RunnerServerMessage) => void>()

  return {
    emitStdout(line: string) {
      replayBuffer.forward(line, message => {
        for (const send of clients) send(message)
      })
    },
    attach() {
      const received: RunnerServerMessage[] = []
      const send = (message: RunnerServerMessage) => received.push(message)
      clients.add(send)
      replayBuffer.replay(send)
      return received
    },
  }
}

describe('ApplicationHelloReplayBuffer', () => {
  it('replays the application hello once when hello arrives before attach', () => {
    const relay = createRelayHarness()

    relay.emitStdout(helloLine)
    const received = relay.attach()

    expect(received).toEqual([{ type: 'stdout', line: helloLine }])
  })

  it('delivers the application hello once when attach happens first', () => {
    const relay = createRelayHarness()

    const received = relay.attach()
    relay.emitStdout(helloLine)

    expect(received).toEqual([{ type: 'stdout', line: helloLine }])
  })
})
