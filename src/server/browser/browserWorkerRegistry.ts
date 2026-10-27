import { createHash, createHmac } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { HttpError } from '../httpError.js'
import { PerKeyMutex } from '../runtime/perKeyMutex.js'
import { runDocker } from '../runtime/dockerCommand.js'
import { HttpBrowserWorker, browserController, type BrowserBinding, type BrowserWorkerPort } from './browserGateway.js'
import browserTools from '../../../deploy/browser/mcp-tools.json' with { type: 'json' }
import { browserAllowedOwners, browserOwnerAllowed, browserOwnerImages, isDigestPinnedBrowserImage } from './browserDeploymentPolicy.js'
import { browserConversationGuidance, changeBrowserConversationControl } from './browserConversation.js'
import type WebSocket from 'ws'

type SessionLookup = (id: string) => Promise<(BrowserBinding & { desiredState: string }) | null>

export function managedBrowserConfigured(): boolean {
  return !!((process.env.MOSS_BROWSER_IMAGE && process.env.MOSS_BROWSER_SECRET) ||
    (process.env.MOSS_BROWSER_GATEWAY_URL && process.env.MOSS_BROWSER_GATEWAY_TOKEN && process.env.MOSS_BROWSER_GATEWAY_AI_TOKEN))
}

/** Profiles are keyed by owner, never by conversation or deployment instance. */
export class BrowserWorkerRegistry implements BrowserWorkerPort {
  private readonly mutex = new PerKeyMutex()
  private readonly image = process.env.MOSS_BROWSER_IMAGE
  private readonly secret = process.env.MOSS_BROWSER_SECRET
  private readonly network = process.env.MOSS_BROWSER_NETWORK
  private readonly ownerImages: ReturnType<typeof browserOwnerImages>
  private readonly workers = new Map<string, { worker: HttpBrowserWorker; sessionId: string; checkedAt: number }>()

  constructor(private readonly getSession: SessionLookup) {
    browserAllowedOwners()
    this.ownerImages = browserOwnerImages()
    if (this.image && (!isDigestPinnedBrowserImage(this.image) || !this.secret || this.secret.length < 32)) {
      throw new Error('Managed browser requires a digest-pinned image and a persistent secret of at least 32 characters')
    }
    if (this.network && !/^[a-zA-Z0-9_.-]+$/.test(this.network)) throw new Error('Invalid browser network')
  }

  private ownerKey(binding: BrowserBinding): string {
    return createHash('sha256').update(JSON.stringify([binding.orgId, binding.userId])).digest('hex').slice(0, 32)
  }

  private credential(key: string, role: string): string {
    return createHmac('sha256', this.secret!).update(JSON.stringify([key, role])).digest('base64url')
  }

  private async docker(args: string[]): Promise<string> {
    const result = await runDocker(args)
    if (result.code !== 0) throw new HttpError(503, 'managed_browser_container_unavailable')
    return result.stdout.trim()
  }

