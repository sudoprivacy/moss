export type CredentialScope = 'system' | 'department' | 'user'

/** A listed field is saved even when disabled; list entries contain no value. */
export function hasSavedCredentialField(entries: readonly { key: string }[], key: string): boolean {
  return entries.some(entry => entry.key === key)
}

export type CredentialDestinationPermissions = {
  canReadAdminSecrets: boolean
  canReadDepartmentSecrets: boolean
  canWriteUserSecrets: boolean
  canWriteAdminSecrets: boolean
}

/** Returns the credential page that owns values for a config-item scope. */
export function credentialRouteForScope(scope: CredentialScope): string {
  switch (scope) {
    case 'department':
      return '/secrets/department'
    case 'user':
      return '/secrets/user-credentials'
    case 'system':
    default:
      return '/secrets/enterprise'
  }
}

/** Whether the current role may navigate to the page owning this credential. */
export function canReadCredentialDestination(
  scope: CredentialScope,
  permissions: CredentialDestinationPermissions,
): boolean {
  switch (scope) {
    case 'department':
      return permissions.canReadAdminSecrets || permissions.canReadDepartmentSecrets
    case 'user':
      return permissions.canReadAdminSecrets || permissions.canWriteUserSecrets
    case 'system':
    default:
      return permissions.canReadAdminSecrets
  }
}

/**
 * Rotation alerts only update metadata. Admins need the server's secrets-write
 * scope; a user-scoped credential can also be extended by its owner role.
 */
export function canExtendCredentialExpiry(
  scope: CredentialScope,
  permissions: CredentialDestinationPermissions,
): boolean {
  return permissions.canWriteAdminSecrets || (scope === 'user' && permissions.canWriteUserSecrets)
}

export type ExpiryAlertLevel = 'expired' | 'urgent' | 'upcoming'

export function expiryAlertLevel(expiresAt: number | null, now = Date.now()): ExpiryAlertLevel {
  if (!expiresAt || expiresAt <= now) return 'expired'
  return expiresAt - now < 6 * 60 * 60 * 1000 ? 'urgent' : 'upcoming'
}
