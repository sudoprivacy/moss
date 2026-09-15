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
 */

import { decryptRandomKey, parsePrivateKeys } from './crypto.js'
import { normalizeRecord } from './normalize.js'
import { openSdk, type RawChatRecord, type SdkHandle } from './sdk.js'
import {
  appendRecords,
  readCursor,
  updateRooms,
  writeCursor,
  writeMedia,
  type ChatRecord,
} from './store.js'
import { mediaBox, mediaExt, mediaSize, parseMediaTypes } from './media.js'
import { appendMediaIndex, type MediaIndexEntry } from './mediaIndex.js'
import { readUserCache, resolveMissing, writeUserCache, type NameLookup } from './users.js'

/** WeCom caps a single GetChatData page at 1000. */
const PAGE_LIMIT = 1000

/** Attempts per media object before giving up. */
const MEDIA_RETRIES = 3

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
  /** Whether to resolve display names (paired with the media switch). */
  resolveNames?: boolean
  /**
   * Resolves a userid to a display name. Supplied by the caller because
   * the 会话存档 SDK has no directory API — it comes from a sibling
   * self-built app, auto-discovered by corpId. Absent = keep raw ids.
   */
  nameLookup?: NameLookup
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
  /** Ids newly resolved to display names this run. */
  namesResolved: number
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
 * `maxPages`). Safe to call repeatedly; concurrent calls for the same
 * instance are the caller's responsibility to serialise.
 */
export async function pullOnce(cfg: PullConfig): Promise<PullResult> {
  const privateKeys = parsePrivateKeys(cfg.privateKeysRaw)
  if (Object.keys(privateKeys).length === 0) {
    throw new Error('msgaudit: no RSA private key configured — records cannot be decrypted')
  }

  const start = await readCursor(cfg.corpAppId)
  let cursor = start.seq
  let fetched = 0
  let written = 0
  let failed = 0
  let filtered = 0
  let media = 0
  let mediaFailed = 0
  let namesResolved = 0
  let pages = 0
  const roomFilter = parseRoomFilter(cfg.roomFilterRaw)
  const mediaTypes = parseMediaTypes(cfg.mediaTypesRaw)
  const mediaMax = Number(cfg.mediaMaxBytes) > 0 ? Number(cfg.mediaMaxBytes) : 0
  const userDir = cfg.nameLookup ? await readUserCache(cfg.corpAppId) : {}
  let userDirDirty = false
  const pendingMedia: MediaIndexEntry[] = []

  const sdk = openSdk(cfg.corpId, cfg.secret)
  try {
    for (;;) {
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

      // Names are resolved before the write so a transcript line carries
      // its annotations from the start. Media is NOT: see below.
      if (cfg.nameLookup) {
        const ids = new Set<string>()
        for (const rec of records) {
          if (rec.from) ids.add(rec.from)
          for (const id of rec.to) ids.add(id)
        }
        const r = await resolveMissing(userDir, ids, cfg.nameLookup)
        if (r.resolved > 0) {
          namesResolved += r.resolved
          userDirDirty = true
        }
        for (const rec of records) {
          if (rec.from && userDir[rec.from]) rec.fromName = userDir[rec.from]
          if (rec.to.length > 0) rec.toNames = rec.to.map((id) => userDir[id] ?? id)
        }
      }

      // Write first, then advance — see ORDERING above.
      const { written: w } = await appendRecords(cfg.corpAppId, records)
      await updateRooms(cfg.corpAppId, records)
      written += w

      // Media is downloaded AFTER the transcript is durable, and its
      // outcome is recorded in a sidecar rather than in the message line.
      // Downloading first would mean a slow or wedged media fetch delays
      // (or (on a crash) loses) the messages themselves — and the message
      // is the irreplaceable part, while media is merely time-limited.
      if (mediaTypes.size > 0) {
        for (const rec of records) {
          if (!mediaTypes.has(rec.msgtype)) continue
          const box = mediaBox(rec)
          if (!box) continue
          const size = mediaSize(box)
          if (mediaMax > 0 && size > mediaMax) {
            pendingMedia.push({
              msgid: rec.msgid,
              msgtime: rec.msgtime,
              error: `skipped: ${size} bytes exceeds limit ${mediaMax}`,
            })
            mediaFailed += 1
            continue
          }
          const outcome = await downloadWithRetry(sdk, rec, box)
          if (outcome.bytes) {
            const rel = await writeMedia(
              cfg.corpAppId,
              rec.msgid,
              rec.msgtime,
              mediaExt(rec, box),
              outcome.bytes,
            )
            pendingMedia.push({ msgid: rec.msgid, msgtime: rec.msgtime, path: rel })
            media += 1
          } else {
            pendingMedia.push({
              msgid: rec.msgid,
              msgtime: rec.msgtime,
              error: outcome.error ?? 'download failed',
            })
            mediaFailed += 1
          }
        }
      }

      // Advance past the whole page, including records we could not
      // decrypt: they will never become readable, and leaving the cursor
      // behind them would block the archive permanently.
      const maxSeq = page.reduce((m, r) => (r.seq > m ? r.seq : m), cursor)
      cursor = maxSeq
      await writeCursor(cfg.corpAppId, cursor)

      pages += 1
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

  if (pendingMedia.length > 0) {
    await appendMediaIndex(cfg.corpAppId, pendingMedia).catch(() => {
      // the files are already on disk; a lost index entry is cosmetic
    })
  }

  if (userDirDirty) {
    await writeUserCache(cfg.corpAppId, userDir).catch(() => {
      // a lost cache costs re-lookups next run, not data
    })
  }

  return { fetched, written, failed, filtered, media, mediaFailed, namesResolved, cursor, pages }
}
