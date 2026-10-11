/** Durable native session bindings shared by SQLite and PostgreSQL. */
export const COHOST_SESSION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS cohost_sessions (
    session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
    owner_user_id TEXT NOT NULL,
    native_agent_id TEXT NOT NULL,
    durable_session_id TEXT NOT NULL,
    repository_path TEXT NOT NULL,
    UNIQUE (owner_user_id, durable_session_id)
  );
`
