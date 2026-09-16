/**
 * Daily retention sweep for downloaded 会话存档 media.
 *
 * Only media is purged: transcripts are small and are the part worth
 * keeping indefinitely, while the images and files are what actually
 * consume disk. Media is stored one directory per day, so a sweep is a
 * handful of directory removals rather than a walk over every file.
 *
 * Runs on its own timer rather than inside the pull loop: a pull happens
 * every few minutes and retention only changes once a day, so doing it
 * per-pull would be 288x the work for the same result — and a slow sweep
 * would sit in front of message archiving, which must not wait.
 */

import { purgeMediaBefore } from './mediaIndex.js'

/** One sweep per day is enough for date-granular retention. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

/** First sweep shortly after boot, so a misconfiguration surfaces early. */
const INITIAL_DELAY_MS = 5 * 60 * 1000

/** Backoff schedule for a failed sweep: 1min, 2, 4, 8, 16 then give up. */
const RETRY_BASE_MS = 60 * 1000
const MAX_RETRIES = 5

/** An instance due for purging, resolved fresh on every sweep. */
export type RetentionTarget = { corpAppId: string; retentionDays: number }
export type RetentionProvider = () => Promise<RetentionTarget[]>

export class MediaPurgeWorker {
  private timer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(private listTargets: RetentionProvider) {}

  start(): void {
    if (this.timer) return
    this.stopped = false
    const tick = () => {
      if (this.stopped) return
      this.sweepWithRetry()
        .catch((err) => console.error('[msgaudit-purge] sweep error:', err))
        .finally(() => {
          if (!this.stopped) {
            this.timer = setTimeout(tick, SWEEP_INTERVAL_MS)
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

  /**
   * Retry with exponential backoff. A transient failure (a file briefly
   * locked, a full disk being cleared) should not mean waiting a whole
   * day for the next attempt; a persistent one gives up and lets the
   * next daily tick try again rather than looping forever.
   */
  private async sweepWithRetry(): Promise<void> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (this.stopped) return
      try {
        await this.sweepOnce()
        return
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          console.error(
            `[msgaudit-purge] giving up after ${MAX_RETRIES + 1} attempts:`,
            err instanceof Error ? err.message : err,
          )
          return
        }
        const delay = RETRY_BASE_MS * 2 ** attempt
        console.warn(
          `[msgaudit-purge] attempt ${attempt + 1} failed (${err instanceof Error ? err.message : err}); ` +
            `retrying in ${Math.round(delay / 1000)}s`,
        )
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  private async sweepOnce(): Promise<void> {
    // Targets are re-read each sweep so a retention change takes effect
    // on the next run without a restart.
    const targets = await this.listTargets()
    for (const t of targets) {
      if (!(t.retentionDays >= 1)) continue
      const cutoff = new Date(Date.now() - t.retentionDays * 24 * 60 * 60 * 1000)
      const r = await purgeMediaBefore(t.corpAppId, cutoff)
      if (r.days > 0 || r.files > 0) {
        console.log(
          `[msgaudit-purge] ${t.corpAppId}: removed ${r.files} files across ${r.days} day(s) ` +
            `older than ${cutoff.toISOString().slice(0, 10)} (retention ${t.retentionDays}d)`,
        )
      }
    }
  }
}
