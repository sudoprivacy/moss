import type { BrowserPrincipal } from './browserGateway.js'

/** Unset enables the deployment; an explicit empty list enables no owners. */
export function browserAllowedOwners(): BrowserPrincipal[] | null {
  const source = process.env.MOSS_BROWSER_ALLOWED_OWNERS
  if (source === undefined) return null
  try {
    if (source.length > 65_536) throw new Error()
    const value: unknown = JSON.parse(source)
    if (!Array.isArray(value) || value.length > 200) throw new Error()
    for (const owner of value) {
      if (!owner || typeof owner !== 'object' || Array.isArray(owner) ||
        Object.keys(owner).some(key => key !== 'orgId' && key !== 'userId') ||
        typeof owner.orgId !== 'string' || !owner.orgId.trim() || owner.orgId.length > 255 ||
        typeof owner.userId !== 'string' || !owner.userId.trim() || owner.userId.length > 255) throw new Error()
    }
    return value as BrowserPrincipal[]
  } catch {
    throw new Error('Invalid MOSS_BROWSER_ALLOWED_OWNERS')
  }
}

export function browserOwnerAllowed(principal: BrowserPrincipal): boolean {
  const owners = browserAllowedOwners()
  return owners === null || owners.some(owner => owner.orgId === principal.orgId && owner.userId === principal.userId)
}
