import type { DatabaseSync } from 'node:sqlite'
import type { DbDriver } from '../db/driver.js'

export type OrganizationModelSettings = Record<string, unknown>

export const ORGANIZATION_MODEL_SETTINGS_SCHEMA = `
      CREATE TABLE IF NOT EXISTS organization_model_settings (
        org_id TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL DEFAULT '{}',
        updated_by TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
`

export function ensureOrganizationModelSettingsSchema(db: DatabaseSync): void {
  db.exec(ORGANIZATION_MODEL_SETTINGS_SCHEMA)
}

export class OrganizationModelSettingsRepository {
  constructor(private readonly db: DbDriver) {}

  async get(orgId: string): Promise<OrganizationModelSettings> {
    const id = orgId.trim()
    if (!id) return {}
    const row = await this.db.get<{ settings_json: string }>(`
      SELECT settings_json FROM organization_model_settings WHERE org_id = ? LIMIT 1
    `, [id])
    if (!row) return {}
    try {
      const parsed = JSON.parse(row.settings_json) as unknown
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  async has(orgId: string): Promise<boolean> {
    return Boolean(await this.db.get('SELECT 1 FROM organization_model_settings WHERE org_id = ?', [orgId.trim()]))
  }

  async put(orgId: string, patch: OrganizationModelSettings, updatedBy: string): Promise<OrganizationModelSettings> {
    const id = orgId.trim()
    if (!id) throw new Error('Organization id is required')
    return this.db.transaction(async () => {
      const next = deepMerge(await this.get(id), patch)
      const timestamp = Date.now()
      await this.db.run(`
        INSERT INTO organization_model_settings (
          org_id, settings_json, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(org_id) DO UPDATE SET
          settings_json = excluded.settings_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `, [id, JSON.stringify(next), updatedBy, timestamp, timestamp])
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
