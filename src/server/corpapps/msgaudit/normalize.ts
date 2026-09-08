/**
 * Normalize the SDK's decrypted JSON into the ChatRecord we archive.
 *
 * The decrypted payload is a provider-shaped object whose fields vary by
 * msgtype (text carries {text:{content}}, image carries {image:{...}},
 * and so on). We flatten the common metadata, lift plain text into a
 * top-level `text` field so an agent can read a day's conversation
 * without knowing the provider's per-type shapes, and pass the rest
 * through untouched under `payload` so nothing is silently lost.
 */

import type { ChatRecord } from './store.js'

type DecryptedMsg = Record<string, unknown>

/** Pull the human-readable text out of whichever per-type slot holds it. */
function extractText(msg: DecryptedMsg, msgtype: string): string | undefined {
  const box = msg[msgtype]
  if (box && typeof box === 'object') {
    const content = (box as Record<string, unknown>).content
    if (typeof content === 'string') return content
  }
  // Some types (e.g. revoke) carry no content at all.
  return undefined
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

/**
 * Build a ChatRecord. `seq` and `msgid` come from the OUTER (still
 * encrypted) envelope rather than the decrypted body, because the
 * envelope is what the cursor and dedup are keyed on.
 */
export function normalizeRecord(
  envelope: { seq: number; msgid: string },
  decrypted: DecryptedMsg,
): ChatRecord {
  const msgtype = typeof decrypted.msgtype === 'string' ? decrypted.msgtype : 'unknown'

  // WeCom gives msgtime in ms already, but guard against a seconds-valued
  // field: a wrong unit here would scatter records across 1970 day-files.
  const rawTime = Number(decrypted.msgtime) || 0
  const msgtime = rawTime > 0 && rawTime < 1e12 ? rawTime * 1000 : rawTime || Date.now()

  const payload: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(decrypted)) {
    if (k === 'msgid' || k === 'seq' || k === 'msgtime' || k === 'msgtype') continue
    if (k === 'from' || k === 'tolist' || k === 'roomid') continue
    payload[k] = v
  }

  const text = extractText(decrypted, msgtype)

  return {
    seq: envelope.seq,
    msgid: envelope.msgid || String(decrypted.msgid ?? ''),
    msgtime,
    from: typeof decrypted.from === 'string' ? decrypted.from : '',
    to: asStringArray(decrypted.tolist),
    roomid: typeof decrypted.roomid === 'string' ? decrypted.roomid : '',
    msgtype,
    ...(text !== undefined ? { text } : {}),
    ...(Object.keys(payload).length > 0 ? { payload } : {}),
  }
}
