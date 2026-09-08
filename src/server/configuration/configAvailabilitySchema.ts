import type { DatabaseSync } from 'node:sqlite'

export function ensureConfigAvailabilitySchema(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(config_items)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'availability')) {
    db.exec(`
      ALTER TABLE config_items ADD COLUMN availability TEXT NOT NULL DEFAULT 'organization'
        CHECK (availability IN ('organization', 'all', 'assigned'))
    `)
  }
  db.exec(`
    UPDATE config_items
    SET availability = 'all'
    WHERE scope = 'user' AND org_id IS NULL AND availability = 'organization';

    CREATE TABLE IF NOT EXISTS config_item_org_assignments (
      config_item_id INTEGER NOT NULL,
      org_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (config_item_id, org_id),
      FOREIGN KEY (config_item_id) REFERENCES config_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_config_item_org_assignments_org
      ON config_item_org_assignments (org_id, config_item_id);
  `)
}
