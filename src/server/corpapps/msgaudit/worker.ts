/**
 * 会话存档 pull scheduler.
 *
 * Follows SourceSyncWorker's shape (sources/syncWorker.ts): a self-
 * rescheduling unref'd timer, a per-instance mutex so a manual trigger
 * cannot overlap a tick, and errors logged rather than thrown into the
 * timer.
 *
 * CRASH ISOLATION — each pull runs in a forked child process. The WeCom
 * finance SDK is a black-box native library; a segfault inside it is not
 * a catchable JS exception and would take the whole server down. Forking
 * confines that to a restartable child, which is the one real advantage
 * a sidecar would have offered, without a second deployment unit.
 */

import { fork } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PullConfig, PullResult } from './puller.js'

/**
 * Locate the forked child's entrypoint.
 *
 * The server ships as a single bundled bin/moss-server.mjs, so this file
 * has no sibling pullChild.js at runtime — scripts/build.js emits the
 * child as its own bundle next to the server binary. In a dev checkout
 * (running from src/) the TS sibling is used instead.
 */
function pullChildPath(): string {
  if (process.env.MOSS_MSGAUDIT_CHILD) return process.env.MOSS_MSGAUDIT_CHILD
  const here = path.dirname(fileURLToPath(import.meta.url))
  // Bundled: /app/bin/moss-server.mjs -> /app/bin/msgaudit-pull-child.js
  const bundled = path.join(here, 'msgaudit-pull-child.js')
  if (fs.existsSync(bundled)) return bundled
  // Dev checkout: run the TypeScript entrypoint directly.
  return path.join(here, 'pullChild.ts')
}

/** How often to poll each enabled archive instance (seconds). */
const DEFAULT_INTERVAL_SEC = 5 * 60

/** A child that outlives this is assumed wedged in native code. */
const CHILD_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Pages per instance per tick while catching up.
 *
 * A first run starts at seq=0 and would otherwise drain WeCom's entire
 * retention window in one pass — for a corp with many groups that is a
 * long, unbounded run holding a native SDK session open. Capping pages
 * per tick spreads the backfill over successive ticks instead; the
 * cursor is committed per page, so each tick simply resumes where the
 * last stopped. 0 disables the cap (drain fully).
 */
const DEFAULT_MAX_PAGES_PER_TICK = 20

export type MsgAuditWorkerOptions = {
  /** Poll interval in seconds. Env: MOSS_MSGAUDIT_INTERVAL_SEC. */
  intervalSec?: number
  /** Pages per instance per tick. Env: MOSS_MSGAUDIT_MAX_PAGES. */
  maxPagesPerTick?: number
}

/** Read a positive-integer setting from env, falling back to `dflt`. */
function envInt(name: string, dflt: number, min: number): number {
  const raw = process.env[name]
  if (!raw) return dflt
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min) {
    console.warn(`[msgaudit] ignoring ${name}=${raw} (must be a number >= ${min})`)
    return dflt
  }
  return Math.floor(n)
}

/**
 * Run one pull in a child process. Resolves with the child's result, or
 * rejects if it crashes, times out, or reports an error — all of which
 * the caller treats as "try again next tick".
 */
export function pullInChild(cfg: PullConfig): Promise<PullResult> {
  return new Promise((resolve, reject) => {
    const child = fork(pullChildPath(), [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })

    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL')
        reject(new Error(`msgaudit: pull timed out after ${CHILD_TIMEOUT_MS}ms`))
      })
    }, CHILD_TIMEOUT_MS)
    timer.unref()

    child.on('message', (msg: { ok: boolean; result?: PullResult; error?: string }) => {
      finish(() => {
        child.kill()
        if (msg.ok && msg.result) resolve(msg.result)
        else reject(new Error(msg.error || 'msgaudit: pull failed'))
      })
    })

    child.on('error', (err) => finish(() => reject(err)))

    child.on('exit', (code, signal) => {
      // Only meaningful if no message arrived: a native crash exits
      // without ever reporting, and that is exactly what we isolate.
      finish(() =>
        reject(new Error(`msgaudit: pull child exited (code=${code}, signal=${signal}) without a result`)),
      )
    })

    child.send(cfg)
  })
}

/** Resolves the archive instances to poll, supplied by the server. */
export type InstanceProvider = () => Promise<PullConfig[]>

export class MsgAuditWorker {
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private inflight = new Set<string>()

  private readonly intervalMs: number
  private readonly maxPagesPerTick: number

  constructor(
    private listInstances: InstanceProvider,
    opts: MsgAuditWorkerOptions = {},
  ) {
    // Explicit options win over env so tests and callers can pin values;
    // the floor of 30s keeps a typo from turning this into a hot loop.
    this.intervalMs =
      (opts.intervalSec ?? envInt('MOSS_MSGAUDIT_INTERVAL_SEC', DEFAULT_INTERVAL_SEC, 30)) * 1000
    this.maxPagesPerTick =
      opts.maxPagesPerTick ?? envInt('MOSS_MSGAUDIT_MAX_PAGES', DEFAULT_MAX_PAGES_PER_TICK, 0)
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    const tick = () => {
      if (this.stopped) return
      this.tickOnce()
        .catch((err) => console.error('[MsgAuditWorker] tick error:', err))
        .finally(() => {
          if (!this.stopped) {
            this.timer = setTimeout(tick, this.intervalMs)
            this.timer.unref()
          }
        })
    }
    this.timer = setTimeout(tick, 10_000)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async tickOnce(): Promise<void> {
    const instances = await this.listInstances()
    for (const cfg of instances) {
      if (this.inflight.has(cfg.corpAppId)) continue
      this.inflight.add(cfg.corpAppId)
      try {
        const r = await pullInChild({ ...cfg, maxPages: this.maxPagesPerTick })
        if (r.written > 0 || r.failed > 0) {
          const capped = this.maxPagesPerTick > 0 && r.pages >= this.maxPagesPerTick
          console.log(
            `[msgaudit] ${cfg.corpAppId}: fetched=${r.fetched} written=${r.written} ` +
              `failed=${r.failed} cursor=${r.cursor}` +
              (capped ? ` (page cap reached; resuming next tick)` : ''),
          )
        }
      } catch (err) {
        console.error(`[msgaudit] ${cfg.corpAppId} pull failed:`, err instanceof Error ? err.message : err)
      } finally {
        this.inflight.delete(cfg.corpAppId)
      }
    }
  }
}