  private resolve(binding: BrowserBinding): Promise<HttpBrowserWorker>
  private resolve(binding: BrowserBinding, isExistingOnly: true): Promise<HttpBrowserWorker | null>
  private resolve(binding: BrowserBinding, isExistingOnly: false, allowTakeover: boolean): Promise<HttpBrowserWorker>
  private async resolve(binding: BrowserBinding, isExistingOnly = false, allowTakeover = true): Promise<HttpBrowserWorker | null> {
    const image = this.ownerImages.find(owner => owner.orgId === binding.orgId && owner.userId === binding.userId)?.image ?? this.image
    if (!image) {
      const { MOSS_BROWSER_GATEWAY_URL: endpoint, MOSS_BROWSER_GATEWAY_TOKEN: token, MOSS_BROWSER_GATEWAY_AI_TOKEN: aiToken } = process.env
      if (!endpoint || !token || !aiToken) throw new HttpError(503, 'managed_browser_not_configured')
      const worker = new HttpBrowserWorker(endpoint, token, fetch, aiToken)
      const response = await fetch(new URL('binding', endpoint.endsWith('/') ? endpoint : endpoint + '/'), {
        headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(2_000),
      })
      if (!response.ok) throw new HttpError(503, 'managed_browser_identity_unavailable')
      const identity = await response.json() as { binding: BrowserBinding | null; browserRunning?: boolean }
      const owner = identity.binding
      if (isExistingOnly && (!owner || owner.sessionId !== binding.sessionId || owner.orgId !== binding.orgId || owner.userId !== binding.userId)) return null
      await this.claim(worker, binding, owner, identity.browserRunning !== false, allowTakeover)
      return worker
    }
    const key = this.ownerKey(binding)
    const cached = this.workers.get(key)
    if (cached?.sessionId === binding.sessionId && Date.now() - cached.checkedAt < 5_000) return cached.worker
    const name = `moss-browser-${key}`
    const volume = `moss-browser-profile-${key}`
    const hostToken = this.credential(key, 'host')
    const aiToken = this.credential(key, 'ai')
    let inspected = await runDocker(['inspect', name])
    if (inspected.code !== 0) {
      if (isExistingOnly) {
        if (/No such (?:object|container):/i.test(inspected.stderr)) return null
        throw new HttpError(503, 'managed_browser_inspection_failed')
      }
      const existingVolume = await runDocker(['volume', 'inspect', volume])
      if (existingVolume.code === 0) {
        const value = JSON.parse(existingVolume.stdout)[0]
        if (value?.Labels?.['moss.browser.owner'] !== key) throw new HttpError(409, 'browser_profile_volume_mismatch')
      } else {
        await this.docker(['volume', 'create', '--label', `moss.browser.owner=${key}`, volume])
      }
      await this.docker(['run', '--rm', '--network', 'none', '--user', '0:0', '--mount', `type=volume,source=${volume},target=/profile`, image, '/bin/chown', '10001:10001', '/profile'])
      const args = ['create', '--name', name, '--label', 'moss.kind=managed-browser', '--label', `moss.browser.owner=${key}`,
        '--restart', 'unless-stopped', '--init', '--pids-limit', '256', '--memory', '1536m', '--cpus', '1.5',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--shm-size', '256m',
        '--mount', `type=volume,source=${volume},target=/profile`,
        '--env', `MOSS_BROWSER_HOST_TOKEN=${hostToken}`, '--env', `MOSS_BROWSER_AI_TOKEN=${aiToken}`]
      if (this.network) args.push('--network', this.network)
      else args.push('--publish', '127.0.0.1::8080')
      args.push(image)
      const created = await runDocker(args)
      // Docker's unique container name also fences concurrent Moss instances.
      // A losing creator inspects the winner; it never removes a contender.
      inspected = await runDocker(['inspect', name])
      if (created.code !== 0 && inspected.code !== 0) throw new HttpError(503, 'managed_browser_start_failed')
    }
    if (inspected.code !== 0) throw new HttpError(503, 'managed_browser_container_unavailable')
    let info = JSON.parse(inspected.stdout)[0]
    if (info?.Config?.Labels?.['moss.kind'] !== 'managed-browser' || info?.Config?.Labels?.['moss.browser.owner'] !== key) {
      throw new HttpError(409, 'browser_container_ownership_mismatch')
    }
    if (info.Config.Image !== image) throw new HttpError(409, 'managed_browser_upgrade_requires_drain')
    if (!info.State.Running) {
      await this.docker(['start', name])
      info = JSON.parse(await this.docker(['inspect', name]))[0]
    }
    const port = info.NetworkSettings?.Ports?.['8080/tcp']?.[0]?.HostPort
    const endpoint = this.network ? `http://${name}:8080/` : `http://127.0.0.1:${port}/`
    if (!this.network && !/^\d+$/.test(String(port))) throw new HttpError(503, 'managed_browser_port_unavailable')
    const worker = new HttpBrowserWorker(endpoint, hostToken, fetch, aiToken)
    let owner: BrowserBinding | null | undefined
    let ownerBrowserRunning = true
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await fetch(new URL('binding', endpoint), { headers: { Authorization: `Bearer ${hostToken}` }, redirect: 'error', signal: AbortSignal.timeout(1000) })
        if (!response.ok) throw new HttpError(503, 'managed_browser_identity_unavailable')
        const identity = await response.json() as { binding: BrowserBinding | null; browserRunning?: boolean }
        owner = identity.binding
        ownerBrowserRunning = identity.browserRunning !== false
        break
      } catch (error) {
        if (error instanceof HttpError) throw error
        await delay(100)
      }
    }
    if (owner === undefined) throw new HttpError(503, 'managed_browser_worker_unavailable')
    if (isExistingOnly && (!owner || owner.sessionId !== binding.sessionId || owner.orgId !== binding.orgId || owner.userId !== binding.userId)) return null
    await this.claim(worker, binding, owner, ownerBrowserRunning, allowTakeover)
    this.workers.set(key, { worker, sessionId: binding.sessionId, checkedAt: Date.now() })
    return worker
  }

  private async claim(worker: HttpBrowserWorker, binding: BrowserBinding, owner: BrowserBinding | null, ownerBrowserRunning: boolean, allowTakeover: boolean): Promise<void> {
    if (owner && owner.sessionId !== binding.sessionId) {
      if (owner.orgId !== binding.orgId || owner.userId !== binding.userId) throw new HttpError(403, 'browser_profile_owner_mismatch')
      const previous = await this.getSession(owner.sessionId)
      // A stopped browser is free for any conversation to claim on an explicit
      // start; a running one stays with the active session that holds it.
      if (!allowTakeover || (previous?.desiredState === 'active' && ownerBrowserRunning)) throw new HttpError(409, 'browser_profile_in_use')
      await worker.invoke(binding, browserController(binding), { kind: 'bind-session', previousSessionId: owner.sessionId })
    }
  }

  async invoke(binding: BrowserBinding, controller: string, action: Record<string, unknown>): Promise<unknown> {
    if (!browserOwnerAllowed(binding)) throw new HttpError(403, 'browser_not_enabled_for_owner')
    const key = this.ownerKey(binding)
    // Passive state polls never move a profile; only an explicit start claims it.
    const worker = await this.mutex.run(key, () => this.resolve(binding, false, action.kind !== 'state'))
    try {
      return await worker.invoke(binding, controller, action)
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 503) {
        this.workers.delete(key)
        // Refresh only the exact state read after a worker stopped. An input,
        // navigation or handoff with an uncertain outcome is never replayed.
        if (action.kind === 'state') {
          const refreshed = await this.mutex.run(key, () => this.resolve(binding, false, false))
          return refreshed.invoke(binding, controller, action)
        }
      }
      throw error
    }
  }

  /** Read who holds the profile without creating a worker or claiming it. */
  async ownerInfo(binding: BrowserBinding): Promise<{ owner: { sessionId: string; desiredState: string | null } | null; browserRunning: boolean }> {
    if (!browserOwnerAllowed(binding)) throw new HttpError(403, 'browser_not_enabled_for_owner')
    const key = this.ownerKey(binding)
    return this.mutex.run(key, async () => {
      let endpoint: string
      let token: string
      if (!this.image) {
        const { MOSS_BROWSER_GATEWAY_URL: url, MOSS_BROWSER_GATEWAY_TOKEN: gatewayToken } = process.env
        if (!url || !gatewayToken) throw new HttpError(503, 'managed_browser_not_configured')
        endpoint = url.endsWith('/') ? url : url + '/'
        token = gatewayToken
      } else {
        const inspected = await runDocker(['inspect', `moss-browser-${key}`])
        if (inspected.code !== 0) return { owner: null, browserRunning: false }
        const info = JSON.parse(inspected.stdout)[0]
        if (!info?.State?.Running) return { owner: null, browserRunning: false }
        const port = info.NetworkSettings?.Ports?.['8080/tcp']?.[0]?.HostPort
        if (!this.network && !/^\d+$/.test(String(port))) throw new HttpError(503, 'managed_browser_port_unavailable')
        endpoint = this.network ? `http://moss-browser-${key}:8080/` : `http://127.0.0.1:${port}/`
        token = this.credential(key, 'host')
      }
      const response = await fetch(new URL('binding', endpoint), { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(2_000) })
      if (!response.ok) throw new HttpError(503, 'managed_browser_identity_unavailable')
      const identity = await response.json() as { binding: BrowserBinding | null; browserRunning?: boolean }
      const owner = identity.binding && identity.binding.orgId === binding.orgId && identity.binding.userId === binding.userId
        ? {
            sessionId: identity.binding.sessionId,
            desiredState: (await this.getSession(identity.binding.sessionId))?.desiredState ?? null,
          }
        : null
      return { owner, browserRunning: identity.browserRunning !== false }
    })
  }

  /** Normal chat never allocates a browser or claims another conversation's profile. */
  async conversationControl(binding: BrowserBinding, controller: string, intent: 'interrupt' | 'continue'): Promise<{ changed: boolean }> {
    if (!managedBrowserConfigured() || !browserOwnerAllowed(binding)) return { changed: false }
    return this.mutex.run(this.ownerKey(binding), async () => {
      const worker = await this.resolve(binding, true)
      if (!worker) return { changed: false }
      return changeBrowserConversationControl(worker, binding, controller, intent)
    })
  }

  async openWindowStream(binding: BrowserBinding, controller: string, action: Record<string, unknown>): Promise<WebSocket> {
    if (!browserOwnerAllowed(binding)) throw new HttpError(403, 'browser_not_enabled_for_owner')
    // A read connection cannot allocate a worker or claim another task's profile.
    const worker = await this.mutex.run(this.ownerKey(binding), () => this.resolve(binding, true))
    if (!worker) throw new HttpError(409, 'browser_not_started')
    return worker.openWindowStream(binding, controller, action)
  }

  async mcp(binding: BrowserBinding, message: unknown): Promise<unknown | null> {
    if (!browserOwnerAllowed(binding)) throw new HttpError(403, 'browser_not_enabled_for_owner')
    // Every agent discovers MCP tools at startup. Discovery must not create a
    // worker or claim an owner's profile before any browser task is requested.
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const rpc = message as { id?: unknown; method?: unknown }
      if (rpc.id === undefined || rpc.id === null) return null
      if (rpc.method === 'initialize') return { jsonrpc: '2.0', id: rpc.id, result: {
        protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'moss-managed-browser', version: '0.1.0' },
      } }
      if (rpc.method === 'tools/list') return { jsonrpc: '2.0', id: rpc.id, result: { tools: browserTools.map(tool => tool.name === 'browser_launch' ? { ...tool, description: browserConversationGuidance } : tool) } }
      if (rpc.method === 'ping') return { jsonrpc: '2.0', id: rpc.id, result: {} }
    }
    // Release provisioning locks before browser calls so takeover can fence
    // queued AI writes while an earlier browser command is still draining.
    const key = this.ownerKey(binding)
    const worker = await this.mutex.run(key, () => this.resolve(binding))
    try { return await worker.mcp(binding, message) }
    catch (error) { this.workers.delete(key); throw error }
  }

  async upload(binding: BrowserBinding, controller: string, name: string, data: Uint8Array, epochs: { controlEpoch: number; targetEpoch: number }): Promise<unknown> {
    if (!browserOwnerAllowed(binding)) throw new HttpError(403, 'browser_not_enabled_for_owner')
    const worker = await this.mutex.run(this.ownerKey(binding), () => this.resolve(binding))
    return worker.upload(binding, controller, name, data, epochs)
  }

  async download(binding: BrowserBinding, controller: string, fileId: string): Promise<Uint8Array> {
    if (!browserOwnerAllowed(binding)) throw new HttpError(403, 'browser_not_enabled_for_owner')
    const worker = await this.mutex.run(this.ownerKey(binding), () => this.resolve(binding))
    return worker.download(binding, controller, fileId)
  }
}
