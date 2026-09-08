import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { MIGRATION_PHASES, type MigrationPhaseName } from './migrationRunStore.js'

export type SourceComponentName = 'sqlite' | 'redis' | 'qms' | 'files'

export interface SourceComponentSnapshot {
  name: SourceComponentName
  checksum: string
  itemCount: number
  readOnly: boolean
  metadata: Record<string, unknown>
}

export interface SourceComponentReader {
  capture(): Promise<SourceComponentSnapshot>
}

export interface SudoworkSourceSnapshot {
  fingerprint: string
  capturedAt: string
  sqlite: SourceComponentSnapshot
  redis: SourceComponentSnapshot
  qms: SourceComponentSnapshot
  files: SourceComponentSnapshot
  includedDomains: MigrationPhaseName[]
  excludedLocalData: ['sessions', 'client_cron', 'client_channels']
}

export type SudoworkSourceSnapshotErrorCode =
  | 'MISSING_COMPONENT'
  | 'SOURCE_NOT_READ_ONLY'
  | 'SOURCE_CHANGED'
  | 'UNSAFE_PATH'
  | 'SOURCE_MUTATED_DURING_READ'

export class SudoworkSourceSnapshotError extends Error {
  constructor(readonly code: SudoworkSourceSnapshotErrorCode, message: string) {
    super(message)
    this.name = 'SudoworkSourceSnapshotError'
  }
}

export class SudoworkSourceSnapshotReader {
  private readonly clock: () => string

  constructor(private readonly readers: Record<SourceComponentName, SourceComponentReader>, options: {
    clock?: () => string
  } = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString())
  }

  async capture(): Promise<SudoworkSourceSnapshot> {
    const components = {} as Record<SourceComponentName, SourceComponentSnapshot>
    for (const name of ['sqlite', 'redis', 'qms', 'files'] as const) {
      const snapshot = await this.readers[name].capture()
      if (snapshot.name !== name || !snapshot.checksum.trim()) {
        throw new SudoworkSourceSnapshotError('MISSING_COMPONENT', `迁移源组件缺失或无校验和: ${name}`)
      }
      if (!snapshot.readOnly) {
        throw new SudoworkSourceSnapshotError('SOURCE_NOT_READ_ONLY', `迁移源组件不是只读快照: ${name}`)
      }
      components[name] = normalizeComponent(snapshot)
    }

    const includedDomains = [...MIGRATION_PHASES]
    const excludedLocalData = ['sessions', 'client_cron', 'client_channels'] as const
    const fingerprintInput = {
      schemaVersion: 1,
      components,
      includedDomains,
      excludedLocalData,
    }
    return {
      fingerprint: sha256(stableJson(fingerprintInput)),
      capturedAt: this.clock(),
      ...components,
      includedDomains,
      excludedLocalData: [...excludedLocalData],
    }
  }

  async assertUnchanged(expectedFingerprint: string): Promise<void> {
    const current = await this.capture()
    if (current.fingerprint !== expectedFingerprint) {
      throw new SudoworkSourceSnapshotError(
        'SOURCE_CHANGED',
        `迁移源快照已变化: expected=${expectedFingerprint}, actual=${current.fingerprint}`,
      )
    }
  }
}

export class FileTreeSnapshotReader implements SourceComponentReader {
  private readonly root: string
  private readonly allowlist: string[]

  constructor(root: string, allowlist: readonly string[]) {
    this.root = resolve(root)
    if (allowlist.length === 0) {
      throw new SudoworkSourceSnapshotError('MISSING_COMPONENT', '文件快照白名单不能为空')
    }
    this.allowlist = [...new Set(allowlist.map(path => this.safeRelativePath(path)))].sort()
  }

  async capture(): Promise<SourceComponentSnapshot> {
    const paths: string[] = []
    for (const entry of this.allowlist) {
      const absolute = resolve(this.root, entry)
      let info
      try {
        info = await lstat(absolute)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new SudoworkSourceSnapshotError('MISSING_COMPONENT', `文件快照白名单路径不存在: ${entry}`)
        }
        throw error
      }
      if (info.isSymbolicLink()) this.rejectSymbolicLink(entry)
      if (info.isFile()) paths.push(entry)
      else if (info.isDirectory()) await this.walk(entry, paths)
      else throw new SudoworkSourceSnapshotError('UNSAFE_PATH', `文件快照包含非普通文件: ${entry}`)
    }

    paths.sort()
    const uniquePaths = [...new Set(paths)]
    const hash = createHash('sha256')
    let totalBytes = 0
    for (const path of uniquePaths) {
      const absolute = resolve(this.root, path)
      const before = await lstat(absolute)
      if (!before.isFile() || before.isSymbolicLink()) this.rejectSymbolicLink(path)
      const bytes = await readFile(absolute)
      const after = await lstat(absolute)
      if (!sameFileState(before, after)) {
        throw new SudoworkSourceSnapshotError('SOURCE_MUTATED_DURING_READ', `文件在快照扫描期间发生变化: ${path}`)
      }
      totalBytes += bytes.byteLength
      hash.update(path).update('\0').update(String(bytes.byteLength)).update('\0').update(bytes).update('\0')
    }

    return {
      name: 'files',
      checksum: hash.digest('hex'),
      itemCount: uniquePaths.length,
      readOnly: true,
      metadata: { paths: uniquePaths, totalBytes },
    }
  }

  private async walk(directory: string, result: string[]): Promise<void> {
    const entries = await readdir(resolve(this.root, directory), { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const child = normalizeRelative(`${directory}/${entry.name}`)
      if (entry.isSymbolicLink()) this.rejectSymbolicLink(child)
      if (entry.isFile()) result.push(child)
      else if (entry.isDirectory()) await this.walk(child, result)
      else throw new SudoworkSourceSnapshotError('UNSAFE_PATH', `文件快照包含非普通文件: ${child}`)
    }
  }

  private safeRelativePath(path: string): string {
    if (!path.trim() || isAbsolute(path)) {
      throw new SudoworkSourceSnapshotError('UNSAFE_PATH', `文件快照路径必须是相对路径: ${path}`)
    }
    const absolute = resolve(this.root, path)
    const relativePath = relative(this.root, absolute)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new SudoworkSourceSnapshotError('UNSAFE_PATH', `文件快照路径逃逸根目录: ${path}`)
    }
    return normalizeRelative(relativePath)
  }

  private rejectSymbolicLink(path: string): never {
    throw new SudoworkSourceSnapshotError('UNSAFE_PATH', `文件快照不允许符号链接: ${path}`)
  }
}

function normalizeComponent(snapshot: SourceComponentSnapshot): SourceComponentSnapshot {
  return {
    name: snapshot.name,
    checksum: snapshot.checksum.trim(),
    itemCount: snapshot.itemCount,
    readOnly: true,
    metadata: sortJson(snapshot.metadata) as Record<string, unknown>,
  }
}

function sameFileState(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && right.isFile()
    && !right.isSymbolicLink()
}

function normalizeRelative(path: string): string {
  return path.split(sep).join('/')
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]))
  }
  return value
}
