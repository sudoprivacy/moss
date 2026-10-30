/** Trusted boundary between authenticated Moss sessions and browser workers.
 *
 * Raw Chrome/extension endpoints are never returned to callers. Workers receive
 * identities from this gateway, and have distinct host and AI credentials.
 */
import { createHash } from 'node:crypto'
import { HttpError } from '../httpError.js'
import { connectWorkerWindowStream } from './browserWindowStream.js'
import type WebSocket from 'ws'

export interface BrowserPrincipal { orgId: string; userId: string }
export interface BrowserBinding extends BrowserPrincipal { sessionId: string }
/** Host-owned navigation credential. Never accept this object from HTTP or MCP. */
export interface AuthorizedBrowserPage {
  url: string
  cookie: { name: string; value: string; url: string; path: string; httpOnly: true; sameSite: 'Strict'; expires: number }
  revoke(): void
}
export interface BrowserEpochs { controlEpoch: number; targetEpoch: number }
export interface BrowserWorkerPort {
  invoke(binding: BrowserBinding, controller: string, action: Record<string, unknown>): Promise<unknown>
  openAuthorizedPage?(binding: BrowserBinding, controller: string, page: AuthorizedBrowserPage, epochs: BrowserEpochs): Promise<unknown>
  upload?(binding: BrowserBinding, controller: string, name: string, data: Uint8Array, epochs: { controlEpoch: number; targetEpoch: number }): Promise<unknown>
  download?(binding: BrowserBinding, controller: string, fileId: string): Promise<Uint8Array>
}
type BrowserRequest = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const actionFields: Record<string, string[]> = {
  state: [], attach: ['viewerId', 'surface'], detach: ['viewerId'],
  start: ['isHeadless', 'transport'],
  stop: ['controlEpoch', 'targetEpoch'],
  restart: ['controlEpoch', 'targetEpoch', 'isHeadless', 'transport', 'acknowledgeStateLoss'],
  frame: ['viewerId', 'controlEpoch', 'targetEpoch', 'surface'],
  'window-stream': ['viewerId', 'controlEpoch', 'targetEpoch'],
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
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'invalid_browser_action')
  const body = input as Record<string, unknown>
  if (typeof body.kind !== 'string' || !Object.hasOwn(actionFields, body.kind)) throw new HttpError(400, 'invalid_browser_action')
  const action: Record<string, unknown> = { kind: body.kind }
  for (const key of actionFields[body.kind]!) {
    if (key in body) action[key] = body[key]
  }
  if (actionFields[body.kind]!.includes('controlEpoch')) {
    for (const key of ['controlEpoch', 'targetEpoch']) {
      if (!Number.isSafeInteger(action[key]) || (action[key] as number) < 0) throw new HttpError(400, 'invalid_browser_epoch')
    }
  }
  if (actionFields[body.kind]!.includes('viewerId') &&
    (typeof action.viewerId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(action.viewerId))) {
    throw new HttpError(400, 'invalid_browser_viewer')
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
  const result = await deps.worker.invoke(binding, browserController(principal), browserAction(body))
  if (result && typeof result === 'object' && 'session' in result) {
    const reply = result as { session: { capabilities?: Record<string, unknown> } }
    if (reply.session?.capabilities) return { ...reply, session: { ...reply.session, capabilities: { ...reply.session.capabilities, conversationControl: true } } }
  }
  return result
}

export async function authorizeSessionBrowser(
  deps: { getSession: (id: string) => Promise<BrowserBinding | null>; isUserActive: (principal: BrowserPrincipal) => Promise<boolean> },
  principal: BrowserPrincipal, sessionId: string,
): Promise<BrowserBinding> {
  const session = await deps.getSession(sessionId)
  if (!session) throw new HttpError(404, 'session_not_found')
  // Browser cookies/profile remain personal even when a manager may inspect a
  // conversation. Check current authorization on every frame and input call.
  if (session.orgId !== principal.orgId || session.userId !== principal.userId || !(await deps.isUserActive(principal))) {
    throw new HttpError(403, 'session_forbidden')
  }
  const binding = { orgId: session.orgId, userId: session.userId, sessionId: session.sessionId }
  return binding
}

/** Trusted review composition only; the ordinary browser action parser excludes it. */
export async function openSessionAuthorizedPage(
  deps: {
    getSession: (id: string) => Promise<BrowserBinding | null>
    isUserActive: (principal: BrowserPrincipal) => Promise<boolean>
    worker: BrowserWorkerPort
  },
  principal: BrowserPrincipal, sessionId: string, page: AuthorizedBrowserPage, epochs: BrowserEpochs,
): Promise<unknown> {
  try {
    const binding = await authorizeSessionBrowser(deps, principal, sessionId)
    if (!deps.worker.openAuthorizedPage) throw new HttpError(409, 'browser_authorized_page_not_supported')
    const result = await deps.worker.openAuthorizedPage(binding, browserController(principal), page, epochs)
    const current = await authorizeSessionBrowser(deps, principal, sessionId)
    if (JSON.stringify(current) !== JSON.stringify(binding)) throw new HttpError(403, 'session_forbidden')
    return result
  } catch (error) {
    // An uncertain navigation is not replayed. Revoke just this review grant;
    // the shared browser, its profile and other tabs retain their ownership.
    page.revoke()
    throw error
  }
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
      throw new HttpError(503, 'browser_connection_unavailable')
    }
    if (!response.ok) {
      let code = 'browser_operation_failed'
      const value = await response.json().catch(() => null) as { error?: unknown } | null
      if (typeof value?.error === 'string' && /^[a-z_]{1,80}$/.test(value.error)) code = value.error
      throw new HttpError([400, 403, 409, 503].includes(response.status) ? response.status : 502, code)
    }
    return response.json()
  }

  async openAuthorizedPage(binding: BrowserBinding, controller: string, page: AuthorizedBrowserPage, epochs: BrowserEpochs): Promise<unknown> {
    return this.invoke(binding, controller, {
      kind: 'open-authorized-page', url: page.url, cookie: page.cookie,
      controlEpoch: epochs.controlEpoch, targetEpoch: epochs.targetEpoch,
    })
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
    }).catch(() => { throw new HttpError(503, 'browser_connection_unavailable') })
    if (response.status === 202) return null
    if (!response.ok) throw new HttpError(502, 'Managed browser MCP unavailable')
    return response.json()
  }

  openWindowStream(binding: BrowserBinding, controller: string, action: Record<string, unknown>): Promise<WebSocket> {
    return connectWorkerWindowStream(this.endpoint, this.token, binding, controller, action)
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
    } catch { throw new HttpError(503, 'browser_file_transfer_unavailable') }
    if (!response.ok) {
      const value = await response.json().catch(() => null) as { error?: unknown } | null
      const code = typeof value?.error === 'string' && /^[a-z_]{1,80}$/.test(value.error) ? value.error : 'browser_file_transfer_failed'
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
