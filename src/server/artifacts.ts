import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { detectFileIntent, matchesDraftPattern } from './draftsCleanup.js'

export const artifactDeclarationsSchema = z.object({
  files: z.array(z.object({
    path: z.string().min(1).max(4096),
    intent: z.enum(['final', 'draft']),
    release: z.boolean().optional().describe('Draft is no longer needed at this path by any later step'),
  }).strict()).max(100),
}).strict()
export type ArtifactDeclaration = z.infer<typeof artifactDeclarationsSchema>['files'][number]
export interface ArtifactRecord {
  sessionId: string
  turnId: string
  relativePath: string
  intent: 'final' | 'draft' | 'unknown'
  origin: 'generated' | 'existing' | 'uploaded'
  revision: string
  size: number
  updatedAt: number
  error?: string
}
export interface ArtifactManifest { v: 1; records: ArtifactRecord[] }
type Fingerprint = { revision: string; size: number }
const ignored = new Set(['.moss', '.scode', '.git', '.nexus', 'node_modules', '.env', 'AGENTS.md'])

export function artifactManifestPath(transcriptPath: string): string {
  return `${transcriptPath}.artifacts.json`
}

/** Only regular files are collected; symlinks and runtime metadata are never artifacts. */
export async function snapshotWorkspace(workspace: string): Promise<Map<string, Fingerprint>> {
  const result = new Map<string, Fingerprint>()
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name) || entry.name.startsWith('.env.')) continue
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) {
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(absolute)) hash.update(chunk)
        result.set(path.relative(workspace, absolute).split(path.sep).join('/'), {
          revision: hash.digest('hex'), size: (await stat(absolute)).size,
        })
      }
    }
  }
  await walk(workspace)
  return result
}

export async function readArtifacts(file: string): Promise<ArtifactManifest> {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (data.v === 1 && Array.isArray(data.records)) return data
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { v: 1, records: [] }
}

/** Runtime-owned records live beside the transcript, outside the agent workspace. */
export class ArtifactTracker {
  private before = new Map<string, Fingerprint>()
  private records = new Map<string, ArtifactRecord>()
  private declarations = new Map<string, ArtifactDeclaration>()
  private turnId = ''
  constructor(private workspace: string, private sessionId: string, private manifestPath: string) {}

  async begin(turnId: string): Promise<void> {
    this.workspace = realpathSync(this.workspace)
    this.turnId = turnId
    this.declarations.clear()
    this.before = await snapshotWorkspace(this.workspace)
    const manifest = await readArtifacts(this.manifestPath)
    this.records = new Map(manifest.records.filter(r => r.sessionId === this.sessionId).map(r => [r.relativePath, r]))
  }

  declare(input: unknown): void {
    const parsed = artifactDeclarationsSchema.safeParse(input)
    if (!parsed.success) return
    for (const file of parsed.data.files) {
      let absolute: string
      try { absolute = realpathSync(path.resolve(this.workspace, file.path)) } catch { continue }
      const relative = path.relative(this.workspace, absolute).split(path.sep).join('/')
      if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) continue
      this.declarations.set(relative, { ...file, path: relative })
    }
  }

  async finish(isCancelled = false): Promise<{ manifest: ArtifactManifest; changed: ArtifactRecord[] }> {
    const after = await snapshotWorkspace(this.workspace)
    const changed: ArtifactRecord[] = []
    for (const [relativePath, fingerprint] of after) {
      const previous = this.records.get(relativePath)
      const original = this.before.get(relativePath)
      const declaration = this.declarations.get(relativePath)
      const isChanged = original?.revision !== fingerprint.revision
      if (!isChanged && !declaration) continue
      // A previous generated origin survives edits; pre-existing inputs never become
      // generated just because a tool claims them as a deliverable.
      const origin = original && previous?.revision !== original.revision ? 'existing' : (previous?.origin ?? (original ? 'existing' : 'generated'))
      let intent: ArtifactRecord['intent'] = 'unknown'
      const absolute = path.join(this.workspace, relativePath)
      if (origin === 'generated') {
        if (relativePath.startsWith('.drafts/')) intent = 'draft'
        else if (declaration) intent = declaration.intent
        else if (previous?.revision === fingerprint.revision) intent = previous.intent
        else {
          const content = fingerprint.size <= 1024 * 1024 ? await readFile(absolute, 'utf8') : ''
          intent = detectFileIntent(relativePath, content).intent
          if (intent === 'unknown' && matchesDraftPattern(path.basename(relativePath))) intent = 'draft'
        }
      }
      const record: ArtifactRecord = {
        sessionId: this.sessionId, turnId: this.turnId, relativePath, intent, origin,
        ...fingerprint, updatedAt: Date.now(),
      }
      if (intent === 'final' && path.extname(relativePath).toLowerCase() === '.json') {
        try { JSON.parse(await readFile(absolute, 'utf8')) }
        catch { record.intent = 'unknown'; record.error = 'Invalid JSON; repair and declare the file again.' }
      }
      if (isCancelled && record.intent === 'final' && origin === 'generated') record.intent = 'unknown'
      // The declaration releases a dependency explicitly; end-of-turn alone never does.
      if (!isCancelled && origin === 'generated' && record.intent === 'draft' && declaration?.release && !relativePath.startsWith('.drafts/')) {
        let destination = `.drafts/${relativePath}`
        if (after.has(destination)) {
          const ext = path.extname(relativePath)
          destination = `.drafts/${relativePath.slice(0, relativePath.length - ext.length)}-${randomUUID()}${ext}`
        }
        await mkdir(path.dirname(path.join(this.workspace, destination)), { recursive: true })
        await rename(absolute, path.join(this.workspace, destination))
        this.records.delete(relativePath)
        record.relativePath = destination
      }
      this.records.set(record.relativePath, record)
      changed.push(record)
    }
    for (const key of this.records.keys()) {
      if (!after.has(key) && !changed.some(r => r.relativePath === key)) this.records.delete(key)
    }
    const manifest: ArtifactManifest = { v: 1, records: [...this.records.values()] }
    await mkdir(path.dirname(this.manifestPath), { recursive: true })
    const temporary = `${this.manifestPath}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600 })
    await rename(temporary, this.manifestPath)
    return { manifest, changed }
  }
}

interface ArtifactTreeNode {
  name: string
  relativePath: string
  fullPath: string
  isFile: boolean
  isDir: boolean
  size?: number
  children?: ArtifactTreeNode[]
}
/** Draft-box entries may point to live files outside .drafts without relocating them. */
export async function projectArtifactDrafts(root: ArtifactTreeNode, workspace: string, manifest: ArtifactManifest): Promise<void> {
  if (root.relativePath && root.relativePath !== '.drafts') return
  const current = await snapshotWorkspace(workspace)
  const drafts = root.relativePath === '.drafts' ? root : root.children?.find(node => node.relativePath === '.drafts')
  if (!drafts) return
  drafts.children ??= []
  for (const record of manifest.records) {
    if (record.origin !== 'generated' || record.intent !== 'draft' || record.relativePath.startsWith('.drafts/')) continue
    if (current.get(record.relativePath)?.revision !== record.revision) continue
    if (drafts.children.some(node => node.relativePath === record.relativePath)) continue
    drafts.children.push({ name: record.relativePath, relativePath: record.relativePath, fullPath: path.join(workspace, record.relativePath), isDir: false, isFile: true, size: record.size })
  }
}
