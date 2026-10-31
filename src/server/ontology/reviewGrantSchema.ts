/** Browser capability bookkeeping only; credentials and canonical models are not copied. */
export const ONTOLOGY_REVIEW_GRANT_SCHEMA = `
CREATE TABLE IF NOT EXISTS ontology_review_grants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  slot BIGINT NOT NULL CHECK (slot >= 0 AND slot < 128),
  workspace_id TEXT NOT NULL REFERENCES ontology_projects(project_id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ontology_session_bindings(session_id) ON DELETE CASCADE,
  authorization_ref TEXT NOT NULL,
  prefix TEXT NOT NULL,
  cookie_name TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  share_id TEXT,
  revision TEXT,
  UNIQUE (org_id, user_id, slot)
);
CREATE INDEX IF NOT EXISTS ontology_review_grants_expiry ON ontology_review_grants(expires_at);
`
