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
import { appendRecords, readCursor, updateRooms, writeCursor, type ChatRecord } from './store.js'

/** WeCom caps a single GetChatData page at 1000. */
const PAGE_LIMIT = 1000

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
}

export type PullResult = {
  fetched: number
  written: number
  /** Decrypted but dropped by the room filter. */
  filtered: number
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
  let pages = 0
  const roomFilter = parseRoomFilter(cfg.roomFilterRaw)

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

      // Write first, then advance — see ORDERING above.
      const { written: w } = await appendRecords(cfg.corpAppId, records)
      await updateRooms(cfg.corpAppId, records)
      written += w

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

  return { fetched, written, failed, filtered, cursor, pages }
}
