import { randomUUID } from 'node:crypto'
import type { AdministrationOptions } from './administration.js'
import { ExternalTaskStore, type Binding, type ExternalActor } from './store.js'
import { parseNexusSecretRef } from '../dify/difyConnectionService.js'
import { ExternalProviderError } from './policy.js'

export interface CredentialOperation {
  id: string
  actor: ExternalActor
  kind: 'onboard' | 'rotate'
  binding: Binding
  targetRef: string
  previousRef?: string
}

/** A durable saga: vault writes use unique references and never overwrite an active key. */
export class CredentialOperations {
  constructor(readonly store: ExternalTaskStore, readonly options: AdministrationOptions) {}

  async reserve(operation: CredentialOperation, requestId: string, requestHash: string): Promise<boolean> {
    await this.store.ready
    return Boolean(await this.store.db.run(`INSERT INTO external_pilot_operations
      (id, org_id, kind, request_id, request_hash, status, lease_until, document)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(org_id, kind, request_id) DO NOTHING`,
    [operation.id, operation.actor.orgId, operation.kind, requestId, requestHash, Date.now() + 60_000, JSON.stringify(operation)]))
  }

  async finish(operation: CredentialOperation, recovering = false): Promise<Binding> {
    const ref = parseNexusSecretRef(operation.targetRef)
    const secret = await this.options.secrets.getSecret(ref.namespace, ref.key, `org:${operation.actor.orgId}`)
    if (!secret?.value || secret.status !== 'enabled') throw new ExternalProviderError(503, 'CREDENTIAL_UNAVAILABLE')
    return this.store.db.transaction(async () => {
      await this.store.db.run('UPDATE external_pilot_operations SET status = status WHERE id = ?', [operation.id])
      const row = await this.store.db.get('SELECT status, lease_until FROM external_pilot_operations WHERE id = ?', [operation.id])
      if (row?.status === 'complete') return this.store.binding(operation.actor, operation.binding.id)
      if (row?.status !== 'pending' || (!recovering && Number(row.lease_until) <= Date.now())) throw new ExternalProviderError(409, 'CREDENTIAL_OPERATION_EXPIRED')
      let binding = operation.binding
      if (operation.kind === 'rotate') {
        await this.store.db.run('UPDATE external_pilot_bindings SET document = document WHERE id = ? AND org_id = ?', [binding.id, binding.orgId])
        binding = await this.store.binding(operation.actor, binding.id)
        if (binding.credentialOperationId !== operation.id || !binding.credentialUpdating) throw new ExternalProviderError(409, 'CONFIGURATION_CHANGED')
        binding.revision = (binding.revision ?? 1) + 1
      }
      binding = { ...binding, credential_ref: operation.targetRef, credentialVersion: secret.version, credentialUpdating: false, credentialRecoveryRequired: false, credentialOperationId: undefined, approved: false, parametersDigest: null, reviewedBy: null }
      await this.options.identities.putIntegrationConnection({ id: binding.connectionId, orgId: binding.orgId, providerType: 'dify', name: binding.name, enabled: true, secretRef: binding.credential_ref, config: { executionMode: 'external_hosted', baseUrl: binding.endpoint, tenantId: binding.workspace_id } })
      if (operation.kind === 'onboard') {
        await this.options.catalog.createAgent({ id: binding.id, orgId: binding.orgId, name: binding.name, authorId: operation.actor.userId, providerType: 'dify', supportedModes: 'cloud', status: 'pending', visibleTo: { user_ids: binding.allowed_user_ids }, providerBinding: { executionMode: 'external_hosted', bindingId: binding.id, connectionId: binding.connectionId, appId: binding.app_id, sourceDigest: binding.source_digest } })
      }
      await this.store.saveBinding(binding)
      await this.store.db.run("UPDATE external_pilot_operations SET status = 'complete' WHERE id = ?", [operation.id])
      await this.audit(operation.actor, recovering ? 'credential.operation_recovered' : `credential.${operation.kind}_completed`, binding.id)
      if (operation.previousRef) await this.queueCleanup(operation.actor, operation.previousRef)
      return binding
    })
  }

