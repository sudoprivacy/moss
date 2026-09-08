import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import JSZip from 'jszip'

export type CatalogArtifactKind = 'agent' | 'skill'

export class CatalogArtifactError extends Error {
  constructor(
    readonly code: 'INVALID_ARCHIVE' | 'ARCHIVE_TOO_LARGE' | 'UNSAFE_PATH' | 'CHECKSUM_MISMATCH' | 'ARTIFACT_EXISTS',
    message: string,
  ) {
    super(message)
    this.name = 'CatalogArtifactError'
  }
}

export interface StagedCatalogArtifact {
  kind: CatalogArtifactKind
  checksum: string
  size: number
  stagingPath: string
  finalPath: string
}

export interface InspectedCatalogArtifact {
  checksum: string
  size: number
}

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_EXPANDED_BYTES = 200 * 1024 * 1024
const MAX_FILES = 2_048

export class CatalogArtifactStore {
  private readonly root: string

  constructor(rootDir: string) {
    this.root = resolve(rootDir)
  }

  async stage(input: {
    kind: CatalogArtifactKind
    orgId: string
    resourceId: string
    version: string
    bytes: Buffer
  }): Promise<StagedCatalogArtifact> {
    const { checksum } = await inspectCatalogArtifact(input.kind, input.bytes)
    const stagingDir = resolve(this.root, '.staging')
    const finalDir = resolve(
      this.root,
      input.kind,
      stableSegment(input.orgId),
      stableSegment(input.resourceId),
    )
    const stagingPath = resolve(stagingDir, `${randomUUID()}.zip`)
    const finalPath = resolve(finalDir, `${stableSegment(input.version)}-${checksum.slice(0, 16)}.zip`)
    this.assertManagedPath(stagingPath)
    this.assertManagedPath(finalPath)
    await mkdir(stagingDir, { recursive: true })
    await writeFile(stagingPath, input.bytes, { flag: 'wx' })
    return { kind: input.kind, checksum, size: input.bytes.length, stagingPath, finalPath }
  }

  async publish(staged: StagedCatalogArtifact): Promise<void> {
    this.assertManagedPath(staged.stagingPath)
    this.assertManagedPath(staged.finalPath)
    await mkdir(resolve(staged.finalPath, '..'), { recursive: true })
    try {
      const existing = await readFile(staged.finalPath)
      const checksum = createHash('sha256').update(existing).digest('hex')
      if (checksum !== staged.checksum) {
        throw new CatalogArtifactError('ARTIFACT_EXISTS', '目标版本已存在不同制品')
      }
      await rm(staged.stagingPath, { force: true })
    } catch (error) {
      if (error instanceof CatalogArtifactError) throw error
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      if (code !== 'ENOENT') throw error
      await rename(staged.stagingPath, staged.finalPath)
    }
  }

  async discard(staged: StagedCatalogArtifact): Promise<void> {
    this.assertManagedPath(staged.stagingPath)
    await rm(staged.stagingPath, { force: true })
  }

  async read(filePath: string, expectedChecksum: string): Promise<Buffer> {
    this.assertManagedPath(filePath)
    const bytes = await readFile(filePath)
    const checksum = createHash('sha256').update(bytes).digest('hex')
    if (checksum !== expectedChecksum) {
      throw new CatalogArtifactError('CHECKSUM_MISMATCH', '制品 checksum 不一致')
    }
    return bytes
  }

  async remove(filePath: string): Promise<void> {
    this.assertManagedPath(filePath)
    await rm(filePath, { force: true })
  }

  private assertManagedPath(filePath: string): void {
    const normalized = resolve(filePath)
    if (normalized !== this.root && !normalized.startsWith(`${this.root}${sep}`)) {
      throw new CatalogArtifactError('UNSAFE_PATH', '制品路径不属于统一目录')
    }
  }
}

export async function inspectCatalogArtifact(
  kind: CatalogArtifactKind,
  bytes: Buffer,
): Promise<InspectedCatalogArtifact> {
  if (bytes.length === 0 || bytes.length > MAX_ARCHIVE_BYTES) {
    throw new CatalogArtifactError('ARCHIVE_TOO_LARGE', '制品大小必须大于 0 且不超过 50 MiB')
  }
  await validateArchive(kind, bytes)
  return {
    checksum: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  }
}

async function validateArchive(kind: CatalogArtifactKind, bytes: Buffer): Promise<void> {
  let archive: JSZip
  try {
    archive = await JSZip.loadAsync(bytes)
  } catch {
    throw new CatalogArtifactError('INVALID_ARCHIVE', '制品不是有效的 ZIP 文件')
  }
  const entries = Object.values(archive.files)
  const files = entries.filter(entry => !entry.dir)
  if (files.length === 0 || files.length > MAX_FILES) {
    throw new CatalogArtifactError('INVALID_ARCHIVE', `制品文件数必须在 1 到 ${MAX_FILES} 之间`)
  }

  let expandedBytes = 0
  let hasSkillManifest = false
  for (const entry of files) {
    const originalName = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name
    if (isUnsafeEntryPath(originalName)) {
      throw new CatalogArtifactError('UNSAFE_PATH', 'ZIP 包含不安全路径')
    }
    if (/(^|\/)SKILL\.md$/i.test(entry.name)) hasSkillManifest = true
    expandedBytes += (await entry.async('uint8array')).byteLength
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new CatalogArtifactError('ARCHIVE_TOO_LARGE', '制品解压后不能超过 200 MiB')
    }
  }
  if (kind === 'skill' && !hasSkillManifest) {
    throw new CatalogArtifactError('INVALID_ARCHIVE', 'Skill 制品必须包含 SKILL.md')
  }
}

function isUnsafeEntryPath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/')
  return normalized.includes('\0')
    || normalized.startsWith('/')
    || /^[a-zA-Z]:\//.test(normalized)
    || normalized.split('/').some(segment => segment === '..')
}

function stableSegment(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
