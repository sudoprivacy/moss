import type { RunnerServerMessage } from './runnerProtocol.js'

type SendRunnerMessage = (message: RunnerServerMessage) => void

function isApplicationHello(line: string, sessionId: string): boolean {
  try {
    const parsed = JSON.parse(line) as unknown
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).type === 'hello' &&
      (parsed as Record<string, unknown>).session_id === sessionId
    )
  } catch {
    return false
  }
}

/**
 * Keeps the backend's initial application-level hello available for clients
 * that attach after it was emitted. All stdout still follows the normal live
 * broadcast path; only the first hello for this session is replayed.
 */
export class ApplicationHelloReplayBuffer {
  #helloLine: string | null = null

  constructor(private readonly sessionId: string) {}

  forward(line: string, broadcast: SendRunnerMessage): void {
    if (this.#helloLine === null && isApplicationHello(line, this.sessionId)) {
      this.#helloLine = line
    }
    broadcast({ type: 'stdout', line })
  }

  replay(send: SendRunnerMessage): void {
    if (this.#helloLine !== null) {
      send({ type: 'stdout', line: this.#helloLine })
    }
  }
}
