/**
 * 企微会话内容存档 (WeCom 会话存档) — event-callback connector.
 *
 * 会话存档 is a CORP-LEVEL paid service, not an application: it has its
 * own Secret (issued in 管理后台 → 安全与管理 → 会话内容存档, distinct from
 * any app's corpsecret) and no AgentId. It is therefore registered as its
 * own corp-app type rather than as extra capabilities on 'wecomapp'.
 *
 * SCOPE — this connector implements ONLY the event-callback half:
 *
 *   企微 → moss   事件回调 (this file): 成员同意/取消存档, 外部联系人授权变更.
 *                 Plain WXBizMsgCrypt over HTTP, same framing as a
 *                 self-built app, so it reuses wecomCallbackCrypto.ts and
 *                 the shared /api/v1/corp-apps/callback/:id listener —
 *                 registering an instance yields a callback URL with no
 *                 new route.
 *
 *   moss → 企微   聊天记录 (NOT here): chat records are PULLED via
 *                 libWeWorkFinanceSdk (native .so, linux-x86_64 only) and
 *                 decrypted with an RSA private key selected by each
 *                 record's `publickey_ver`. That needs a sidecar and is
 *                 deliberately out of scope for this file.
 *
 * Configuring the service in the WeCom console requires a working event
 * URL that passes the GET handshake, but the events themselves are only
 * useful for archive-coverage monitoring — content analysis does not need
 * them (getchatdata already returns only consenting members' messages).
 * So inbound events are decrypted and surfaced as 'other', never dropped
 * silently, but nothing here depends on them.
 */

import type {
  CorpAppConfig,
  CorpAppConnector,
  CorpAppCredentials,
  CorpAppInfo,
  InboundMessage,
  TestConnectionResult,
} from './types.js'
import { registerCorpApp } from './types.js'
import { extractEncrypt, decrypt, readXmlField, verifyUrl } from './wecomCallbackCrypto.js'

export class WeComMsgAuditConnector implements CorpAppConnector {
  readonly type = 'wecommsgaudit'

  /**
   * Event callback only. Chat-record pulling ('listChatData' /
   * 'decryptChatData') is intentionally absent until the SDK sidecar
   * lands — the agent API returns 501 for undeclared capabilities.
   */
  readonly capabilities = ['receive']

  private corpId = ''
  private callbackToken = ''
  private encodingAesKey = ''

  /**
   * 会话存档 has no AgentId, so the instance key is the corpId alone. The
   * unique index is (org_id, type, app_key), so this never collides with a
   * 'wecomapp' row for the same corp.
   */
  keyOf(config: CorpAppConfig): string {
    return String(config.corpId ?? '')
  }

  /**
   * Only corpId is structurally required. Token/EncodingAESKey are needed
   * for the callback, but are checked at callback time rather than here so
   * an instance can be created before the console config is finished.
   */
  async init(config: CorpAppConfig, credentials: CorpAppCredentials): Promise<void> {
    this.corpId = String(config.corpId ?? '')
    this.callbackToken = credentials.callbackToken ?? ''
    this.encodingAesKey = credentials.encodingAesKey ?? ''
    if (!this.corpId) throw new Error('wecommsgaudit: missing corpId')
  }

  /**
   * There is nothing cheap to call: the 会话存档 Secret cannot mint an app
   * access_token, and every record API lives in the native SDK. So this
   * reports whether the callback credentials are present — which is what
   * the admin can actually act on — instead of failing on an app-token
   * check that will never succeed for this service.
   */
  async testConnection(): Promise<TestConnectionResult> {
    if (!this.callbackToken || !this.encodingAesKey) {
      return { ok: false, message: '缺少事件回调 Token / EncodingAESKey，无法通过企微 URL 验证' }
    }
    return { ok: true, message: '回调凭据已配置，可在企微后台完成 URL 验证' }
  }

  async getInfo(): Promise<CorpAppInfo> {
    return { type: this.type, key: this.corpId, identity: { corpId: this.corpId } }
  }

  /** GET handshake — same WXBizMsgCrypt framing as a self-built app. */
  async verifyCallbackUrl(p: {
    msgSignature: string
    timestamp: string
    nonce: string
    echostr: string
  }): Promise<string> {
    this.requireCallbackCreds()
    return verifyUrl({
      token: this.callbackToken,
      encodingAesKey: this.encodingAesKey,
      msgSignature: p.msgSignature,
      timestamp: p.timestamp,
      nonce: p.nonce,
      echostr: p.echostr,
    })
  }

  /**
   * Decrypt an inbound archive event. These carry no chat content — only
   * consent/authorization changes — so they are surfaced uniformly as
   * 'other' with the event name as text, enough for coverage monitoring
   * without modelling a schema nothing reads yet.
   */
  async parseInboundCallback(p: {
    msgSignature: string
    timestamp: string
    nonce: string
    body: string
  }): Promise<InboundMessage[]> {
    this.requireCallbackCreds()
    const encrypt = extractEncrypt(p.body)
    if (!encrypt) return []
    const { message } = decrypt(this.encodingAesKey, encrypt)

    const receivedAt = Number(readXmlField(message, 'CreateTime')) * 1000 || Date.now()
    const event = readXmlField(message, 'Event')
    const changeType = readXmlField(message, 'ChangeType')
    const from = readXmlField(message, 'FromUserName') || this.corpId

    return [
      {
        id: `${event || 'event'}:${receivedAt}`,
        from,
        type: 'other',
        text: changeType ? `${event}:${changeType}` : event,
        receivedAt,
      },
    ]
  }

  private requireCallbackCreds(): void {
    if (!this.callbackToken || !this.encodingAesKey) {
      throw new Error('wecommsgaudit: missing callbackToken / encodingAesKey')
    }
  }
}

registerCorpApp('wecommsgaudit', () => new WeComMsgAuditConnector())
