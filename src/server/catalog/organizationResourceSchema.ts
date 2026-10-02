import type { DatabaseSync } from 'node:sqlite'

// Keep the installation identity independent from artifact storage and Hub names.
export const ORGANIZATION_RESOURCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS org_resource_installations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('agent', 'skill')),
  source_provider TEXT NOT NULL,
  source_resource_id TEXT NOT NULL,
  name TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  installed_by TEXT NOT NULL,
  installed_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (org_id, resource_type, source_provider, source_resource_id)
);
CREATE INDEX IF NOT EXISTS org_resource_installations_name
  ON org_resource_installations (org_id, resource_type, name);
`

export function ensureOrganizationResourceSchema(db: DatabaseSync): void {
  db.exec(ORGANIZATION_RESOURCE_SCHEMA)
  for (const table of ['tenant_assistants', 'tenant_skills']) {
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name))
    if (!columns.has('source_type')) db.exec(`ALTER TABLE ${table} ADD COLUMN source_type TEXT NOT NULL DEFAULT 'tenant'`)
    if (!columns.has('config_json')) db.exec(`ALTER TABLE ${table} ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'`)
  }
}

export const ORGANIZATION_RESOURCE_PG_SCHEMA = ORGANIZATION_RESOURCE_SCHEMA + `
ALTER TABLE tenant_assistants ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'tenant';
ALTER TABLE tenant_assistants ADD COLUMN IF NOT EXISTS config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE tenant_skills ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'tenant';
ALTER TABLE tenant_skills ADD COLUMN IF NOT EXISTS config_json TEXT NOT NULL DEFAULT '{}';
`
