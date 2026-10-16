/** Canonical session/attempt/instance/event facts shared by SQLite and PostgreSQL. */
export const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  transcript_session_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  cwd TEXT NOT NULL,
  runtime_type TEXT NOT NULL,
  docker_image TEXT,
  docker_mode TEXT,
  config_dir TEXT,
  container_name TEXT,
  status TEXT NOT NULL,
  desired_state TEXT NOT NULL,
  current_attempt_id TEXT,
  transcript_path TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  assistant_name TEXT,
  source TEXT,
  channel_chat_id TEXT,
  client_metadata TEXT,
  created_at BIGINT NOT NULL,
  last_active_at BIGINT NOT NULL,
  ended_at BIGINT,
  deleted_at BIGINT
);

CREATE TABLE IF NOT EXISTS session_attempts (
  attempt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  generation BIGINT NOT NULL,
  backend_type TEXT NOT NULL,
  runtime_state TEXT NOT NULL,
  server_instance_id TEXT,
  runner_pid BIGINT,
  container_name TEXT,
  attach_path TEXT,
  resume_transcript_session_id TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  last_heartbeat_at BIGINT,
  stopped_at BIGINT,
  exit_code BIGINT,
  exit_signal TEXT,
  stop_reason TEXT,
  error_text TEXT,
  UNIQUE (session_id, generation)
);

CREATE TABLE IF NOT EXISTS server_instances (
  instance_id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  pid BIGINT,
  started_at BIGINT NOT NULL,
  heartbeat_at BIGINT NOT NULL,
  stopped_at BIGINT,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  attempt_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

`
