import type { ParkAgentChannel, PreparedParkTurn } from '../agentChannel.js'

/**
 * Deterministic in-memory channel for tests: replays a scripted delta
 * sequence per turn, records create/terminate calls, and lets tests flip
 * liveness to exercise the 401 recovery path.
 */
export class FakeAgentChannel implements ParkAgentChannel {
  private nextId = 0
  readonly created: Array<{ orgId: string; assistantId: string; anonymousSessionId: string }> = []
  readonly terminated: string[] = []
  readonly sent: Array<{ mossSessionId: string; question: string }> = []
  readonly idleSessions = new Set<string>()
  readonly owners = new Map<string, string>()
  async retireVisitor(orgId: string, anonymousSessionId: string): Promise<void> {
    for (const [index, input] of this.created.entries()) {
      const id = `fake-agent-${index + 1}`
      if (input.orgId === orgId && input.anonymousSessionId === anonymousSessionId && !this.deadSessions.has(id)) await this.terminate(id)
    }
  }
  async runningCount(orgId: string): Promise<number> {
    return [...this.owners].filter(([id, owner]) => owner === orgId && !this.deadSessions.has(id) && !this.idleSessions.has(id)).length
  }
  async isRunning(id: string): Promise<boolean> {
    return this.owners.has(id) && !this.deadSessions.has(id) && !this.idleSessions.has(id)
  }
  async prepareTurn(id: string): Promise<PreparedParkTurn> {
    this.idleSessions.delete(id)
    return { send: (question, uuid, onDelta) => this.sendAndStream(id, question, uuid, onDelta), dispose: () => {} }
  }
  readonly deadSessions = new Set<string>()
  script: string[] = []
  /** Optional gate invoked before each scripted turn (concurrency tests suspend here). */
  beforeSend?: () => Promise<void>

  async createSession(input: { orgId: string; assistantId: string; anonymousSessionId: string }): Promise<string> {
    this.created.push(input)
    this.nextId += 1
    const id = `fake-agent-${this.nextId}`
    this.owners.set(id, input.orgId)
    return id
  }

  async sendAndStream(mossSessionId: string, question: string, _uuid: string, onDelta: (text: string) => void): Promise<{ answer: string }> {
    this.sent.push({ mossSessionId, question })
    await this.beforeSend?.()
    let answer = ''
    for (const delta of this.script) {
      answer += delta
      onDelta(delta)
    }
    return { answer }
  }

  async terminate(mossSessionId: string): Promise<void> {
    this.terminated.push(mossSessionId)
    this.deadSessions.add(mossSessionId)
  }

  async isAlive(mossSessionId: string): Promise<boolean> {
    return !this.deadSessions.has(mossSessionId)
  }
}
