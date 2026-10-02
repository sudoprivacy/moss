import type { DatabaseSync } from 'node:sqlite'
import { ensureBillingSchema } from '../billing/billingSchema.js'
import { ensureCatalogSchema } from '../catalog/catalogSchema.js'
import { ensureClientPolicySchema } from '../configuration/clientPolicyRepository.js'
import { ensureConfigAvailabilitySchema } from '../configuration/configAvailabilitySchema.js'
import { ensurePlatformIntegrationSettingsSchema } from '../configuration/platformIntegrationSettingsRepository.js'
import { ensureOrganizationModelSettingsSchema } from '../configuration/organizationModelSettingsRepository.js'
import { ensureDifySchema } from '../dify/difySchema.js'
import { ensureIdentitySchema } from '../identity/identityRepository.js'

export function ensureSqliteCompatibilityDomainSchemas(
  db: DatabaseSync,
  options: { legacyClientCronEnabled?: boolean } = {},
): void {
  ensureIdentitySchema(db, options)
  ensureCatalogSchema(db)
  ensureConfigAvailabilitySchema(db)
  ensureClientPolicySchema(db)
  ensureOrganizationModelSettingsSchema(db)
  ensurePlatformIntegrationSettingsSchema(db)
  ensureDifySchema(db)
  ensureBillingSchema(db)
}

export function ensureCompatibilityCounterTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS compatibility_id_counters (
      counter_key TEXT PRIMARY KEY,
      last_value INTEGER NOT NULL
    );
  `)
}

export function ensureCompatibilityCoreSchema(db: DatabaseSync): void {
  ensureCompatibilityCounterTable(db)
  db.exec(`
    INSERT INTO compatibility_id_counters (counter_key, last_value)
    SELECT 'resource_numeric_aliases:' || namespace,
           MAX(COALESCE(MAX(legacy_id), 0), 1999999999)
    FROM resource_numeric_aliases
    WHERE 1 = 1
    GROUP BY namespace
    ON CONFLICT(counter_key) DO UPDATE SET
      last_value = MAX(compatibility_id_counters.last_value, excluded.last_value);

    INSERT INTO compatibility_id_counters (counter_key, last_value)
    VALUES
      ('operation_audit_events', MAX(COALESCE((SELECT MAX(legacy_id) FROM operation_audit_events), 0), 1999999999)),
      ('billing_ledger_entries', MAX(COALESCE((SELECT MAX(legacy_id) FROM billing_ledger_entries), 0), 1999999999))
    ON CONFLICT(counter_key) DO UPDATE SET
      last_value = MAX(compatibility_id_counters.last_value, excluded.last_value);

    INSERT INTO compatibility_id_counters (counter_key, last_value)
    SELECT 'billing_activity_records:' || activity_type,
           MAX(COALESCE(MAX(legacy_id), 0), 1999999999)
    FROM billing_activity_records
    WHERE 1 = 1
    GROUP BY activity_type
    ON CONFLICT(counter_key) DO UPDATE SET
      last_value = MAX(compatibility_id_counters.last_value, excluded.last_value);
  `)
}
