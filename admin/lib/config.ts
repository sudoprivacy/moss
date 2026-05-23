/**
 * COS (Cloud Object Storage) base URL for skill/assistant icons and assets
 * Can be overridden via environment variable or runtime config
 */
export const COS_BASE_URL =
  import.meta.env.VITE_COS_BASE_URL ||
  'https://sudoclaw-1309794936.cos.ap-beijing.myqcloud.com'

/**
 * Build full URL for COS assets
 */
export function buildCosUrl(path: string): string {
  if (!path) return ''
  if (path.startsWith('http')) return path
  const cleanPath = path.replace(/^\/+/, '')
  return `${COS_BASE_URL}/${cleanPath}`
}

/**
 * Resolve icon URL - handles both full URLs and relative COS paths
 */
export function resolveIconUrl(icon: string | undefined | null): string | undefined {
  if (!icon) return undefined
  if (icon.startsWith('http')) return icon
  if (icon.includes('skill-hub/') || icon.includes('assistant-hub/')) {
    return buildCosUrl(icon)
  }
  return icon
}
