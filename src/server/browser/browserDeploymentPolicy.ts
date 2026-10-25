import type { BrowserPrincipal } from './browserGateway.js'

type BrowserOwnerImage = BrowserPrincipal & { image: string }

function isOwner(value: unknown, fields: readonly string[]): value is BrowserPrincipal {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => fields.includes(key)) &&
    'orgId' in value && typeof value.orgId === 'string' && !!value.orgId.trim() && value.orgId.length <= 255 &&
    'userId' in value && typeof value.userId === 'string' && !!value.userId.trim() && value.userId.length <= 255
}

export function isDigestPinnedBrowserImage(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-zA-Z0-9._/:\-]+@)?sha256:[a-f0-9]{64}$/.test(value)
}

/** Unset enables the deployment; an explicit empty list enables no owners. */
export function browserAllowedOwners(): BrowserPrincipal[] | null {
  const source = process.env.MOSS_BROWSER_ALLOWED_OWNERS
  if (source === undefined) return null
  try {
    if (source.length > 65_536) throw new Error()
    const value: unknown = JSON.parse(source)
    if (!Array.isArray(value) || value.length > 200) throw new Error()
    for (const owner of value) {
      if (!isOwner(owner, ['orgId', 'userId'])) throw new Error()
    }
    return value as BrowserPrincipal[]
  } catch {
    throw new Error('Invalid MOSS_BROWSER_ALLOWED_OWNERS')
  }
}

/** Deployment pins preserve an owner's running browser during a staged upgrade. */
export function browserOwnerImages(): BrowserOwnerImage[] {
  const source = process.env.MOSS_BROWSER_OWNER_IMAGES
  if (source === undefined) return []
  try {
    if (source.length > 65_536) throw new Error()
    const value: unknown = JSON.parse(source)
    if (!Array.isArray(value) || value.length > 200) throw new Error()
    if (value.length && !isDigestPinnedBrowserImage(process.env.MOSS_BROWSER_IMAGE)) throw new Error()
    const seen = new Set<string>()
    for (const owner of value) {
      if (!isOwner(owner, ['orgId', 'userId', 'image']) || !('image' in owner) || !isDigestPinnedBrowserImage(owner.image)) throw new Error()
      const key = JSON.stringify([owner.orgId, owner.userId])
      if (seen.has(key)) throw new Error()
      seen.add(key)
    }
    return value as BrowserOwnerImage[]
  } catch {
    throw new Error('Invalid MOSS_BROWSER_OWNER_IMAGES')
  }
}

export function browserOwnerAllowed(principal: BrowserPrincipal): boolean {
  const owners = browserAllowedOwners()
  return owners === null || owners.some(owner => owner.orgId === principal.orgId && owner.userId === principal.userId)
}
