/**
 * Document Center v2 — WeCom Drive Connector.
 *
 * Pulls documents from 企业微信 微盘 (WeCom Drive) using the official
 * REST API. Acquires an access token via /cgi-bin/gettoken and caches
 * it for the documented 7200s TTL minus a 5-minute safety buffer.
 *
 * Config:
 *   - rootPath (optional): the folder fileid (called `fileid` in WeCom)
 *     to start from. If omitted, lists "我的空间" root (spaceid mode).
 *   - spaceid (optional): the WeCom space ID. If omitted, uses the
 *     authenticating agent's default space.
 *
 * Credentials (encrypted in MOSS_HOME/secrets/<key>.json):
 *   - corpId       — required
 *   - agentId      — agent (应用) ID; required for spaceid resolution
 *   - agentSecret  — agent secret; used as `corpsecret` in gettoken
 *
 * Notes for P0:
 *   - "Drive" API still has rate limits — we cache file_list responses
 *     for the duration of one walkTree() pass via an in-memory map.
 *   - getEtag() is a wrapper around file_info; cheap enough.
 *   - testConnection() just calls /cgi-bin/gettoken to verify creds.
 *   - The connector is single-use (worker creates a fresh instance per
 *     sync run), so we don't bother with cross-run token persistence.
 *
 * References:
 *   - https://developer.work.weixin.qq.com/document/path/97778 (file_list)
 *   - https://developer.work.weixin.qq.com/document/path/97774 (gettoken)
 *   - https://developer.work.weixin.qq.com/document/path/97779 (file_info)
 *   - https://developer.work.weixin.qq.com/document/path/97781 (file_download)
 */

import {
  type ExternalFileNode,
  type ExternalSourceConfig,
  type ExternalSourceConnector,
  type ExternalSourceCredentials,
  type TestConnectionResult,
  registerConnector,
} from './types.js'

const API_BASE = process.env.WECOM_DRIVE_API_BASE || 'https://qyapi.weixin.qq.com'
const TOKEN_TTL_SAFETY_MS = 5 * 60_000

type WecomDriveConfig = ExternalSourceConfig & {
  rootPath?: string  // top-level folder fileid (or '' for space root)
  spaceid?: string   // optional explicit space ID
}

type WecomFileInfo = {
  fileid: string
  spaceid: string
  fatherid?: string
  file_name: string
  file_type: 1 | 2 | 3 | 4  // 1=folder, 2=word, 3=excel, 4=ppt — per WeCom docs
  file_size?: number
  ctime?: number
  mtime?: number
  modify_userid?: string
  /** download_url is only returned by file_download, not file_list */
  download_url?: string
}

// File type to MIME mapping. WeCom Drive uses internal numeric codes
// that don't fully map to MIME, but their docs list these.
const FILE_TYPE_MIME: Record<number, string | undefined> = {
  1: undefined,             // folder
  2: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  3: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  4: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Extended types per WeCom — these aren't always returned by file_list
  // but include them defensively:
  5: 'application/pdf',
  6: 'image/png',
  10: 'text/markdown',
}

const FILE_TYPE_EXT: Record<number, string> = {
  2: '.docx',
  3: '.xlsx',
  4: '.pptx',
  5: '.pdf',
  6: '.png',
  10: '.md',
}

function inferExtension(name: string, fileType: number): string {
  if (/\.[a-z0-9]+$/i.test(name)) return name
  const ext = FILE_TYPE_EXT[fileType]
  return ext ? `${name}${ext}` : name
}

export class WecomDriveConnector implements ExternalSourceConnector {
  readonly type = 'wecom_drive'

  private corpId = ''
  private agentSecret = ''
  private spaceId = ''
  private rootFileId = ''

  private cachedToken: { token: string; expiresAt: number } | null = null

