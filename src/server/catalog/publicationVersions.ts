/** Product release versions are independent of source revisions and runtime digests. */
export function isPublicationVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(value)
}
export function comparePublicationVersions(a: string, b: string): number {
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!
  return 0
}
export function latestPublicationVersion(versions: string[]): string | null {
  return versions.filter(isPublicationVersion).sort(comparePublicationVersions).at(-1) ?? null
}
export function nextPublicationVersion(version: string | null | undefined): string {
  if (!isPublicationVersion(version)) return '1.0.0'
  const parts = version.split('.').map(Number)
  for (let i = 2; i >= 0; i--) {
    if (parts[i]! < 999999999) { parts[i]!++; return parts.join('.') }
    parts[i] = 0
  }
  throw new Error('发布版本号已达到上限')
}
export function publicationVersionError(version: unknown, released: string[], reserved: string[] = []): string | null {
  if (!isPublicationVersion(version)) return '版本号格式应为主版本.次版本.修订号，例如 1.1.0 或 2.0.0'
  if (released.includes(version) || reserved.includes(version)) return '该版本号已发布或正在审核，请使用其他版本号'
  const latest = latestPublicationVersion(released)
  if (latest && comparePublicationVersions(version, latest) <= 0) return `新版本必须高于已发布版本 ${latest}`
  return null
}
