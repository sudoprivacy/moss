/** Native protocol binding and writer fence, adjunct to canonical Session/Attempt. */
export const STANDARD_ACP_SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS standard_acp_sessions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
  owner_user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  native_agent_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  native_session_id TEXT,
  writer_attempt_id TEXT NOT NULL REFERENCES session_attempts(attempt_id),
  writer_nonce TEXT NOT NULL,
  writer_released BIGINT NOT NULL DEFAULT 0
);
`
