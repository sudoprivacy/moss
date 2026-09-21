import type { DbDriver } from '../db/driver.js'

const MIGRATION_LOCK_KEY = 'moss:legacy-enterprise-cron-policy'
const MIGRATION_LOCK_TIMEOUT_MS = 60_000
const MIGRATION_LOCK_RETRY_MS = 100

/**
 * Import legacy cron restrictions after organization profiles have been seeded.
 * The marker and profile writes commit together; legacy columns remain intact
 * for embeddings that still use the enterprise API without policy hooks.
 */
export async function migrateLegacyEnterpriseCronPolicy(driver: DbDriver): Promise<number> {
  const deadline = Date.now() + MIGRATION_LOCK_TIMEOUT_MS
  for (;;) {
    // PG serializes both first-boot DDL and policy writes across instances.
    // A peer holding the lock is not completion: wait for its commit and marker.
    const migrated = await driver.tryRunExclusive(MIGRATION_LOCK_KEY, () => migrateInTransaction(driver))
    if (migrated !== null) return migrated
    if (Date.now() >= deadline) throw new Error('Legacy enterprise cron policy migration lock timeout')
    await new Promise(resolve => setTimeout(resolve, MIGRATION_LOCK_RETRY_MS))
  }
}

async function migrateInTransaction(driver: DbDriver): Promise<number> {
  return driver.transaction(async () => {
    const profilesExist = await driver.get(driver.kind === 'postgres'
      ? `SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'organization_profiles'`
      : `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'organization_profiles'`)
    if (!profilesExist) return 0

    await driver.exec(`
      CREATE TABLE IF NOT EXISTS enterprise_cron_policy_migrations (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        applied_at BIGINT NOT NULL
      )
    `)
    if (await driver.get('SELECT 1 FROM enterprise_cron_policy_migrations WHERE id = 1')) return 0

    const missingProfile = await driver.get(`
      SELECT o.id FROM organizations o
      LEFT JOIN organization_profiles p ON p.org_id = o.id
      WHERE p.org_id IS NULL LIMIT 1
    `)
    if (missingProfile) {
      throw new Error('Organization profiles must be initialized before migrating legacy enterprise cron policy')
    }

    const overrides = await driver.all<{ org_id: string; enabled: number | string | null }>(`
      SELECT p.org_id,
        CASE WHEN e.id IS NULL THEN legacy.client_cron_enabled ELSE e.client_cron_enabled END AS enabled
      FROM organization_profiles p
      LEFT JOIN enterprises e ON e.id = p.org_id
      LEFT JOIN enterprises legacy ON legacy.id = 'default'
    `)
    const timestamp = Date.now()
    let migrated = 0
    for (const { org_id: orgId, enabled } of overrides) {
      // Never reopen cron when a profile already restricts it. Null and true
      // legacy values leave profile policy and the live global switch intact.
      if (enabled === null || Number(enabled) !== 0) continue
      await driver.run(`
        UPDATE organization_profiles SET client_cron_enabled = 0, updated_at = ? WHERE org_id = ?
      `, [timestamp, orgId])
      migrated += 1
    }
    await driver.run('INSERT INTO enterprise_cron_policy_migrations (id, applied_at) VALUES (1, ?)', [timestamp])
    return migrated
  })
}
