import { SudographReviewComments, type ISudographReviewBinding, type ISudographReviewHostOptions, type ShareoneReviewAssets } from '@sudowork/sudograph-runtime'
import type { SecretsApi } from '../api/secrets.js'
import { openSessionAuthorizedPage, type BrowserEpochs, type BrowserPrincipal, type BrowserWorkerPort } from '../browser/browserGateway.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import type { DirectConnectStore } from '../db.js'
import type { RuntimeService } from '../runtimeService.js'
import { createNativeConversationReview } from './nativeConversationReview.js'
import { OntologyReviewStore } from './reviewStore.js'
import { createModelContextHost } from './runnerHost.js'
import { createSharedModelReviewHost } from './sharedReviewHost.js'
import { createUserShareoneCredentials } from './userShareoneCredentials.js'

/** Production ports are selected by the host, never by a page, prompt or browser action. */
export async function createCloudModelReviewService(options: {
  store: DirectConnectStore
  runtime: Pick<RuntimeService, 'connectInternalChannel'>
  browser: BrowserWorkerPort
  secrets: Pick<SecretsApi, 'getUserSecret' | 'putUserSecret' | 'deleteUserSecret'>
  isUserActive(owner: BrowserPrincipal): Promise<boolean>
  origin: string
  shareoneOrigin: string
  assets: ShareoneReviewAssets
}) {
  const { store } = options
  const ports = await createModelContextHost(store)
  let isClosed = false
  const denied = () => new ResourceAccessError(403, 'Current model review access is unavailable')
  const authorizeOwner = async (owner: BrowserPrincipal) => {
    if (isClosed) throw new ResourceAccessError(503, 'Model review is closed')
    if (!await options.isUserActive({ orgId: owner.orgId, userId: owner.userId })) throw denied()
  }
  const resolve = async (input: Pick<ISudographReviewBinding, 'workspaceId' | 'conversationId'>, expected?: BrowserPrincipal) => {
    const session = await store.getSession(input.conversationId)
    const binding = await store.ontologyProjects.resolveSession(input.conversationId)
    if (!session || session.deletedAt !== null || !binding || binding.projectId !== input.workspaceId
      || session.userId !== binding.userId || session.orgId !== binding.orgId
      || (expected && (expected.orgId !== binding.orgId || expected.userId !== binding.userId))) throw denied()
    await authorizeOwner(binding)
    await ports.ontologyReview.authorize(binding)
    return binding
  }
  const providers = new Map<string, Promise<{ comments: SudographReviewComments; delivery: ReturnType<typeof createNativeConversationReview>; watching: Set<string> }>>()
  const provider = async (input: ISudographReviewBinding) => {
    const binding = await resolve(input)
    const owner = Object.freeze({ orgId: binding.orgId, userId: binding.userId })
    const key = JSON.stringify([owner.orgId, owner.userId])
    let current = providers.get(key)
    if (!current) {
      current = (async () => {
        const authorizeConversation = async (conversationId: string) => {
          const registered = await store.ontologyProjects.resolveSession(conversationId)
          if (!registered) throw denied()
          await resolve({ workspaceId: registered.projectId, conversationId }, owner)
        }
        const credentials = createUserShareoneCredentials(options.secrets, owner, () => authorizeOwner(owner))
        const delivery = createNativeConversationReview(options.runtime, authorizeConversation)
        try {
          const comments = new SudographReviewComments({
            database: new OntologyReviewStore(store.driver, owner.orgId), baseUrl: options.shareoneOrigin,
            currentAccount: () => key, ...credentials, ...delivery,
            authorize: async target => { await resolve(target, owner) },
            head: async (workspaceId, conversationId?: string) => {
              // An older SDK must fail closed instead of inventing a conversation binding.
              if (!conversationId) throw new Error('Upgrade the review SDK: bound conversation head reads are required')
              return await ports.ontologyReview.read(await resolve({ workspaceId, conversationId }, owner), { operation: 'head' }) as { revision: string; context_digest: string }
            },
          })
          return { comments, delivery, watching: new Set<string>() }
        } catch (error) { delivery.close(); throw error }
      })()
      providers.set(key, current)
      void current.catch(() => { if (providers.get(key) === current) providers.delete(key) })
    }
    return current
  }
  const prepare = async (binding: ISudographReviewBinding) => {
    const value = await provider(binding)
    const space = await value.comments.prepare(binding.workspaceId, binding.conversationId)
    if (space) value.watching.add(JSON.stringify([binding.workspaceId, binding.conversationId]))
    return space
  }
  const comments: NonNullable<ISudographReviewHostOptions['comments']> = {
    assets: options.assets,
    prepare,
    proxy: async (binding, route, method, body) => (await provider(binding)).comments.proxy(binding, route, method, body),
    status: async binding => {
      const value = await provider(binding)
      // A durable page grant can already contain its ShareOne space after host
      // replacement. Restore this process's watcher without caching credentials
      // or repeatedly preparing it on every delivery-status poll.
      if (!value.watching.has(JSON.stringify([binding.workspaceId, binding.conversationId]))) await prepare(binding)
      return value.comments.status(binding.workspaceId, binding.conversationId)
    },
  }
  let host: Awaited<ReturnType<typeof createSharedModelReviewHost>>
  try { host = await createSharedModelReviewHost(store, { origin: options.origin, comments, isUserActive: options.isUserActive }) }
  catch (error) { await ports.close(); throw error }
  return {
    handleRequest: host.handleRequest,
    open: async (owner: BrowserPrincipal, sessionId: string, epochs: BrowserEpochs) => {
      await authorizeOwner(owner)
      const launch = await host.open(owner, sessionId)
      await openSessionAuthorizedPage({ getSession: id => store.getSession(id),
        isUserActive: options.isUserActive, worker: options.browser }, owner, sessionId, launch, epochs)
      return { surface: 'viewer' as const, conversationId: sessionId }
    },
    close: async () => {
      if (isClosed) return
      isClosed = true
      for (const current of providers.values()) {
        try { const value = await current; value.comments.close(); value.delivery.close() } catch { /* Failed initialization has no live provider. */ }
      }
      providers.clear()
      try { await host.close() } finally { await ports.close() }
    },
  }
}
