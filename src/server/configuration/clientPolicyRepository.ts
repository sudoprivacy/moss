import type { DatabaseSync } from 'node:sqlite'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'

export type ClientDeliveryPolicy = Record<string, unknown>

type PolicyScope = 'platform' | 'organization'

export class ClientPolicyRepository {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS client_delivery_policies (
        scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'organization')),
        scope_id TEXT NOT NULL,
        policy_json TEXT NOT NULL DEFAULT '{}',
        updated_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope_type, scope_id)
      );
      CREATE INDEX IF NOT EXISTS client_delivery_policies_scope_idx
        ON client_delivery_policies (scope_type, scope_id);
    `)
  }

  getPlatform(): ClientDeliveryPolicy {
    return this.get('platform', 'default')
  }

  getOrganization(orgId: string): ClientDeliveryPolicy {
    return this.get('organization', orgId)
  }

  getEffective(orgId?: string): ClientDeliveryPolicy {
    const platform = this.getPlatform()
    return orgId ? deepMerge(platform, this.getOrganization(orgId)) : platform
  }

  putPlatform(patch: ClientDeliveryPolicy, updatedBy: string): ClientDeliveryPolicy {
    return this.put('platform', 'default', patch, updatedBy)
  }

  putOrganization(orgId: string, patch: ClientDeliveryPolicy, updatedBy: string): ClientDeliveryPolicy {
    if (!orgId.trim()) throw new Error('Organization id is required')
    return this.put('organization', orgId, patch, updatedBy)
  }

  private get(scopeType: PolicyScope, scopeId: string): ClientDeliveryPolicy {
    const row = this.db.prepare(`
      SELECT policy_json FROM client_delivery_policies WHERE scope_type = ? AND scope_id = ?
    `).get(scopeType, scopeId) as { policy_json: string } | undefined
    if (!row) return {}
    try {
      const value = JSON.parse(row.policy_json) as unknown
      return isRecord(value) ? value : {}
    } catch {
      return {}
    }
  }

  private put(
    scopeType: PolicyScope,
    scopeId: string,
    patch: ClientDeliveryPolicy,
    updatedBy: string,
  ): ClientDeliveryPolicy {
    assertNoSensitiveValues(patch)
    return runInTransaction(this.db, () => {
      const next = deepMerge(this.get(scopeType, scopeId), patch)
      const timestamp = Date.now()
      this.db.prepare(`
        INSERT INTO client_delivery_policies (
          scope_type, scope_id, policy_json, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_type, scope_id) DO UPDATE SET
          policy_json = excluded.policy_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `).run(scopeType, scopeId, JSON.stringify(next), updatedBy, timestamp, timestamp)
      return next
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepMerge(base: ClientDeliveryPolicy, patch: ClientDeliveryPolicy): ClientDeliveryPolicy {
  const result: ClientDeliveryPolicy = structuredClone(base)
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isRecord(value) && isRecord(result[key])
      ? deepMerge(result[key] as ClientDeliveryPolicy, value)
      : structuredClone(value)
  }
  return result
}

function assertNoSensitiveValues(value: unknown, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveValues(item, `${path}[${index}]`))
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
    const isPresenceFlag = normalized.endsWith('set') || normalized.endsWith('configured')
    const isReference = normalized.endsWith('ref')
    if (!isPresenceFlag && !isReference && /(secret|password|token|apikey|privatekey|credential|cipher|nonce)/.test(normalized)) {
      throw new Error(`敏感字段不能写入客户端策略: ${path ? `${path}.` : ''}${key}`)
    }
    assertNoSensitiveValues(child, path ? `${path}.${key}` : key)
  }
}
