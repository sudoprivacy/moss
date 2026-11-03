/**
 * The agent home: durable files that belong to an agent rather than to any
 * one session or employee.
 *
 *   /agent-home/<org>/<agent>/history/<yyyy>/<mm>/<session>/summary.md
 *   /agent-home/<org>/<agent>/history/.../conversation.md
 *   /agent-home/<org>/<agent>/history/.../artifacts.json
 *   /agent-home/<org>/<agent>/artifacts/<session>/<relative path>   outputs
 *   /agent-home/<org>/<agent>/inputs/<session>/<relative path>      inputs
 *     (each extracted file has a `<file>.extract.json` next to it)
 *   /agent-home/<org>/<agent>/memory/shared.md
 *   /agent-home/<org>/<agent>/memory/users/<user>.md
 *   /agent-home/<org>/<agent>/a2a/<call>.md
 *
 * With Nexus enabled the files live in Nexus VFS, next to the secrets vault,
 * so they are backed up and upgraded with it. Without Nexus they live in a
 * local directory with the same layout. Either way the index in moss.db only
 * points at them.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import path from 'path'

export interface AgentHomeEntry {
  name: string
  path: string
  isDirectory: boolean
}

export interface AgentHomeStore {
  readonly kind: 'nexus' | 'local'
  write(p: string, content: Buffer | string): Promise<void>
  read(p: string): Promise<Buffer | null>
  list(dir: string): Promise<AgentHomeEntry[]>
  remove(p: string): Promise<void>
  size(p: string): Promise<number | null>
}

export const AGENT_HOME_ROOT = '/agent-home'

/** Path segments must be safe on every backend and never climb out. */
export function safeSegment(value: string): string {
  const cleaned = String(value)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
  if (cleaned === '.' || cleaned === '..') return '_'
  return cleaned.slice(0, 120) || '_'
}

/** Join a user-supplied relative path, rejecting `..` and absolute paths. */
export function safeRelative(rel: string): string {
  const parts = rel.replace(/\\/g, '/').split('/').filter(p => p && p !== '.')
  if (parts.some(p => p === '..')) throw new Error(`unsafe path: ${rel}`)
  return parts.map(safeSegment).join('/')
}

export function agentRoot(orgId: string, agentId: string): string {
  return `${AGENT_HOME_ROOT}/${safeSegment(orgId)}/${safeSegment(agentId)}`
}

export function historyDir(orgId: string, agentId: string, sessionId: string, createdAt: number): string {
  const d = new Date(createdAt)
  const yyyy = String(d.getUTCFullYear())
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${agentRoot(orgId, agentId)}/history/${yyyy}/${mm}/${safeSegment(sessionId)}`
}

export function artifactDir(orgId: string, agentId: string, sessionId: string): string {
  return `${agentRoot(orgId, agentId)}/artifacts/${safeSegment(sessionId)}`
}

export function inputDir(orgId: string, agentId: string, sessionId: string): string {
  return `${agentRoot(orgId, agentId)}/inputs/${safeSegment(sessionId)}`
}

export function sharedMemoryPath(orgId: string, agentId: string): string {
  return `${agentRoot(orgId, agentId)}/memory/shared.md`
}

export function userMemoryPath(orgId: string, agentId: string, userId: string): string {
  return `${agentRoot(orgId, agentId)}/memory/users/${safeSegment(userId)}.md`
}

export function a2aLogPath(orgId: string, agentId: string, callId: string): string {
  return `${agentRoot(orgId, agentId)}/a2a/${safeSegment(callId)}.md`
}

/** Local filesystem backend (also used by tests). */
export class LocalAgentHomeStore implements AgentHomeStore {
  readonly kind = 'local' as const
  constructor(private readonly baseDir: string) {}

  private resolve(p: string): string {
    if (!p.startsWith(`${AGENT_HOME_ROOT}/`) && p !== AGENT_HOME_ROOT) throw new Error(`outside agent home: ${p}`)
    const rel = safeRelative(p.slice(AGENT_HOME_ROOT.length))
    return path.join(this.baseDir, rel)
  }

  async write(p: string, content: Buffer | string): Promise<void> {
    const target = this.resolve(p)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }

  async read(p: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(p))
    } catch {
      return null
    }
  }

  async list(dir: string): Promise<AgentHomeEntry[]> {
    try {
      const entries = await readdir(this.resolve(dir), { withFileTypes: true })
      return entries.map(e => ({ name: e.name, path: `${dir.replace(/\/$/, '')}/${e.name}`, isDirectory: e.isDirectory() }))
    } catch {
      return []
    }
  }

  async remove(p: string): Promise<void> {
    await rm(this.resolve(p), { recursive: true, force: true })
  }

  async size(p: string): Promise<number | null> {
    try {
      return (await stat(this.resolve(p))).size
    } catch {
      return null
    }
  }
}

/** Minimal slice of NexusVfsClient this module needs (keeps tests light). */
export interface NexusVfsLike {
  write(path: string, content: Buffer, authToken: string): Promise<void>
  read(path: string, authToken: string): Promise<Buffer>
  readdir(path: string, authToken: string): Promise<Array<{ name: string; entryType: number }>>
  delete(path: string, authToken: string): Promise<void>
  stat(path: string, authToken: string): Promise<{ size: number; isDirectory?: boolean } | null>
}

/** Nexus VFS backend. Works against nexusd 0.1.5 and 0.8.x alike. */
export class NexusAgentHomeStore implements AgentHomeStore {
  readonly kind = 'nexus' as const
  constructor(private readonly client: NexusVfsLike, private readonly authToken = '') {}

  private check(p: string): string {
    if (!p.startsWith(`${AGENT_HOME_ROOT}/`)) throw new Error(`outside agent home: ${p}`)
    return `${AGENT_HOME_ROOT}/${safeRelative(p.slice(AGENT_HOME_ROOT.length))}`
  }

  async write(p: string, content: Buffer | string): Promise<void> {
    await this.client.write(this.check(p), Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), this.authToken)
  }

  async read(p: string): Promise<Buffer | null> {
    try {
      return await this.client.read(this.check(p), this.authToken)
    } catch {
      return null
    }
  }

  async list(dir: string): Promise<AgentHomeEntry[]> {
    const checked = this.check(dir)
    try {
      const entries = await this.client.readdir(checked, this.authToken)
      // nexusd returns full paths for names; normalize to basename.
      return entries.map(e => {
        const full = e.name.startsWith('/') ? e.name : `${checked}/${e.name}`
        return { name: full.slice(full.lastIndexOf('/') + 1), path: full, isDirectory: e.entryType === 1 }
      })
    } catch {
      return []
    }
  }

  async remove(p: string): Promise<void> {
    const checked = this.check(p)
    const entries = await this.list(checked)
    for (const e of entries) await this.remove(e.path)
    try {
      await this.client.delete(checked, this.authToken)
    } catch {
      // Already gone.
    }
  }

  async size(p: string): Promise<number | null> {
    try {
      const st = await this.client.stat(this.check(p), this.authToken)
      return st ? st.size : null
    } catch {
      return null
    }
  }
}
