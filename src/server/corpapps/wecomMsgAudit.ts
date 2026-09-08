/**
 * 企微会话内容存档 (WeCom 会话存档) — event-callback connector.
 *
 * 会话存档 is a CORP-LEVEL paid service, not an application: it has its
 * own Secret (issued in 管理后台 → 安全与管理 → 会话内容存档, distinct from
 * any app's corpsecret) and no AgentId. It is therefore registered as its
 * own corp-app type rather than as extra capabilities on 'wecomapp'.
 *
 * SCOPE — this connector spans both halves:
 *
 *   企微 → moss   事件回调 (this file): 成员同意/取消存档, 外部联系人授权变更.
 *                 Plain WXBizMsgCrypt over HTTP, same framing as a
 *                 self-built app, so it reuses wecomCallbackCrypto.ts and
 *                 the shared /api/v1/corp-apps/callback/:id listener —
 *                 registering an instance yields a callback URL with no
 *                 new route.
 *
 *   moss → 企微   聊天记录 (msgaudit/): records are PULLED via
 *                 libWeWorkFinanceSdk (native .so, linux-x86_64 only) and
 *                 decrypted with an RSA private key selected by each
 *                 record's `publickey_ver`. Credentials live here; the
 *                 pull pipeline and JSONL archive live under msgaudit/.
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
import { parsePrivateKeys } from './msgaudit/crypto.js'
import type { PullConfig } from './msgaudit/puller.js'
import { extractEncrypt, decrypt, readXmlField, verifyUrl } from './wecomCallbackCrypto.js'

export class WeComMsgAuditConnector implements CorpAppConnector {
  readonly type = 'wecommsgaudit'

  readonly capabilities = ['receive', 'pullChatData']

  private corpId = ''
  private callbackToken = ''
  private encodingAesKey = ''
  /** 会话存档-specific Secret; cannot mint an app access_token. */
  private secret = ''
  /** publickey_ver -> PEM, JSON-encoded (secret store holds strings only). */
  private privateKeysRaw = ''

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
    this.secret = credentials.secret ?? ''
    this.privateKeysRaw = credentials.privateKeys ?? ''
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
    const missing: string[] = []
    if (!this.callbackToken || !this.encodingAesKey) missing.push('事件回调 Token/EncodingAESKey')
    if (!this.secret) missing.push('会话存档 Secret')
    if (!this.privateKeysRaw) missing.push('RSA 私钥')
    if (missing.length === 3) return { ok: false, message: `未配置：${missing.join('、')}` }
    if (missing.length > 0) {
      // Partial config is a legitimate intermediate state: callback-only
      // (to pass the console's URL check) and pull-only are both usable.
      return { ok: true, message: `已配置，但缺少：${missing.join('、')}` }
    }
    // Key material is validated here rather than at first pull, so a
    // malformed PEM surfaces in the admin UI instead of in a worker log.
    const keys = parsePrivateKeys(this.privateKeysRaw)
    if (Object.keys(keys).length === 0) {
      return { ok: false, message: 'RSA 私钥无法解析（应为 PEM，或 {"版本号": "PEM"} 的 JSON）' }
    }
    return { ok: true, message: `回调与拉取凭据齐备，私钥版本：${Object.keys(keys).sort().join(', ')}` }
  }

  /** Config for the pull worker; null when this instance cannot pull. */
  pullConfig(corpAppId: string): PullConfig | null {
    if (!this.secret || !this.privateKeysRaw) return null
    return {
      corpAppId,
      corpId: this.corpId,
      secret: this.secret,
      privateKeysRaw: this.privateKeysRaw,
    }
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
