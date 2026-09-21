/**
 * org_zone_bindings / zone_binding_outbox / zone_binding_audit 三表 DDL。
 *
 * 约束来源：SW-20260915-002-MOSS-BINDING（§8.7 数据表）：
 *  - UNIQUE(org_id, nexus_deployment_id, zone_id, purpose)；zone_id 不单独 unique
 *    （一个 Zone 可被多个 Org 绑定）；
 *  - 每个 Org 最多一个 active default binding（partial unique）；
 *  - outbox UNIQUE(binding_id, generation, action)；lease owner/lease until/
 *    fence/attempt/next retry/operation ID 字段完整。
 *
 * 方言：同一文本同时用于 SQLite（authCenter initTables）与 PostgreSQL
 * （pg_schema.ts）——两侧均支持 partial unique index 与 CHECK，时间戳统一
 * INTEGER/BIGINT 毫秒（跟随 AuthCenterDb 现有模式），wire 层的 RFC 3339
 * 字符串由 bindingService 在出参处转换。
 */
export const ZONE_BINDING_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS org_zone_bindings (
    binding_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    nexus_deployment_id TEXT NOT NULL,
    zone_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    desired_capabilities TEXT NOT NULL,
    resource_prefixes TEXT,
    desired_state TEXT NOT NULL DEFAULT 'bound' CHECK (desired_state IN ('bound', 'detached')),
    sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'syncing', 'active', 'detaching', 'detached', 'sync_failed', 'unknown')),
    nexus_grant_id TEXT,
    nexus_operation_id TEXT,
    generation INTEGER NOT NULL DEFAULT 1,
    last_error_code TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE (org_id, nexus_deployment_id, zone_id, purpose)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS org_zone_bindings_default_uniq
    ON org_zone_bindings (org_id, nexus_deployment_id)
    WHERE is_default = 1 AND desired_state = 'bound';
  CREATE INDEX IF NOT EXISTS org_zone_bindings_org_idx ON org_zone_bindings (org_id);

  CREATE TABLE IF NOT EXISTS zone_binding_outbox (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL REFERENCES org_zone_bindings(binding_id),
    generation INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('provision', 'update', 'detach')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
    lease_owner TEXT,
    lease_until BIGINT,
    fence INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at BIGINT,
    operation_id TEXT,
    last_error_code TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE (binding_id, generation, action)
  );
  CREATE INDEX IF NOT EXISTS zone_binding_outbox_pending_idx
    ON zone_binding_outbox (status, next_retry_at);

  CREATE TABLE IF NOT EXISTS zone_binding_audit (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT,
    detail TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS zone_binding_audit_binding_idx
    ON zone_binding_audit (binding_id, created_at);
`
