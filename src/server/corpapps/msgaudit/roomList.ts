/**
 * Uploaded room-id list for the daily member snapshot.
 *
 * WHY THIS EXISTS — rooms.json is built from the message stream, so a group
 * appears there only after it has produced one archived message. A corp
 * whose archive member sits in thousands of groups would otherwise only ever
 * photograph the few that happen to chat. An admin uploads a file (txt / csv
 * / xlsx — typically the 群活跃度看板) and every `wr_` id found in it joins
 * the snapshot set.
 *
 * SCOPE — the list widens the SNAPSHOT set only. It never filters which
 * messages are archived (that is `roomFilter`), and it is unioned with
 * rooms.json rather than replacing it, so a chatty room that is missing from
 * the file still gets photographed.
 *
 * Layout, beside the transcripts:
 *
 *   roomlist.json              { roomIds, count, ignored, fileName, uploadedAt, source }
 *   roomlist/<file name>       the uploaded bytes, kept for audit / re-parse
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import iconv from 'iconv-lite'
import { appDir, DIRECT_BUCKET, type RoomMeta } from './store.js'

/**
 * External group ids as WeCom issues them: `wr_` + a base64url body.
 *
 * Lookarounds rather than `\b`: the body may legitimately end in `-` or `_`,
 * which are non-word/word characters respectively, and `\b` would either
 * miss the id or truncate it. Length bounds keep a stray `wr_` in prose
 * from matching.
 */
export const EXTERNAL_ROOM_ID_RE = /(?<![A-Za-z0-9_-])wr_[A-Za-z0-9_-]{20,40}(?![A-Za-z0-9_-])/g

/** Contact ids that sometimes sit in the same column. Counted, never kept. */
const CONTACT_ID_RE = /(?<![A-Za-z0-9_-])w[om]_[A-Za-z0-9_-]{20,40}(?![A-Za-z0-9_-])/g

/** Only these XML parts of an xlsx can hold cell text. */
const XLSX_TEXT_PARTS = /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/

export type RoomListFile = {
  roomIds: string[]
  count: number
  /** wo_/wm_ ids seen in the file and dropped. */
  ignored: number
  fileName: string
  uploadedAt: number
  source: 'upload'
}

function roomListFile(corpAppId: string): string {
  return path.join(appDir(corpAppId), 'roomlist.json')
}

function roomListDir(corpAppId: string): string {
  return path.join(appDir(corpAppId), 'roomlist')
}

/** zip local-file-header magic: an .xlsx is a zip whatever it is called. */
function looksLikeZip(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b
}

function scan(text: string, ids: Set<string>): number {
  for (const m of text.matchAll(EXTERNAL_ROOM_ID_RE)) ids.add(m[0])
  return (text.match(CONTACT_ID_RE) ?? []).length
}

/**
 * Pull every external-group id out of an uploaded file.
 *
 * No cell parsing for xlsx: a `wr_` id is never entity-escaped, so it
 * appears verbatim in the sheet XML whether the cell is a shared string or
 * an inline string. That makes this indifferent to how the producing tool
 * wrote the workbook (the 看板 fill skill writes inlineStr, Excel writes
 * sharedStrings) and keeps us off any spreadsheet library.
 */
export async function extractRoomIds(
  buffer: Buffer,
  fileName: string,
): Promise<{ ids: string[]; ignored: number }> {
  const ids = new Set<string>()
  let ignored = 0

  if (/\.xlsx$/i.test(fileName) || looksLikeZip(buffer)) {
    if (looksLikeZip(buffer)) {
      const JSZip = (await import('jszip')).default
      const zip = await JSZip.loadAsync(buffer)
      const parts = Object.values(zip.files).filter((f) => !f.dir && XLSX_TEXT_PARTS.test(f.name))
      if (parts.length === 0) throw new Error('xlsx 中未找到工作表')
      for (const part of parts) ignored += scan(await part.async('string'), ids)
      return { ids: [...ids].sort(), ignored }
    }
    // Named .xlsx but not a zip: fall through and read it as text rather than
    // refusing — a mis-exported csv is a mistake worth tolerating.
  }

  let text = buffer.toString('utf8')
  // A replacement character means the bytes were not UTF-8; Chinese Excel
  // exports csv as GBK by default.
  if (text.includes('�')) text = iconv.decode(buffer, 'gbk')
  ignored += scan(text, ids)
  return { ids: [...ids].sort(), ignored }
}

/** Keep the original file name usable on disk without letting it escape the dir. */
function safeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^\w.\-一-鿿]/g, '_').slice(0, 120)
  return base || 'roomlist.txt'
}

export async function writeRoomList(
  corpAppId: string,
  fileName: string,
  original: Buffer,
  ids: string[],
  ignored: number,
): Promise<RoomListFile> {
  const dir = roomListDir(corpAppId)
  // Only the current upload is kept; an older file sitting beside it would
  // make "which list is live" a question.
  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, safeFileName(fileName)), original)

  const meta: RoomListFile = {
    roomIds: ids,
    count: ids.length,
    ignored,
    fileName,
    uploadedAt: Date.now(),
    source: 'upload',
  }
  const file = roomListFile(corpAppId)
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(meta), 'utf8')
  await fsp.rename(tmp, file)
  return meta
}

/** The uploaded ids, or null when no list has been uploaded. */
export async function readRoomList(corpAppId: string): Promise<string[] | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(roomListFile(corpAppId), 'utf8')) as Partial<RoomListFile>
    return Array.isArray(parsed.roomIds) ? parsed.roomIds.filter((x) => typeof x === 'string') : null
  } catch {
    return null
  }
}

export async function clearRoomList(corpAppId: string): Promise<void> {
  await fsp.rm(roomListFile(corpAppId), { force: true })
  await fsp.rm(roomListDir(corpAppId), { recursive: true, force: true })
}

/**
 * Every room that should be photographed today: the uploaded list plus the
 * rooms the message stream has seen, minus the 1:1 bucket (direct chats have
 * no roster).
 */
export function snapshotRoomSet(uploaded: string[] | null, archived: RoomMeta[]): string[] {
  const all = new Set<string>([...(uploaded ?? []), ...archived.map((r) => r.roomid)])
  all.delete('')
  all.delete(DIRECT_BUCKET)
  return [...all].sort()
}
