/**
 * 会话存档 pull loop.
 *
 * WeCom's archive is a monotonic seq-indexed log, not a time range: you
 * ask for everything after `seq` and page forward. The cursor is
 * therefore the whole of the sync state.
 *
 * ORDERING — records are written BEFORE the cursor advances. A crash in
 * between replays the window, which the store's msgid dedup absorbs. The
 * reverse order would silently lose messages, which is unrecoverable
 * (the archive has a retention window; a gap noticed late cannot be
 * back-filled).
 *
 * MEDIA COMES AFTER THE CURSOR. Media used to be downloaded before the
 * cursor was saved, so a page with too much media for one pull (on
 * 2026-10-16, one 4.6 MB image posted to 351 groups, ~1.6 GB in one page)
 * was killed at the time limit every time and replayed from the start,
 * downloading the same files again. The archive stayed frozen for four
 * days. Now:
 *   - the cursor is saved as soon as the page's messages are durable;
 *   - files already on disk are not downloaded again;
 *   - identical content (same md5sum) is downloaded once per pull and
 *     linked for the repeats;
 *   - a pull stops starting new downloads and new pages near its time
 *     budget, so it returns cleanly instead of being killed. Media it did
 *     not get to is recorded as skipped in the media index.
 *
 * Membership snapshots are NOT taken here. They used to run at the end of
 * every pull, which cannot work at tens of thousands of groups (the pull
 * child has a 10-minute budget) and only ever saw rooms that had spoken.
 * See snapshotWorker.ts.
 */

import { decryptRandomKey, parsePrivateKeys } from './crypto.js'
import { normalizeRecord } from './normalize.js'
import { openSdk, type RawChatRecord, type SdkHandle } from './sdk.js'
import {
  appendRecords,
  hasMedia,
  linkMedia,
  mediaRelPath,
  readCursor,
  updateRooms,
  writeCursor,
  writeMedia,
  type ChatRecord,
} from './store.js'
import { mediaBox, mediaExt, mediaSize, parseMediaTypes } from './media.js'
import { appendMediaIndex, type MediaIndexEntry } from './mediaIndex.js'

/** WeCom caps a single GetChatData page at 1000. */
const PAGE_LIMIT = 1000

/** Attempts per media object before giving up. */
const MEDIA_RETRIES = 3

/**
 * How long one pull may run before it stops starting new media downloads
 * and new pages. Kept well under the worker's 10-minute child timeout so
 * the pull returns (and reports) instead of being killed.
 */
export const DEFAULT_PULL_BUDGET_MS = 7 * 60 * 1000

/**
 * Fetch one media object, retrying transient failures.
 *
 * An expired `sdkfileid` (10005) is permanent, so retrying it only wastes
 * time and delays the rest of the batch — that case bails immediately.
 * Everything else (network blips, transient SDK errors) gets three tries
 * with a short backoff.
 */
async function downloadWithRetry(
  sdk: SdkHandle,
  rec: ChatRecord,
  box: Record<string, unknown>,
): Promise<{ bytes?: Buffer; error?: string }> {
  let lastError = ''
  for (let attempt = 1; attempt <= MEDIA_RETRIES; attempt++) {
    try {
      const bytes = sdk.getMediaData(String(box.sdkfileid))
      if (bytes.length === 0) throw new Error('empty download')
      return { bytes }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      // 10005 = fileid expired/invalid: no amount of retrying helps.
      if (lastError.includes('10005')) break
      if (attempt < MEDIA_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * attempt))
      }
    }
  }
  return { error: `${lastError} (after ${MEDIA_RETRIES} attempts)` }
}

/**
 * Parse the admin's room filter into a lookup set.
 *
 * Accepts commas, spaces and newlines in any mix, so a list pasted from a
 * spreadsheet or typed by hand both work. Returns null for "no filter" —
 * distinct from an empty set, which would archive nothing.
 */
