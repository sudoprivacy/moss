/** Delivery bookkeeping only; ShareOne owns comments and the compiler owns definitions. */
export const ONTOLOGY_REVIEW_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ontology_review_values (
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (org_id, key)
);
CREATE TABLE IF NOT EXISTS ontology_review_subscriptions (
  org_id TEXT NOT NULL,
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  account TEXT NOT NULL,
  share_id TEXT NOT NULL,
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, workspace_id, conversation_id, account, share_id)
);
CREATE TABLE IF NOT EXISTS ontology_review_inbox (
  org_id TEXT NOT NULL,
  id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  message_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','delivered','error','ignored')),
  error TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, subscription_id, event_id),
  FOREIGN KEY (org_id, subscription_id) REFERENCES ontology_review_subscriptions(org_id, id)
);
CREATE INDEX IF NOT EXISTS ontology_review_inbox_pending ON ontology_review_inbox(org_id, status, created_at);
CREATE TABLE IF NOT EXISTS ontology_review_input_claims (
  org_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (org_id, subscription_id, input_digest),
  FOREIGN KEY (org_id, subscription_id) REFERENCES ontology_review_subscriptions(org_id, id),
  FOREIGN KEY (org_id, item_id) REFERENCES ontology_review_inbox(org_id, id)
);
`
