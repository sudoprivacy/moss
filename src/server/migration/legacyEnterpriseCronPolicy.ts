import type { DatabaseSync } from 'node:sqlite'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'

/**
 * Import legacy cron restrictions after organization profiles have been seeded.
 * The marker and profile writes commit together; legacy columns remain intact
 * for embeddings that still use the enterprise API without policy hooks.
 */
export function migrateLegacyEnterpriseCronPolicy(db: DatabaseSync): number {
  const profilesExist = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'organization_profiles'
  `).get()
  if (!profilesExist) return 0

  return runInTransaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS enterprise_cron_policy_migrations (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        applied_at INTEGER NOT NULL
      )
    `)
    if (db.prepare('SELECT 1 FROM enterprise_cron_policy_migrations WHERE id = 1').get()) return 0

    const missingProfile = db.prepare(`
      SELECT o.id FROM organizations o
      LEFT JOIN organization_profiles p ON p.org_id = o.id
      WHERE p.org_id IS NULL LIMIT 1
    `).get()
    if (missingProfile) {
      throw new Error('Organization profiles must be initialized before migrating legacy enterprise cron policy')
    }

    const overrides = db.prepare(`
      SELECT p.org_id AS orgId,
        CASE WHEN e.id IS NULL THEN legacy.client_cron_enabled ELSE e.client_cron_enabled END AS enabled
      FROM organization_profiles p
      LEFT JOIN enterprises e ON e.id = p.org_id
      LEFT JOIN enterprises legacy ON legacy.id = 'default'
    `).all() as Array<{ orgId: string; enabled: number | null }>
    const update = db.prepare(`
      UPDATE organization_profiles SET client_cron_enabled = 0, updated_at = ? WHERE org_id = ?
    `)
    const timestamp = Date.now()
    let migrated = 0
    for (const { orgId, enabled } of overrides) {
      // Never reopen cron when a profile already restricts it. Null and true
      // legacy values leave profile policy and the live global switch intact.
      if (enabled === null || Number(enabled) !== 0) continue
      update.run(timestamp, orgId)
      migrated += 1
    }
    db.prepare('INSERT INTO enterprise_cron_policy_migrations (id, applied_at) VALUES (1, ?)').run(timestamp)
    return migrated
  })
}
