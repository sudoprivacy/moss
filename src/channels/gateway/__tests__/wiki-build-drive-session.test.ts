import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { WikiJobExecutor } from '../WikiJobExecutor.js'
import type { RuntimeService } from '../../../server/runtimeService.js'
import type { DocumentStore } from '../../../server/documentStore.js'
import type { DirectConnectStore } from '../../../server/db.js'

/**
 * Regression tests for WikiJobExecutor.driveSession failure surfacing.
 *
 * Before this fix, driveSession resolved `{ ok: true }` on ANY socket
 * `close`/`exit`, so a session runner that crashed at startup (the classic
 * symptom of a corrupted/split SQLite WAL, where the runner's session_events
 * insert fails the `sessions` foreign key) was reported as success — and the
 * build then failed downstream with the misleading "WIKI.md was not produced".
 *
 * These tests drive the real driveSession against a mock attach socket and
 * assert that:
 *   - a clean run WITH agent output still succeeds,
 *   - a runner that closes/exits BEFORE any agent output is a failure,
 *   - a non-zero exit code is a failure carrying the runner's stderr,
 * so the caller surfaces the real reason instead of masking it.
 *
 * driveSession only touches docStore.updateBuildJob + handleAgentLine, so the
 * runtime/db deps are stubbed. The method is private; we reach it through a
 * typed cast, matching how the runner-reschedule test exercises internal logic.
 */

type DriveResult = { ok: boolean; error?: string }

function makeExecutor(): {
  drive: (socket: EventEmitter, jobId: string, prompt: string) => Promise<DriveResult>
} {
  const docStore = {
    // driveSession calls this on progress; a no-op stub is enough.
    updateBuildJob: () => {},
  } as unknown as DocumentStore
  const runtime = {} as unknown as RuntimeService
  const db = {} as unknown as DirectConnectStore

  const executor = new WikiJobExecutor(runtime, docStore, db)
  // driveSession is private; cast to reach it (see file header).
  const drive = (executor as unknown as {
    driveSession: (
      socket: EventEmitter,
      jobId: string,
      prompt: string,
    ) => Promise<DriveResult>
  }).driveSession.bind(executor)
  return { drive }
}

/** A minimal duplex-ish mock: driveSession only reads events and calls
 *  socket.write()/socket.writable + removeAllListeners on settle. */
function makeMockSocket(): EventEmitter & {
  writable: boolean
  write: (s: string) => boolean
  destroy: () => void
} {
  const sock = new EventEmitter() as EventEmitter & {
    writable: boolean
    write: (s: string) => boolean
    destroy: () => void
  }
  sock.writable = true
  sock.write = () => true
  sock.destroy = () => {}
  return sock
}

/** Emit a runner protocol frame the way the real attach socket does:
 *  newline-delimited JSON on the 'data' channel. */
function emitFrame(sock: EventEmitter, obj: unknown): void {
  sock.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8'))
}

describe('WikiJobExecutor.driveSession failure surfacing', () => {
  it('succeeds when the agent produced output then exited cleanly', async () => {
    const { drive } = makeExecutor()
    const sock = makeMockSocket()
    const p = drive(sock, 'job-1', 'go')
    // A real agent stdout line (assistant text) counts as progress.
    emitFrame(sock, {
      type: 'stdout',
      line: JSON.stringify({ type: 'assistant', text: '正在阅读文档' }),
    })
    emitFrame(sock, { type: 'exit', code: 0, signal: null })
    const result = await p
    expect(result.ok).toBe(true)
  })

  it('fails when the runner closes before producing any output (startup crash)', async () => {
    const { drive } = makeExecutor()
    const sock = makeMockSocket()
    const p = drive(sock, 'job-2', 'go')
    // Runner died in start() before the backend spawned: no stdout, just close.
    sock.emit('close')
    const result = await p
    expect(result.ok).toBe(false)
    expect(result.error).toContain('before producing any output')
  })

  it('fails and surfaces stderr when the runner reports it then dies', async () => {
    const { drive } = makeExecutor()
    const sock = makeMockSocket()
    const p = drive(sock, 'job-3', 'go')
    // #fail broadcasts the concrete reason as stderr, then exit(1), before
    // its own DB writes (which may also FK-fail) run.
    emitFrame(sock, { type: 'stderr', line: 'Error: FOREIGN KEY constraint failed' })
    emitFrame(sock, { type: 'exit', code: 1, signal: null })
    const result = await p
    expect(result.ok).toBe(false)
    expect(result.error).toContain('FOREIGN KEY constraint failed')
  })

  it('fails on a non-zero exit code even without stderr', async () => {
    const { drive } = makeExecutor()
    const sock = makeMockSocket()
    const p = drive(sock, 'job-4', 'go')
    emitFrame(sock, { type: 'exit', code: 137, signal: 'SIGKILL' })
    const result = await p
    expect(result.ok).toBe(false)
    expect(result.error).toContain('137')
  })

  it('still succeeds on close AFTER the agent produced output', async () => {
    const { drive } = makeExecutor()
    const sock = makeMockSocket()
    const p = drive(sock, 'job-5', 'go')
    emitFrame(sock, {
      type: 'stdout',
      line: JSON.stringify({ type: 'assistant', text: '写入 WIKI.md' }),
    })
    // Socket closes with no explicit exit frame — normal enough once work ran.
    sock.emit('close')
    const result = await p
    expect(result.ok).toBe(true)
  })
})
