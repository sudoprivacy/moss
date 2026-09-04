/**
 * Shared WeCom REST client.
 *
 * Wraps the 企业微信 server API (qyapi.weixin.qq.com): acquires an
 * access_token via /cgi-bin/gettoken and caches it for the documented
 * 7200s TTL minus a safety buffer, transparently retrying once on the
 * "token invalid/expired" errcodes.
 *
 * The token + retry logic mirrors sources/wecomDrive.ts; it is extracted
 * here because the WeComApp corp-app connector needs the same behaviour
 * plus multipart media upload. wecomDrive.ts is intentionally left
 * untouched.
 *
 * References:
 *   - https://developer.work.weixin.qq.com/document/path/91039 (gettoken)
 *   - https://developer.work.weixin.qq.com/document/path/90253 (media/upload)
 *   - https://developer.work.weixin.qq.com/document/path/90236 (message/send)
 */

const API_BASE = process.env.WECOM_API_BASE || 'https://qyapi.weixin.qq.com'
const TOKEN_TTL_SAFETY_MS = 5 * 60_000

/** errcodes that mean "token is no longer valid" — clear cache + retry. */
const TOKEN_INVALID_CODES = new Set([40014, 42001, 41001])

export class WeComApiClient {
  private cachedToken: { token: string; expiresAt: number } | null = null

  /**
   * @param corpId WeCom corp ID (used as `corpid` in gettoken)
   * @param secret app secret (used as `corpsecret` in gettoken)
   */
  constructor(
    private readonly corpId: string,
    private readonly secret: string,
  ) {}

