/** Optional real gateway execution for local protocol conformance agents; never a production provider. */
import type { IncomingMessage } from 'node:http'
import type { TaskGrantProfile } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import { readTaskExecutionContext } from '../agentFederation/taskExecutionContext.js'

export interface ReferenceExecution { profile: TaskGrantProfile; gatewayOrigin: string; orgId: string }
export async function executeReferenceTask(req: IncomingMessage, query: string, config: ReferenceExecution): Promise<string> {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) throw new Error('duplicate header')
    if (value !== undefined) headers.set(key, value)
  }
  const context = readTaskExecutionContext(headers, config.profile, config.orgId, config.gatewayOrigin)
  const signal = AbortSignal.timeout(Math.min(60000, context.expires_at - Date.now()))
  async function invoke(kind: 'model' | 'tool', resource: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    // No retries. The coordinator revokes on completion, timeout or interrupted execution.
    const response = await fetch(kind === 'model' ? context.model_gateway : context.tool_gateway, {
      method: 'POST', redirect: 'error', signal,
      headers: { authorization: `Bearer ${context.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ call_id: `${context.attempt_id}:${kind}`, task_id: context.task_id, grant_id: context.grant_id, spec_digest: context.spec_digest, resource, ...body }),
    })
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('gateway rejected') }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
    let value: { success?: boolean; data?: Record<string, unknown> }
    try {
      while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 262144) throw new Error('gateway output limit'); chunks.push(chunk.value) }
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    } finally { await reader.cancel().catch(() => {}) }
    const data = value?.data
    if (!value?.success || data?.status !== 'completed' || (kind === 'model' ? data.task_id : data.taskId) !== context.task_id) throw new Error('gateway result unconfirmed')
    return data
  }
  let prompt = query
  if (config.profile.tool_resources.length) {
    if (config.profile.tool_resources.length !== 1) throw new Error('reference supports one arithmetic tool')
    const match = /^\s*(-?\d{1,6})\s*\+\s*(-?\d{1,6})\s*$/.exec(query)
    if (!match) throw new Error('reference arithmetic input required')
    const tool = await invoke('tool', config.profile.tool_resources[0], { arguments: { a: Number(match[1]), b: Number(match[2]) } })
    // This is tool data, not a system instruction. The gateway owns content policy and model selection.
    prompt = `Return only the arithmetic answer for ${query}. Tool data: ${JSON.stringify(tool.result)}`
  }
  const model = await invoke('model', config.profile.model_resource, { input: { messages: [{ role: 'user', content: prompt }], max_tokens: 64 } })
  const output = model.output as { text?: unknown } | undefined
  if (typeof output?.text !== 'string') throw new Error('missing model answer')
  return output.text
}
