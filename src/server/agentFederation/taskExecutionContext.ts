import { TASK_GRANT_PROFILE, type CustomAgentManifest, type TaskExecutionContext, type TaskGrantProfile } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import type { ProviderInvocation } from './adapter.js'
import { ExternalProviderError } from '../externalProviders/policy.js'

export const CONTEXT_HEADER = 'X-Sudo-Execution-Context'
export const TOKEN_HEADER = 'X-Sudo-Execution-Token'
const resource = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,499}$/.test(value)
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,149}$/.test(value)
function fail(): never { throw new ExternalProviderError(409, 'TASK_EXECUTION_CONTEXT_INVALID') }
function endpoint(value: string, org: string, kind: 'models' | 'tools') {
  let url: URL
  try { url = new URL(value) } catch { return fail() }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== `/api/v1/agent-${kind}/${org}/invoke`) fail()
  return url.origin
}
export function validateExecutionContext(value: TaskExecutionContext, expected: Pick<ProviderInvocation, 'task_id' | 'attempt_id' | 'session_id' | 'org_id'>,
  profile: NonNullable<CustomAgentManifest['execution_context']>, now = Date.now()): TaskExecutionContext {
  if (!value || Object.keys(value).some(k => !['profile', 'model_resource', 'tool_resources', 'max_model_calls', 'task_id', 'attempt_id', 'session_id', 'org_id', 'grant_id', 'spec_digest', 'expires_at', 'model_gateway', 'tool_gateway', 'access_token'].includes(k))
    || value.profile !== TASK_GRANT_PROFILE || value.profile !== profile.profile
    || !resource(value.model_resource) || !Array.isArray(value.tool_resources) || value.tool_resources.length > 16
    || new Set(value.tool_resources).size !== value.tool_resources.length || value.tool_resources.some(v => !resource(v) || !/^mcp:[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(v))
    || value.model_resource !== profile.model_resource || JSON.stringify(value.tool_resources) !== JSON.stringify(profile.tool_resources)
    || value.max_model_calls !== profile.max_model_calls || !Number.isInteger(value.max_model_calls) || value.max_model_calls < 1 || value.max_model_calls > 32
    || !identifier(value.grant_id) || ![value.task_id, value.attempt_id, value.session_id, value.org_id].every(identifier)
    || ['task_id', 'attempt_id', 'session_id', 'org_id'].some(k => value[k as keyof typeof expected] !== expected[k as keyof typeof expected])
    || !/^sha256:[a-f0-9]{64}$/.test(value.spec_digest) || !Number.isSafeInteger(value.expires_at) || value.expires_at <= now || value.expires_at > now + 300000
    || typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 8192 || /[^\x21-\x7e]/.test(value.access_token)
    || endpoint(value.model_gateway, value.org_id, 'models') !== endpoint(value.tool_gateway, value.org_id, 'tools')) fail()
  return value
}
/** Only called for the actual invocation; discovery and session cleanup never receive this credential. */
export async function taskExecutionHeaders(manifest: CustomAgentManifest, input: ProviderInvocation): Promise<Record<string, string>> {
  if (!manifest.execution_context) {
    if (input.execution_context) fail()
    return {}
  }
  if (!input.execution_context) throw new ExternalProviderError(409, 'TASK_EXECUTION_CONTEXT_REQUIRED')
  const context = validateExecutionContext(await input.execution_context(), input, manifest.execution_context)
  const { access_token, ...metadata } = context
  const encoded = Buffer.from(JSON.stringify(metadata)).toString('base64url')
  if (encoded.length + access_token.length > 12000) fail()
  return { [CONTEXT_HEADER]: encoded, [TOKEN_HEADER]: access_token }
}

/** Receiver helper. Destination comes from deployment configuration, never from an untrusted header alone. */
export function readTaskExecutionContext(headers: Headers, profile: TaskGrantProfile, orgId: string, gatewayOrigin: string): TaskExecutionContext {
  const encoded = headers.get(CONTEXT_HEADER), token = headers.get(TOKEN_HEADER)
  if (!encoded || !token || encoded.length + token.length > 12000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) fail()
  let value: Record<string, unknown>
  try {
    const bytes = Buffer.from(encoded, 'base64url')
    if (bytes.toString('base64url') !== encoded) fail()
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch { return fail() }
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'access_token' in value || value.org_id !== orgId) fail()
  const context = validateExecutionContext({ ...value, access_token: token } as TaskExecutionContext,
    { task_id: String(value.task_id), attempt_id: String(value.attempt_id), session_id: String(value.session_id), org_id: orgId }, profile)
  if (new URL(context.model_gateway).origin !== gatewayOrigin || new URL(context.tool_gateway).origin !== gatewayOrigin) fail()
  return context
}

/** A provider must not echo the runtime capability into persisted output or user-visible events. */
export function assertNoTaskCredential(value: unknown, token?: string) {
  if (token && JSON.stringify(value)?.includes(token)) throw new ExternalProviderError(502, 'PROVIDER_CREDENTIAL_DISCLOSURE')
}
