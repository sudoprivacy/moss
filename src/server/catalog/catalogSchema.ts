import type { DatabaseSync } from 'node:sqlite'

type CatalogTable = 'tenant_assistants' | 'tenant_skills'

function columns(db: DatabaseSync, table: CatalogTable): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  )
}

function addMissingColumns(
  db: DatabaseSync,
  table: CatalogTable,
  definitions: ReadonlyArray<readonly [name: string, definition: string]>,
): void {
  const existing = columns(db, table)
  for (const [name, definition] of definitions) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
  }
}

export function ensureCatalogSchema(db: DatabaseSync): void {
  addMissingColumns(db, 'tenant_assistants', [
    ['provider_type', "provider_type TEXT NOT NULL DEFAULT 'moss_runtime' CHECK (provider_type IN ('local', 'moss_runtime', 'dify'))"],
    ['provider_binding', 'provider_binding TEXT CHECK (provider_binding IS NULL OR json_valid(provider_binding))'],
    ['supported_modes', "supported_modes TEXT NOT NULL DEFAULT 'both' CHECK (supported_modes IN ('local', 'cloud', 'both'))"],
    ['availability', "availability TEXT NOT NULL DEFAULT 'organization' CHECK (availability IN ('organization', 'all', 'assigned'))"],
    ['source_provider', "source_provider TEXT NOT NULL DEFAULT 'moss'"],
    ['source_resource_id', 'source_resource_id TEXT'],
    ['profession', 'profession TEXT'],
    ['prompt_file', 'prompt_file TEXT'],
    ['sort_order', 'sort_order INTEGER NOT NULL DEFAULT 0'],
  ])
  addMissingColumns(db, 'tenant_skills', [
    ['supported_modes', "supported_modes TEXT NOT NULL DEFAULT 'both' CHECK (supported_modes IN ('local', 'cloud', 'both'))"],
    ['availability', "availability TEXT NOT NULL DEFAULT 'organization' CHECK (availability IN ('organization', 'all', 'assigned'))"],
    ['source_provider', "source_provider TEXT NOT NULL DEFAULT 'moss'"],
    ['source_resource_id', 'source_resource_id TEXT'],
    ['category', 'category TEXT'],
    ['categories', 'categories TEXT'],
    ['emoji', 'emoji TEXT'],
    ['icon', 'icon TEXT'],
    ['homepage', 'homepage TEXT'],
    ['applicable_scenarios', 'applicable_scenarios TEXT'],
    ['core_features', 'core_features TEXT'],
    ['sort_order', 'sort_order INTEGER NOT NULL DEFAULT 0'],
  ])

  db.exec(`
    UPDATE tenant_assistants SET source_resource_id = id WHERE source_resource_id IS NULL;
    UPDATE tenant_skills SET source_resource_id = id WHERE source_resource_id IS NULL;

    CREATE INDEX IF NOT EXISTS idx_tenant_assistants_org_mode
      ON tenant_assistants (org_id, availability, supported_modes, status, enabled);
    CREATE INDEX IF NOT EXISTS idx_tenant_assistants_provider
      ON tenant_assistants (provider_type, source_provider, source_resource_id);
    CREATE INDEX IF NOT EXISTS idx_tenant_assistants_availability
      ON tenant_assistants (availability, status, enabled);
    CREATE INDEX IF NOT EXISTS idx_tenant_skills_org_mode
      ON tenant_skills (org_id, availability, supported_modes, status, enabled);
    CREATE INDEX IF NOT EXISTS idx_tenant_skills_availability
      ON tenant_skills (availability, status, enabled);

    CREATE TRIGGER IF NOT EXISTS trg_tenant_assistants_availability_insert
      BEFORE INSERT ON tenant_assistants
      WHEN NEW.availability NOT IN ('organization', 'all', 'assigned')
      BEGIN SELECT RAISE(ABORT, 'catalog availability invalid'); END;
    CREATE TRIGGER IF NOT EXISTS trg_tenant_assistants_availability_update
      BEFORE UPDATE OF availability ON tenant_assistants
      WHEN NEW.availability NOT IN ('organization', 'all', 'assigned')
      BEGIN SELECT RAISE(ABORT, 'catalog availability invalid'); END;
    CREATE TRIGGER IF NOT EXISTS trg_tenant_skills_availability_insert
      BEFORE INSERT ON tenant_skills
      WHEN NEW.availability NOT IN ('organization', 'all', 'assigned')
      BEGIN SELECT RAISE(ABORT, 'catalog availability invalid'); END;
    CREATE TRIGGER IF NOT EXISTS trg_tenant_skills_availability_update
      BEFORE UPDATE OF availability ON tenant_skills
      WHEN NEW.availability NOT IN ('organization', 'all', 'assigned')
      BEGIN SELECT RAISE(ABORT, 'catalog availability invalid'); END;

    CREATE TABLE IF NOT EXISTS catalog_resource_org_assignments (
      resource_type TEXT NOT NULL CHECK (resource_type IN ('agent', 'skill')),
      resource_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (resource_type, resource_id, org_id)
    );
    CREATE INDEX IF NOT EXISTS idx_catalog_resource_org_assignments_org
      ON catalog_resource_org_assignments (org_id, resource_type, resource_id);
    CREATE TRIGGER IF NOT EXISTS trg_catalog_agent_assignment_parent
      BEFORE INSERT ON catalog_resource_org_assignments
      WHEN NEW.resource_type = 'agent'
        AND NOT EXISTS (SELECT 1 FROM tenant_assistants WHERE id = NEW.resource_id)
      BEGIN SELECT RAISE(ABORT, 'catalog resource not found'); END;
    CREATE TRIGGER IF NOT EXISTS trg_catalog_skill_assignment_parent
      BEFORE INSERT ON catalog_resource_org_assignments
      WHEN NEW.resource_type = 'skill'
        AND NOT EXISTS (SELECT 1 FROM tenant_skills WHERE id = NEW.resource_id)
      BEGIN SELECT RAISE(ABORT, 'catalog resource not found'); END;

    CREATE TRIGGER IF NOT EXISTS trg_tenant_assistants_source_id
      AFTER INSERT ON tenant_assistants
      WHEN NEW.source_resource_id IS NULL
      BEGIN
        UPDATE tenant_assistants SET source_resource_id = NEW.id WHERE id = NEW.id;
      END;

    CREATE TRIGGER IF NOT EXISTS trg_tenant_skills_source_id
      AFTER INSERT ON tenant_skills
      WHEN NEW.source_resource_id IS NULL
      BEGIN
        UPDATE tenant_skills SET source_resource_id = NEW.id WHERE id = NEW.id;
      END;

    CREATE TABLE IF NOT EXISTS resource_external_aliases (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('agent', 'skill')),
      resource_id TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (resource_type, provider_type, provider_id, external_id),
      UNIQUE (resource_type, resource_id, provider_type, provider_id)
    );

    CREATE INDEX IF NOT EXISTS idx_resource_external_aliases_org
      ON resource_external_aliases (org_id, resource_type, resource_id);

    CREATE TABLE IF NOT EXISTS command_executions (
      command_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      context_source TEXT NOT NULL CHECK (context_source IN ('online', 'migration', 'replay')),
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (command_type, idempotency_key)
    );
  `)
}
