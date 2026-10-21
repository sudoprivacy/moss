import { ManagedImageError, type ManagedImageStore } from '../configuration/managedImageStore.js'
import { HttpError } from '../httpRespond.js'

export async function saveParkLogo(images: ManagedImageStore | undefined, value: unknown) {
  if (!images) throw new HttpError(503, 'Image store is unavailable')
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'Invalid logo upload')
  const upload = value as Record<string, unknown>
  const encoded = upload.content_base64
  if (
    typeof upload.file_name !== 'string' ||
    typeof upload.mime_type !== 'string' ||
    typeof encoded !== 'string' ||
    !encoded ||
    encoded.length > Math.ceil((500 * 1024) / 3) * 4 ||
    /[^A-Za-z0-9+/=]/.test(encoded)
  ) {
    throw new HttpError(400, 'Invalid logo upload')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.toString('base64') !== encoded)
    throw new HttpError(400, 'Invalid logo content')
  try {
    return await images.put({
      kind: 'park-logo',
      originalName: upload.file_name,
      mimeType: upload.mime_type,
      bytes,
    })
  } catch (error) {
    if (error instanceof ManagedImageError) throw new HttpError(error.statusCode, error.message)
    throw error
  }
}