export function parseRoomFilter(raw: string | undefined): Set<string> | null {
  if (!raw) return null
  const ids = raw
    .split(/[\s,，]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
  return ids.length > 0 ? new Set(ids) : null
}

export type PullConfig = {
  corpAppId: string
  corpId: string
  secret: string
  /** JSON map of publickey_ver -> PEM, or a bare PEM (treated as v1). */
  privateKeysRaw: string
  /** Stop after this many pages in one run; 0 = drain fully. */
  maxPages?: number
  /**
   * Raw room filter as typed by the admin: room ids separated by commas
   * and/or whitespace. Empty (or absent) archives every conversation.
   */
  roomFilterRaw?: string
  /** Media types to download ("image,emotion" / "all"); empty = none. */
  mediaTypesRaw?: string
  /** Skip files larger than this (bytes). 0 = no limit. */
  mediaMaxBytes?: number
  /** Wall-clock budget for this pull (ms); see DEFAULT_PULL_BUDGET_MS. */
  budgetMs?: number
}

export type PullResult = {
  fetched: number
  written: number
  /** Decrypted but dropped by the room filter. */
  filtered: number
  /** Media objects written to disk. */
  media: number
  /** Media downloads that were skipped or failed. */
  mediaFailed: number
  /** Media served from disk or from a same-content file instead of downloading. */
  mediaReused: number
  /** True when the time budget stopped this pull before the archive head. */
  budgetHit: boolean
  failed: number
  cursor: number
  /** Pages consumed this run; equals maxPages when the cap stopped it. */
  pages: number
}

/**
 * Decrypt one page. A single undecryptable record (typically a rotated-
 * away public key version) must not abort the batch — it would wedge the
 * cursor forever behind that record. Failures are counted and skipped,
 * and the reason is logged once per page rather than per record.
 */
function decryptPage(
  sdk: SdkHandle,
  privateKeys: Record<string, string>,
  page: RawChatRecord[],
): { records: ChatRecord[]; failed: number; firstError?: string } {
  const records: ChatRecord[] = []
  let failed = 0
  let firstError: string | undefined

  for (const raw of page) {
    try {
      const randomKey = decryptRandomKey(privateKeys, raw.publickey_ver, raw.encrypt_random_key)
      const plain = sdk.decryptData(randomKey, raw.encrypt_chat_msg)
      records.push(normalizeRecord({ seq: raw.seq, msgid: raw.msgid }, JSON.parse(plain)))
    } catch (err) {
      failed += 1
      if (!firstError) firstError = err instanceof Error ? err.message : String(err)
    }
  }
  return { records, failed, firstError }
}

/**
 * Pull from the stored cursor to the head of the archive (or until
 * `maxPages`, or the time budget). Safe to call repeatedly; concurrent
 * calls for the same instance are the caller's responsibility to serialise.
 *
 * `open` is injectable so tests can run without the native SDK.
 */
export async function pullOnce(
  cfg: PullConfig,
  open: (corpId: string, secret: string) => SdkHandle = openSdk,
): Promise<PullResult> {
  const privateKeys = parsePrivateKeys(cfg.privateKeysRaw)
  if (Object.keys(privateKeys).length === 0) {
    throw new Error('msgaudit: no RSA private key configured — records cannot be decrypted')
  }

  const deadline = Date.now() + (cfg.budgetMs ?? DEFAULT_PULL_BUDGET_MS)
  const start = await readCursor(cfg.corpAppId)
  let cursor = start.seq
  let fetched = 0
  let written = 0
  let failed = 0
  let filtered = 0
  let media = 0
  let mediaFailed = 0
  let mediaReused = 0
  let pages = 0
  let budgetHit = false
  const roomFilter = parseRoomFilter(cfg.roomFilterRaw)
  const mediaTypes = parseMediaTypes(cfg.mediaTypesRaw)
  const mediaMax = Number(cfg.mediaMaxBytes) > 0 ? Number(cfg.mediaMaxBytes) : 0
  // md5sum -> a file already on disk with that content, for this pull.
  const byMd5 = new Map<string, string>()

  const sdk = open(cfg.corpId, cfg.secret)
  try {
    for (;;) {
      if (Date.now() >= deadline) {
        budgetHit = true
        break
      }
      const page = await sdk.getChatData(cursor, PAGE_LIMIT)
      if (page.length === 0) break
      fetched += page.length

      const { records: decrypted, failed: pageFailed, firstError } = decryptPage(sdk, privateKeys, page)
      failed += pageFailed

      // Filtering happens AFTER decryption because WeCom's envelope carries
      // only seq/msgid/publickey_ver — roomid exists solely inside the
      // encrypted body, so there is no way to skip a room before decrypting.
      // The cursor still advances over filtered records: they were fetched
      // and are not coming back, and holding the cursor for them would
      // re-pull the same traffic forever.
      const records = roomFilter
        ? decrypted.filter((r) => roomFilter.has(r.roomid || ''))
        : decrypted
      filtered += decrypted.length - records.length
      if (firstError) {
        console.error(
          `[msgaudit] ${pageFailed}/${page.length} records failed to decrypt in page at seq ${cursor}: ${firstError}`,
        )
      }

      // Write first, then advance — see ORDERING above.
      const { written: w } = await appendRecords(cfg.corpAppId, records)
      await updateRooms(cfg.corpAppId, records)
      written += w

      // Advance past the whole page, including records we could not
      // decrypt: they will never become readable, and leaving the cursor
      // behind them would block the archive permanently. Saved BEFORE media
      // so slow or plentiful media can never hold the messages back.
      const maxSeq = page.reduce((m, r) => (r.seq > m ? r.seq : m), cursor)
      cursor = maxSeq
      await writeCursor(cfg.corpAppId, cursor)
      pages += 1

      if (mediaTypes.size > 0) {
        const m = await downloadPageMedia(sdk, cfg.corpAppId, records, {
          mediaTypes,
          mediaMax,
          deadline,
          byMd5,
        })
        media += m.media
        mediaFailed += m.mediaFailed
        mediaReused += m.mediaReused
        if (m.budgetHit) budgetHit = true
        // Indexed per page, not at the end of the pull, so a pull that is
        // killed still keeps the record of what it already downloaded.
        if (m.entries.length > 0) {
          await appendMediaIndex(cfg.corpAppId, m.entries).catch(() => {
            // the files are already on disk; a lost index entry is cosmetic
          })
        }
      }

      if (page.length < PAGE_LIMIT) break
      if (cfg.maxPages && pages >= cfg.maxPages) break
    }
  } finally {
    // The SDK allocates a native slot per Init; not freeing it exhausts
    // the library's pool across restarts of the loop.
    try {
      sdk.destroy()
    } catch {
      // best-effort
    }
  }

  return { fetched, written, failed, filtered, media, mediaFailed, mediaReused, budgetHit, cursor, pages }
}

/**
 * Fetch the media for one page of already-durable records. Returns the
 * index entries to record, one per media-carrying record.
 */
async function downloadPageMedia(
  sdk: SdkHandle,
  corpAppId: string,
  records: ChatRecord[],
  opts: {
    mediaTypes: Set<string>
    mediaMax: number
    deadline: number
    byMd5: Map<string, string>
  },
): Promise<{ entries: MediaIndexEntry[]; media: number; mediaFailed: number; mediaReused: number; budgetHit: boolean }> {
  const entries: MediaIndexEntry[] = []
  let media = 0
  let mediaFailed = 0
  let mediaReused = 0
  let budgetHit = false

  for (const rec of records) {
    if (!opts.mediaTypes.has(rec.msgtype)) continue
    const box = mediaBox(rec)
    if (!box) continue
    const base = { msgid: rec.msgid, msgtime: rec.msgtime }
    const size = mediaSize(box)
    if (opts.mediaMax > 0 && size > opts.mediaMax) {
      entries.push({ ...base, error: `skipped: ${size} bytes exceeds limit ${opts.mediaMax}` })
      mediaFailed += 1
      continue
    }

    const ext = mediaExt(rec, box)
    const md5 = typeof box.md5sum === 'string' && box.md5sum ? box.md5sum : ''

    // Already on disk (a replayed page): nothing to fetch.
    const rel = mediaRelPath(rec.msgid, rec.msgtime, ext)
    if (await hasMedia(corpAppId, rel)) {
      if (md5 && !opts.byMd5.has(md5)) opts.byMd5.set(md5, rel)
      entries.push({ ...base, path: rel })
      mediaReused += 1
      continue
    }

    // Same content already fetched this pull: link it instead.
    const same = md5 ? opts.byMd5.get(md5) : undefined
    if (same) {
      try {
        const linked = await linkMedia(corpAppId, same, rec.msgid, rec.msgtime, ext)
        entries.push({ ...base, path: linked })
        mediaReused += 1
        continue
      } catch {
        // fall through to a real download
      }
    }

    if (Date.now() >= opts.deadline) {
      entries.push({ ...base, error: 'skipped: pull time budget used up' })
      mediaFailed += 1
      budgetHit = true
      continue
    }

    const outcome = await downloadWithRetry(sdk, rec, box)
    if (outcome.bytes) {
      const written = await writeMedia(corpAppId, rec.msgid, rec.msgtime, ext, outcome.bytes)
      if (md5) opts.byMd5.set(md5, written)
      entries.push({ ...base, path: written })
      media += 1
    } else {
      entries.push({ ...base, error: outcome.error ?? 'download failed' })
      mediaFailed += 1
    }
  }
  return { entries, media, mediaFailed, mediaReused, budgetHit }
}
