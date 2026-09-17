import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import sharp from 'sharp'

const MAX_FILE_SIZE = 500 * 1024
const MIME_BY_EXTENSION = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
])
const GENERATED_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:svg|png|jpe?g)$/

export type ManagedImageKind = 'config-item' | 'enterprise'

export class ManagedImageError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'ManagedImageError'
  }
}

export class ManagedImageStore {
  constructor(private readonly root: string) {}

  async inspect(input: {
    kind: ManagedImageKind
    filename: string
    mimeType: string
    bytes: Uint8Array
  }): Promise<void> {
    const extension = extname(input.filename).toLowerCase()
    const expectedMime = MIME_BY_EXTENSION.get(extension)
    if (!expectedMime || expectedMime !== input.mimeType.toLowerCase()) {
      throw new ManagedImageError(400, '仅支持 SVG、PNG、JPG 格式的图片')
    }
    if (input.bytes.byteLength > MAX_FILE_SIZE) {
      throw new ManagedImageError(400, '文件大小不能超过 500KB')
    }
    await this.validateImage(input.bytes, extension, input.kind === 'config-item')
  }

  async put(input: {
    kind: ManagedImageKind
    originalName: string
    mimeType: string
    bytes: Uint8Array
  }): Promise<{ filename: string; publicPath: string }> {
    const extension = extname(input.originalName).toLowerCase()
    await this.inspect({ ...input, filename: input.originalName })

    const directoryName = directoryFor(input.kind)
    const directory = join(this.root, directoryName)
    const filename = `${randomUUID()}${extension}`
    const destination = join(directory, filename)
    const temporary = join(directory, `.${filename}.tmp`)
    await mkdir(directory, { recursive: true })
    try {
      await writeFile(temporary, input.bytes, { flag: 'wx' })
      await rename(temporary, destination)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    return {
      filename,
      publicPath: `/uploads/${directoryName}/${filename}`,
    }
  }

  async read(kind: ManagedImageKind, filename: string): Promise<{ bytes: Buffer; mimeType: string }> {
    if (basename(filename) !== filename || !GENERATED_FILENAME.test(filename)) {
      throw new ManagedImageError(404, 'File not found')
    }
    const mimeType = MIME_BY_EXTENSION.get(extname(filename).toLowerCase())
    if (!mimeType) throw new ManagedImageError(404, 'File not found')
    try {
      return {
        bytes: await readFile(join(this.root, directoryFor(kind), filename)),
        mimeType,
      }
    } catch {
      throw new ManagedImageError(404, 'File not found')
    }
  }

  async importExisting(input: {
    kind: ManagedImageKind
    filename: string
    mimeType: string
    bytes: Uint8Array
  }): Promise<{ filename: string; publicPath: string; reused: boolean }> {
    if (basename(input.filename) !== input.filename || !GENERATED_FILENAME.test(input.filename)) {
      throw new ManagedImageError(400, '历史图片文件名必须是 UUID 格式')
    }
    await this.inspect(input)
    const extension = extname(input.filename).toLowerCase()
    const directoryName = directoryFor(input.kind)
    const directory = join(this.root, directoryName)
    const destination = join(directory, input.filename)
    await mkdir(directory, { recursive: true })
    try {
      const existing = await readFile(destination)
      if (!existing.equals(Buffer.from(input.bytes))) {
        throw new ManagedImageError(409, `历史图片文件名冲突: ${input.filename}`)
      }
      return { filename: input.filename, publicPath: `/uploads/${directoryName}/${input.filename}`, reused: true }
    } catch (error) {
      if (error instanceof ManagedImageError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const temporary = join(directory, `.${input.filename}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, input.bytes, { flag: 'wx' })
      await link(temporary, destination)
      return { filename: input.filename, publicPath: `/uploads/${directoryName}/${input.filename}`, reused: false }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = await readFile(destination)
        if (existing.equals(Buffer.from(input.bytes))) {
          return { filename: input.filename, publicPath: `/uploads/${directoryName}/${input.filename}`, reused: true }
        }
        throw new ManagedImageError(409, `历史图片文件名冲突: ${input.filename}`)
      }
      throw error
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private async validateImage(bytes: Uint8Array, extension: string, square: boolean): Promise<void> {
    if (extension === '.svg') {
      const source = Buffer.from(bytes).toString('utf8')
      if (/<(?:script|foreignObject|iframe|object|embed)\b|\bon\w+\s*=|(?:href|src)\s*=\s*["']\s*(?:javascript:|data:|https?:)|<!DOCTYPE|<!ENTITY/i.test(source)) {
        throw new ManagedImageError(400, 'SVG 图片包含不安全内容')
      }
    }
    try {
      const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
      const actual = metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format ?? ''}`
      if (actual !== MIME_BY_EXTENSION.get(extension)) throw new Error('format mismatch')
      if (!metadata.width || !metadata.height) throw new Error('missing dimensions')
      if (square && metadata.width !== metadata.height) {
        throw new ManagedImageError(400, '图标必须是正方形图片（宽高比为 1:1）')
      }
    } catch (error) {
      if (error instanceof ManagedImageError) throw error
      throw new ManagedImageError(400, '无法解析图片尺寸，请确保上传有效的图片文件')
    }
  }
}

function directoryFor(kind: ManagedImageKind): 'config-items' | 'enterprises' {
  return kind === 'config-item' ? 'config-items' : 'enterprises'
}
