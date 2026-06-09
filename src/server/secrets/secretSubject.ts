export const SYSTEM_SECRET_SUBJECT = 'system:moss'

export const DEPT_SECRET_SUBJECT = 'role:moss'

/** Org-scoped namespace prefix, e.g. `org:{orgId}:`. Non-user (system/role)
 *  namespaces are org-bound so two orgs can hold the same pinyin without
 *  colliding in Nexus. User namespaces are already isolated by userId. */
export function orgNamespacePrefix(orgId: string): string {
  return `org:${orgId}:`
}

/**
 * Wrap a base namespace so it is isolated per org. Only system/role (enterprise
 * and department) namespaces are org-scoped; user namespaces are returned
 * unchanged. Idempotent: a namespace already carrying an `org:{id}:` prefix is
 * left as-is.
 */
export function orgScopedNamespace(namespace: string, orgId: string): string {
  if (!orgId) return namespace
  if (namespace.startsWith('org:')) return namespace
  if (namespace.startsWith('system:') || namespace.startsWith('role:')) {
    return `${orgNamespacePrefix(orgId)}${namespace}`
  }
  return namespace
}

/** Strip an `org:{orgId}:` prefix if present, returning the base namespace. */
export function stripOrgPrefix(namespace: string): string {
  const m = namespace.match(/^org:[^:]+:(.*)$/)
  return m ? m[1] : namespace
}

/** Extract the orgId from an `org:{orgId}:...` namespace, or null. */
export function namespaceOrgId(namespace: string): string | null {
  const m = namespace.match(/^org:([^:]+):/)
  return m ? m[1] : null
}

/**
 * 命名空间 → Nexus 调用主体。
 * system:* 共享一个固定主体，使企业秘钥与具体管理员解耦；
 * role:* 共享一个固定主体，使部门秘钥与具体管理员解耦；
 * 其它命名空间（user:{userId}:*）以传入的 userId 为主体。
 *
 * 多组织隔离：system/role 主体附带 orgId（从命名空间的 `org:{orgId}:` 前缀解析），
 * 使不同组织的企业/部门凭据在 Nexus 中互不可见。
 */
export function secretSubject(namespace: string, userId: string): string {
  const orgId = namespaceOrgId(namespace)
  const base = stripOrgPrefix(namespace)
  if (base.startsWith('system:')) {
    return orgId ? `${SYSTEM_SECRET_SUBJECT}:${orgId}` : SYSTEM_SECRET_SUBJECT
  }
  if (base.startsWith('role:')) {
    return orgId ? `${DEPT_SECRET_SUBJECT}:${orgId}` : DEPT_SECRET_SUBJECT
  }
  return userId
}
