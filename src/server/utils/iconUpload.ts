import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { extname, join } from 'path'

const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
])

const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
}

const DEFAULT_MAX_SIZE = 2 * 1024 * 1024 // 2MB

/**
 * Save an uploaded icon image to disk and return its URL path.
 *
 * @param baseDir  - Base directory (e.g. config.runtimeDir) where uploads/ subdirectory lives
 * @param buffer   - Raw file bytes
 * @param contentType - MIME type from Content-Type header (may be undefined)
 * @param subDir  - Subdirectory under uploads/ (e.g. 'config-items' or 'mcp-icons')
 * @param maxSize - Maximum file size in bytes (default 2MB)
 * @returns URL path string (e.g. "/uploads/config-items/uuid.png")
 */
export async function saveUploadedIcon(
  baseDir: string,
  buffer: Buffer,
  contentType: string | undefined,
  subDir: string,
  maxSize: number = DEFAULT_MAX_SIZE,
): Promise<string> {
  // 1. Validate Content-Type
  const mime = normalizeContentType(contentType)
  if (!ALLOWED_CONTENT_TYPES.has(mime)) {
    throw new Error(`不支持的图片格式: ${mime}，仅支持 PNG、JPG、WebP、SVG`)
  }

  // 2. Validate file size
  if (buffer.length > maxSize) {
    throw new Error(`图片大小不能超过 ${Math.round(maxSize / 1024)}KB`)
  }

  // 3. Generate UUID filename with correct extension
  const ext = CONTENT_TYPE_EXT[mime]
  const filename = `${randomUUID()}${ext}`

  // 4. Ensure directory exists and write file
  const dir = join(baseDir, 'uploads', subDir)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, filename)
  await writeFile(filePath, buffer)

  // 5. Return URL path
  return `/uploads/${subDir}/${filename}`
}

function normalizeContentType(contentType: string | undefined): string {
  if (!contentType) return 'image/png'
  const parsed = contentType.split(';')[0].trim().toLowerCase()
  if (parsed === 'image/jpg') return 'image/jpeg'
  return parsed
}