  /** Acquire a cached access_token, refreshing when expired. */
  async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.token
    }
    const url = `${API_BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(
      this.corpId,
    )}&corpsecret=${encodeURIComponent(this.secret)}`
    const resp = await fetch(url)
    if (!resp.ok) {
      throw new Error(`gettoken HTTP ${resp.status}`)
    }
    const json = (await resp.json()) as {
      errcode?: number
      errmsg?: string
      access_token?: string
      expires_in?: number
    }
    if (json.errcode && json.errcode !== 0) {
      throw new Error(`gettoken errcode=${json.errcode} ${json.errmsg ?? ''}`)
    }
    if (!json.access_token) {
      throw new Error('gettoken: no access_token in response')
    }
    const ttlMs = (json.expires_in ?? 7200) * 1000
    this.cachedToken = {
      token: json.access_token,
      expiresAt: Date.now() + ttlMs - TOKEN_TTL_SAFETY_MS,
    }
    return json.access_token
  }

  /**
   * POST a JSON body to a WeCom endpoint with the access_token appended
   * as a query param. Retries once (with a fresh token) when WeCom
   * reports the token is invalid/expired.
   */
  async post(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const send = async (token: string) => {
      const url = `${API_BASE}${endpoint}${endpoint.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        throw new Error(`${endpoint} HTTP ${resp.status}`)
      }
      return (await resp.json()) as Record<string, unknown>
    }

    const token = await this.getAccessToken()
    const json = await send(token)
    const code = Number(json.errcode ?? 0)
    if (code === 0) return json

    if (TOKEN_INVALID_CODES.has(code)) {
      this.cachedToken = null
      const retryToken = await this.getAccessToken()
      const retryJson = await send(retryToken)
      const retryCode = Number(retryJson.errcode ?? 0)
      if (retryCode === 0) return retryJson
      throw new Error(`${endpoint} errcode=${retryCode} ${String(retryJson.errmsg ?? '')}`)
    }
    throw new Error(`${endpoint} errcode=${code} ${String(json.errmsg ?? '')}`)
  }

  /**
   * GET a JSON endpoint with the access_token appended. Mirrors `post`'s
   * token-refresh retry. Most WeCom APIs are POST; a few (appchat/get,
   * agent/get) are GET and would otherwise have to be faked with an empty
   * POST body, which those endpoints reject.
   */
  async get(endpoint: string): Promise<Record<string, unknown>> {
    const send = async (token: string) => {
      const url = `${API_BASE}${endpoint}${endpoint.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
      const resp = await fetch(url)
      if (!resp.ok) {
        throw new Error(`${endpoint} HTTP ${resp.status}`)
      }
      return (await resp.json()) as Record<string, unknown>
    }

    const token = await this.getAccessToken()
    const json = await send(token)
    const code = Number(json.errcode ?? 0)
    if (code === 0) return json

    if (TOKEN_INVALID_CODES.has(code)) {
      this.cachedToken = null
      const retryJson = await send(await this.getAccessToken())
      const retryCode = Number(retryJson.errcode ?? 0)
      if (retryCode === 0) return retryJson
      throw new Error(`${endpoint} errcode=${retryCode} ${String(retryJson.errmsg ?? '')}`)
    }
    throw new Error(`${endpoint} errcode=${code} ${String(json.errmsg ?? '')}`)
  }

  /**
   * GET binary content from a WeCom endpoint with the access_token
   * appended (e.g. /cgi-bin/media/get?media_id=...). Returns the raw
   * bytes plus the server-provided filename (from Content-Disposition,
   * when present). Retries once on an invalid token.
   *
   * WeCom signals errors here with a JSON body (errcode != 0) and a
   * `application/json` content-type instead of the binary stream.
   */
  async getBytes(
    endpoint: string,
  ): Promise<{ bytes: Buffer; fileName?: string; contentType?: string }> {
    const send = async (token: string) => {
      const url = `${API_BASE}${endpoint}${endpoint.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`${endpoint} HTTP ${resp.status}`)
      const ct = resp.headers.get('content-type') ?? ''
      const buf = Buffer.from(await resp.arrayBuffer())
      // Error responses come back as JSON, not the media stream.
      if (ct.includes('application/json')) {
        let json: Record<string, unknown> = {}
        try {
          json = JSON.parse(buf.toString('utf8')) as Record<string, unknown>
        } catch {
          // fall through; treat as opaque error
        }
        return { error: json, bytes: buf, ct, resp }
      }
      const disp = resp.headers.get('content-disposition') ?? ''
      const m = disp.match(/filename="?([^"]+)"?/i)
      return {
        error: null as Record<string, unknown> | null,
        bytes: buf,
        ct,
        fileName: m ? decodeURIComponent(m[1]) : undefined,
        resp,
      }
    }

    const token = await this.getAccessToken()
    let r = await send(token)
    if (r.error) {
      const code = Number(r.error.errcode ?? 0)
      if (TOKEN_INVALID_CODES.has(code)) {
        this.cachedToken = null
        r = await send(await this.getAccessToken())
      }
      if (r.error) {
        throw new Error(`${endpoint} errcode=${Number(r.error.errcode ?? 0)} ${String(r.error.errmsg ?? '')}`)
      }
    }
    return { bytes: r.bytes, fileName: r.fileName, contentType: r.ct }
  }

  /**
   * Upload bytes via a multipart/form-data POST (e.g.
   * /cgi-bin/media/upload?type=file). Returns the parsed JSON, which for
   * media/upload includes `media_id`. Retries once on an invalid token.
   *
   * The body is hand-assembled (rather than via `FormData` + `fetch`)
   * because WeCom's media/upload returned `errcode=44001 empty media
   * data` against undici's FormData serialisation — likely a strict-
   * parser quirk. This mirrors what `curl --form` produces, which the
   * WeCom curl examples document as the canonical client.
   */
  async postMultipart(
    endpoint: string,
    fieldName: string,
    fileName: string,
    bytes: Buffer,
    contentType = 'application/octet-stream',
  ): Promise<Record<string, unknown>> {
    const send = async (token: string) => {
      const url = `${API_BASE}${endpoint}${endpoint.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
      const boundary = `----WeComBoundary${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
      const safeName = fileName.replace(/[\r\n"]/g, '_')
      const head = Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${fieldName}"; filename="${safeName}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
        'utf8',
      )
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
      const body = Buffer.concat([head, bytes, tail])
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      })
      if (!resp.ok) {
        throw new Error(`${endpoint} HTTP ${resp.status}`)
      }
      return (await resp.json()) as Record<string, unknown>
    }

    const token = await this.getAccessToken()
    const json = await send(token)
    const code = Number(json.errcode ?? 0)
    if (code === 0) return json

    if (TOKEN_INVALID_CODES.has(code)) {
      this.cachedToken = null
      const retryToken = await this.getAccessToken()
      const retryJson = await send(retryToken)
      const retryCode = Number(retryJson.errcode ?? 0)
      if (retryCode === 0) return retryJson
      throw new Error(`${endpoint} errcode=${retryCode} ${String(retryJson.errmsg ?? '')}`)
    }
    throw new Error(`${endpoint} errcode=${code} ${String(json.errmsg ?? '')}`)
  }
}
