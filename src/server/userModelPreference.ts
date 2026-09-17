/**
 * User model preference storage
 * Stores user's preferred model selection for sessions
 */

import type { DbDriver } from './db/driver.js'

// In-memory fallback storage
const memoryStore = new Map<string, { modelId: string; updatedAt: number }>()

let driver: DbDriver | null = null

/**
 * Initialize the user model preference store with a shared DB driver.
 * Async because the postgres driver builds its table over a pooled connection;
 * sqlite resolves synchronously under the hood (unchanged behavior).
 */
export async function initUserModelPreferenceStore(database: DbDriver): Promise<void> {
  driver = database

  // Create table if not exists (sqlite only — the postgres backend gets this
  // table from pg_schema.ts, applied by openStoreAsync before any call here).
  if (driver.kind === 'sqlite') {
    await driver.exec(`
      CREATE TABLE IF NOT EXISTS user_model_preferences (
        user_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }
}

/**
 * Get user's model preference
 */
export async function getUserModelPreference(userId: string): Promise<{ modelId: string; updatedAt: number } | null> {
  process.stderr.write(`[ModelPreference] getUserModelPreference called for userId: ${userId}\n`)
  if (driver) {
    try {
      const row = await driver.get<{ model_id: string; updated_at: number }>(`
        SELECT model_id, updated_at
        FROM user_model_preferences
        WHERE user_id = ?
      `, [userId])

      process.stderr.write(`[ModelPreference] Database query result: ${row ? JSON.stringify(row) : 'null'}\n`)
      if (row) {
        return {
          modelId: row.model_id,
          updatedAt: row.updated_at,
        }
      }
      return null
    } catch (err) {
      // Fall back to memory store on error
      process.stderr.write(`[UserModelPreference] Database error, falling back to memory store: ${err}\n`)
    }
  } else {
    process.stderr.write(`[ModelPreference] No database, using memory store\n`)
  }

  const memoryResult = memoryStore.get(userId) || null
  process.stderr.write(`[ModelPreference] Memory store result: ${memoryResult ? JSON.stringify(memoryResult) : 'null'}\n`)
  return memoryResult
}

/**
 * Set user's model preference
 */
export async function setUserModelPreference(userId: string, modelId: string): Promise<void> {
  const updatedAt = Date.now()

  if (driver) {
    try {
      // INSERT OR REPLACE (SQLite/MySQL dialect) → ON CONFLICT DO UPDATE, which
      // both SQLite and PostgreSQL support and which updates in place (no
      // delete+reinsert), keeping the upsert portable across backends.
      await driver.run(`
        INSERT INTO user_model_preferences (user_id, model_id, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET
          model_id = excluded.model_id,
          updated_at = excluded.updated_at
      `, [userId, modelId, updatedAt])
      return
    } catch {
      // Fall back to memory store on error
      process.stderr.write(`[UserModelPreference] Database error, falling back to memory store\n`)
    }
  }

  memoryStore.set(userId, { modelId, updatedAt })
}

/**
 * Clear user's model preference
 */
export async function clearUserModelPreference(userId: string): Promise<void> {
  if (driver) {
    try {
      await driver.run(`DELETE FROM user_model_preferences WHERE user_id = ?`, [userId])
      return
    } catch {
      // Fall back to memory store on error
      process.stderr.write(`[UserModelPreference] Database error, falling back to memory store\n`)
    }
  }

  memoryStore.delete(userId)
}
