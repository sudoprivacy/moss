/** Trusted boundary between authenticated Moss sessions and browser workers.
 *
 * Raw Chrome/extension endpoints are never returned to callers. Workers receive
 * identities from this gateway, and have distinct host and AI credentials.
 */
import { createHash } from 'node:crypto'
import { HttpError } from '../httpError.js'

export interface BrowserPrincipal { orgId: string; userId: string }
export interface BrowserBinding extends BrowserPrincipal { sessionId: string }
export interface BrowserWorkerPort {
  invoke(binding: BrowserBinding, controller: string, action: Record<string, unknown>): Promise<unknown>
  upload?(binding: BrowserBinding, controller: string, name: string, data: Uint8Array, epochs: { controlEpoch: number; targetEpoch: number }): Promise<unknown>
  download?(binding: BrowserBinding, controller: string, fileId: string): Promise<Uint8Array>
}
type BrowserRequest = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
const JPEG_START_OF_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** Add the native screenshot coordinate space before a managed-worker image. */
export function addBrowserFrameCoordinateHint(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const result = (value as { result?: unknown }).result
  if (!result || typeof result !== 'object') return value
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return value
  if (content.some(block => block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' && (block as { text: string }).text.includes('browserInputCoordinates'))) return value
  const imageIndex = content.findIndex(
    block => block && typeof block === 'object' && (block as { type?: unknown }).type === 'image' && (block as { mimeType?: unknown }).mimeType === 'image/jpeg' && typeof (block as { data?: unknown }).data === 'string',
  )
  if (imageIndex < 0) return value
  const dimensions = readJpegDimensions((content[imageIndex] as { data: string }).data)
  if (!dimensions) return value
  const hint = {
    type: 'text',
    text: JSON.stringify({
      screenshotPixelDimensions: dimensions,
      browserInputCoordinates: {
        unit: 'css-pixel',
        instruction:
          'Do not pass raw screenshot pixel positions to browser_action. First call browser_action command with method Runtime.evaluate and paramsJson {"expression":"({width:innerWidth,height:innerHeight,devicePixelRatio})","returnByValue":true}; divide screenshot x and y by the returned devicePixelRatio before clicking or scrolling.',
      },
    }),
  }
  return {
    ...value,
    result: {
      ...result,
      content: [...content.slice(0, imageIndex), hint, ...content.slice(imageIndex)],
    },
  }
}

function readJpegDimensions(data: string): { width: number; height: number } | undefined {
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length < 10 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let offset = 2
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 1 >= bytes.length) break
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) break
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      const height = bytes.readUInt16BE(offset + 3)
      const width = bytes.readUInt16BE(offset + 5)
      if (width > 0 && height > 0) return { width, height }
      return undefined
    }
    offset += length
  }
  return undefined
}

const actionFields: Record<string, string[]> = {
  state: [], attach: ['viewerId', 'surface'], detach: ['viewerId'],
  start: ['isHeadless', 'transport'],
  stop: ['controlEpoch', 'targetEpoch'],
  restart: ['controlEpoch', 'targetEpoch', 'isHeadless', 'transport', 'acknowledgeStateLoss'],
  frame: ['viewerId', 'controlEpoch', 'targetEpoch', 'surface'],
  take: ['controlEpoch', 'targetEpoch'], return: ['controlEpoch', 'targetEpoch', 'note'],
  input: ['controlEpoch', 'targetEpoch', 'input', 'surface'], navigate: ['controlEpoch', 'targetEpoch', 'url'],
  back: ['controlEpoch', 'targetEpoch'], forward: ['controlEpoch', 'targetEpoch'],
  reload: ['controlEpoch', 'targetEpoch'], 'new-tab': ['controlEpoch', 'targetEpoch'],
  'select-tab': ['controlEpoch', 'targetEpoch', 'targetId'],
  'close-tab': ['controlEpoch', 'targetEpoch', 'targetId'],
  'upload-files': ['controlEpoch', 'targetEpoch', 'chooserId', 'fileIds'],
}

/** Callers cannot supply actor roles, user IDs, profile paths or raw endpoints. */
export function browserAction(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Invalid browser action')
  const body = input as Record<string, unknown>
  if (typeof body.kind !== 'string' || !Object.hasOwn(actionFields, body.kind)) throw new HttpError(400, 'Invalid browser action')
  const action: Record<string, unknown> = { kind: body.kind }
  for (const key of actionFields[body.kind]!) {
    if (key in body) action[key] = body[key]
  }
  if (actionFields[body.kind]!.includes('controlEpoch')) {
    for (const key of ['controlEpoch', 'targetEpoch']) {
      if (!Number.isSafeInteger(action[key]) || (action[key] as number) < 0) throw new HttpError(400, 'Invalid browser epoch')
    }
  }
  if (actionFields[body.kind]!.includes('viewerId') &&
    (typeof action.viewerId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(action.viewerId))) {
    throw new HttpError(400, 'Invalid browser viewer')
  }
  return action
}

export function browserController(principal: BrowserPrincipal): string {
  return 'user-' + createHash('sha256').update(JSON.stringify([principal.orgId, principal.userId])).digest('hex')
}

