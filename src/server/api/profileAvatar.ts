import { AuthServiceError } from '../auth/service.js'

const MAX_IMAGE_BYTES = 2 * 1024 * 1024

/** Only decoded, re-encoded raster data is persisted or returned to clients. */
export async function normalizeProfileAvatar(value: unknown): Promise<string | null> {
  if (value === null) return null
  if (typeof value !== 'string') throw new AuthServiceError(400, 'avatar must be an image data URL or null')
  if (value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64) throw new AuthServiceError(413, 'Avatar exceeds 2 MiB')
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match) throw new AuthServiceError(400, 'Only PNG, JPEG and WebP avatars are supported')
  const input = Buffer.from(match[2]!, 'base64')
  if (input.length > MAX_IMAGE_BYTES) throw new AuthServiceError(413, 'Avatar exceeds 2 MiB')
  try {
    const { default: sharp } = await import('sharp')
    const image = sharp(input, { limitInputPixels: 16_000_000, failOn: 'warning' })
    const metadata = await image.metadata()
    if (metadata.format !== match[1] || (metadata.pages ?? 1) > 1) throw new Error('Unsupported image')
    const output = await image.rotate().resize(256, 256, { fit: 'cover' }).webp({ quality: 85 }).toBuffer()
    return `data:image/webp;base64,${output.toString('base64')}`
  } catch {
    throw new AuthServiceError(400, 'Invalid or unsupported avatar image')
  }
}