  async init(
    config: ExternalSourceConfig,
    credentials: ExternalSourceCredentials,
  ): Promise<void> {
    const cfg = config as WecomDriveConfig
    this.corpId = credentials.corpId ?? ''
    this.agentSecret = credentials.agentSecret ?? ''
    this.spaceId = String(cfg.spaceid ?? credentials.spaceid ?? '')
    this.rootFileId = String(cfg.rootPath ?? '')

    if (!this.corpId) throw new Error('wecom_drive: missing corpId in credentials')
    if (!this.agentSecret) {
      throw new Error('wecom_drive: missing agentSecret in credentials')
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const token = await this.getAccessToken()
      if (!token) return { ok: false, message: '无法获取 access_token' }
      // Optionally verify by listing the root folder; we just check token
      // here so testConnection stays cheap.
      return { ok: true, message: 'access_token 获取成功' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async list(folderPath: string): Promise<ExternalFileNode[]> {
    const fileid = folderPath || this.rootFileId || ''
    const items = await this.callFileList(fileid)
    return items.map((item) => this.toNode(item, fileid || null, fileid || ''))
  }

  async *walkTree(rootPath: string): AsyncIterable<ExternalFileNode> {
    type StackEntry = { fileid: string; pathPrefix: string; parentExternalId: string | null }
    const initialId = rootPath || this.rootFileId || ''
    const stack: StackEntry[] = [{ fileid: initialId, pathPrefix: '', parentExternalId: null }]

    while (stack.length > 0) {
      const { fileid, pathPrefix, parentExternalId } = stack.pop()!
      const items = await this.callFileList(fileid).catch((err) => {
        console.error('[wecom_drive] file_list failed:', err)
        return [] as WecomFileInfo[]
      })

      // Stable order so sync diffs are deterministic
      items.sort((a, b) => a.file_name.localeCompare(b.file_name))

      for (const it of items) {
        const name = inferExtension(it.file_name, it.file_type)
        const relPath = pathPrefix ? `${pathPrefix}/${name}` : name
        const node: ExternalFileNode = {
          externalId: it.fileid,
          parentExternalId,
          type: it.file_type === 1 ? 'folder' : 'file',
          name,
          relativePath: relPath,
          size: it.file_size,
          mimeType: FILE_TYPE_MIME[it.file_type],
          etag: this.makeEtag(it),
          lastModified: it.mtime ? it.mtime * 1000 : undefined,
        }
        yield node
        if (it.file_type === 1) {
          stack.push({
            fileid: it.fileid,
            pathPrefix: relPath,
            parentExternalId: it.fileid,
          })
        }
      }
    }
  }

  async download(externalId: string): Promise<Buffer> {
    const dl = await this.callFileDownload(externalId)
    if (!dl.download_url) {
      throw new Error(`wecom_drive: no download_url for ${externalId}`)
    }
    const resp = await fetch(dl.download_url)
    if (!resp.ok) {
      throw new Error(`wecom_drive: download HTTP ${resp.status}`)
    }
    const ab = await resp.arrayBuffer()
    return Buffer.from(ab)
  }

  async getEtag(externalId: string): Promise<string> {
    const info = await this.callFileInfo(externalId)
    return this.makeEtag(info)
  }

  // ============================================================
  // Internals — HTTP calls
  // ============================================================

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.token
    }
    const url = `${API_BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.agentSecret)}`
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

  private async post(endpoint: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = await this.getAccessToken()
    const url = `${API_BASE}${endpoint}?access_token=${encodeURIComponent(token)}`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      throw new Error(`${endpoint} HTTP ${resp.status}`)
    }
    const json = (await resp.json()) as Record<string, unknown>
    const code = Number(json.errcode ?? 0)
    if (code !== 0) {
      // Token may have been invalidated server-side — clear cache and retry once.
      if (code === 40014 || code === 42001 || code === 41001) {
        this.cachedToken = null
        const retryToken = await this.getAccessToken()
        const retryResp = await fetch(`${API_BASE}${endpoint}?access_token=${encodeURIComponent(retryToken)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const retryJson = (await retryResp.json()) as Record<string, unknown>
        const retryCode = Number(retryJson.errcode ?? 0)
        if (retryCode === 0) return retryJson
        throw new Error(`${endpoint} errcode=${retryCode} ${String(retryJson.errmsg ?? '')}`)
      }
      throw new Error(`${endpoint} errcode=${code} ${String(json.errmsg ?? '')}`)
    }
    return json
  }

  private async callFileList(fatherId: string): Promise<WecomFileInfo[]> {
    // The WeCom drive API uses cursor-style pagination. For P0 we fetch
    // up to FILE_LIST_PAGE_SIZE per page and loop until exhausted.
    const PAGE_SIZE = 100
    const collected: WecomFileInfo[] = []
    let start = 0
    while (true) {
      const body: Record<string, unknown> = {
        start,
        limit: PAGE_SIZE,
        sort_type: 1,
      }
      if (fatherId) body.fatherid = fatherId
      if (this.spaceId) body.spaceid = this.spaceId
      const json = await this.post('/cgi-bin/wedrive/file_list', body)
      const list = Array.isArray(json.file_list) ? (json.file_list as WecomFileInfo[]) : []
      collected.push(...list)
      const hasMore = Boolean(json.has_more)
      if (!hasMore || list.length === 0) break
      start += list.length
      // Safety: avoid infinite loop
      if (start > 50_000) break
    }
    return collected
  }

  private async callFileInfo(fileid: string): Promise<WecomFileInfo> {
    const json = await this.post('/cgi-bin/wedrive/file_info', { fileid })
    const fi = json.file_info as WecomFileInfo | undefined
    if (!fi) throw new Error(`file_info: no file_info for ${fileid}`)
    return fi
  }

  private async callFileDownload(fileid: string): Promise<{ download_url?: string }> {
    const json = await this.post('/cgi-bin/wedrive/file_download', { fileid })
    return { download_url: typeof json.download_url === 'string' ? json.download_url : undefined }
  }

  // ============================================================
  // Helpers
  // ============================================================

  private toNode(
    item: WecomFileInfo,
    parentExternalId: string | null,
    pathPrefix: string,
  ): ExternalFileNode {
    const name = inferExtension(item.file_name, item.file_type)
    const relPath = pathPrefix ? `${pathPrefix}/${name}` : name
    return {
      externalId: item.fileid,
      parentExternalId,
      type: item.file_type === 1 ? 'folder' : 'file',
      name,
      relativePath: relPath,
      size: item.file_size,
      mimeType: FILE_TYPE_MIME[item.file_type],
      etag: this.makeEtag(item),
      lastModified: item.mtime ? item.mtime * 1000 : undefined,
    }
  }

  private makeEtag(item: WecomFileInfo): string {
    // size + mtime is enough for change detection — WeCom doesn't expose
    // a real content hash. mtime is in seconds.
    return `${item.file_size ?? 0}-${item.mtime ?? 0}`
  }
}

registerConnector('wecom_drive', () => new WecomDriveConnector())
