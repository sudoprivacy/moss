/** Host references only. Canonical definitions and credentials remain outside this registry. */
export const ONTOLOGY_PROJECT_SCHEMA = `
CREATE TABLE IF NOT EXISTS ontology_projects (
  project_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  authority_ref TEXT NOT NULL,
  worker_ref TEXT NOT NULL,
  model_ref TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  enabled BIGINT NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  generation BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  UNIQUE (org_id, authority_ref),
  UNIQUE (org_id, worker_ref, model_ref)
);
CREATE INDEX IF NOT EXISTS ontology_projects_org ON ontology_projects(org_id, enabled);
CREATE TABLE IF NOT EXISTS ontology_session_bindings (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
  project_id TEXT NOT NULL REFERENCES ontology_projects(project_id),
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  binding_id TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL
);
`
