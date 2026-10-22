import { randomUUID } from 'node:crypto'
import type { ExternalProviderAdministration } from './administration.js'
import type { ExternalActor } from './store.js'
import type { ExternalPilotPolicy } from '../../../contracts/external-provider/v1/contract.js'
import type { EndpointRequest, EndpointRequestsPage } from './endpointRequests.types.js'
import { canonicalEndpoint, ExternalProviderError } from './policy.js'

function input(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new ExternalProviderError(400, 'INVALID_ADMIN_INPUT')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ExternalProviderError(400, 'INVALID_ADMIN_INPUT')
  return value.trim()
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ExternalProviderError(400, 'INVALID_ADMIN_INPUT')
  return Number(value)
}

/** Callers enforce organization administration; granting/reviewing also requires platform administration. */
export class EndpointRequests {
  constructor(private readonly admin: ExternalProviderAdministration) {}
  private get store() { return this.admin.store }

  async list(actor: ExternalActor, after = ''): Promise<EndpointRequestsPage> {
    await this.store.ready
    const rows = await this.store.db.all('SELECT document FROM external_endpoint_requests WHERE org_id = ? AND id > ? ORDER BY id LIMIT 51', [actor.orgId, after])
    const items = rows.slice(0, 50).map(row => JSON.parse(String(row.document)) as EndpointRequest)
    return { items, next_cursor: rows.length > 50 ? items.at(-1)!.id : null }
  }

  async submit(actor: ExternalActor, value: unknown) {
    const body = input(value, ['endpoint', 'reason'])
    const endpoint = canonicalEndpoint(text(body.endpoint, 1024)), reason = text(body.reason, 1000)
    await this.store.ready
    return this.store.db.transaction(async () => {
      await this.admin.lockPolicy(actor)
      const policy = await this.admin.policy(actor)
      if (this.allowed(policy, endpoint)) return { request: null, policy }
      const pending = await this.pending(actor, endpoint)
      if (pending) return { request: pending, policy }
      const request = this.newRequest(actor, endpoint, reason)
      await this.insert(actor, request)
      await this.admin.audit(actor, 'endpoint.requested', request.id)
      return { request, policy }
    })
  }

  /** Explicit inline approval. It preserves the enabled flag and all other addresses. */
  async approve(actor: ExternalActor, value: unknown) {
    const body = input(value, ['endpoint', 'note', 'policy_revision'])
    const endpoint = canonicalEndpoint(text(body.endpoint, 1024)), note = text(body.note, 1000)
    const expected = revision(body.policy_revision)
    await this.store.ready
    return this.store.db.transaction(async () => {
      await this.admin.lockPolicy(actor)
      const current = await this.admin.policy(actor)
      this.checkPolicy(current, expected)
      if (this.allowed(current, endpoint)) return { request: null, policy: current }
      const pending = await this.pending(actor, endpoint)
      const request = pending ?? this.newRequest(actor, endpoint, note)
      if (!pending) await this.insert(actor, request)
      return this.decide(actor, request, current, true, note)
    })
  }

  async review(actor: ExternalActor, value: unknown) {
    const body = input(value, ['id', 'revision', 'policy_revision', 'approved', 'note'])
    const id = text(body.id, 100), expected = revision(body.revision), policyRevision = revision(body.policy_revision), note = text(body.note, 1000)
    if (typeof body.approved !== 'boolean') throw new ExternalProviderError(400, 'INVALID_ADMIN_INPUT')
    const approved = body.approved
    await this.store.ready
    return this.store.db.transaction(async () => {
      await this.admin.lockPolicy(actor)
      const row = await this.store.db.get('SELECT document FROM external_endpoint_requests WHERE org_id = ? AND id = ?', [actor.orgId, id])
      if (!row) throw new ExternalProviderError(404, 'ENDPOINT_REQUEST_NOT_FOUND')
      const request = JSON.parse(String(row.document)) as EndpointRequest
      if (request.status !== 'pending' || request.revision !== expected) throw new ExternalProviderError(409, 'ENDPOINT_REQUEST_CHANGED')
      const policy = await this.admin.policy(actor)
      this.checkPolicy(policy, policyRevision)
      return this.decide(actor, request, policy, approved, note)
    })
  }

  private allowed(policy: ExternalPilotPolicy, endpoint: string) { return policy.endpoints.some(value => canonicalEndpoint(value) === endpoint) }
  private checkPolicy(policy: ExternalPilotPolicy, expected: number) {
    if (policy.revision !== expected) throw new ExternalProviderError(409, 'CONFIGURATION_CHANGED')
  }
  private async pending(actor: ExternalActor, endpoint: string): Promise<EndpointRequest | null> {
    const row = await this.store.db.get("SELECT document FROM external_endpoint_requests WHERE org_id = ? AND endpoint = ? AND status = 'pending'", [actor.orgId, endpoint])
    return row ? JSON.parse(String(row.document)) as EndpointRequest : null
  }
  private newRequest(actor: ExternalActor, endpoint: string, reason: string): EndpointRequest {
    return { id: randomUUID(), endpoint, reason, status: 'pending', revision: 1, requested_by: actor.userId, requested_at: Date.now(), reviewed_by: null, reviewed_at: null, review_note: null }
  }
  private async insert(actor: ExternalActor, request: EndpointRequest) {
    // Bound retained requests per organization; never silently delete approval evidence.
    const count = await this.store.db.get('SELECT COUNT(*) AS count FROM external_endpoint_requests WHERE org_id = ?', [actor.orgId])
    if (Number(count?.count) >= 1000) throw new ExternalProviderError(409, 'ENDPOINT_REQUEST_LIMIT')
    await this.store.db.run('INSERT INTO external_endpoint_requests(id, org_id, endpoint, status, document) VALUES (?, ?, ?, ?, ?)', [request.id, actor.orgId, request.endpoint, request.status, JSON.stringify(request)])
  }
  private async decide(actor: ExternalActor, request: EndpointRequest, current: ExternalPilotPolicy, approved: boolean, note: string) {
    let policy = current
    if (approved && !this.allowed(current, request.endpoint)) {
      if (current.endpoints.length >= 20) throw new ExternalProviderError(409, 'ENDPOINT_LIMIT')
      policy = { ...current, endpoints: [...current.endpoints, request.endpoint], revision: current.revision + 1 }
      await this.store.db.run('UPDATE external_pilot_policy SET document = ? WHERE org_id = ?', [JSON.stringify(policy), actor.orgId])
      await this.admin.audit(actor, 'policy.updated', actor.orgId)
    }
    const reviewed: EndpointRequest = { ...request, status: approved ? 'approved' : 'rejected', revision: request.revision + 1, reviewed_by: actor.userId, reviewed_at: Date.now(), review_note: note }
    const changed = await this.store.db.run("UPDATE external_endpoint_requests SET status = ?, document = ? WHERE org_id = ? AND id = ? AND status = 'pending'", [reviewed.status, JSON.stringify(reviewed), actor.orgId, request.id])
    if (!changed) throw new ExternalProviderError(409, 'ENDPOINT_REQUEST_CHANGED')
    await this.admin.audit(actor, approved ? 'endpoint.approved' : 'endpoint.rejected', request.id)
    return { request: reviewed, policy }
  }
}