  async abandon(operation: CredentialOperation): Promise<void> {
    await this.store.db.transaction(async () => {
      const changed = await this.store.db.run("UPDATE external_pilot_operations SET status = 'cleanup', kind = 'cleanup', request_id = id, lease_until = 0 WHERE id = ? AND status = 'pending'", [operation.id])
      if (!changed) return
      if (operation.kind === 'rotate') {
        await this.store.db.run('UPDATE external_pilot_bindings SET document = document WHERE id = ? AND org_id = ?', [operation.binding.id, operation.actor.orgId])
        const binding = await this.store.binding(operation.actor, operation.binding.id)
        if (binding.credentialOperationId === operation.id) {
          binding.credentialUpdating = false; binding.credentialOperationId = undefined
          binding.credentialRecoveryRequired = true; binding.approved = false; binding.parametersDigest = null
          binding.revision = (binding.revision ?? 1) + 1
          await this.store.saveBinding(binding)
        }
      }
      await this.audit(operation.actor, 'credential.operation_abandoned', operation.binding.id)
    })
  }

  async queueCleanup(actor: ExternalActor, targetRef: string): Promise<void> {
    const ref = parseNexusSecretRef(targetRef)
    // Reference-only integrations do not transfer ownership of their existing vault entries.
    if (!ref.namespace.startsWith(`org:${actor.orgId}:external:`)) return
    const id = randomUUID()
    await this.store.db.run(`INSERT INTO external_pilot_operations (id, org_id, kind, request_id, request_hash, status, lease_until, document)
      VALUES (?, ?, 'cleanup', ?, '', 'cleanup', 0, ?)`, [id, actor.orgId, id, JSON.stringify({ actor, targetRef })])
  }

  async reconcile(now = Date.now()): Promise<void> {
    await this.store.ready
    const rows = await this.store.db.all("SELECT * FROM external_pilot_operations WHERE status IN ('pending', 'cleanup') AND lease_until <= ? ORDER BY lease_until LIMIT 25", [now])
    for (const row of rows) {
      // CAS coalesces workers. A retained cleanup tombstone also catches a late vault write
      // from an expired process; no delayed callback can publish an abandoned operation.
      if (!await this.store.db.run('UPDATE external_pilot_operations SET lease_until = ? WHERE id = ? AND lease_until = ? AND status = ?', [now + 60_000, String(row.id), Number(row.lease_until), String(row.status)])) continue
      const operation = JSON.parse(String(row.document)) as CredentialOperation
      if (row.status === 'pending') {
        try { await this.finish(operation, true) }
        catch (error) {
          if (error instanceof ExternalProviderError && ['CREDENTIAL_UNAVAILABLE', 'CONFIGURATION_CHANGED'].includes(error.code)) await this.abandon(operation)
          // Transport/DB errors remain pending for a later bounded reconciliation.
        }
      } else if (this.options.secrets.deleteSecret) {
        const ref = parseNexusSecretRef(operation.targetRef)
        try {
          await this.options.secrets.deleteSecret(ref.namespace, ref.key, `org:${operation.actor.orgId}`)
          await this.store.db.run('UPDATE external_pilot_operations SET lease_until = ? WHERE id = ?', [now + 3600_000, String(row.id)])
        } catch { /* Retain the tombstone and retry; never discard an uncertain cleanup. */ }
      }
    }
    // Upgrade recovery for the old finally-only rotation. Its key state is unknowable,
    // so unblock management but require a fresh rotation before approval.
    const bindings = await this.store.db.all(`SELECT document FROM external_pilot_bindings WHERE document LIKE '%"credentialUpdating":true%' AND document NOT LIKE '%"credentialOperationId":%' LIMIT 25`)
    for (const row of bindings) {
      const candidate = JSON.parse(String(row.document)) as Binding
      if (!candidate.credentialUpdating || candidate.credentialOperationId) continue
      await this.store.db.transaction(async () => {
        await this.store.db.run('UPDATE external_pilot_bindings SET document = document WHERE id = ?', [candidate.id])
        const binding = await this.store.binding({ orgId: candidate.orgId, userId: 'system' }, candidate.id)
        if (!binding.credentialUpdating || binding.credentialOperationId) return
        binding.credentialUpdating = false; binding.credentialRecoveryRequired = true
        binding.approved = false; binding.parametersDigest = null; binding.revision = (binding.revision ?? 1) + 1
        await this.store.saveBinding(binding)
        await this.audit({ orgId: binding.orgId, userId: 'system' }, 'credential.legacy_recovery_required', binding.id)
      })
    }
  }

  private async audit(actor: ExternalActor, action: string, id: string) {
    await this.store.db.run('INSERT INTO external_pilot_admin_audit(id, org_id, user_id, action, resource_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [randomUUID(), actor.orgId, actor.userId, action, id, Date.now()])
  }
}
