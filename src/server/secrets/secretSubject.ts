export const SYSTEM_SECRET_SUBJECT = 'system:moss'

export const DEPT_SECRET_SUBJECT = 'role:moss'

/**
 * 命名空间 → Nexus 调用主体。
 * system:* 共享一个固定主体，使企业秘钥与具体管理员解耦；
 * role:* 共享一个固定主体，使部门秘钥与具体管理员解耦；
 * 其它命名空间（user:{userId}:*）以传入的 userId 为主体。
 */
export function secretSubject(namespace: string, userId: string): string {
  if (namespace.startsWith('system:')) return SYSTEM_SECRET_SUBJECT
  if (namespace.startsWith('role:')) return DEPT_SECRET_SUBJECT
  return userId
}
