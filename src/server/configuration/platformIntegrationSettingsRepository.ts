import type { DatabaseSync } from 'node:sqlite'
import type { DbDriver } from '../db/driver.js'

export function ensurePlatformIntegrationSettingsSchema(db: DatabaseSync): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS platform_integration_settings (
        setting_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
  `)
}

export class PlatformIntegrationSettingsRepository {
  constructor(private readonly driver: DbDriver) {}

  async get(key: string): Promise<Record<string, unknown> | undefined> {
    const row = await this.driver.get<{ value_json: string }>(`
      SELECT value_json FROM platform_integration_settings WHERE setting_key = ?
    `, [key])
    if (!row) return undefined
    const parsed = JSON.parse(row.value_json) as unknown
    return isRecord(parsed) ? parsed : undefined
  }

  async put(key: string, value: Record<string, unknown>, updatedBy: string): Promise<void> {
    if (!key.trim()) throw new Error('Platform integration setting key is required')
    await this.driver.transaction(async () => {
      const timestamp = Date.now()
      await this.driver.run(`
        INSERT INTO platform_integration_settings (
          setting_key, value_json, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `, [key, JSON.stringify(value), updatedBy, timestamp, timestamp])
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
