/**
 * 企微自建应用 (WeCom self-built application) corp-app connector.
 *
 * A standard WeCom REST integration using corpId + agentId + secret
 * against qyapi.weixin.qq.com. This is NOT the WeCom AI-bot WebSocket
 * (channels/plugins/wecom) — different product, different credentials.
 *
 * Config (non-secret, in corp_apps.config_json):
 *   - corpId   企业ID
 *   - agentId  应用 AgentId
 *
 * Credentials (encrypted in the secret store):
 *   - secret          应用 Secret (corpsecret for gettoken)
 *   - callbackToken   接收消息 Token        (optional; needed for receive)
 *   - encodingAesKey  接收消息 EncodingAESKey (optional; needed for receive)
 *
 * Capabilities: send (text or markdown, incl. WeCom's
 * `<font color="info|comment|warning">` colour spans), sendFile,
 * receive (callback), info.
 */

import {
  type ApprovalListParams,
  type CorpAppConfig,
  type CorpAppConnector,
  type CorpAppCredentials,
  type CorpAppInfo,
  type CustomerGroupListParams,
  type GroupMsgListParams,
  type GroupMsgSendEntry,
  type GroupMsgSendSummary,
  type GroupMsgTaskParams,
  type GroupMsgTaskResult,
  type InboundMessage,
  type TestConnectionResult,
  registerCorpApp,
} from './types.js'
import { WeComApiClient } from './wecomClient.js'
import {
  decrypt,
  extractEncrypt,
  readXmlField,
  verifySignature,
  verifyUrl,
} from './wecomCallbackCrypto.js'

/**
 * WeCom send-result status codes (doc 93338). Status 3 is the daily
 * per-group broadcast cap: the target already received a 群发 today, so this
 * one was discarded after the sender confirmed it.
 */
const GROUP_MSG_SEND_STATUS: Record<number, string> = {
  0: '未发送',
  1: '已发送',
  2: '发送失败（客户不是好友）',
  3: '发送失败（今日已收到其他群发）',
}

export class WeComAppConnector implements CorpAppConnector {
  readonly type = 'wecomapp'
  readonly capabilities = [
    'send',
    'sendMarkdown',
    'sendFile',
    'receive',
    'info',
    'downloadMedia',
    'listApprovals',
    'getApproval',
    'listCustomerGroups',
    'sendGroupMsg',
    'groupMsgResult',
    'uploadMedia',
    'groupMsgSummary',
    'listGroupMsgs',
    'cancelGroupMsg',
    'groupMsgQueue',
  ]

  private corpId = ''
  private agentId = ''
  private secret = ''
  private callbackToken = ''
  private encodingAesKey = ''
  private client: WeComApiClient | null = null

  keyOf(config: CorpAppConfig): string {
    return `${String(config.corpId ?? '')}:${String(config.agentId ?? '')}`
  }

  async init(config: CorpAppConfig, credentials: CorpAppCredentials): Promise<void> {
    this.corpId = String(config.corpId ?? '')
    this.agentId = String(config.agentId ?? '')
    this.secret = credentials.secret ?? ''
    this.callbackToken = credentials.callbackToken ?? ''
    this.encodingAesKey = credentials.encodingAesKey ?? ''
    if (!this.corpId) throw new Error('wecomapp: missing corpId')
    if (!this.agentId) throw new Error('wecomapp: missing agentId')
    if (!this.secret) throw new Error('wecomapp: missing secret')
    this.client = new WeComApiClient(this.corpId, this.secret)
  }

