import { ManagedImageError, type ManagedImageStore } from '../configuration/managedImageStore.js'
import type { SudoworkManagedImage } from './sudoworkP2SourceReader.js'

interface P2ManagedImageSource {
  readManagedImages(): Promise<SudoworkManagedImage[]>
}

export interface P2ManagedImageMigrationPlan {
  status: 'ready' | 'blocked'
  counts: { source: number; imports: number; reuses: number }
  conflicts: Array<{ filename: string; reason: string }>
}

export class P2ManagedImageMigrationBlockedError extends Error {
  constructor(readonly report: P2ManagedImageMigrationPlan) {
    super(`P2 配置图片迁移预检失败: ${report.conflicts.length} 个冲突`)
    this.name = 'P2ManagedImageMigrationBlockedError'
  }
}

export class P2ManagedImageMigrationService {
  constructor(private readonly options: {
    source: P2ManagedImageSource
    target: ManagedImageStore
  }) {}

  async plan(): Promise<P2ManagedImageMigrationPlan> {
    const images = await this.options.source.readManagedImages()
    const conflicts: Array<{ filename: string; reason: string }> = []
    const seen = new Set<string>()
    let imports = 0
    let reuses = 0
    for (const image of images) {
      const key = `${image.kind}:${image.filename}`
      if (seen.has(key)) {
        conflicts.push({ filename: image.filename, reason: '源快照包含重复图片文件名' })
        continue
      }
      seen.add(key)
      try {
        await this.options.target.inspect(image)
        try {
          const existing = await this.options.target.read(image.kind, image.filename)
          if (existing.mimeType !== image.mimeType || !existing.bytes.equals(image.bytes)) {
            conflicts.push({ filename: image.filename, reason: '目标存在同名但内容不同的图片' })
          } else {
            reuses += 1
          }
        } catch (error) {
          if (error instanceof ManagedImageError && error.statusCode === 404) imports += 1
          else throw error
        }
      } catch (error) {
        conflicts.push({ filename: image.filename, reason: errorMessage(error) })
      }
    }
    return {
      status: conflicts.length > 0 ? 'blocked' : 'ready',
      counts: { source: images.length, imports, reuses },
      conflicts,
    }
  }

  async execute(): Promise<{ imported: number; reused: number; source: number }> {
    const plan = await this.plan()
    if (plan.status === 'blocked') throw new P2ManagedImageMigrationBlockedError(plan)
    const images = await this.options.source.readManagedImages()
    let imported = 0
    let reused = 0
    for (const image of images) {
      const result = await this.options.target.importExisting(image)
      if (result.reused) reused += 1
      else imported += 1
    }
    return { imported, reused, source: images.length }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
