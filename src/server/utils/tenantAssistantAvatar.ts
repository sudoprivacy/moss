import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, unlink, writeFile } from 'fs/promises'
import { join } from 'path'

export type TenantAssistantAvatarUpload = {
  filename: string
  contentType: string
  data: Buffer
}

export type TenantAssistantAvatarValidation = {
  extension: '.png' | '.jpg' | '.svg'
  contentType: 'image/png' | 'image/jpeg' | 'image/svg+xml'
  data: Buffer
}

const MAX_AVATAR_BYTES = 2 * 1024 * 1024
const AVATAR_URL_PREFIX = '/uploads/tenant-assistant-avatars/'
const MANAGED_AVATAR_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|svg)$/i

function normalizedContentType(contentType: string): string {
  const value = contentType.split(';')[0]?.trim().toLowerCase() || ''
  return value === 'image/jpg' ? 'image/jpeg' : value
}

function hasPngSignature(data: Buffer): boolean {
  return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
}

function hasJpegSignature(data: Buffer): boolean {
  return data.length >= 3 && data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
}

function isSvg(data: Buffer): boolean {
  const source = data.toString('utf8')
  return /<svg(?:\s|>)/i.test(source)
    && !/<script\b|\son\w+\s*=|(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|data:|javascript:)/i.test(source)
}

export function validateTenantAssistantAvatar(upload: TenantAssistantAvatarUpload): TenantAssistantAvatarValidation {
  if (upload.data.length === 0 || upload.data.length > MAX_AVATAR_BYTES) {
    throw new Error('头像图片大小必须大于 0 且不超过 2 MiB')
  }

  const contentType = normalizedContentType(upload.contentType)
  const filename = upload.filename.trim().toLowerCase()

  if (contentType === 'image/png' && filename.endsWith('.png') && hasPngSignature(upload.data)) {
    return { extension: '.png', contentType: 'image/png', data: upload.data }
  }
  if (contentType === 'image/jpeg' && (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) && hasJpegSignature(upload.data)) {
    return { extension: '.jpg', contentType: 'image/jpeg', data: upload.data }
  }
  if (contentType === 'image/svg+xml' && filename.endsWith('.svg') && isSvg(upload.data)) {
    return { extension: '.svg', contentType: 'image/svg+xml', data: upload.data }
  }

  throw new Error('头像仅支持 PNG、JPG/JPEG、SVG 格式')
}

export async function saveTenantAssistantAvatar(
  runtimeDir: string,
  upload: TenantAssistantAvatarUpload,
): Promise<string> {
  const validated = validateTenantAssistantAvatar(upload)
  const filename = `${randomUUID()}${validated.extension}`
  const directory = join(runtimeDir, 'uploads', 'tenant-assistant-avatars')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, filename), validated.data)
  return `${AVATAR_URL_PREFIX}${filename}`
}

export function getTenantAssistantAvatarFilename(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url.startsWith(AVATAR_URL_PREFIX)) return null
  const filename = url.slice(AVATAR_URL_PREFIX.length)
  return MANAGED_AVATAR_NAME.test(filename) ? filename : null
}

export async function removeTenantAssistantAvatar(runtimeDir: string, url: string | null | undefined): Promise<void> {
  const filename = getTenantAssistantAvatarFilename(url)
  if (!filename) return
  const path = join(runtimeDir, 'uploads', 'tenant-assistant-avatars', filename)
  if (existsSync(path)) await unlink(path)
}