  private requireClient(): WeComApiClient {
    if (!this.client) throw new Error('wecomapp: connector not initialized')
    return this.client
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const token = await this.requireClient().getAccessToken()
      if (!token) return { ok: false, message: '无法获取 access_token' }
      return { ok: true, message: 'access_token 获取成功' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async getInfo(): Promise<CorpAppInfo> {
    const client = this.requireClient()
    let identity: Record<string, unknown> = {}
    try {
      // /cgi-bin/agent/get is a GET, but post() always uses POST; fetch directly.
      const token = await client.getAccessToken()
      const base = process.env.WECOM_API_BASE || 'https://qyapi.weixin.qq.com'
      const resp = await fetch(
        `${base}/cgi-bin/agent/get?access_token=${encodeURIComponent(token)}&agentid=${encodeURIComponent(this.agentId)}`,
      )
      if (resp.ok) {
        const json = (await resp.json()) as Record<string, unknown>
        if (Number(json.errcode ?? 0) === 0) {
          identity = { name: json.name, square_logo_url: json.square_logo_url }
        }
      }
    } catch {
      // identity is best-effort
    }
    return { type: this.type, key: `${this.corpId}:${this.agentId}`, identity }
  }

  async sendMessage(
    to: string,
    text: string,
    format: 'text' | 'markdown' = 'text',
  ): Promise<{ ok: boolean; msgId?: string }> {
    const body =
      format === 'markdown'
        ? { touser: to, msgtype: 'markdown', agentid: Number(this.agentId), markdown: { content: text } }
        : { touser: to, msgtype: 'text', agentid: Number(this.agentId), text: { content: text } }
    const json = await this.requireClient().post('/cgi-bin/message/send', body)
    return { ok: Number(json.errcode ?? 0) === 0, msgId: json.msgid ? String(json.msgid) : undefined }
  }

  async sendFile(
    to: string,
    fileName: string,
    bytes: Buffer,
  ): Promise<{ ok: boolean; msgId?: string }> {
    const client = this.requireClient()
    // 1. upload media → media_id (type=file, valid for 3 days)
    const upload = await client.postMultipart(
      '/cgi-bin/media/upload?type=file',
      'media',
      fileName,
      bytes,
    )
    const mediaId = upload.media_id ? String(upload.media_id) : ''
    if (!mediaId) {
      throw new Error(`media/upload: no media_id (errcode=${String(upload.errcode ?? '')})`)
    }
    // 2. send file message
    const json = await client.post('/cgi-bin/message/send', {
      touser: to,
      msgtype: 'file',
      agentid: Number(this.agentId),
      file: { media_id: mediaId },
    })
    return { ok: Number(json.errcode ?? 0) === 0, msgId: json.msgid ? String(json.msgid) : undefined }
  }

  async downloadMedia(
    mediaId: string,
  ): Promise<{ bytes: Buffer; fileName?: string; contentType?: string }> {
    return this.requireClient().getBytes(
      `/cgi-bin/media/get?media_id=${encodeURIComponent(mediaId)}`,
    )
  }

  /**
   * List approval instance ids (审批单号) in a time window.
   *
   * Requires this app to be authorised under 审批 → 「可调用接口的应用」
   * in the WeCom admin console, otherwise WeCom returns a permission
   * errcode. The raw response is passed through: `sp_no_list` (the
   * matching approval numbers) and `new_next_cursor` (absent when the
   * result set is exhausted).
   *
   * https://developer.work.weixin.qq.com/document/path/91816
   */
  async listApprovals(params: ApprovalListParams): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      starttime: params.starttime,
      endtime: params.endtime,
      new_cursor: params.cursor ?? '',
      size: params.size ?? 100,
    }
    if (params.filters && params.filters.length > 0) {
      body.filters = params.filters
    }
    return this.requireClient().post('/cgi-bin/oa/getapprovalinfo', body)
  }

  /**
   * Fetch the full detail of a single approval instance by its sp_no.
   *
   * Raw passthrough of WeCom `getapprovaldetail` — the `info` object with
   * sp_no, sp_name, sp_status, template_id, apply_time, applyer,
   * sp_record[] (per-step approver/speech/sptime), comments[] and
   * apply_data (form controls, including file/attachment media ids).
   *
   * https://developer.work.weixin.qq.com/document/path/91983
   */
  async getApproval(spNo: string): Promise<Record<string, unknown>> {
    return this.requireClient().post('/cgi-bin/oa/getapprovaldetail', { sp_no: spNo })
  }

