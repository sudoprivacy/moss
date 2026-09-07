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

/** How often to poll each enabled archive instance. */
const TICK_INTERVAL_MS = 5 * 60 * 1000

/** A child that outlives this is assumed wedged in native code. */
const CHILD_TIMEOUT_MS = 10 * 60 * 1000

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

  constructor(private listInstances: InstanceProvider) {}

  start(): void {
    if (this.timer) return
    this.stopped = false
    const tick = () => {
      if (this.stopped) return
      this.tickOnce()
        .catch((err) => console.error('[MsgAuditWorker] tick error:', err))
        .finally(() => {
          if (!this.stopped) {
            this.timer = setTimeout(tick, TICK_INTERVAL_MS)
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
        const r = await pullInChild(cfg)
        if (r.written > 0 || r.failed > 0) {
          console.log(
            `[msgaudit] ${cfg.corpAppId}: fetched=${r.fetched} written=${r.written} failed=${r.failed} cursor=${r.cursor}`,
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
