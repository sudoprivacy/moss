import type { SessionRpcMessage } from '@nexus-ai-fs/vfs-client'
import { AcpRequestTracker, AcpRpcError, validateAcpTimeout } from './acpRequestTracker.js'
import type { AcpMessageTransport } from './acpTransport.js'

type JsonObject = Record<string, unknown>
type Session = { busy: boolean; outcomeUnknown: boolean; turn: number }
type Completion = { requestId: string; method: string; result?: unknown; error?: Error; late: boolean }
export type StandardAcpDriverOptions = {
  /** Synchronous event sinks: persistence and authorization belong to the host. */
  onNotification?(message: SessionRpcMessage): void
  onCompletion?(completion: Completion): void
  onStderr?(line: string): void
  onDisconnect?(cause: unknown): void
  /** Without an authorized host decision, permission is cancelled. */
  requestPermission?(request: JsonObject): Promise<string | null>
  timeoutMs?: number
  /** A real coding turn has no invented 30-second deadline. The host may set one. */
  promptTimeoutMs?: number
}

export class AcpOutcomeUnknown extends Error {
  constructor(readonly requestId: string, readonly method: string, cause?: unknown) {
    super(`ACP ${method} outcome is unknown; do not resubmit automatically`, { cause })
    this.name = 'AcpOutcomeUnknown'
  }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ACP response object')
  return value as JsonObject
}

/** Standard ACP v1 session driver. No Task store, scheduler or provider credentials.
 * The host supplies an already-authorized transport and resolved workspace/MCP
 * configuration. Text is forwarded literally; no scode metadata is invented.
 */
export class StandardAcpDriver {
  readonly #requests = new AcpRequestTracker()
  readonly #sessions = new Map<string, Session>()
  #sequence = 0
  #closed = false
  #opening = false
  #initialized?: Promise<JsonObject>
  #capabilities?: JsonObject
  #closing?: Promise<void>

