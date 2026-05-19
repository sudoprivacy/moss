/**
 * User model preference storage
 * Stores user's preferred model selection for sessions
 */

import type { DatabaseSync } from 'node:sqlite'

// In-memory fallback storage
const memoryStore = new Map<string, { modelId: string; updatedAt: number }>()

let db: DatabaseSync | null = null

/**
 * Initialize the user model preference store with a database instance
 */
export function initUserModelPreferenceStore(database: DatabaseSync): void {
  db = database

  // Create table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_model_preferences (
      user_id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
}

/**
 * Get user's model preference
 */
export function getUserModelPreference(userId: string): { modelId: string; updatedAt: number } | null {
  process.stderr.write(`[ModelPreference] getUserModelPreference called for userId: ${userId}\n`)
  if (db) {
    try {
      const row = db.prepare(`
        SELECT model_id, updated_at
        FROM user_model_preferences
        WHERE user_id = ?
      `).get(userId) as { model_id: string; updated_at: number } | undefined

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
export function setUserModelPreference(userId: string, modelId: string): void {
  const updatedAt = Date.now()

  if (db) {
    try {
      db.prepare(`
        INSERT OR REPLACE INTO user_model_preferences (user_id, model_id, updated_at)
        VALUES (?, ?, ?)
      `).run(userId, modelId, updatedAt)
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
export function clearUserModelPreference(userId: string): void {
  if (db) {
    try {
      db.prepare(`DELETE FROM user_model_preferences WHERE user_id = ?`).run(userId)
      return
    } catch {
      // Fall back to memory store on error
      process.stderr.write(`[UserModelPreference] Database error, falling back to memory store\n`)
    }
  }

  memoryStore.delete(userId)
}
