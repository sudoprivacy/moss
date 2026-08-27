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

/**
 * Parameters for `listCustomerGroups()` (WeCom 客户群列表, doc 92120).
 *
 * `ownerUserIds` filters by 群主 — and note that WeCom's visibility rule is
 * keyed on the OWNER alone: a group whose owner is outside the app's visible
 * range is not returned at all, even when other members are in range. With no
 * filter WeCom returns every owner in the visible range, but errors with
 * `81017` once that range exceeds 1000 people, so callers at scale must page
 * by owner (WeCom caps `ownerUserIds` at 100 per call).
 */
export type CustomerGroupListParams = {
  ownerUserIds?: string[]
  statusFilter?: number
  cursor?: string
  limit?: number
}

/**
 * Parameters for `createGroupMsgTask()` (WeCom 企业群发, doc 92135).
 *
 * IMPORTANT — this does NOT send. It creates a *pending task* that a human
 * must confirm in 企微 群发助手 before anything reaches the group. Tasks
 * created through the API are recorded by WeCom as `create_type=0` (企业发表)
 * with an empty `creator`, which additionally requires an administrator to
 * approve them before the sender is even notified. Only tasks composed by a
 * person inside the WeCom client are `create_type=1` (个人发表) and skip that
 * admin step — there is no API parameter that changes this.
 *
 * `sender` must be an internal 企业成员 userid who is already a member of the
 * target group; an `external_userid` is rejected with `60111 userid not found`.
 */
export type GroupMsgTaskParams = {
  chatIdList: string[]
  sender: string
  text?: string
  attachments?: GroupMsgAttachment[]
  allowSelect?: boolean
}

/**
 * One attachment on a 群发 task. WeCom accepts at most 9 per task. Media must
 * already be uploaded (see `uploadMedia`) — attachments carry a `mediaId`,
 * never raw bytes.
 */
export type GroupMsgAttachment = {
  msgtype: 'image' | 'link' | 'video' | 'file' | 'miniprogram'
  mediaId?: string
  [key: string]: unknown
}

/**
 * Parameters for `listGroupMsgs()` (WeCom 群发记录, doc 93338). The provider
 * caps the window at one month. `filterType`: 0=企业发表 1=个人发表 2=全部.
 */
export type GroupMsgListParams = {
  startTime: number
  endTime: number
  creator?: string
  filterType?: number
  cursor?: string
  limit?: number
}

/**
 * One target's outcome in `GroupMsgSendSummary`. `status` mirrors WeCom's
 * send-result codes: 0=未发送 1=已发送 2=非好友失败 3=已收到其他群发失败.
 */
export type GroupMsgSendEntry = {
  chatId: string
  status: number
  statusLabel: string
  delivered: boolean
  /** True for status 3 — the target's daily broadcast quota was already used. */
  blockedByDailyCap: boolean
  sendTime?: number
}

/**
 * Reconciled view of what a 群发 task actually delivered.
 *
 * This exists because the obvious signal lies: a task whose members show
 * `已发送` may still have delivered to nobody. WeCom accepts only one 群发 per
 * customer group per day, and a same-day second task is confirmed by the human
 * as normal, then silently discarded with send-result status 3. Callers must
 * reconcile here rather than trusting task status.
 */
export type GroupMsgSendSummary = {
  msgId: string
  delivered: number
  pending: number
  failed: number
  /** Targets dropped because the group already received a broadcast today. */
  blockedByDailyCap: number
  entries: GroupMsgSendEntry[]
}

