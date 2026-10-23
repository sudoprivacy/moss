import type { TaskGrantProfile } from '../../contracts/agent-federation/v1alpha1/contract'

/** Display the declared scope before upload is approved; it never grants permission. */
export function ExternalTaskProfile({ source, profile }: { source?: string; profile?: TaskGrantProfile }) {
  let value: unknown = profile
  if (source) {
    try { value = (JSON.parse(source) as { execution_context?: unknown }).execution_context } catch { return null }
  }
  if (!value || typeof value !== 'object') return null
  const fields = value as Record<string, unknown>
  if (fields.profile !== 'sudo-task-grant/v1' || typeof fields.model_resource !== 'string' || !Array.isArray(fields.tool_resources)
    || !fields.tool_resources.every(v => typeof v === 'string') || !Number.isInteger(fields.max_model_calls)) return null
  return <div className="space-y-1 rounded-md border p-3 text-sm" aria-label="任务权限声明">
    <p className="font-medium">使用平台模型和工具</p>
    <p className="break-all">模型资源：{fields.model_resource}</p>
    <p>每个任务最多调用模型 {String(fields.max_model_calls)} 次</p>
    <p className="break-all">工具资源：{fields.tool_resources.length ? fields.tool_resources.join('、') : '无'}</p>
    <p className="text-xs text-muted-foreground">此为服务申请的权限。必须与台账及组织授权一致，并经审核发布后才可使用。每个任务单独授权，结束时回收；已有远端操作不保证取消。</p>
  </div>
}
