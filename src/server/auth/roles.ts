export type AuthRole = 'super_admin' | 'admin' | 'dept_admin' | 'user'

/** Roles allowed to manage organization bindings. */
export const ADMIN_ROLES: ReadonlySet<string> = new Set(['admin', 'super_admin'])
