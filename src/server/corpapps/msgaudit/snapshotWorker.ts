/**
 * 会话存档 daily member-snapshot scheduler.
 *
 * WeCom never reports departures, so the only way to see a customer leave
 * is to photograph every group's roster daily and diff consecutive photos
 * (members.ts). This worker takes the photos.
 *
 * WHY IT IS NOT PART OF THE PULL — the pull runs every few minutes inside a
 * forked child with a 10-minute timeout. Photographing 20,000 groups takes
 * tens of minutes of HTTPS calls; inside the pull it would either be killed
 * mid-run or starve archiving. This worker has its own timer, its own
 * concurrency, and resumes from disk on every tick.
 *
 * WHY IT RUNS IN-PROCESS — the pull is forked to contain a native SDK crash.
 * A snapshot is plain HTTPS/JSON through `fetch`, needs the corp-app
 * connector and its decrypted secrets (which live in this process), and the
 * work is network-bound. Forking would mean relaying every lookup back over
 * IPC for no isolation benefit.
 *
 * WHAT GETS PHOTOGRAPHED — the uploaded room list (roomList.ts) unioned with
 * rooms.json. rooms.json alone only knows groups that have spoken.
 *
 * RESUMING — every tick recomputes what is missing from disk
 * (`snapshotExists`), so a restart, a crash or a throttle pause costs
 * nothing but time. Writes are tmp+rename, so a half-written photo never
 * exists.
 *
 * DAY BOUNDARY — "today" is members.ts's `dayKey` (UTC). A run that straddles
 * midnight UTC leaves the new day incomplete; the next tick finishes it.
 */

import {
  computeAndWriteLeaves,
  leavesExist,
  readLastUpdated,
  snapshotExists,
  writeLastUpdated,
  writeSnapshot,
  type RosterInfo,
} from './members.js'
import { dayKey, listRooms, updateRoomNames } from './store.js'
import { readRoomList, snapshotRoomSet } from './roomList.js'

/**
 * One instance to photograph.
 *
 * `rosterLookup` returns null for a DEFINITIVE "this room has no roster"
 * (an internal group, a dissolved or invisible chat) and THROWS for anything
 * that might succeed on retry (rate limit, token failure, network). The
 * distinction is the whole point: treating a throttle as "no roster" would
 * mark the day complete with photos missing and then report phantom
 * departures.
 */
export type SnapshotTarget = {
  corpAppId: string
  rosterLookup: (roomId: string) => Promise<RosterInfo | null>
}

export type SnapshotProvider = () => Promise<SnapshotTarget[]>

export type SnapshotWorkerOptions = {
  intervalSec?: number
  concurrency?: number
}

export type SnapshotRunResult = {
  rooms: number
  photographed: number
  skipped: number
  failed: number
  complete: boolean
  leaves?: number
}

/**
 * Gap between passes. A pass runs until its todo list is done (however long
 * that takes), then waits this long. Hourly is enough: the snapshot is a daily
 * photo, and the next tick only has to retry stragglers and catch the new day.
 */
const DEFAULT_INTERVAL_SEC = 60 * 60
const DEFAULT_CONCURRENCY = 4
const INITIAL_DELAY_MS = 30_000
const ROOM_ATTEMPTS = 3
const THROTTLE_PAUSE_MS = 60_000

function envInt(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    console.warn(`[msgaudit-snapshot] ignoring ${name}=${raw} (need an integer in ${min}..${max}); using ${fallback}`)
    return fallback
  }
  return n
}

/** WeCom "freq out of limit". Everything else with an errcode is a final answer. */
export function isThrottle(err: unknown): boolean {
  return /errcode=45009\b/.test(err instanceof Error ? err.message : String(err))
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Run `fn` over `items` with at most `n` in flight. No dependency needed for this. */
export async function runWithConcurrency<T>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      await fn(item as T)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker))
}

export class RosterSnapshotWorker {
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private inflight = new Set<string>()
  private readonly intervalMs: number
  private readonly concurrency: number
  /**
   * Rooms that answered "no roster" today, per instance. Without this a
   * tick would re-ask every internal or dissolved group in a
   * 20,000-room list forever. Lost on restart: one extra pass, acceptable.
   */
  private skipped = new Map<string, { day: string; ids: Set<string> }>()
  /** Set when WeCom throttles; every worker waits it out together. */
  private pauseUntil = 0

