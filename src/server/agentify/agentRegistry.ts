/**
 * Agent identity for agentify.
 *
 * Sessions and tokens refer to an agent by whatever string the caller used —
 * a display name ("返厂日报助手"), a directory name or a meta id. That string
 * changes when an agent is renamed. This module turns any of them into one
 * stable id: the meta `id` (a UUID for tenant and custom agents), or the
 * directory name when an agent has no id.
 */
import path from 'path'
import type { AssistantStoreMeta } from '../agentStore.js'
import type { VisibleTo } from '../visibilityFilter.js'
import { customItemOwnerId, itemCreatorId, withOwnerVisibility } from '../visibilityFilter.js'

export interface AgentRef {
  id: string
  name: string
  displayName: string
  dir: string
  description: string
  visibleTo: VisibleTo
  ownerId: string | null
  meta: AssistantStoreMeta | null
}

export interface AgentLookup {
  findAssistantDir(nameOrId: string): Promise<{ dir: string } | null>
  readAssistantMeta(dir: string): Promise<AssistantStoreMeta | null>
}

export function agentRefFromDir(dir: string, meta: AssistantStoreMeta | null): AgentRef {
  const dirName = path.basename(dir).trim()
  const name = typeof meta?.name === 'string' && meta.name.trim() ? meta.name.trim() : dirName
  const displayName =
    typeof meta?.display_name === 'string' && meta.display_name.trim() ? meta.display_name.trim() : name
  const id = typeof meta?.id === 'string' && meta.id.trim() ? meta.id.trim() : dirName
  return {
    id,
    name,
    displayName,
    dir,
    description: typeof meta?.description === 'string' ? meta.description : '',
    visibleTo: withOwnerVisibility(meta?.visible_to, itemCreatorId(meta)),
    ownerId: customItemOwnerId(meta),
    meta,
  }
}

/** Short-lived cache: agent lookups scan directories, and hot paths repeat them. */
export class AgentRegistry {
  private cache = new Map<string, { ref: AgentRef | null; at: number }>()
  constructor(private readonly lookup: AgentLookup, private readonly ttlMs = 30_000) {}

  async resolve(nameOrId: string | null | undefined): Promise<AgentRef | null> {
    const key = String(nameOrId ?? '').trim()
    if (!key) return null
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.ref
    let ref: AgentRef | null = null
    try {
      const found = await this.lookup.findAssistantDir(key)
      if (found) ref = agentRefFromDir(found.dir, await this.lookup.readAssistantMeta(found.dir))
    } catch {
      ref = null
    }
    this.cache.set(key, { ref, at: Date.now() })
    return ref
  }

  invalidate(): void {
    this.cache.clear()
  }
}
