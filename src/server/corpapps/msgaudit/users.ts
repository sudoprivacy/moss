/**
 * Display-name resolution for archived chat records.
 *
 * WHY RESOLVE PER PULL, WITHOUT A CACHE
 * -------------------------------------
 * A record stores ids (`sunhuimin`, `wo_l7aCgAA...`). Names are resolved
 * fresh on every pull rather than cached, because a display name is
 * mutable: people and groups get renamed, and a cached name would pin the
 * archive to whatever the name happened to be the first time that id was
 * seen — silently drifting out of date with no way to notice.
 *
 * The cost is bounded: only the ids appearing in the current batch are
 * resolved, deduplicated per run. A quiet instance resolves a handful of
 * ids per pull.
 *
 * When a lookup fails the record keeps the raw id, so a name is never
 * silently blank — an id is always more useful than an empty field.
 *
 * The 会话存档 SDK has no directory API, so this goes through a sibling
 * self-built app (wecomapp) over REST. That app needs its IP allow-listed
 * in the WeCom console; without it every lookup fails with 60020 and
 * records simply keep their raw ids.
 */

export type UserDirectory = Record<string, string>

/** External ids are prefixed by WeCom; everything else is an employee. */
export function isExternalId(id: string): boolean {
  return /^(wo|wm)_/.test(id)
}

/** Fetches a display name, or null when the provider cannot resolve it. */
export type NameLookup = (id: string, external: boolean) => Promise<string | null>

/**
 * Resolve every id not already cached, mutating `dir` in place.
 *
 * Every id in the batch is resolved, including ones seen before: names
 * are mutable, so a previous answer is not evidence about the current
 * one. A failed lookup falls back to the raw id rather than an empty
 * string, and is retried on the next pull that sees the id.
 */
export async function resolveMissing(
  dir: UserDirectory,
  ids: Iterable<string>,
  lookup: NameLookup,
): Promise<{ resolved: number; failed: number }> {
  let resolved = 0
  let failed = 0
  // Deduplicate within the batch, but do NOT skip ids already in `dir` —
  // names change, so every pull re-reads them from the provider.
  const pending = new Set<string>()
  for (const id of ids) {
    if (id) pending.add(id)
  }
  for (const id of pending) {
    try {
      const name = await lookup(id, isExternalId(id))
      if (name) {
        dir[id] = name
        resolved += 1
      } else {
        // Fall back to the id itself: a record should never carry a blank
        // name when it could carry something identifying.
        dir[id] = id
        failed += 1
      }
    } catch {
      dir[id] = id
      failed += 1
    }
  }
  return { resolved, failed }
}
