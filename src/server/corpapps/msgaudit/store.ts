/**
 * 会话存档 record storage — append-only JSONL on the filesystem.
 *
 * WHY THE FILESYSTEM, NOT SQLITE
 * ------------------------------
 * These records exist to be read by an AI agent (statistics, summaries,
 * investigation over a group's history). An agent works far better with
 * files it can glob, grep and read incrementally than with a table it
 * must query through an API. The layout below is therefore optimised for
 * "load one room's traffic for a date range" — the dominant access
 * pattern — rather than for random single-message lookup.
 *
 * LAYOUT
 * ------
 *   $MOSS_HOME/msgaudit/<corpAppId>/
 *     cursor.json                       { seq, updatedAt }
 *     rooms.json                        roomId -> { name, lastSeen, count }
 *     chat/<roomId>/<YYYY-MM-DD>.jsonl  one JSON message per line
 *
 * Partitioning by room then by day means an agent asking "summarise this
 * group last week" reads exactly 7 small files, and an agent asking for
 * a whole corp's daily volume can stat file sizes without parsing. JSONL
 * (not a JSON array) keeps writes O(1) appends and lets a reader stream
 * line-by-line without loading a day into memory.
 *
 * MOSS_HOME is bind-mounted to the host in deploy/docker-compose.yml
 * (./.moss:/root/.moss), so records written here are directly readable
 * on the host with no extra mount.
 *
 * IDEMPOTENCY
 * -----------
 * WeCom's `seq` cursor can legitimately replay (a crash between writing
 * records and committing the cursor). Appends are therefore deduplicated
 * per (room, day) against the msgids already on that line-set, so a
 * re-pull of an overlapping window does not double-count messages in
 * later aggregation.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** One archived chat message, normalized from the SDK's decrypted JSON. */
export type ChatRecord = {
  /** WeCom global sequence number — the pull cursor. */
  seq: number
  /** WeCom message id; unique per message, used for dedup. */
  msgid: string
  /** Epoch ms. */
  msgtime: number
  /** Sender userid (internal) or external_userid. */
  from: string
  /** Recipient ids; for a group this is the member list at send time. */
  to: string[]
  /** Group/room id. Empty for 1:1 chats — those bucket under `_direct`. */
  roomid: string
  /** 'text' | 'image' | 'file' | 'revoke' | ... (provider vocabulary). */
  msgtype: string
  /** Plain text when the type carries one. */
  text?: string
  /** Provider payload for non-text types, passed through unchanged. */
  payload?: Record<string, unknown>
}

/** Bucket name for 1:1 (non-group) conversations, which have no roomid. */
export const DIRECT_BUCKET = '_direct'

export function msgauditRoot(): string {
  const home = process.env.MOSS_HOME || path.join(os.homedir(), '.moss')
  return path.join(home, 'msgaudit')
}

export function appDir(corpAppId: string): string {
  return path.join(msgauditRoot(), sanitizeSegment(corpAppId))
}

/**
 * Make an id safe as a single path segment. Room ids are provider-issued
 * (base64-ish, can contain '/' and '='), so they are not usable raw — a
 * traversal here would write outside MOSS_HOME. Ids that are already
 * clean pass through readable; anything else is hashed so the mapping
 * stays stable and collision-free.
 */
export function sanitizeSegment(id: string): string {
  if (id && /^[A-Za-z0-9_-]{1,120}$/.test(id) && id !== '.' && id !== '..') return id
  return 'h_' + createHash('sha256').update(id).digest('hex').slice(0, 32)
}

/** UTC date key. Deliberately not local time: stable across TZ changes. */
export function dayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}

// ============================================================
// Cursor
// ============================================================

export type Cursor = { seq: number; updatedAt: number }

export async function readCursor(corpAppId: string): Promise<Cursor> {
  const file = path.join(appDir(corpAppId), 'cursor.json')
  try {
    const raw = await fsp.readFile(file, 'utf8')
    const c = JSON.parse(raw) as Cursor
    return { seq: Number(c.seq) || 0, updatedAt: Number(c.updatedAt) || 0 }
  } catch {
    return { seq: 0, updatedAt: 0 }
  }
}

