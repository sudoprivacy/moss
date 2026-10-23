import type { IncomingMessage } from 'node:http'
import type { ExecutionModelCall, ExecutionModelGateway } from './executionModelGateway.js'
import { ExternalProviderError } from '../externalProviders/policy.js'

export const modelInvocationRoute = /^\/api\/v1\/agent-models\/([A-Za-z0-9_.:@-]{1,150})\/invoke$/
export const MODEL_BODY_LIMIT = 256000
export const TOOL_BODY_LIMIT = 40000

/** Enforce the size bound while reading, before JSON parsing or IAM/remote calls. */
export async function readExecutionJson(req: IncomingMessage, limit: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')
    || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity'))
    throw new ExternalProviderError(415, 'EXECUTION_JSON_REQUIRED')
  const declared = req.headers['content-length']
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new ExternalProviderError(413, 'EXECUTION_BODY_TOO_LARGE')
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0, done = false
    const finish = (error?: Error) => {
      if (done) return
      done = true; clearTimeout(timer)
      if (error) { chunks.length = 0; reject(error) } else resolve(Buffer.concat(chunks))
    }
    const timer = setTimeout(() => finish(new ExternalProviderError(408, 'EXECUTION_BODY_TIMEOUT')), 10000)
    timer.unref()
    req.on('data', (data: Buffer) => {
      if (done) return
      bytes += data.byteLength
      if (bytes > limit) finish(new ExternalProviderError(413, 'EXECUTION_BODY_TOO_LARGE'))
      else chunks.push(Buffer.from(data))
    })
    req.once('end', () => finish())
    req.once('aborted', () => finish(new ExternalProviderError(400, 'EXECUTION_BODY_ABORTED')))
    req.once('error', () => finish(new ExternalProviderError(400, 'EXECUTION_BODY_ABORTED')))
  })
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required')
    return value
  } catch { throw new ExternalProviderError(400, 'INVALID_EXECUTION_JSON') }
}

/** Provider-facing response only. Never serialize the gateway's internal token/owner/ledger record. */
export function modelInvocationResult(call: ExecutionModelCall, now = Date.now()) {
  const stale = ['preparing', 'dispatching'].includes(call.status) && call.grantExpiresAt <= now
  return { kind: 'ModelInvocationResult' as const, call_id: call.callId, task_id: call.taskId, model_call_id: call.id,
    status: stale ? 'unknown' as const : call.status,
    ...(call.status === 'completed' && typeof call.answer === 'string' ? { output: { text: call.answer } } : {}),
    ...(call.error || stale ? { error_code: call.error ?? 'MODEL_EXECUTION_UNCONFIRMED' } : {}),
    usage_status: call.ledgerStatus === 'router_verified' && !!call.routerAuthorityId && call.consumption.length > 0 ? 'router_verified' as const : 'pending' as const }
}

/** The bearer is checked by Nexus CheckExecutionGrant, not accepted as a browser identity. */
export async function dispatchModelInvocation(gateway: Pick<ExecutionModelGateway, 'invoke'> | undefined,
  orgId: string, body: unknown, token: string, signal?: AbortSignal) {
  if (!gateway) throw new ExternalProviderError(503, 'MODEL_GATEWAY_NOT_CONFIGURED')
  if (!token || token.length > 8192 || /[\r\n]/.test(token)) throw new ExternalProviderError(401, 'EXECUTION_TOKEN_INVALID')
  return modelInvocationResult(await gateway.invoke(orgId, body, token, signal))
}