  constructor(private readonly transport: AcpMessageTransport, private readonly options: StandardAcpDriverOptions = {}) {
    validateAcpTimeout(options.timeoutMs ?? 30000)
    validateAcpTimeout(options.promptTimeoutMs ?? null)
    transport.start({
      onMessage: message => {
        if (this.#closed) return
        if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
          this.#disconnect(new Error('Invalid ACP message')); return
        }
        if (this.#requests.handleResponse(message)) return
        if (message.method && (typeof message.id === 'string' || typeof message.id === 'number')) void this.#reverseRequest(message)
        else if (message.method && message.id === undefined) {
          try { this.options.onNotification?.(message) }
          catch (error) { this.#disconnect(error) }
        }
      },
      onStderr: line => this.#diagnostic(line),
      onClose: (_code, _signal, error) => this.#disconnect(error),
    })
  }

  initialize(): Promise<JsonObject> {
    this.#initialized ??= this.#call('initialize', {
      protocolVersion: 1, clientInfo: { name: 'moss-standard-acp', version: '1' }, clientCapabilities: {},
    }, result => {
      const value = object(result)
      if (value.protocolVersion !== 1) throw new Error('The execution does not support ACP v1')
      this.#capabilities = structuredClone(object(value.agentCapabilities ?? {}))
      return structuredClone(this.#capabilities)
    })
    return this.#initialized
  }

  async open(input: { cwd: string; mcpServers?: unknown[]; resumeSessionId?: string }): Promise<string> {
    await this.initialize()
    if (this.#opening) throw new Error('An ACP session open is still pending; resolve it before retrying')
    if (this.#sessions.size >= 32) throw new Error('ACP session limit reached')
    if (!input.cwd || (input.resumeSessionId !== undefined && !input.resumeSessionId)) throw new Error('A resolved workspace and valid session ID are required')
    if (input.resumeSessionId && this.#capabilities?.loadSession !== true) throw new Error('The execution does not support session recovery')
    if (input.resumeSessionId && this.#sessions.has(input.resumeSessionId)) throw new Error('ACP session is already open')
    const method = input.resumeSessionId ? 'session/load' : 'session/new'
    const mcpServers = structuredClone(input.mcpServers ?? [])
    this.#opening = true
    return this.#call(method, {
      cwd: input.cwd, mcpServers,
      ...(input.resumeSessionId ? { sessionId: input.resumeSessionId } : {}),
    }, result => {
      const value = object(result)
      const sessionId = value.sessionId ?? input.resumeSessionId
      if (typeof sessionId !== 'string' || !sessionId ||
          (input.resumeSessionId && sessionId !== input.resumeSessionId) || this.#sessions.has(sessionId)) {
        throw new Error('Invalid ACP session identity')
      }
      this.#sessions.set(sessionId, { busy: false, outcomeUnknown: false, turn: 0 })
      return sessionId
    }, () => { this.#opening = false })
  }

  prompt(sessionId: string, text: string, timeoutMs: number | null = this.options.promptTimeoutMs ?? null): Promise<JsonObject> {
    const session = this.#session(sessionId)
    if (session.busy) throw new Error('ACP turn is still pending; do not send another copy')
    if (typeof text !== 'string') throw new Error('This driver accepts text input')
    validateAcpTimeout(timeoutMs)
    session.busy = true
    session.turn++
    return this.#call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, result => {
      const value = object(result)
      if (typeof value.stopReason !== 'string' || !value.stopReason) throw new Error('Invalid ACP prompt completion')
      return value
    },
      () => { session.busy = false; session.outcomeUnknown = false },
      () => { session.outcomeUnknown = true }, timeoutMs)
  }

  /** Sending cancellation is not confirmation. The prompt reply settles the turn. */
  async cancel(sessionId: string): Promise<void> {
    this.#session(sessionId)
    try { await this.transport.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }) }
    catch (error) { this.#disconnect(error); throw new AcpOutcomeUnknown('notification', 'session/cancel', error) }
  }

  /** Local connection facts only, never proof of remote task completion. */
  status(sessionId: string): { connected: boolean; pending: boolean; outcomeUnknown: boolean } {
    const session = this.#sessions.get(sessionId)
    if (!session) throw new Error('ACP session is not bound to this connection')
    return { connected: !this.#closed && this.transport.connected, pending: session.busy, outcomeUnknown: session.outcomeUnknown }
  }

  async close(force = false): Promise<void> {
    this.#disconnect(new Error('ACP connection closed'), force)
    await this.#closing
  }

  #session(id: string): Session {
    if (this.#closed || !this.transport.connected) throw new Error('ACP connection is closed')
    const session = this.#sessions.get(id)
    if (!session) throw new Error('ACP session is not bound to this connection')
    return session
  }

  #call<T>(method: string, params: JsonObject, parse: (result: unknown) => T,
    settled: () => void = () => {}, timedOut: () => void = () => {},
    timeoutMs: number | null = this.options.timeoutMs ?? 30000): Promise<T> {
    if (this.#closed || !this.transport.connected) return Promise.reject(new Error('ACP connection is closed'))
    const id = `moss-execution-${++this.#sequence}`
    return new Promise<T>((resolve, reject) => {
      let late = false
      this.#requests.track(id, {
        onReply: result => {
          try { const value = parse(result); settled(); resolve(value); this.#completion({ requestId: id, method, result, late }) }
          catch (error) {
            timedOut()
            const failure = new AcpOutcomeUnknown(id, method, error)
            this.#disconnect(failure); reject(failure)
            this.#completion({ requestId: id, method, error: failure, late })
          }
        },
        onError: error => {
          const failure = error instanceof AcpRpcError ? error : new AcpOutcomeUnknown(id, method, error)
          if (error instanceof AcpRpcError) settled()
          else timedOut()
          reject(failure)
          this.#completion({ requestId: id, method, error: failure, late })
        },
        onTimeout: () => { late = true; timedOut(); reject(new AcpOutcomeUnknown(id, method)) },
      }, timeoutMs)
      // Register before dispatch: an in-process transport may reply immediately.
      try { void this.transport.send({ jsonrpc: '2.0', id, method, params }).catch(error => this.#disconnect(error)) }
      catch (error) { this.#disconnect(error) }
    })
  }

  #completion(value: Completion): void {
    try { this.options.onCompletion?.(value) }
    catch { this.#diagnostic('ACP completion observer failed; reconcile existing work before retrying\n') }
  }

  #diagnostic(line: string): void {
    try { this.options.onStderr?.(line) } catch { /* A diagnostic sink cannot change execution state. */ }
  }

  #disconnect(cause?: unknown, force = false): void {
    if (this.#closed) return
    this.#closed = true
    this.#requests.failAll(cause instanceof Error ? cause : new Error('ACP execution disconnected'))
    this.#closing = Promise.resolve().then(() => this.transport.close(force))
    void this.#closing.catch(() => this.#diagnostic('ACP transport cleanup failed\n'))
    try { this.options.onDisconnect?.(cause) } catch { this.#diagnostic('ACP disconnect observer failed\n') }
  }

  async #reverseRequest(message: SessionRpcMessage): Promise<void> {
    let response: SessionRpcMessage
    if (message.method === 'session/request_permission') {
      let params: JsonObject
      try { params = object(message.params) }
      catch {
        try { await this.transport.send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Invalid permission request' } }) }
        catch (error) { this.#disconnect(error) }
        return
      }
      let optionId: string | null = null
      let session: Session | undefined
      let turn: number | undefined
      const optionIds = new Set(Array.isArray(params.options) ? params.options.flatMap(option =>
        option && typeof option === 'object' && typeof (option as JsonObject).optionId === 'string'
          ? [(option as JsonObject).optionId as string] : []) : [])
      try {
        session = this.#session(String(params.sessionId)); turn = session.turn
        if (session.busy) optionId = await this.options.requestPermission?.(structuredClone(params)) ?? null
      } catch { /* No authorized decision: cancel, never guess an allow option. */ }
      const known = session?.busy && session.turn === turn && optionId !== null && optionIds.has(optionId)
      response = { jsonrpc: '2.0', id: message.id, result: {
        outcome: optionId !== null && known ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
      } }
    } else response = { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method is not supported' } }
    if (this.#closed) return
    try { await this.transport.send(response) } catch (error) { this.#disconnect(error) }
  }
}
