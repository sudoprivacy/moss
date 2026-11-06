/** Describe a native model-write refusal without exposing private RPC diagnostics. */
export function modelEgressRefusal(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const detail = 'data' in error && typeof error.data === 'string'
    ? error.data : 'message' in error ? error.message : undefined
  if (typeof detail !== 'string' || !detail.includes('Nexus model write:') ||
    !/permission denied|permissiondenied|access denied/i.test(detail)) return undefined
  return 'Nexus 拒绝了此次模型外发。请管理员检查出口保护策略与模型挂载权限。'
}
