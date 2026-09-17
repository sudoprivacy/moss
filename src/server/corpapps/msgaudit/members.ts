/**
 * Daily group-membership snapshots, and the departures derived from them.
 *
 * WeCom's archive stream carries messages, not membership events: nobody
 * is told when a customer leaves a group. The only way to notice is to
 * photograph the roster periodically and diff consecutive photographs.
 *
 * Snapshots are taken once per day, on the first pull after midnight, and
 * stored beside the transcripts:
 *
 *   members/<roomId>/<YYYY-MM-DD>.json   roster as of that day's first pull
 *   leaves.json                          departures, keyed by room + date
 *
 * A departure is dated to the EARLIER snapshot — comparing 9/9 with 9/10
 * yields entries dated 9/9, meaning "gone sometime after the 9/9 photo".
 * Since the first pull of a day lands minutes after midnight, that reads
 * as "left during 9/9", which is what an operator expects.
 *
 * Only external members (`wo_`/`wm_` prefixed) are reported: staff leaving
 * a group is ordinary churn, while a customer leaving is the signal worth
 * surfacing.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { appDir, dayKey, sanitizeSegment } from './store.js'

/** One day's roster for one room. */
export type MemberSnapshot = {
  roomid: string
  date: string
  /** Member userids present at snapshot time. */
  members: string[]
  /** Epoch ms the snapshot was taken. */
  takenAt: number
}

/** Departures observed for one room between two consecutive snapshots. */
export type LeaveRecord = {
  roomid: string
  /** Date of the EARLIER snapshot — departures happened after it. */
  date: string
  /** External userids present then, absent now. */
  leaves: string[]
  /** The later snapshot this was computed against, for traceability. */
  comparedWith: string
}

function membersDir(corpAppId: string, roomId: string): string {
  return path.join(appDir(corpAppId), 'members', sanitizeSegment(roomId))
}

function leavesFile(corpAppId: string): string {
  return path.join(appDir(corpAppId), 'leaves.json')
}

/** External ids are prefixed by WeCom; everything else is an employee. */
export function isExternalId(id: string): boolean {
  return /^(wo|wm)_/.test(id)
}

export async function writeSnapshot(
  corpAppId: string,
  roomId: string,
  members: string[],
  takenAt = Date.now(),
): Promise<MemberSnapshot> {
  const date = dayKey(takenAt)
  const dir = membersDir(corpAppId, roomId)
  await fsp.mkdir(dir, { recursive: true })
  const snap: MemberSnapshot = {
    roomid: roomId,
    date,
    members: [...new Set(members)].sort(),
    takenAt,
  }
  const file = path.join(dir, `${date}.json`)
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(snap, null, 2), 'utf8')
  await fsp.rename(tmp, file)
  return snap
}

export async function readSnapshot(
  corpAppId: string,
  roomId: string,
  date: string,
): Promise<MemberSnapshot | null> {
  try {
    const raw = await fsp.readFile(path.join(membersDir(corpAppId, roomId), `${date}.json`), 'utf8')
    return JSON.parse(raw) as MemberSnapshot
  } catch {
    return null
  }
}

/**
 * The most recent snapshot strictly before `date`.
 *
 * Deliberately not "yesterday": pulling can be paused, the server can be
 * down, a room can go quiet. Comparing against whatever photo came last
 * keeps the diff correct across gaps, at the cost of the window
 * occasionally spanning more than a day — which `comparedWith` makes
 * visible.
 */
export async function previousSnapshot(
  corpAppId: string,
  roomId: string,
  date: string,
): Promise<MemberSnapshot | null> {
  let files: string[]
  try {
    files = await fsp.readdir(membersDir(corpAppId, roomId))
  } catch {
    return null
  }
  const dates = files
    .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < date)
    .sort()
  const prev = dates[dates.length - 1]
  return prev ? readSnapshot(corpAppId, roomId, prev) : null
}

/** External members present in `before` but gone from `after`. */
export function diffExternalLeaves(before: MemberSnapshot, after: MemberSnapshot): string[] {
  const present = new Set(after.members)
  return before.members.filter((id) => isExternalId(id) && !present.has(id)).sort()
}

export async function readLeaves(corpAppId: string): Promise<LeaveRecord[]> {
  try {
    const raw = await fsp.readFile(leavesFile(corpAppId), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as LeaveRecord[]) : []
  } catch {
    return []
  }
}

/**
 * Merge new departure records into leaves.json.
 *
 * Keyed by room+date so a re-run replaces rather than duplicates: the
 * same two snapshots always yield the same answer, and an operator
 * re-running a day should not see it twice.
 */
export async function appendLeaves(corpAppId: string, records: LeaveRecord[]): Promise<void> {
  if (records.length === 0) return
  const existing = await readLeaves(corpAppId)
  const byKey = new Map(existing.map((r) => [`${r.roomid}|${r.date}`, r]))
  for (const r of records) byKey.set(`${r.roomid}|${r.date}`, r)
  const merged = [...byKey.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.roomid.localeCompare(b.roomid),
  )
  const file = leavesFile(corpAppId)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(merged, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

/**
 * Whether today's snapshot for this room has already been taken.
 *
 * Membership is photographed once a day; pulls run every few minutes, so
 * without this the roster would be fetched ~288 times a day per room.
 */
export async function snapshotExists(
  corpAppId: string,
  roomId: string,
  date = dayKey(Date.now()),
): Promise<boolean> {
  return (await readSnapshot(corpAppId, roomId, date)) !== null
}