/**
 * Persist the cursor atomically (write temp + rename). A torn cursor.json
 * would either replay the whole archive or skip records permanently, so
 * this is the one write that must never be partial.
 */
export async function writeCursor(corpAppId: string, seq: number): Promise<void> {
  const dir = appDir(corpAppId)
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'cursor.json')
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, JSON.stringify({ seq, updatedAt: Date.now() }, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

// ============================================================
// Records
// ============================================================

/**
 * Append records, grouped into per-room per-day JSONL files, skipping any
 * msgid already present in its target file.
 *
 * Returns the number of lines actually written and the highest seq seen —
 * the caller commits that seq only after this resolves, so a crash
 * mid-append replays into the dedup path rather than losing messages.
 */
export async function appendRecords(
  corpAppId: string,
  records: ChatRecord[],
): Promise<{ written: number; maxSeq: number }> {
  if (records.length === 0) return { written: 0, maxSeq: 0 }

  // Group by target file so each file is opened once per batch.
  const buckets = new Map<string, ChatRecord[]>()
  let maxSeq = 0
  for (const r of records) {
    if (r.seq > maxSeq) maxSeq = r.seq
    const room = r.roomid ? sanitizeSegment(r.roomid) : DIRECT_BUCKET
    const key = `${room}/${dayKey(r.msgtime)}`
    const list = buckets.get(key)
    if (list) list.push(r)
    else buckets.set(key, [r])
  }

  let written = 0
  for (const [key, list] of buckets) {
    const [room, day] = key.split('/')
    const dir = path.join(appDir(corpAppId), 'chat', room)
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${day}.jsonl`)

    const seen = await readMsgIds(file)
    const lines: string[] = []
    for (const r of list) {
      if (seen.has(r.msgid)) continue
      seen.add(r.msgid)
      lines.push(JSON.stringify(r))
    }
    if (lines.length === 0) continue
    await fsp.appendFile(file, lines.join('\n') + '\n', 'utf8')
    written += lines.length
  }

  return { written, maxSeq }
}

/**
 * Collect the msgids already in a JSONL file. Streams rather than
 * JSON.parse-ing whole lines: only the id is needed, and a busy group's
 * day file can hold thousands of long records.
 */
async function readMsgIds(file: string): Promise<Set<string>> {
  const ids = new Set<string>()
  let raw: string
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch {
    return ids
  }
  for (const line of raw.split('\n')) {
    if (!line) continue
    const m = line.match(/"msgid":"((?:[^"\\]|\\.)*)"/)
    if (m) ids.add(m[1])
  }
  return ids
}

// ============================================================
// Room roster (for agent-facing discovery)
// ============================================================

export type RoomMeta = { roomid: string; dir: string; count: number; lastSeen: number }

/**
 * Update the room index after a batch. This is a convenience for agents
 * and humans: without it, discovering which rooms exist means walking a
 * directory of opaque hashed names.
 */
export async function updateRooms(corpAppId: string, records: ChatRecord[]): Promise<void> {
  if (records.length === 0) return
  const file = path.join(appDir(corpAppId), 'rooms.json')
  let rooms: Record<string, RoomMeta> = {}
  try {
    rooms = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, RoomMeta>
  } catch {
    // first write
  }
  for (const r of records) {
    const roomid = r.roomid || DIRECT_BUCKET
    const dir = r.roomid ? sanitizeSegment(r.roomid) : DIRECT_BUCKET
    const cur = rooms[roomid] ?? { roomid, dir, count: 0, lastSeen: 0 }
    cur.count += 1
    if (r.msgtime > cur.lastSeen) cur.lastSeen = r.msgtime
    rooms[roomid] = cur
  }
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(rooms, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

/** List archived rooms for an instance (reads the roster index). */
export function listRooms(corpAppId: string): RoomMeta[] {
  const file = path.join(appDir(corpAppId), 'rooms.json')
  try {
    const rooms = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, RoomMeta>
    return Object.values(rooms).sort((a, b) => b.lastSeen - a.lastSeen)
  } catch {
    return []
  }
}