export async function invokeSessionBrowser(
  deps: {
    getSession: (id: string) => Promise<BrowserBinding | null>
    isUserActive: (principal: BrowserPrincipal) => Promise<boolean>
    worker: BrowserWorkerPort
  },
  principal: BrowserPrincipal,
  sessionId: string,
  body: unknown,
): Promise<unknown> {
  const binding = await authorizeSessionBrowser(deps, principal, sessionId)
  return deps.worker.invoke(binding, browserController(principal), browserAction(body))
}

export async function authorizeSessionBrowser(
  deps: { getSession: (id: string) => Promise<BrowserBinding | null>; isUserActive: (principal: BrowserPrincipal) => Promise<boolean> },
  principal: BrowserPrincipal, sessionId: string,
): Promise<BrowserBinding> {
  const session = await deps.getSession(sessionId)
  if (!session) throw new HttpError(404, 'Session not found')
  // Browser cookies/profile remain personal even when a manager may inspect a
  // conversation. Check current authorization on every frame and input call.
  if (session.orgId !== principal.orgId || session.userId !== principal.userId || !(await deps.isUserActive(principal))) {
    throw new HttpError(403, 'Forbidden')
  }
  const binding = { orgId: session.orgId, userId: session.userId, sessionId: session.sessionId }
  return binding
}

export class HttpBrowserWorker implements BrowserWorkerPort {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly request: BrowserRequest = fetch,
    private readonly aiToken?: string,
  ) {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid managed browser endpoint')
    }
    if (!token) throw new Error('Managed browser host credential is required')
  }

  async invoke(binding: BrowserBinding, controller: string, action: Record<string, unknown>): Promise<unknown> {
    let response: Response
    try {
      response = await this.request(new URL('invoke', this.endpoint.endsWith('/') ? this.endpoint : this.endpoint + '/'), {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ binding, controller, action }),
        signal: AbortSignal.timeout(action.kind === 'start' || action.kind === 'restart' ? 90_000 : 25_000),
      })
    } catch {
      // An uncertain input outcome must be observed, never retried here.
      throw new HttpError(503, 'Browser connection unavailable; input was not replayed')
    }
    if (!response.ok) {
      let code = 'Browser operation failed'
      const value = await response.json().catch(() => null) as { error?: unknown } | null
      if (typeof value?.error === 'string' && /^[a-z_]{1,80}$/.test(value.error)) code = value.error
      throw new HttpError([400, 403, 409, 503].includes(response.status) ? response.status : 502, code)
    }
    return response.json()
  }

  async mcp(binding: BrowserBinding, message: unknown): Promise<unknown | null> {
    if (!this.aiToken) throw new HttpError(503, 'Managed browser agent credential is required')
    // Bind using only host-verified identity. A shared fixture worker refuses a
    // different owner; a provisioner must route each owner to its own worker.
    await this.invoke(binding, browserController(binding), { kind: 'state' })
    const response = await this.request(new URL('mcp', this.endpoint.endsWith('/') ? this.endpoint : this.endpoint + '/'), {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.aiToken}`, 'X-Moss-Browser-Session': binding.sessionId },
      body: JSON.stringify(message), signal: AbortSignal.timeout(90_000),
    }).catch(() => { throw new HttpError(503, 'Browser connection unavailable; input was not replayed') })
    if (response.status === 202) return null
    if (!response.ok) throw new HttpError(502, 'Managed browser MCP unavailable')
    return addBrowserFrameCoordinateHint(await response.json())
  }

  private async transfer(path: string, context: Record<string, unknown>, data?: Uint8Array, name?: string): Promise<Response> {
    let response: Response
    try {
      response = await this.request(new URL(path, this.endpoint.endsWith('/') ? this.endpoint : this.endpoint + '/'), {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/octet-stream',
          'X-Moss-Browser-Context': encodeURIComponent(JSON.stringify(context)),
          ...(name === undefined ? {} : { 'X-Moss-Browser-File-Name': encodeURIComponent(name) }),
        },
        body: data ? new Uint8Array(data).buffer : undefined,
        signal: AbortSignal.timeout(90_000),
      })
    } catch { throw new HttpError(503, 'Browser file transfer unavailable; request was not replayed') }
    if (!response.ok) {
      const value = await response.json().catch(() => null) as { error?: unknown } | null
      const code = typeof value?.error === 'string' && /^[a-z_]{1,80}$/.test(value.error) ? value.error : 'Browser file transfer failed'
      throw new HttpError([400, 403, 409, 413, 503].includes(response.status) ? response.status : 502, code)
    }
    return response
  }

  async upload(binding: BrowserBinding, controller: string, name: string, data: Uint8Array, epochs: { controlEpoch: number; targetEpoch: number }): Promise<unknown> {
    if (data.byteLength > 16 * 1024 * 1024) throw new HttpError(413, 'browser_files_too_large')
    return (await this.transfer('files/receive', { binding, controller, ...epochs }, data, name)).json()
  }

  async download(binding: BrowserBinding, controller: string, fileId: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{32}$/.test(fileId)) throw new HttpError(400, 'browser_file_not_found')
    const response = await this.transfer('files/read', { binding, controller, fileId })
    const data = new Uint8Array(await response.arrayBuffer())
    if (data.byteLength > 16 * 1024 * 1024) throw new HttpError(413, 'browser_files_too_large')
    return data
  }
}
