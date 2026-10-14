import { createHash } from 'node:crypto'
import Ajv2020 from 'ajv/dist/2020.js'
import schema from '../../../contracts/agent-federation/v1alpha1/schema.json' with { type: 'json' }
import type { CustomAgentManifest, ExternalRunBinding, HttpAgentResult, ProviderCapabilities, ProviderObservation } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import { ExternalProviderError } from '../externalProviders/policy.js'

const ajv = new Ajv2020({ strict: true, allErrors: false })
ajv.addSchema(schema)
const manifestValidator = ajv.compile<CustomAgentManifest>({ $ref: `${schema.$id}#/$defs/CustomAgentManifest` })
const resultValidator = ajv.compile<HttpAgentResult>({ $ref: `${schema.$id}#/$defs/HttpAgentResult` })
const runValidator = ajv.compile<ExternalRunBinding>({ $ref: `${schema.$id}#/$defs/ExternalRunBinding` })
const observationValidator = ajv.compile<ProviderObservation>({ $ref: `${schema.$id}#/$defs/ProviderObservation` })

export const HTTP_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  supports_streaming: false, supports_cancel: false, supports_resume: false,
  supports_idempotency: false, supports_tool_events: false, supports_trace_export: false,
  supports_version_pin: false, supports_human_approval: false,
})
export const DIFY_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({ ...HTTP_CAPABILITIES, supports_streaming: true })

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function parseCustomManifest(input: unknown): CustomAgentManifest {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 64 * 1024) throw new ExternalProviderError(400, 'INVALID_CUSTOM_MANIFEST')
  let value: unknown
  try { value = JSON.parse(input) } catch { throw new ExternalProviderError(400, 'INVALID_CUSTOM_MANIFEST') }
  if (!manifestValidator(value)) {
    if (manifestValidator.errors?.some(error => error.instancePath === '/capabilities' && error.keyword === 'const')) throw new ExternalProviderError(409, 'UNSUPPORTED_PROVIDER_CAPABILITY')
    throw new ExternalProviderError(400, 'INVALID_CUSTOM_MANIFEST')
  }
  return value
}

export function customManifestDigest(manifest: CustomAgentManifest): string {
  const validated = parseCustomManifest(JSON.stringify(manifest))
  return `sha256:${createHash('sha256').update(stable(validated)).digest('hex')}`
}

export function parseHttpAgentResult(value: unknown, invocationId: string): HttpAgentResult {
  if (!resultValidator(value) || value.invocation_id !== invocationId) throw new ExternalProviderError(502, 'INVALID_PROVIDER_RESULT')
  return value
}

export function parseExternalRunBinding(value: unknown): ExternalRunBinding {
  if (!runValidator(value)) throw new ExternalProviderError(502, 'INVALID_EXTERNAL_RUN_BINDING')
  return value
}

export function parseProviderObservation(value: unknown): ProviderObservation {
  if (!observationValidator(value)) throw new ExternalProviderError(502, 'INVALID_PROVIDER_OBSERVATION')
  return value
}
