/** Durable storage assignment; live runtime addresses and process state stay outside SQL. */
export const COHOST_AGENT_HOME_SCHEMA = `
  CREATE TABLE IF NOT EXISTS cohost_agent_homes (
    owner_user_id TEXT NOT NULL,
    native_agent_id TEXT NOT NULL,
    allocation_id TEXT NOT NULL,
    PRIMARY KEY (owner_user_id, native_agent_id)
  );
  CREATE INDEX IF NOT EXISTS idx_cohost_agent_home_allocation
    ON cohost_agent_homes (owner_user_id, allocation_id);
`