/** Result of `createGroupMsgTask()`. `failList` holds chat ids WeCom rejected. */
export type GroupMsgTaskResult = {
  ok: boolean
  msgId?: string
  failList?: string[]
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

  /**
   * Optional: send a message to a platform user. `format` selects the
   * message representation:
   *   - 'text' (default): plain text, no styling.
   *   - 'markdown': provider-flavoured markdown, e.g. WeCom's
   *     `<font color="info|comment|warning">` colour spans. Callers
   *     should check `capabilities` for 'sendMarkdown' before relying on
   *     colour — connectors without markdown support should treat this
   *     as plain text.
   */
  sendMessage?(
    to: string,
    text: string,
    format?: 'text' | 'markdown',
  ): Promise<{ ok: boolean; msgId?: string }>

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
   * Optional: list customer groups (WeCom 客户群, doc 92120). Returns the raw
   * provider response (`group_chat_list` + `next_cursor`) so no fields are
   * lost. See `CustomerGroupListParams` for the owner-visibility caveat.
   */
  listCustomerGroups?(params: CustomerGroupListParams): Promise<Record<string, unknown>>

  /**
   * Optional: fetch one customer group's detail (doc 92122) — name, owner,
   * notice, admin list and the full `member_list`, where `type` is 1 for
   * internal staff and 2 for external contacts. Pass `needName` to have WeCom
   * include member display names (it omits them by default).
   */
  getCustomerGroup?(chatId: string, needName?: boolean): Promise<Record<string, unknown>>

  /**
   * Optional: create a 群发 task targeting customer groups (doc 92135).
   * Creates a task pending human confirmation — see `GroupMsgTaskParams`.
   */
  createGroupMsgTask?(params: GroupMsgTaskParams): Promise<GroupMsgTaskResult>

  /**
   * Optional: per-target delivery status for a 群发 task (doc 93338).
   * WeCom `status`: 0=未发送 1=已发送 2=因客户不是好友失败
   * 3=因客户已收到其他群发失败. A group accepts only ONE 群发 per day, so a
   * same-day second task settles as status 3 while the task itself still
   * reports as sent — always reconcile here, not on the task status alone.
   */
  getGroupMsgSendResult?(
    msgId: string,
    userId: string,
    cursor?: string,
  ): Promise<Record<string, unknown>>

  /**
   * Optional: list past 群发 tasks in a time window (doc 93338). Raw
   * passthrough of `group_msg_list` + `next_cursor`. Used to reconstruct
   * which groups already received a broadcast — the provider enforces one
   * per group per day but never reports the remaining quota.
   */
  listGroupMsgs?(params: GroupMsgListParams): Promise<Record<string, unknown>>

  /**
   * Optional: reconcile a 群发 task into a per-target delivery summary,
   * paging through the provider's cursor. Prefer this over
   * `getGroupMsgSendResult` when you want to know what actually landed —
   * it classifies the daily-cap rejection (status 3) explicitly.
   */
  summariseGroupMsgDelivery?(msgId: string, userId: string): Promise<GroupMsgSendSummary>

  /**
   * Optional: per-member task status for a 群发 (doc 93338).
   * WeCom `status`: 0=未发送 2=已发送.
   */
  getGroupMsgTask?(msgId: string, cursor?: string): Promise<Record<string, unknown>>

  /**
   * Optional: cancel a pending 群发 task (`cancel_groupmsg_send`). Removes it
   * from the approver's and sender's queues so a stale task cannot be
   * confirmed days later and consume that day's quota.
   */
  cancelGroupMsgSend?(msgId: string): Promise<{ ok: boolean }>

  /**
   * Optional: re-trigger the confirmation prompt for a pending 群发 task
   * (doc 97610). WeCom allows at most 3 reminders per task per 24h.
   */
  remindGroupMsgSend?(msgId: string): Promise<{ ok: boolean }>

  /**
   * Optional: upload media and return its provider media id, without sending
   * anything. Group-message attachments reference media by id, so upload and
   * send are separate steps here (unlike `sendFile`, which does both).
   * WeCom media ids expire after 3 days.
   */
  uploadMedia?(
    type: 'file' | 'image' | 'video' | 'voice',
    fileName: string,
    bytes: Buffer,
  ): Promise<{ mediaId: string }>

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
