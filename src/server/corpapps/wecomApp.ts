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
 * Capabilities: send (text), sendFile, receive (callback), info.
 */

import {
  type ApprovalListParams,
  type CorpAppConfig,
  type CorpAppConnector,
  type CorpAppCredentials,
  type CorpAppInfo,
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

export class WeComAppConnector implements CorpAppConnector {
  readonly type = 'wecomapp'
  readonly capabilities = [
    'send',
    'sendFile',
    'receive',
    'info',
    'downloadMedia',
    'listApprovals',
    'getApproval',
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

  async sendMessage(to: string, text: string): Promise<{ ok: boolean; msgId?: string }> {
    const json = await this.requireClient().post('/cgi-bin/message/send', {
      touser: to,
      msgtype: 'text',
      agentid: Number(this.agentId),
      text: { content: text },
    })
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
