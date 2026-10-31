/** A dispatch reservation survives restart and never expires after an uncertain submission. */
export const ONTOLOGY_REVIEW_DISPATCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS ontology_review_dispatch_claims (
  org_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (org_id, item_id),
  FOREIGN KEY (org_id, item_id) REFERENCES ontology_review_inbox(org_id, id) ON DELETE CASCADE
);
`
