/**
 * Agent memory: notes the agent (or an admin) chose to keep.
 *
 *  - shared.md: facts about the work, visible to every session of the agent;
 *  - users/<id>.md: notes about one employee, visible only in that employee's
 *    sessions (preferences, what they are working on).
 *
 * Each file is a list of dated entries. It is written to the agent home and
 * indexed like any other document, so `recall` finds memory too.
 */
import type { AgentHomeStore } from './agentHome.js'
import { sharedMemoryPath, userMemoryPath } from './agentHome.js'
import type { HistoryIndex } from './historyIndex.js'
import type { AgentifyStore } from './store.js'

export type MemoryScope = 'shared' | 'private'

export const MAX_MEMORY_ENTRY_CHARS = 2000
export const MAX_MEMORY_FILE_CHARS = 60_000

function stamp(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ')
}

/** Parse `- [time by who] text` entries; keeps unknown lines as their own entries. */
export function parseMemoryEntries(text: string): Array<{ header: string; body: string }> {
  const entries: Array<{ header: string; body: string }> = []
  for (const block of text.split(/\n(?=- \[)/)) {
    const trimmed = block.trim()
    if (!trimmed || trimmed.startsWith('# ')) {
      const rest = trimmed.replace(/^# .*\n?/, '').trim()
      if (rest) entries.push({ header: '', body: rest })
      continue
    }
    const m = trimmed.match(/^- \[([^\]]*)\]\s*([\s\S]*)$/)
    entries.push(m ? { header: m[1]!, body: m[2]!.trim() } : { header: '', body: trimmed })
  }
  return entries
}

export function renderMemory(title: string, entries: Array<{ header: string; body: string }>): string {
  const lines = [`# ${title}`, '']
  for (const e of entries) lines.push(e.header ? `- [${e.header}] ${e.body}` : `- ${e.body}`)
  return `${lines.join('\n')}\n`
}

export class AgentMemory {
  constructor(
    private readonly home: AgentHomeStore,
    private readonly index: HistoryIndex,
    private readonly store: AgentifyStore,
  ) {}

  private path(orgId: string, agentId: string, scope: MemoryScope, userId: string | null): string {
    if (scope === 'private') {
      if (!userId) throw new Error('private memory needs a user')
      return userMemoryPath(orgId, agentId, userId)
    }
    return sharedMemoryPath(orgId, agentId)
  }

  async read(orgId: string, agentId: string, scope: MemoryScope, userId: string | null): Promise<string> {
    const buf = await this.home.read(this.path(orgId, agentId, scope, userId))
    return buf ? buf.toString('utf8') : ''
  }

  async add(input: { orgId: string; agentId: string; agentDisplayName: string; scope: MemoryScope; userId: string | null; author: string; text: string }): Promise<number> {
    const body = input.text.replace(/\s+\n/g, '\n').trim()
    if (!body) throw new Error('memory text is empty')
    if (body.length > MAX_MEMORY_ENTRY_CHARS) throw new Error(`memory entry is longer than ${MAX_MEMORY_ENTRY_CHARS} characters`)
    const existing = parseMemoryEntries(await this.read(input.orgId, input.agentId, input.scope, input.userId))
    // Do not store the exact same fact twice.
    if (existing.some(e => e.body === body)) return existing.length
    existing.push({ header: `${stamp(Date.now())} ${input.author}`, body })
    // Oldest entries go first when the file grows past its budget.
    while (existing.length > 1 && renderMemory('x', existing).length > MAX_MEMORY_FILE_CHARS) existing.shift()
    await this.save(input.orgId, input.agentId, input.agentDisplayName, input.scope, input.userId, existing)
    return existing.length
  }

  /** Replace the whole file (admin edit). */
  async replace(input: { orgId: string; agentId: string; agentDisplayName: string; scope: MemoryScope; userId: string | null; text: string }): Promise<void> {
    if (input.text.length > MAX_MEMORY_FILE_CHARS) throw new Error(`memory is longer than ${MAX_MEMORY_FILE_CHARS} characters`)
    await this.save(input.orgId, input.agentId, input.agentDisplayName, input.scope, input.userId, parseMemoryEntries(input.text))
  }

  async remove(input: { orgId: string; agentId: string; agentDisplayName: string; scope: MemoryScope; userId: string | null; index: number }): Promise<boolean> {
    const entries = parseMemoryEntries(await this.read(input.orgId, input.agentId, input.scope, input.userId))
    if (input.index < 0 || input.index >= entries.length) return false
    entries.splice(input.index, 1)
    await this.save(input.orgId, input.agentId, input.agentDisplayName, input.scope, input.userId, entries)
    return true
  }

  private async save(orgId: string, agentId: string, displayName: string, scope: MemoryScope, userId: string | null, entries: Array<{ header: string; body: string }>): Promise<void> {
    const title = scope === 'shared' ? `${displayName} 共享记忆` : `${displayName} 个人记忆`
    const text = renderMemory(title, entries)
    const p = this.path(orgId, agentId, scope, userId)
    await this.home.write(p, text)
    const docKey = scope === 'shared' ? 'memory:shared' : `memory:user:${userId}`
    if (entries.length === 0) {
      this.store.deleteDoc(orgId, agentId, docKey)
      return
    }
    await this.index.indexDoc({
      orgId,
      agentId,
      kind: 'memory',
      docKey,
      userId: scope === 'private' ? userId : null,
      visibility: scope === 'private' ? 'private' : 'shared',
      path: p,
      title,
      text,
      createdAt: Date.now(),
    })
  }

  /**
   * Text injected into a new session: the newest shared and private entries,
   * within `budget` characters, plus pointers to recent work.
   */
  async buildInjection(input: { orgId: string; agentId: string; userId: string | null; budget: number; recentWork: string[] }): Promise<string> {
    const take = (entries: Array<{ header: string; body: string }>, chars: number): string[] => {
      const out: string[] = []
      let used = 0
      for (const e of [...entries].reverse()) {
        const line = `- ${e.body}`
        if (used + line.length > chars) break
        out.unshift(line)
        used += line.length
      }
      return out
    }
    const shared = parseMemoryEntries(await this.read(input.orgId, input.agentId, 'shared', null))
    const mine = input.userId ? parseMemoryEntries(await this.read(input.orgId, input.agentId, 'private', input.userId)) : []
    const sections: string[] = []
    const sharedLines = take(shared, Math.floor(input.budget * 0.55))
    if (sharedLines.length > 0) sections.push(`Shared memory (all employees):\n${sharedLines.join('\n')}`)
    const mineLines = take(mine, Math.floor(input.budget * 0.25))
    if (mineLines.length > 0) sections.push(`Your notes about this employee:\n${mineLines.join('\n')}`)
    if (input.recentWork.length > 0) {
      const lines: string[] = []
      let used = 0
      for (const w of input.recentWork) {
        if (used + w.length > input.budget * 0.2) break
        lines.push(`- ${w}`)
        used += w.length
      }
      if (lines.length > 0) sections.push(`Recent work (use \`agentctl history show <id>\` for details):\n${lines.join('\n')}`)
    }
    return sections.join('\n\n')
  }
}
