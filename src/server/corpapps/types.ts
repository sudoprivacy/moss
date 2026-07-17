/**
 * 企业应用管理 (Corp App Management) — Connector abstraction.
 *
 * A CorpAppConnector wraps an outbound integration with a third-party
 * enterprise platform (企微自建应用 / WeCom self-built app, and future
 * types like Lark/DingTalk self-built apps). Unlike IM channel plugins,
 * an admin can register MULTIPLE named instances of the same type — so
 * the abstraction is instance-oriented, not singleton.
 *
 * Capabilities are per-type and OPTIONAL: a connector implements only
 * the methods its platform supports. The agent-facing API returns the
 * declared `capabilities` so callers (and the `corpapp` CLI) know what
 * a given instance can do before invoking it.
 *
 * This mirrors the External Sources connector registry
 * (sources/types.ts): each connector self-registers with
 * `registerCorpApp(type, factory)` at import time, and the API layers
 * construct fresh instances per request via `createCorpApp(type)`.
 */

// ============================================================
// Types
// ============================================================

/**
 * Non-secret configuration for a corp-app instance. Stored as
 * `corp_apps.config_json`. For wecomapp this holds `corpId`/`agentId`
 * (identifiers, not secrets) so the instance KEY can be derived without
 * decrypting the credential blob.
 */
export type CorpAppConfig = { [key: string]: unknown }

/**
 * Credentials handed to the connector at init time. Resolved from the
 * secret store (sources/secrets.ts) before `init()`. Shape is
 * connector-specific (wecomapp: { secret, callbackToken, encodingAesKey }).
 */
export type CorpAppCredentials = Record<string, string>

/** Result of `testConnection()` — surfaced in the admin config dialog. */
export type TestConnectionResult = { ok: boolean; message?: string }

/**
 * Parameters for `listApprovals()`. `starttime`/`endtime` are Unix
 * seconds (provider-defined max window applies — WeCom caps at 31 days).
 * `cursor` paginates (empty on the first page). `filters` are opaque
 * key/value pairs passed through to the provider (WeCom: template_id,
 * creator, sp_status, record_type, department).
 */
export type ApprovalListParams = {
  starttime: number
  endtime: number
  cursor?: string
  size?: number
  filters?: { key: string; value: string }[]
}

/** Identity/info about the connected app, from `getInfo()`. */
export type CorpAppInfo = {
  type: string
  key: string
  identity: Record<string, unknown>
}

/**
 * A normalized inbound message parsed from a provider callback. The
 * connector owns provider-specific crypto/parsing; buffering lives in
 * the `corp_app_inbound` DB table (db.ts) so messages survive restarts
 * and cross the callback-listener ↔ session-container process boundary.
 */
export type InboundMessage = {
  id: string
  from: string
  type: 'text' | 'file' | 'image' | 'other'
  text?: string
  mediaId?: string
  fileName?: string
  receivedAt: number
}

// ============================================================
// Connector interface
// ============================================================

export interface CorpAppConnector {
  /** Connector type identifier — also the value stored in corp_apps.type. */
  readonly type: string

  /**
   * Capabilities this connector supports, e.g.
   * ['send','sendFile','receive','info']. Returned by the API so the
   * agent knows what an instance can do; an unsupported capability
   * yields HTTP 501 at the agent endpoint.
   */
  readonly capabilities: string[]

  /**
   * Compute the stable instance KEY from config. For wecomapp this is
   * `${corpId}:${agentId}`. Derived from config (not credentials) so the
   * key can be computed/indexed without decrypting secrets.
   */
  keyOf(config: CorpAppConfig): string

  /**
   * Establish a session with the platform using config + credentials.
   * Connectors are single-use (constructed fresh per request); keep
   * state in-memory, no explicit teardown needed.
   */
  init(config: CorpAppConfig, credentials: CorpAppCredentials): Promise<void>

  /**
   * Cheap credential check (no heavy calls) — typically just acquire an
   * access token. Used by the admin "test connection" button.
   */
  testConnection(): Promise<TestConnectionResult>

  /** Optional: identity/info about the connected app. */
  getInfo?(): Promise<CorpAppInfo>

  /** Optional: send a text message to a platform user. */
  sendMessage?(to: string, text: string): Promise<{ ok: boolean; msgId?: string }>

  /** Optional: upload + send a file to a platform user. */
  sendFile?(to: string, fileName: string, bytes: Buffer): Promise<{ ok: boolean; msgId?: string }>

  /**
   * Optional: download the bytes of an inbound media item by its
   * provider media id (e.g. WeCom MediaId from a received file/image).
   * Returns the bytes plus a best-effort filename/content-type.
   */
  downloadMedia?(mediaId: string): Promise<{ bytes: Buffer; fileName?: string; contentType?: string }>

  /**
   * Optional: list approval (审批) instance ids in a time window, with
   * optional filters (template/creator/status/...). Returns the raw
   * provider response (e.g. WeCom getapprovalinfo: sp_no_list +
   * new_next_cursor). The provider schema is passed through unchanged.
   */
  listApprovals?(params: ApprovalListParams): Promise<Record<string, unknown>>

  /**
   * Optional: fetch the full detail of a single approval instance by its
   * provider id (e.g. WeCom sp_no). Returns the raw provider response
   * (type, status, applicant, step records, comments, form data).
   */
  getApproval?(spNo: string): Promise<Record<string, unknown>>

  /**
   * Optional: handle a provider URL-verification handshake. Returns the
   * plaintext to echo back (e.g. WeCom's decrypted echostr).
   */
  verifyCallbackUrl?(p: {
    msgSignature: string
    timestamp: string
    nonce: string
    echostr: string
  }): Promise<string>

  /**
   * Optional: verify + decrypt + parse an inbound callback POST body
   * into normalized messages. The callback listener persists the result
   * via the DB inbound buffer.
   */
  parseInboundCallback?(p: {
    msgSignature: string
    timestamp: string
    nonce: string
    body: string
  }): Promise<InboundMessage[]>
}

// ============================================================
// Connector registry
// ============================================================

export type CorpAppFactory = () => CorpAppConnector

const registry = new Map<string, CorpAppFactory>()

/**
 * Register a corp-app connector type. Called once at module init time by
 * each connector implementation (corpapps/wecomApp.ts).
 */
export function registerCorpApp(type: string, factory: CorpAppFactory): void {
  if (registry.has(type)) {
    throw new Error(`corp app type already registered: ${type}`)
  }
  registry.set(type, factory)
}

/**
 * Construct a fresh connector instance for the given type. Throws if the
 * type isn't registered. Callers create one per request so connectors
 * don't need to be reentrant.
 */
export function createCorpApp(type: string): CorpAppConnector {
  const factory = registry.get(type)
  if (!factory) {
    throw new Error(`unknown corp app type: ${type}`)
  }
  return factory()
}

/** Return all registered corp-app type names. */
export function listCorpAppTypes(): string[] {
  return Array.from(registry.keys()).sort()
}

/** Return the declared capabilities for a type (empty if unknown). */
export function getCorpAppCapabilities(type: string): string[] {
  const factory = registry.get(type)
  if (!factory) return []
  try {
    return factory().capabilities
  } catch {
    return []
  }
}
