/** Deterministic HTTP double for Moss fault-injection tests, not real Nexus deployment evidence. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { Channel, CommandResult, Decision, Principal, RegistryWire, SignedVersion, VersionManifest } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import type { RegistryRequest } from '../agentFederation/registryClient.js'
import { stableJson } from '../agentFederation/provider/protocol.js'
type Command = Extract<RegistryWire, { request_id: string }>
const API = 'agent-registry.sudo.dev/v1alpha1'
const hash = (value: Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`
export function registryHttpFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const keyId = hash(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32))
  const versions = new Map<string, SignedVersion>(), decisions = new Map<string, Decision>(), channels = new Map<string, Channel>()
  const requests = new Map<string, CommandResult>(), files = new Map<string, string>()
  let principal: Principal | null = null
  const state = { unavailable: false, failNextKind: '', beforeRequest: (_method: string) => {} }
  const error = (code: string, status = 409) => Response.json({ detail: { code } }, { status })
  const request: RegistryRequest = async (target, init) => {
    state.beforeRequest(init.method)
    if (state.unavailable) throw new Error('injected connection outage')
    const url = new URL(target), body = init.body ? JSON.parse(init.body) : undefined
    if (url.pathname.startsWith('/api/v2/files/')) {
      const path = String(body?.path ?? url.searchParams.get('path'))
      if (url.pathname.endsWith('/mkdir')) return Response.json({ created: true })
      if (url.pathname.endsWith('/write')) {
        if (files.has(path)) return error('exists', 409)
        if (body.if_none_match !== true) throw new Error('Moss attempted a mutable artifact write')
        files.set(path, body.content)
        return Response.json({ revision: `${path}@1` })
      }
      return files.has(path) ? Response.json({ content: files.get(path), encoding: 'base64' }) : error('missing', 404)
    }
    if (url.pathname.endsWith('/commands')) {
      const command = body as Command
      if (state.failNextKind === command.kind) { state.failNextKind = ''; throw new Error('injected interrupted migration') }
      const previous = requests.get(command.request_id)
      if (previous) return Response.json(previous)
      const now = Date.now()
      if (command.kind === 'RegisterPrincipal') {
        if (principal) return error('AGENT_PRINCIPAL_EXISTS')
        principal = { principal: command.principal, owner_zone: 'zone-1', status: 'active', display_name: command.display_name, revision: 0, created_at: now }
      }
      if (!principal) return error('AGENT_PRINCIPAL_NOT_FOUND', 404)
      principal.revision++
      const result: CommandResult = { api_version: API, kind: 'RegistryCommandResult', principal: structuredClone(principal) }
      if (command.kind === 'PublishVersion') {
        let version = versions.get(command.version)
        if (version && version.manifest.spec_digest !== command.spec_digest) return error('IMMUTABLE_VERSION_CONFLICT')
        if (!version) {
          const manifest: VersionManifest = { api_version: API, kind: 'VersionManifest' as const, principal: command.principal, version: command.version,
            spec_ref: command.spec_ref, spec_digest: command.spec_digest, source_evidence_refs: command.source_evidence_refs ?? [], created_at: now, created_by: 'user:operator', evidence: 'signed_registration_only' as const }
          const bytes = Buffer.from(stableJson(manifest))
          version = { manifest, payload_base64: bytes.toString('base64'), digest: hash(bytes), algorithm: 'Ed25519', key_id: keyId, signature_base64: sign(null, bytes, privateKey).toString('base64') }
          versions.set(command.version, version)
        }
        result.version = version
      }
      if (command.kind === 'DecideVersion') {
        if (decisions.get(command.version)?.decision === 'revoked') return error('AGENT_VERSION_REVOKED')
        const decision: Decision = { id: command.request_id, version: command.version, decision: command.decision, actor: 'user:operator', reason: command.reason,
          expires_at: command.expires_at ?? null, created_at: now, registry_revision: principal.revision }
        decisions.set(command.version, decision); result.decision = decision
        if (command.decision !== 'approved') for (const channel of channels.values()) if (channel.version === command.version && channel.enabled) { channel.enabled = false; channel.revision++ }
      }
      if (command.kind === 'MoveChannel') {
        const previous = channels.get(command.channel)
        if ((previous?.revision ?? 0) !== command.expected_revision) return error('CHANNEL_REVISION_CONFLICT')
        const version = versions.get(command.version), decision = decisions.get(command.version)
        if (!version || decision?.decision !== 'approved') return error('AGENT_VERSION_NOT_APPROVED')
        const channel: Channel = { name: command.channel, version: command.version, revision: command.expected_revision + 1,
          spec_digest: version.manifest.spec_digest, enabled: true, updated_at: now }
        channels.set(command.channel, channel); result.channel = channel
      }
      requests.set(command.request_id, structuredClone(result))
      return Response.json(result)
    }
    if (!principal) return error('AGENT_PRINCIPAL_NOT_FOUND', 404)
    if (url.pathname.endsWith('/versions')) return Response.json({ api_version: API, kind: 'RegistryVersionsPage', principal,
      items: [...versions.values()].map(version => ({ version, decision: decisions.get(version.manifest.version) ?? null })), channels: [...channels.values()], next_cursor: null })
    if (url.pathname.includes('/versions/')) {
      const label = decodeURIComponent(url.pathname.split('/').at(-1)!), version = versions.get(label)
      return version ? Response.json({ version, decision: decisions.get(label) ?? null }) : error('AGENT_VERSION_NOT_FOUND', 404)
    }
    const channel = url.searchParams.has('version') ? null : channels.get(url.searchParams.get('channel') ?? 'stable')
    const version = versions.get(url.searchParams.get('version') ?? channel?.version ?? ''), decision = version && decisions.get(version.manifest.version)
    if (!url.searchParams.has('version') && !channel?.enabled) return error('AGENT_CHANNEL_UNAVAILABLE', 404)
    if (!version || decision?.decision !== 'approved' || (decision.expires_at ?? 0) <= Date.now()) return error('AGENT_VERSION_NOT_APPROVED')
    return Response.json({ api_version: API, kind: 'RegistryResolution', principal, version, approval: decision, channel, evaluated_at: Date.now() })
  }
  return { request, publicPem, files, state, versions }
}
