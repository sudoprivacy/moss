/**
 * Background sweeper for the 群发 queue: on a timer, for every corp app that
 * has a queue, settle → reap expired entries → withdraw their WeCom tasks →
 * retry withdrawals that failed earlier. See queueSweep.ts for why.
 *
 * Env:
 *   MOSS_QUEUE_SWEEP_INTERVAL_MIN   minutes between passes (default 30; 0 disables)
 *   MOSS_QUEUE_SWEEP_CANCEL_WECOM   "0" to reap without withdrawing at WeCom (default on)
 *
 * Single-process like the queue's own lock: a second moss-server sharing the
 * same MOSS_HOME would need a cross-process lock (see groupMsgQueue.ts).
 */
import { listQueueCorpAppIds } from './groupMsgQueue.js'
import { sweepQueue, type SweepResult } from './queueSweep.js'
import type { CorpAppConnector } from './types.js'

const DEFAULT_INTERVAL_MIN = 30
const INITIAL_DELAY_MS = 60_000

export type SweepTarget = { corpAppId: string; connector: () => Promise<CorpAppConnector | null> }

export class QueueSweepWorker {
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private readonly intervalMs: number
  private readonly cancelWecom: boolean

  constructor(
    /** Resolves a corp app id to a connector factory, or null to skip it (missing/disabled/other type). */
    private resolve: (corpAppId: string) => SweepTarget | null,
    opts: { intervalMin?: number; cancelWecom?: boolean } = {},
  ) {
    const envMin = Number.parseFloat(process.env.MOSS_QUEUE_SWEEP_INTERVAL_MIN ?? '')
    const min = opts.intervalMin ?? (Number.isFinite(envMin) && envMin >= 0 ? envMin : DEFAULT_INTERVAL_MIN)
    this.intervalMs = min * 60_000
    this.cancelWecom = opts.cancelWecom ?? process.env.MOSS_QUEUE_SWEEP_CANCEL_WECOM !== '0'
  }

  start(): void {
    if (this.timer || this.intervalMs <= 0) return
    this.stopped = false
    const tick = () => {
      if (this.stopped) return
      this.tickOnce()
        .catch((err) => console.error('[queue-sweep] tick error:', err))
        .finally(() => {
          // Armed after each pass, so a slow pass delays the next instead of overlapping it.
          if (!this.stopped) {
            this.timer = setTimeout(tick, this.intervalMs)
            this.timer.unref()
          }
        })
    }
    this.timer = setTimeout(tick, INITIAL_DELAY_MS)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** One pass over every queue. Exposed for tests. */
  async tickOnce(now?: Date): Promise<Record<string, SweepResult>> {
    const out: Record<string, SweepResult> = {}
    for (const corpAppId of await listQueueCorpAppIds()) {
      const target = this.resolve(corpAppId)
      if (!target) continue
      try {
        const r = await sweepQueue(corpAppId, await target.connector(), { now, cancelWecom: this.cancelWecom })
        out[corpAppId] = r
        const failed = r.reaped.filter((x) => x.msgid && !x.wecomCancelled).length + r.retried.filter((x) => !x.ok).length
        if (r.reaped.length || r.retried.length || r.reconciled.length) {
          console.log(
            `[queue-sweep] ${corpAppId}: settled ${r.reconciled.length}, reaped ${r.reaped.length}, ` +
              `withdrawal retries ${r.retried.length}` + (failed ? `, withdrawals still failing ${failed}` : ''),
          )
        }
      } catch (err) {
        console.error(`[queue-sweep] ${corpAppId}:`, err instanceof Error ? err.message : err)
      }
    }
    return out
  }
}
