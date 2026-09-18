/**
 * Daily group-membership snapshots, and the departures derived from them.
 *
 * WeCom's archive stream carries messages, not membership events: nobody
 * is told when a customer leaves a group. The only way to notice is to
 * photograph the roster periodically and diff consecutive photographs.
 *
 * Layout, beside the transcripts:
 *
 *   members/<roomId>/<YYYY-MM-DD>.json   roster as of that day's snapshot
 *   members/lastupdated.json             the day fully photographed last
 *   members/leaves/<YYYY-MM-DD>.json     departures computed on that day
 *
 * Two phases, each guarded so they run once per day regardless of how
 * often pulling happens:
 *
 *   1. snapshot every room in rooms.json that has no photo for today
 *   2. once every room is photographed, diff against each room's previous
 *      photo and write one leaves file for the day
 *
 * Phase 2 is keyed on the CURRENT date, so the file answers "what did we
 * learn today". The window it actually covers is in `previousDate`:
 * normally yesterday, but after an outage it can be several days back,
 * since the only honest comparison is against the last photo that
 * exists.
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
  /** The snapshot this was computed against — today, normally. */
  currentDate: string
  /**
   * The earlier snapshot. Usually yesterday; after an outage it can be
   * days back, which is exactly why it is recorded rather than assumed.
   * Null when this room has no earlier photo (first day seen).
   */
  previousDate: string | null
  /** External userids present in the previous photo, absent in the current. */
  leaves: string[]
}

/** One day's departure computation, across every room. */
export type LeavesFile = {
  date: string
  computedAt: number
  rooms: LeaveRecord[]
}

function membersDir(corpAppId: string, roomId: string): string {
  return path.join(appDir(corpAppId), 'members', sanitizeSegment(roomId))
}

function leavesFile(corpAppId: string, date: string): string {
  return path.join(appDir(corpAppId), 'members', 'leaves', `${date}.json`)
}

function lastUpdatedFile(corpAppId: string): string {
  return path.join(appDir(corpAppId), 'members', 'lastupdated.json')
}

/** The last date on which every known room was photographed. */
export async function readLastUpdated(corpAppId: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(lastUpdatedFile(corpAppId), 'utf8')
    const parsed = JSON.parse(raw) as { date?: unknown }
    return typeof parsed.date === 'string' ? parsed.date : null
  } catch {
    return null
  }
}

/**
 * Mark a day as fully photographed. Written only after every room in
 * rooms.json has a snapshot, so it doubles as the gate for phase 2 — a
 * partial day must not produce a departure list.
 */
export async function writeLastUpdated(corpAppId: string, date: string): Promise<void> {
  const file = lastUpdatedFile(corpAppId)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, JSON.stringify({ date, at: Date.now() }, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

/** Whether the departure list for `date` has already been computed. */
export async function leavesExist(corpAppId: string, date: string): Promise<boolean> {
  try {
    await fsp.access(leavesFile(corpAppId, date))
    return true
  } catch {
    return false
  }
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

export async function readLeaves(corpAppId: string, date: string): Promise<LeavesFile | null> {
  try {
    const raw = await fsp.readFile(leavesFile(corpAppId, date), 'utf8')
    return JSON.parse(raw) as LeavesFile
  } catch {
    return null
  }
}

/**
 * Write one day's departure list.
 *
 * Always written, even when nobody left: an empty file means "computed,
 * nothing found", while a missing file means "not computed yet" — and
 * phase 2 keys off exactly that distinction.
 */
export async function writeLeaves(
  corpAppId: string,
  date: string,
  rooms: LeaveRecord[],
): Promise<void> {
  const file = leavesFile(corpAppId, date)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const payload: LeavesFile = { date, computedAt: Date.now(), rooms }
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
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
