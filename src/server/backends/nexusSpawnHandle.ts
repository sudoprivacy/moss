/**
 * A `ChildProcess`-shaped view of an agent nexus is supervising.
 *
 * `acpBridge` speaks to a local child through `stdin` / `stdout` / `stderr` and
 * a `close` event. When nexus owns the process instead, the same three streams
 * live on `/proc/{sessionId}/fd/{0,1,2}` as node-local `DT_STREAM`s. This class
 * presents them with the shape the bridge already expects, so the 1200 lines of
 * ACP framing, transcript writing and busy-state tracking are reused unchanged
 * — the k8s backend's own comment calls that bridge "reused UNCHANGED", and
 * this keeps that true.
 *
 * `stdout` / `stderr` are real `PassThrough`s, so `readline.createInterface`
 * and `.on('data')` behave exactly as they do over a pipe.
 */

import { PassThrough, Writable } from 'stream'
import type { ManagedAgentClient } from '../nexus/managedAgentClient.js'

/** Long-poll budget for one blocking read. The daemon answers the timeout. */
const READ_LONG_POLL_MS = 30_000

/**
 * Pause after a read that returned nothing. A blocking read has already spent
 * the wait, so this never fires against a healthy daemon; it exists so a peer
 * that answers empty reads instantly cannot turn the follow loop into a spin.
 */
const IDLE_BACKOFF_MS = 25

/**
 * The subset of `ChildProcess` the ACP bridge and the k8s backend actually
 * touch. Narrow on purpose: a real `ChildProcess` satisfies it structurally, so
 * the docker and host paths keep passing theirs with no change.
 */
export type AcpChildProcessLike = {
  stdin: Pick<Writable, 'write' | 'end' | 'destroyed'> & { writableEnded: boolean } | null
  stdout: PassThrough | NodeJS.ReadableStream | null
  stderr: PassThrough | NodeJS.ReadableStream | null
  killed: boolean
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export class NexusSpawnHandle implements AcpChildProcessLike {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable

  killed = false

  #closed = false
  #closeListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>()
  #readersStopped = false

  constructor(
    private readonly agent: ManagedAgentClient,
    private readonly sessionId: string,
    /** OS pid on the nexus host, for the pid-bound auth-proxy token. */
    readonly pid: number | null,
  ) {
    const fd0 = `/proc/${sessionId}/fd/0`
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _enc, cb) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        this.agent.streamWrite(fd0, buf).then(
          () => cb(),
          (err: unknown) => cb(err instanceof Error ? err : new Error(String(err))),
        )
      },
    })

    void this.#pump(`/proc/${sessionId}/fd/1`, this.stdout)
    void this.#pump(`/proc/${sessionId}/fd/2`, this.stderr)
  }

  /**
   * Follow one fd stream until it disconnects.
   *
   * Per the DT_STREAM contract: data → deliver and advance the offset; a
   * long-poll that expires (`timedOut`, and `eof` on older servers) → re-read
   * at the SAME offset, the blocking read is itself the wait. Only a rejection
   * means the writer is gone, and that is what ends the session.
   */
  async #pump(streamPath: string, sink: PassThrough): Promise<void> {
    let offset = '0'
    while (!this.#readersStopped) {
      let res
      try {
        res = await this.agent.streamReadAt(streamPath, offset, {
          blocking: true,
          timeoutMs: READ_LONG_POLL_MS,
        })
      } catch {
        // The stream closed or the writer exited — the disconnect signal.
        this.#emitClose()
        return
      }
      if (res.data.length > 0) {
        // The other fd's pump may have closed the handle while this read was
        // in flight — both sinks end together, so writing now would throw
        // ERR_STREAM_WRITE_AFTER_END out of a detached async loop. Checking
        // only at the top of the loop is not enough: the flag flips during the
        // await.
        if (this.#readersStopped || sink.writableEnded) return
        sink.write(res.data)
        offset = res.nextOffset
        continue
      }
      // Nothing this round, so re-read from the same offset. A blocking read
      // has already spent the wait, but a peer that answers an empty read
      // immediately — an older daemon, or one configured with no long-poll —
      // would otherwise spin this loop hot enough to pin a core. Yielding
      // briefly costs a real long-poll nothing and makes that case harmless.
      await new Promise(resolve => setTimeout(resolve, IDLE_BACKOFF_MS))
    }
  }

  #emitClose(): void {
    if (this.#closed) return
    this.#closed = true
    this.#readersStopped = true
    this.stdout.end()
    this.stderr.end()
    for (const listener of this.#closeListeners) {
      try {
        listener(0, null)
      } catch (err) {
        process.stderr.write(`[NexusSpawnHandle] close listener error: ${String(err)}\n`)
      }
    }
    this.#closeListeners.clear()
  }

  on(_event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this {
    if (this.#closed) {
      listener(0, null)
      return this
    }
    this.#closeListeners.add(listener)
    return this
  }

  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this {
    return this.on(event, listener)
  }

  /**
   * Ask nexus to tear the session down. Signal is accepted for shape
   * compatibility — nexus owns the process, so the kill is a `cancel_v1` RPC
   * rather than a local signal.
   */
  kill(_signal?: NodeJS.Signals | number): boolean {
    if (this.killed) return true
    this.killed = true
    void this.agent.cancel(this.sessionId).catch((err: unknown) => {
      process.stderr.write(
        `[NexusSpawnHandle] cancel failed (session=${this.sessionId}): ${String(err)}\n`,
      )
    })
    this.#emitClose()
    return true
  }
}
