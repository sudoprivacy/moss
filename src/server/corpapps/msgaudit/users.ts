/**
 * Display-name resolution for archived chat records.
 *
 * WHY RESOLVE AT ARCHIVE TIME
 * ---------------------------
 * A record stores ids (`sunhuimin`, `wo_l7aCgAA...`), and the lookups that
 * turn those into names are not permanent:
 *
 *   - internal userids resolve from the corp directory, so they survive
 *     leaving a group but not necessarily leaving the company;
 *   - external userids resolve only while the contact is still linked to
 *     some member of the corp — once that ends, WeCom returns 84061 and
 *     the name is gone for good.
 *
 * The archive, by contrast, is permanent. So names are resolved when a
 * record is first seen and cached forever; the cache is append-only and
 * never re-validates, because a name we captured is strictly better than
 * a lookup that may now fail.
 *
 * The 会话存档 SDK has no directory API, so this goes through a sibling
 * self-built app (wecomapp) over REST. That app needs its IP allow-listed
 * in the WeCom console; without it every lookup fails with 60020 and
 * records simply keep their raw ids.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { appDir } from './store.js'

export type UserDirectory = Record<string, string>

/** Where the name cache lives, beside the transcripts it annotates. */
function cacheFile(corpAppId: string): string {
  return path.join(appDir(corpAppId), 'users.json')
}

export async function readUserCache(corpAppId: string): Promise<UserDirectory> {
  try {
    const raw = await fsp.readFile(cacheFile(corpAppId), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: UserDirectory = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** Atomic write: a torn cache would silently lose captured names. */
export async function writeUserCache(corpAppId: string, dir: UserDirectory): Promise<void> {
  const file = cacheFile(corpAppId)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(dir, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

/** External ids are prefixed by WeCom; everything else is an employee. */
export function isExternalId(id: string): boolean {
  return /^(wo|wm)_/.test(id)
}

/** Fetches a display name, or null when the provider cannot resolve it. */
export type NameLookup = (id: string, external: boolean) => Promise<string | null>

/**
 * Resolve every id not already cached, mutating `dir` in place.
 *
 * A failed lookup is NOT cached: the id stays absent and is retried on
 * the next pull that sees it. That is deliberate — a name may be missing
 * only because the sibling app is temporarily misconfigured (IP not yet
 * allow-listed, token expired), and permanently writing off those ids
 * would lose names that were still recoverable. The cost is bounded:
 * ids are deduplicated per run, and a genuinely departed contact is
 * retried only while it keeps appearing in new traffic.
 */
export async function resolveMissing(
  dir: UserDirectory,
  ids: Iterable<string>,
  lookup: NameLookup,
): Promise<{ resolved: number; failed: number }> {
  let resolved = 0
  let failed = 0
  const pending = new Set<string>()
  for (const id of ids) {
    if (id && !Object.prototype.hasOwnProperty.call(dir, id)) pending.add(id)
  }
  for (const id of pending) {
    try {
      const name = await lookup(id, isExternalId(id))
      if (name) {
        dir[id] = name
        resolved += 1
      } else {
        failed += 1
      }
    } catch {
      failed += 1
    }
  }
  return { resolved, failed }
}
