import { URL } from 'url'

export interface ValidateUrlResult {
  valid: boolean
  error?: string
}

export function validateRemoteUrl(rawUrl: string): ValidateUrlResult {
  if (!rawUrl) return { valid: false, error: 'URL is empty' }
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: `Unsupported protocol: ${parsed.protocol}` }
    }
    return { valid: true }
  } catch {
    return { valid: false, error: 'Invalid URL format' }
  }
}
