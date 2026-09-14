/**
 * Sidecar index of downloaded media.
 *
 * Media is fetched AFTER the transcript line is already durable, so its
 * outcome cannot go into that line — the JSONL is append-only and
 * rewriting it to attach a path would mean re-reading and re-writing a
 * whole day file per download. The index lives beside the transcript
 * instead and is joined by `msgid`.
 *
 * Keeping it separate also means a purge of old media (by day directory)
 * only has to trim this file, never touch the transcripts themselves.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { appDir, dayKey } from './store.js'

export type MediaIndexEntry = {
  /** Joins to ChatRecord.msgid. */
  msgid: string
  /** Epoch ms of the message, so a purge can filter without a join. */
  msgtime: number
  /** Path relative to the instance dir; absent when the download failed. */
  path?: string
  /** Why it is absent — expired sdkfileid, over the size limit, etc. */
  error?: string
}

function indexFile(corpAppId: string, day: string): string {
  return path.join(appDir(corpAppId), 'media', `${day}.index.jsonl`)
}

/**
 * Append outcomes, grouped by the message's day so the index is
 * partitioned the same way the files are.
 */
export async function appendMediaIndex(
  corpAppId: string,
  entries: MediaIndexEntry[],
): Promise<void> {
  if (entries.length === 0) return
  const byDay = new Map<string, MediaIndexEntry[]>()
  for (const e of entries) {
    const day = dayKey(e.msgtime)
    const list = byDay.get(day)
    if (list) list.push(e)
    else byDay.set(day, [e])
  }
  for (const [day, list] of byDay) {
    const file = indexFile(corpAppId, day)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.appendFile(file, list.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  }
}

/** Read one day's media outcomes, keyed by msgid. */
export async function readMediaIndex(
  corpAppId: string,
  day: string,
): Promise<Map<string, MediaIndexEntry>> {
  const out = new Map<string, MediaIndexEntry>()
  let raw: string
  try {
    raw = await fsp.readFile(indexFile(corpAppId, day), 'utf8')
  } catch {
    return out
  }
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const e = JSON.parse(line) as MediaIndexEntry
      // Later entries win: a retry that finally succeeded supersedes the
      // earlier failure for the same message.
      if (e.msgid) out.set(e.msgid, e)
    } catch {
      // skip a torn line rather than failing the whole read
    }
  }
  return out
}

/**
 * Delete media (files and index) for days strictly older than `cutoff`.
 *
 * Transcripts are left untouched: the text is small and is the part worth
 * keeping indefinitely, while media is what actually consumes disk.
 */
export async function purgeMediaBefore(
  corpAppId: string,
  cutoff: Date,
): Promise<{ days: number; files: number }> {
  const root = path.join(appDir(corpAppId), 'media')
  const cutoffDay = dayKey(cutoff.getTime())
  let days = 0
  let files = 0
  let entries: string[]
  try {
    entries = await fsp.readdir(root)
  } catch {
    return { days: 0, files: 0 }
  }
  for (const name of entries) {
    const day = name.endsWith('.index.jsonl') ? name.slice(0, -'.index.jsonl'.length) : name
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= cutoffDay) continue
    const target = path.join(root, name)
    try {
      const st = await fsp.stat(target)
      if (st.isDirectory()) {
        files += (await fsp.readdir(target)).length
        await fsp.rm(target, { recursive: true, force: true })
        days += 1
      } else {
        await fsp.rm(target, { force: true })
      }
    } catch {
      // best-effort: a file already gone is fine
    }
  }
  return { days, files }
}
