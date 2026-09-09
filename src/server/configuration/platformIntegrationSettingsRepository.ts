import type { DatabaseSync } from 'node:sqlite'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'

export class PlatformIntegrationSettingsRepository {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS platform_integration_settings (
        setting_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }

  get(key: string): Record<string, unknown> | undefined {
    const row = this.db.prepare(`
      SELECT value_json FROM platform_integration_settings WHERE setting_key = ?
    `).get(key) as { value_json: string } | undefined
    if (!row) return undefined
    const parsed = JSON.parse(row.value_json) as unknown
    return isRecord(parsed) ? parsed : undefined
  }

  put(key: string, value: Record<string, unknown>, updatedBy: string): void {
    if (!key.trim()) throw new Error('Platform integration setting key is required')
    runInTransaction(this.db, () => {
      const timestamp = Date.now()
      this.db.prepare(`
        INSERT INTO platform_integration_settings (
          setting_key, value_json, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `).run(key, JSON.stringify(value), updatedBy, timestamp, timestamp)
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
