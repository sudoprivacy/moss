import type { DatabaseSync } from 'node:sqlite'
import { ensureBillingSchema } from '../billing/billingSchema.js'
import { BillingRepository } from '../billing/billingRepository.js'
import { ensureCatalogSchema } from '../catalog/catalogSchema.js'
import { CatalogRepository } from '../catalog/catalogRepository.js'
import { ensureCompatibilityCounterTable } from '../db/compatibilitySchema.js'
import { SqliteDriver, type DbDriver } from '../db/driver.js'
import { ensureDifySchema } from '../dify/difySchema.js'
import { DifyRepository } from '../dify/difyRepository.js'
import { ensureIdentitySchema, IdentityRepository } from '../identity/identityRepository.js'
import { ensureClientPolicySchema } from '../configuration/clientPolicyRepository.js'
import { ensureOrganizationModelSettingsSchema } from '../configuration/organizationModelSettingsRepository.js'

export function requireSqliteTestDatabase(store: { db: DatabaseSync | undefined }): DatabaseSync {
  if (!store.db) throw new Error('SQLite test database is unavailable')
  return store.db
}

export function createIdentityTestRepository(
  db: DatabaseSync,
  options: { legacyClientCronEnabled?: boolean } = {},
  driver: DbDriver = new SqliteDriver(db),
): IdentityRepository {
  ensureIdentitySchema(db, options)
  ensureClientPolicySchema(db)
  ensureOrganizationModelSettingsSchema(db)
  ensureCompatibilityCounterTable(db)
  return new IdentityRepository(driver)
}

export function createCatalogTestRepository(
  db: DatabaseSync,
  driver: DbDriver = new SqliteDriver(db),
): CatalogRepository {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_assistants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT, description TEXT,
      default_init_prompt TEXT, prompts_i18n TEXT, categories TEXT, avatar TEXT, skills TEXT,
      version TEXT, author_id TEXT NOT NULL, author_name TEXT, status TEXT DEFAULT 'pending',
      source_url TEXT, checksum TEXT, file_path TEXT, enabled_skills TEXT,
      publish_note TEXT, review_note TEXT, reviewed_by TEXT, reviewed_at INTEGER,
      enabled INTEGER DEFAULT 1, visible_to TEXT, org_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tenant_skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT, description TEXT,
      version TEXT, author_id TEXT NOT NULL, author_name TEXT, status TEXT DEFAULT 'pending',
      source_url TEXT, checksum TEXT, file_path TEXT, publish_note TEXT,
      review_note TEXT, reviewed_by TEXT, reviewed_at INTEGER,
      enabled INTEGER DEFAULT 1, visible_to TEXT, org_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  ensureCatalogSchema(db)
  return new CatalogRepository(driver)
}

export function createDifyTestRepository(
  db: DatabaseSync,
  driver: DbDriver = new SqliteDriver(db),
): DifyRepository {
  ensureDifySchema(db)
  return new DifyRepository(driver)
}

export function createBillingTestRepository(
  db: DatabaseSync,
  driver: DbDriver = new SqliteDriver(db),
): BillingRepository {
  ensureBillingSchema(db)
  ensureCompatibilityCounterTable(db)
  return new BillingRepository(driver)
}
