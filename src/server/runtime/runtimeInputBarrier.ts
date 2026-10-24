import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import { HttpError } from '../httpError.js'

export interface RunnerInputEndpoint {
  attemptId: string
  attachPath: string | null
  isOwned: boolean
}

type RunnerActivity = 'idle' | 'busy' | 'unavailable'

/** Keep the actual consuming daemons fenced until the operator resumes. */
export class RuntimeInputBarrier {
  readonly #controls = new Map<string, Map<string, RunnerControl>>()
  readonly #channels = new Set<RunnerControl>()
  #isClosed = false

  constructor(private readonly endpoints: () => Promise<RunnerInputEndpoint[]>) {}

  async pause(id: string, timeoutMs: number): Promise<Array<{ attemptId: string; state: RunnerActivity }>> {
    const before = await this.endpoints()
    if (this.#isClosed) throw new HttpError(503, 'Controller input services are closed')
    let controls = this.#controls.get(id)
    if (!controls) { controls = new Map(); this.#controls.set(id, controls) }
    const holders = controls
    const states = await Promise.all(before.map(async endpoint => {
      let state: RunnerActivity = 'unavailable'
      if (endpoint.isOwned && endpoint.attachPath) {
        let control = holders.get(endpoint.attemptId)
        if (control && control.endpoint.attachPath !== endpoint.attachPath) return { attemptId: endpoint.attemptId, state }
        if (!control) { control = this.#open(endpoint, timeoutMs); holders.set(endpoint.attemptId, control) }
        try {
          await control.ready
          control.wasRequested = true
          const reply = await control.request('pause_input', id, 'input_paused', timeoutMs + 250)
          state = reply.isInputDrained === true && reply.isReady === true && reply.isBusy === false
            ? 'idle' : reply.isBusy === true ? 'busy' : 'unavailable'
        } catch { /* The coordinator releases this holder before refusing preparation. */ }
      }
      return { attemptId: endpoint.attemptId, state }
    }))
    const after = await this.endpoints()
    if (this.#isClosed) throw new HttpError(503, 'Controller input services are closed')
    const identity = (items: RunnerInputEndpoint[]): string => JSON.stringify(items.map(item =>
      [item.attemptId, item.attachPath, item.isOwned]).sort())
    if (identity(before) !== identity(after)) states.push({ attemptId: 'runner-set-changed', state: 'unavailable' })
    return states
  }

  async resume(id: string): Promise<void> {
    if (this.#isClosed) return
    const controls = this.#controls.get(id)
    if (!controls) return
    await Promise.all([...controls.values()].map(async control => {
      if (!control.wasRequested) { control.socket.destroy(); return }
      let target = control
      try {
        if (target.socket.destroyed || !target.socket.writable) target = this.#open(control.endpoint, 5000)
        await target.ready
        await target.request('resume_input', id, 'input_resumed', 5000)
        control.wasRequested = false
        control.socket.end()
        if (target !== control) target.socket.end()
      } catch {
        if (target !== control) target.socket.destroy()
        if (this.#isClosed) return
        throw new HttpError(503, 'Runner input fence release is unconfirmed; retry releasing this pause')
      }
    }))
    this.#controls.delete(id)
  }

  close(): void {
    this.#isClosed = true
    for (const control of this.#channels) control.socket.destroy()
    this.#channels.clear()
    this.#controls.clear()
  }

  #open(endpoint: RunnerInputEndpoint, timeoutMs: number): RunnerControl {
    if (this.#isClosed) throw new HttpError(503, 'Controller input services are closed')
    const control = new RunnerControl(endpoint, timeoutMs)
    this.#channels.add(control)
    control.socket.once('close', () => this.#channels.delete(control))
    return control
  }
}

class RunnerControl {
  readonly socket: Socket
  readonly ready: Promise<void>
  wasRequested = false
  readonly #pending = new Map<string, { type: string; resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>()

  constructor(readonly endpoint: RunnerInputEndpoint, timeoutMs: number) {
    this.socket = createConnection(endpoint.attachPath!)
    this.socket.setEncoding('utf8')
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    this.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    const timer = setTimeout(() => fail(new Error('Runner input protocol unavailable')), timeoutMs)
    const fail = (error: Error): void => {
      clearTimeout(timer)
      rejectReady(error)
      for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
      this.#pending.clear()
    }
    let buffer = ''
    this.socket.on('data', chunk => {
      buffer += String(chunk)
      if (buffer.length > 1_048_576) { fail(new Error('Runner frame limit exceeded')); this.socket.destroy(); return }
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        let message: Record<string, unknown>
        try {
          const value: unknown = JSON.parse(line)
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid runner frame')
          message = value as Record<string, unknown>
        }
        catch { fail(new Error('Invalid runner frame')); this.socket.destroy(); return }
        if (message.type === 'hello') {
          clearTimeout(timer)
          if (message.attemptId !== endpoint.attemptId || message.inputPauseSupported !== true) {
            fail(new Error('Runner input protocol unavailable')); this.socket.destroy(); return
          }
          resolveReady()
        }
        if (typeof message.requestId === 'string') {
          const pending = this.#pending.get(message.requestId)
          if (pending && message.type === pending.type && message.attemptId === endpoint.attemptId) {
            clearTimeout(pending.timer)
            this.#pending.delete(message.requestId)
            pending.resolve(message)
          }
        }
      }
    })
    this.socket.on('error', fail)
    this.socket.once('close', () => fail(new Error('Runner control closed')))
  }

  request(type: 'pause_input' | 'resume_input', pauseId: string, response: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed || !this.socket.writable) { reject(new Error('Runner control closed')); return }
      const requestId = randomUUID()
      const timer = setTimeout(() => { this.#pending.delete(requestId); reject(new Error('Runner input operation timed out')) }, timeoutMs)
      this.#pending.set(requestId, { type: response, resolve, reject, timer })
      this.socket.write(JSON.stringify({ type, pauseId, requestId }) + '\n')
    })
  }
}
