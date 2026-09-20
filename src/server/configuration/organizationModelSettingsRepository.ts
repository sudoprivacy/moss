import type { DatabaseSync } from 'node:sqlite'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'

export type OrganizationModelSettings = Record<string, unknown>

export class OrganizationModelSettingsRepository {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS organization_model_settings (
        org_id TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL DEFAULT '{}',
        updated_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  get(orgId: string): OrganizationModelSettings {
    const id = orgId.trim()
    if (!id) return {}
    const row = this.db.prepare(`
      SELECT settings_json FROM organization_model_settings WHERE org_id = ? LIMIT 1
    `).get(id) as { settings_json: string } | undefined
    if (!row) return {}
    try {
      const parsed = JSON.parse(row.settings_json) as unknown
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  put(orgId: string, patch: OrganizationModelSettings, updatedBy: string): OrganizationModelSettings {
    const id = orgId.trim()
    if (!id) throw new Error('Organization id is required')
    return runInTransaction(this.db, () => {
      const next = deepMerge(this.get(id), patch)
      const timestamp = Date.now()
      this.db.prepare(`
        INSERT INTO organization_model_settings (
          org_id, settings_json, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(org_id) DO UPDATE SET
          settings_json = excluded.settings_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `).run(id, JSON.stringify(next), updatedBy, timestamp, timestamp)
      return next
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepMerge(base: OrganizationModelSettings, patch: OrganizationModelSettings): OrganizationModelSettings {
  const result: OrganizationModelSettings = structuredClone(base)
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isRecord(value) && isRecord(result[key])
      ? deepMerge(result[key] as OrganizationModelSettings, value)
      : structuredClone(value)
  }
  return result
}
