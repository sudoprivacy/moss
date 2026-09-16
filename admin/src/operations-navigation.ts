export const OPERATION_ROUTES = {
  invitations: '/operations/invitations',
  billing: '/operations/billing',
  audit: '/operations/audit',
  quality: '/operations/quality',
  sudoworkSettings: '/operations/sudowork-settings',
} as const

export function canSeeOperationsNavigation(scopes: readonly string[]): boolean {
  return scopes.includes('*')
    || scopes.includes('admin:*')
    || scopes.includes('admin:settings')
}
