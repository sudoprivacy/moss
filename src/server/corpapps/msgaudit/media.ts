/**
 * Media download policy for 会话存档 records.
 *
 * WeCom hands out an `sdkfileid` per media object, valid for roughly
 * three days. There is therefore no "download it later" option: the only
 * moment a file is reliably retrievable is the pull that first sees it.
 * Everything here runs inline with the pull for that reason.
 */

import type { ChatRecord } from './store.js'

/** Message types that carry a downloadable `sdkfileid`. */
export const MEDIA_TYPES = ['image', 'emotion', 'file', 'video', 'voice'] as const
export type MediaType = (typeof MEDIA_TYPES)[number]

/**
 * Parse the admin's download list ("image,emotion" / "" / "all").
 * Empty means download nothing; unknown names are ignored rather than
 * failing the pull, so a typo costs media rather than the whole run.
 */
export function parseMediaTypes(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === 'all' || trimmed === '*') return new Set(MEDIA_TYPES)
  const out = new Set<string>()
  for (const part of trimmed.split(/[\s,，]+/)) {
    const t = part.trim()
    if (t && (MEDIA_TYPES as readonly string[]).includes(t)) out.add(t)
  }
  return out
}

/** The provider's media descriptor for a record, or null if it has none. */
export function mediaBox(rec: ChatRecord): Record<string, unknown> | null {
  const box = rec.payload?.[rec.msgtype]
  if (!box || typeof box !== 'object') return null
  const b = box as Record<string, unknown>
  return typeof b.sdkfileid === 'string' && b.sdkfileid.length > 0 ? b : null
}

/**
 * Declared byte size. Images use `filesize`, emotions use `imagesize`,
 * and voice uses neither — hence the fallbacks rather than one field.
 */
export function mediaSize(box: Record<string, unknown>): number {
  for (const k of ['filesize', 'imagesize', 'voice_size', 'size']) {
    const v = Number(box[k])
    if (Number.isFinite(v) && v > 0) return v
  }
  return 0
}

/**
 * File extension for the downloaded bytes. Emotions declare type 1=GIF,
 * 2=PNG; other kinds carry a filename we can borrow, else a neutral
 * extension so the file is still openable by content sniffing.
 */
export function mediaExt(rec: ChatRecord, box: Record<string, unknown>): string {
  if (rec.msgtype === 'emotion') return Number(box.type) === 2 ? '.png' : '.gif'
  if (rec.msgtype === 'image') return '.jpg'
  if (rec.msgtype === 'voice') return '.amr'
  if (rec.msgtype === 'video') return '.mp4'
  const name = typeof box.filename === 'string' ? box.filename : ''
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) {
    const ext = name.slice(dot).toLowerCase()
    if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext
  }
  return '.bin'
}
