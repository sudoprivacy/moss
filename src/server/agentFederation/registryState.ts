import type { DbDriver } from '../db/driver.js'
import { ExternalProviderError } from '../externalProviders/policy.js'

export const REGISTRY_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_registry_links (
    catalog_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, state TEXT NOT NULL, document TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_registry_snapshots (
    catalog_id TEXT NOT NULL, version TEXT NOT NULL, spec_digest TEXT NOT NULL, document TEXT NOT NULL,
    PRIMARY KEY(catalog_id, version)
  );
  CREATE TABLE IF NOT EXISTS agent_registry_commands (
    id TEXT PRIMARY KEY, catalog_id TEXT NOT NULL, document TEXT NOT NULL, result TEXT, created_at BIGINT NOT NULL
  );
`

export async function assertLegacyAuthority(db: DbDriver, catalogId: string): Promise<void> {
  const row = await db.get('SELECT state FROM agent_registry_links WHERE catalog_id = ?', [catalogId])
  if (row) throw new ExternalProviderError(409, 'REGISTRY_AUTHORITY_REQUIRED')
}

/** Installed only by explicit enrollment/migration, never by startup or GET. */
export async function installRegistryFences(db: DbDriver): Promise<void> {
  for (const table of ['agent_versions', 'agent_version_decisions', 'agent_channels', 'agent_channel_events']) {
    const name = `${table}_registry_fence`
    if (db.kind === 'sqlite') {
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        const record = action === 'DELETE' ? 'OLD' : 'NEW'
        await db.exec(`CREATE TRIGGER IF NOT EXISTS ${name}_${action.toLowerCase()} BEFORE ${action} ON ${table}
          WHEN EXISTS (SELECT 1 FROM agent_registry_links WHERE catalog_id = ${record}.catalog_id)
          BEGIN SELECT RAISE(ABORT, 'REGISTRY_AUTHORITY_REQUIRED'); END;`)
      }
    } else {
      await db.exec(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM agent_registry_links WHERE catalog_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.catalog_id ELSE NEW.catalog_id END)
          THEN RAISE EXCEPTION 'REGISTRY_AUTHORITY_REQUIRED'; END IF;
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
        END $$;
        DROP TRIGGER IF EXISTS ${name} ON ${table};
        CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}();`)
    }
  }
  // A legacy publisher cannot create an accepted Task for a migrated Agent. New Task records
  // carry the verified Registry registration; old strict parsers also reject this new projection.
  if (db.kind === 'sqlite') {
    await db.exec(`CREATE TRIGGER IF NOT EXISTS product_task_registry_fence BEFORE INSERT ON product_task_records
      WHEN json_extract(NEW.document, '$.resolution.status') = 'accepted'
      AND EXISTS (SELECT 1 FROM agent_registry_links l JOIN tasks t ON json_extract(t.document, '$.agent_id') = l.catalog_id
        WHERE t.id = NEW.task_id AND (l.state <> 'active' OR coalesce(json_extract(NEW.document, '$.resolution.agent.registry.authority'), '') <> 'nexus_registry'))
      BEGIN SELECT RAISE(ABORT, 'REGISTRY_AUTHORITY_REQUIRED'); END;`)
  } else {
    await db.exec(`CREATE OR REPLACE FUNCTION product_task_registry_fence() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.document::jsonb #>> '{resolution,status}' = 'accepted' AND EXISTS (
          SELECT 1 FROM agent_registry_links l JOIN tasks t ON t.document::jsonb ->> 'agent_id' = l.catalog_id
          WHERE t.id = NEW.task_id AND (l.state <> 'active' OR coalesce(NEW.document::jsonb #>> '{resolution,agent,registry,authority}', '') <> 'nexus_registry'))
        THEN RAISE EXCEPTION 'REGISTRY_AUTHORITY_REQUIRED'; END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS product_task_registry_fence ON product_task_records;
      CREATE TRIGGER product_task_registry_fence BEFORE INSERT ON product_task_records FOR EACH ROW EXECUTE FUNCTION product_task_registry_fence();`)
  }
}