  constructor(
    private listTargets: SnapshotProvider,
    opts: SnapshotWorkerOptions = {},
  ) {
    this.intervalMs =
      (opts.intervalSec ?? envInt('MOSS_MSGAUDIT_SNAPSHOT_INTERVAL_SEC', DEFAULT_INTERVAL_SEC, 60)) * 1000
    this.concurrency =
      opts.concurrency ?? envInt('MOSS_MSGAUDIT_SNAPSHOT_CONCURRENCY', DEFAULT_CONCURRENCY, 1, 16)
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    const tick = () => {
      if (this.stopped) return
      this.tickOnce()
        .catch((err) => console.error('[msgaudit-snapshot] tick error:', err))
        .finally(() => {
          // Armed here, not on an interval: a pass that outlasts the interval
          // simply delays the next one, so two passes can never overlap.
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

  private async tickOnce(): Promise<void> {
    const targets = await this.listTargets()
    for (const t of targets) {
      if (this.stopped) return
      if (this.inflight.has(t.corpAppId)) continue
      this.inflight.add(t.corpAppId)
      try {
        await this.snapshotInstance(t)
      } catch (err) {
        console.error(`[msgaudit-snapshot] ${t.corpAppId} failed:`, err instanceof Error ? err.message : err)
      } finally {
        this.inflight.delete(t.corpAppId)
      }
    }
  }

  /** One pass over one instance. Exported for tests via the class. */
  async snapshotInstance(t: SnapshotTarget): Promise<SnapshotRunResult> {
    const id = t.corpAppId
    const today = dayKey(Date.now())
    const rooms = snapshotRoomSet(await readRoomList(id), listRooms(id))

    let skip = this.skipped.get(id)
    if (!skip || skip.day !== today) {
      skip = { day: today, ids: new Set() }
      this.skipped.set(id, skip)
    }

    // Resume: only what has no photo today and has not already said "no roster".
    const todo: string[] = []
    for (const roomId of rooms) {
      if (skip.ids.has(roomId)) continue
      if (await snapshotExists(id, roomId, today)) continue
      todo.push(roomId)
    }

    let photographed = 0
    let failed = 0
    const names: Record<string, string> = {}

    await runWithConcurrency(todo, this.concurrency, async (roomId) => {
      for (let attempt = 1; attempt <= ROOM_ATTEMPTS; attempt++) {
        if (this.stopped) return
        const wait = this.pauseUntil - Date.now()
        if (wait > 0) await sleep(wait)
        try {
          const info = await t.rosterLookup(roomId)
          if (!info || info.members.length === 0) {
            skip!.ids.add(roomId)
            return
          }
          await writeSnapshot(id, roomId, info.members, Date.now(), {
            roomName: info.roomName,
            memberNames: info.memberNames,
          })
          if (info.roomName) names[roomId] = info.roomName
          photographed += 1
          return
        } catch (err) {
          if (isThrottle(err)) {
            // The limit is per corp, not per room: pause everyone, not just
            // this worker, or the other three keep hammering it.
            this.pauseUntil = Math.max(this.pauseUntil, Date.now() + THROTTLE_PAUSE_MS * attempt)
          } else if (attempt < ROOM_ATTEMPTS) {
            await sleep(500 * attempt)
          }
          if (attempt === ROOM_ATTEMPTS) {
            failed += 1
            console.error(
              `[msgaudit-snapshot] ${id} ${roomId} failed after ${ROOM_ATTEMPTS} attempts:`,
              err instanceof Error ? err.message : err,
            )
          }
        }
      }
    })

    if (Object.keys(names).length > 0) {
      await updateRoomNames(id, names).catch((err) => {
        // Cosmetic: the photos already hold the names and the next run retries.
        console.error('[msgaudit-snapshot] annotating rooms.json failed:', err instanceof Error ? err.message : err)
      })
    }

    // A room that failed leaves the day incomplete, so phase 2 holds off
    // rather than diffing against a half-built picture.
    const complete = failed === 0 && !this.stopped && rooms.length > 0
    if (complete) await writeLastUpdated(id, today).catch(() => {})

    let leaves: number | undefined
    if ((await readLastUpdated(id)) === today && !(await leavesExist(id, today))) {
      leaves = await computeAndWriteLeaves(id, rooms, today).catch((err) => {
        console.error('[msgaudit-snapshot] writing leaves failed:', err instanceof Error ? err.message : err)
        return undefined
      })
    }

    const result: SnapshotRunResult = {
      rooms: rooms.length,
      photographed,
      skipped: skip.ids.size,
      failed,
      complete,
      leaves,
    }
    if (todo.length > 0 || leaves !== undefined) {
      console.log(
        `[msgaudit-snapshot] ${id}: photographed ${photographed}/${rooms.length} ` +
          `(todo ${todo.length}, skipped ${skip.ids.size}, failed ${failed}) complete=${complete}` +
          (leaves !== undefined ? ` leaves=${leaves}` : ''),
      )
    }
    return result
  }
}
