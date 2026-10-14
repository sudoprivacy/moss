import { isIP } from 'node:net'
import { parseNexusSecretRef } from '../dify/difyConnectionService.js'
import type { RegisterExternalAgent } from '../../../contracts/external-provider/v1/contract.js'

export class ExternalProviderError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
    this.name = 'ExternalProviderError'
  }
}

export interface PilotPolicy {
  orgIds: string[]
  endpoints: string[]
  timeoutMs: number
}

export function pilotPolicyFromEnvironment(): PilotPolicy {
  return {
    orgIds: (process.env.MOSS_EXTERNAL_PILOT_ORGS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    endpoints: (process.env.MOSS_EXTERNAL_PILOT_ENDPOINTS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    timeoutMs: 120_000,
  }
}

export function canonicalEndpoint(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new ExternalProviderError(400, 'INVALID_ENDPOINT') }
  // The first LAN pilot accepts literal IPs only: no DNS rebinding or redirects.
  if (!['http:', 'https:'].includes(url.protocol) || !isIP(url.hostname.replace(/^\[|\]$/g, ''))
    || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '') !== '/v1') {
    throw new ExternalProviderError(400, 'INVALID_ENDPOINT')
  }
  return url.href.replace(/\/+$/, '')
}

export function assertPilot(policy: PilotPolicy, orgId: string, endpoint?: string): void {
  if (!policy.orgIds.includes(orgId)) throw new ExternalProviderError(403, 'PILOT_NOT_ENABLED')
  if (endpoint && !policy.endpoints.some(value => canonicalEndpoint(value) === canonicalEndpoint(endpoint))) {
    throw new ExternalProviderError(403, 'ENDPOINT_NOT_APPROVED')
  }
}

export function parseRegistration(value: unknown, orgId: string, policy: PilotPolicy, now = Date.now()): RegisterExternalAgent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExternalProviderError(400, 'INVALID_BINDING')
  const input = value as Record<string, unknown>
  const keys = ['provider_kind', 'name', 'endpoint', 'app_id', 'workspace_id', 'credential_ref', 'source_digest', 'decoder', 'allowed_user_ids', 'review_expires_at', 'review_note']
  if (Object.keys(input).some(key => !keys.includes(key))) throw new ExternalProviderError(400, 'UNKNOWN_BINDING_FIELD')
  for (const key of ['name', 'endpoint', 'app_id', 'workspace_id', 'credential_ref', 'source_digest', 'review_note']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 1024) throw new ExternalProviderError(400, 'INVALID_BINDING')
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(input.source_digest))
    || !['text', 'reply_actions_v1'].includes(String(input.decoder))
    || !Array.isArray(input.allowed_user_ids) || !input.allowed_user_ids.length || input.allowed_user_ids.length > 100
    || input.allowed_user_ids.some(id => typeof id !== 'string' || !/^[\w:-]{1,150}$/.test(id))
    || typeof input.review_expires_at !== 'number' || !Number.isFinite(input.review_expires_at)
    || input.review_expires_at <= now || input.review_expires_at > now + 7 * 86400_000) {
    throw new ExternalProviderError(400, 'INVALID_PILOT_REVIEW')
  }
  if (input.provider_kind !== undefined && !['dify', 'custom_http'].includes(String(input.provider_kind))) throw new ExternalProviderError(400, 'PROVIDER_NOT_IMPLEMENTED')
  const endpoint = canonicalEndpoint(String(input.endpoint))
  assertPilot(policy, orgId, endpoint)
  // This is a reference, never an App key. Confine it to this organization's vault namespace.
  try {
    const ref = parseNexusSecretRef(String(input.credential_ref))
    if (!ref.namespace.startsWith(`org:${orgId}:`) || !/^[\w:-]+$/.test(ref.namespace) || !/^[\w-]+$/.test(ref.key)) throw new Error()
  } catch { throw new ExternalProviderError(400, 'INVALID_CREDENTIAL_REFERENCE') }
  return { ...input, endpoint } as unknown as RegisterExternalAgent
}