  /**
   * List 客户群 ids (doc 92120).
   *
   * WeCom decides visibility by GROUP OWNER only: a group whose 群主 is
   * outside this app's visible range is silently absent from the result —
   * there is no error, just a short list. Without `ownerUserIds` WeCom walks
   * every owner in range and fails with `81017` once that exceeds 1000
   * people, so large tenants must page by owner (max 100 ids per call).
   *
   * https://developer.work.weixin.qq.com/document/path/92120
   */
  async listCustomerGroups(params: CustomerGroupListParams): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      status_filter: params.statusFilter ?? 0,
      limit: params.limit ?? 1000,
    }
    if (params.cursor) body.cursor = params.cursor
    if (params.ownerUserIds && params.ownerUserIds.length > 0) {
      body.owner_filter = { userid_list: params.ownerUserIds }
    }
    return this.requireClient().post('/cgi-bin/externalcontact/groupchat/list', body)
  }

  /**
   * Fetch one 客户群's detail (doc 92122) — raw passthrough of `group_chat`:
   * name, owner, create_time, notice, admin_list and member_list. Members
   * carry `type` 1 (internal staff, real userid) or 2 (external contact,
   * opaque `external_userid`). `needName` is required for display names.
   *
   * https://developer.work.weixin.qq.com/document/path/92122
   */
  async getCustomerGroup(chatId: string, needName = true): Promise<Record<string, unknown>> {
    return this.requireClient().post('/cgi-bin/externalcontact/groupchat/get', {
      chat_id: chatId,
      need_name: needName ? 1 : 0,
    })
  }

  /**
   * Create a 群发 task for customer groups (doc 92135).
   *
   * This does NOT deliver the message. WeCom creates a task that a human must
   * confirm in 群发助手, and API-created tasks land as `create_type=0`
   * (企业发表) which an administrator must approve first. Verified against a
   * live tenant: passing `create_type` in the request is ignored, and neither
   * the app secret nor the 客户联系 secret changes the outcome.
   *
   * A customer group accepts only ONE 群发 per day; a second same-day task is
   * confirmed normally but settles as send-result status 3.
   *
   * https://developer.work.weixin.qq.com/document/path/92135
   */
  async createGroupMsgTask(params: GroupMsgTaskParams): Promise<GroupMsgTaskResult> {
    if (params.chatIdList.length === 0) {
      throw new Error('createGroupMsgTask: chatIdList must not be empty')
    }
    if (params.chatIdList.length > 2000) {
      throw new Error('createGroupMsgTask: chatIdList exceeds WeCom limit of 2000')
    }
    if (!params.sender) {
      // WeCom distinguishes absent from empty here: omitting `sender` makes it
      // auto-assign the task to the group owner, while an empty string is
      // rejected with `40058 field sender unexpected empty string`. Requiring
      // an explicit sender avoids both the error and the undocumented
      // owner-fallback, so the caller always knows who will be asked to confirm.
      throw new Error('createGroupMsgTask: sender is required for chat_type=group')
    }
    const attachments = params.attachments ?? []
    if (attachments.length > 9) {
      throw new Error(
        `createGroupMsgTask: ${attachments.length} attachments exceeds WeCom limit of 9`,
      )
    }
    if (!params.text && attachments.length === 0) {
      throw new Error('createGroupMsgTask: text or attachments is required')
    }
    if (params.text && Buffer.byteLength(params.text, 'utf8') > 4000) {
      throw new Error('createGroupMsgTask: text exceeds WeCom limit of 4000 bytes')
    }

    const body: Record<string, unknown> = {
      chat_type: 'group',
      chat_id_list: params.chatIdList,
      sender: params.sender,
    }
    if (params.text) body.text = { content: params.text }
    if (params.allowSelect !== undefined) body.allow_select = params.allowSelect
    if (attachments.length > 0) {
      body.attachments = attachments.map((a) => {
        const { msgtype, mediaId, ...rest } = a
        const payload: Record<string, unknown> = { ...rest }
        if (mediaId) payload.media_id = mediaId
        return { msgtype, [msgtype]: payload }
      })
    }

    const json = await this.requireClient().post(
      '/cgi-bin/externalcontact/add_msg_template',
      body,
    )
    const failList = Array.isArray(json.fail_list) ? (json.fail_list as string[]) : undefined
    return {
      ok: Number(json.errcode ?? 0) === 0,
      msgId: json.msgid ? String(json.msgid) : undefined,
      failList,
    }
  }

  /**
   * Per-target delivery status for a 群发 task (doc 93338). Raw passthrough of
   * `send_list` + `next_cursor`. status: 0=未发送 1=已发送 2=非好友失败
   * 3=已收到其他群发失败 (the daily per-group cap).
   */
  async getGroupMsgSendResult(
    msgId: string,
    userId: string,
    cursor?: string,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { msgid: msgId, userid: userId, limit: 1000 }
    if (cursor) body.cursor = cursor
    return this.requireClient().post('/cgi-bin/externalcontact/get_groupmsg_send_result', body)
  }

  /**
   * List past 群发 tasks in a window (doc 93338). The provider caps the range
   * at one month and returns tasks, not per-group targets — resolving which
   * groups were hit requires following each msgid into the send result.
   */
  async listGroupMsgs(params: GroupMsgListParams): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      chat_type: 'group',
      start_time: params.startTime,
      end_time: params.endTime,
      filter_type: params.filterType ?? 2,
      limit: params.limit ?? 100,
    }
    if (params.creator) body.creator = params.creator
    if (params.cursor) body.cursor = params.cursor
    return this.requireClient().post('/cgi-bin/externalcontact/get_groupmsg_list_v2', body)
  }

  /**
   * Reconcile what a 群发 task actually delivered, paging the cursor.
   *
   * Exists because the naive signal is misleading: a member showing 已发送
   * only means they tapped confirm. WeCom permits one 群发 per customer group
   * per day, and a same-day second task is confirmed normally then dropped
   * with status 3 — no error at creation, no warning to the sender. Only the
   * send-result reveals it, so campaign code must reconcile here.
   */
  async summariseGroupMsgDelivery(msgId: string, userId: string): Promise<GroupMsgSendSummary> {
    const entries: GroupMsgSendEntry[] = []
    let cursor: string | undefined
    // Bound the walk: a runaway/repeating cursor must not spin forever.
    for (let page = 0; page < 200; page++) {
      const json = await this.getGroupMsgSendResult(msgId, userId, cursor)
      const list = Array.isArray(json.send_list) ? (json.send_list as Record<string, unknown>[]) : []
      for (const row of list) {
        const status = Number(row.status ?? 0)
        entries.push({
          chatId: String(row.chat_id ?? row.external_userid ?? ''),
          status,
          statusLabel: GROUP_MSG_SEND_STATUS[status] ?? `unknown(${status})`,
          delivered: status === 1,
          blockedByDailyCap: status === 3,
          sendTime: row.send_time ? Number(row.send_time) : undefined,
        })
      }
      const next = typeof json.next_cursor === 'string' ? json.next_cursor : ''
      if (!next || next === cursor) break
      cursor = next
    }
    return {
      msgId,
      delivered: entries.filter((e) => e.status === 1).length,
      pending: entries.filter((e) => e.status === 0).length,
      failed: entries.filter((e) => e.status === 2 || e.status === 3).length,
      blockedByDailyCap: entries.filter((e) => e.status === 3).length,
      entries,
    }
  }

  /**
   * Per-member task status for a 群发 (doc 93338). status: 0=未发送 2=已发送.
   * Note a member showing 2 only means they confirmed — check
   * `getGroupMsgSendResult` to learn whether the group actually received it.
   */
  async getGroupMsgTask(msgId: string, cursor?: string): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { msgid: msgId, limit: 1000 }
    if (cursor) body.cursor = cursor
    return this.requireClient().post('/cgi-bin/externalcontact/get_groupmsg_task', body)
  }

  /**
   * Cancel a pending 群发 task.
   *
   * Verified against a live tenant: the endpoint is `cancel_groupmsg_send`
   * (not `stop_groupmsg_send`, which 404s). Afterwards `get_groupmsg_task`
   * reports `41093 group message canceled`, which callers should treat as
   * "gone", not as an error.
   */
  async cancelGroupMsgSend(msgId: string): Promise<{ ok: boolean }> {
    const json = await this.requireClient().post(
      '/cgi-bin/externalcontact/cancel_groupmsg_send',
      { msgid: msgId },
    )
    return { ok: Number(json.errcode ?? 0) === 0 }
  }

  /**
   * Re-trigger the confirmation prompt for a pending 群发 (doc 97610).
   * WeCom allows 3 reminders per task per 24h; callers must track their own
   * count as the API does not report remaining attempts.
   */
  async remindGroupMsgSend(msgId: string): Promise<{ ok: boolean }> {
    const json = await this.requireClient().post(
      '/cgi-bin/externalcontact/remind_groupmsg_send',
      { msgid: msgId },
    )
    return { ok: Number(json.errcode ?? 0) === 0 }
  }

  /**
   * Upload media and return its id, without sending. Group attachments
   * reference media by id, so this is the upload half of `sendFile`. WeCom
   * media ids are valid for 3 days.
   */
  async uploadMedia(
    type: 'file' | 'image' | 'video' | 'voice',
    fileName: string,
    bytes: Buffer,
  ): Promise<{ mediaId: string }> {
    const upload = await this.requireClient().postMultipart(
      `/cgi-bin/media/upload?type=${encodeURIComponent(type)}`,
      'media',
      fileName,
      bytes,
    )
    const mediaId = upload.media_id ? String(upload.media_id) : ''
    if (!mediaId) {
      throw new Error(`media/upload: no media_id (errcode=${String(upload.errcode ?? '')})`)
    }
    return { mediaId }
  }

  async verifyCallbackUrl(p: {
    msgSignature: string
    timestamp: string
    nonce: string
    echostr: string
  }): Promise<string> {
    if (!this.callbackToken || !this.encodingAesKey) {
      throw new Error('wecomapp: callbackToken/encodingAesKey not configured')
    }
    return verifyUrl({
      token: this.callbackToken,
      encodingAesKey: this.encodingAesKey,
      msgSignature: p.msgSignature,
      timestamp: p.timestamp,
      nonce: p.nonce,
      echostr: p.echostr,
    })
  }

  async parseInboundCallback(p: {
    msgSignature: string
    timestamp: string
    nonce: string
    body: string
  }): Promise<InboundMessage[]> {
    if (!this.callbackToken || !this.encodingAesKey) {
      throw new Error('wecomapp: callbackToken/encodingAesKey not configured')
    }
    const encrypt = extractEncrypt(p.body)
    if (!encrypt) throw new Error('wecomapp: no <Encrypt> in callback body')
    if (!verifySignature(this.callbackToken, p.timestamp, p.nonce, encrypt, p.msgSignature)) {
      throw new Error('wecomapp: callback signature mismatch')
    }
    const { message } = decrypt(this.encodingAesKey, encrypt)
    const msgType = readXmlField(message, 'MsgType')
    const from = readXmlField(message, 'FromUserName')
    const createTime = Number(readXmlField(message, 'CreateTime') || '0')
    const msgId = readXmlField(message, 'MsgId') || `${from}-${createTime}`
    const receivedAt = createTime ? createTime * 1000 : Date.now()

    if (msgType === 'text') {
      return [
        {
          id: msgId,
          from,
          type: 'text',
          text: readXmlField(message, 'Content'),
          receivedAt,
        },
      ]
    }
    if (msgType === 'file') {
      return [
        {
          id: msgId,
          from,
          type: 'file',
          mediaId: readXmlField(message, 'MediaId'),
          fileName: readXmlField(message, 'FileName') || undefined,
          receivedAt,
        },
      ]
    }
    if (msgType === 'image') {
      return [
        {
          id: msgId,
          from,
          type: 'image',
          mediaId: readXmlField(message, 'MediaId'),
          receivedAt,
        },
      ]
    }
    // Non-message events (subscribe, etc.) — surface as 'other' so the
    // agent can see something arrived without us modelling every event.
    return [{ id: msgId, from, type: 'other', text: msgType, receivedAt }]
  }
}

registerCorpApp('wecomapp', () => new WeComAppConnector())
