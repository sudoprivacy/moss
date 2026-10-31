import { SudographReviewHost, type ISudographReviewBinding, type ISudographReviewHostOptions } from '@sudowork/sudograph-runtime'
import type { DirectConnectStore } from '../db.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import { createModelContextHost } from './runnerHost.js'
import { OntologyReviewGrantStore, reviewAuthorizationRef } from './reviewGrantStore.js'

/** Existing server ingress and comment providers, never request-selected configuration. */
export async function createSharedModelReviewHost(store: DirectConnectStore, options: {
  origin: string
  comments: NonNullable<ISudographReviewHostOptions['comments']>
}) {
  if (!options.comments) throw new ResourceAccessError(503, 'Model review requires the existing comment provider')
  const ports = await createModelContextHost(store)
  const grants = new OntologyReviewGrantStore(store.driver, store.ontologyProjects)
  const resolve = async (grant: ISudographReviewBinding) => {
    const binding = await store.ontologyProjects.resolveSession(grant.conversationId)
    if (!binding || binding.projectId !== grant.workspaceId || reviewAuthorizationRef(binding) !== grant.authorizationRef) {
      throw new ResourceAccessError(403, 'Canonical review authorization is unavailable')
    }
    await ports.ontologyReview.authorize(binding)
    return binding
  }
  let host: SudographReviewHost
  try {
    host = new SudographReviewHost({ embedded: { origin: options.origin, grants }, comments: options.comments,
      authorize: async grant => reviewAuthorizationRef(await resolve(grant)),
      read: async (_project, request, grant) => ports.ontologyReview.read(await resolve(grant), request),
    })
  } catch (error) { await ports.close(); throw error }
  return {
    handleRequest: host.handleRequest.bind(host),
    /** Private browser handoff only. Do not serialize the returned launch to an agent or renderer. */
    open: async (owner: { orgId: string; userId: string }, sessionId: string) => {
      const session = await store.getSession(sessionId)
      if (!session || session.orgId !== owner.orgId || session.userId !== owner.userId || session.deletedAt !== null) {
        throw new ResourceAccessError(403, 'Canonical review authorization is unavailable')
      }
      const binding = await store.ontologyProjects.resolveSession(sessionId)
      if (!binding) throw new ResourceAccessError(403, 'Canonical review authorization is unavailable')
      await ports.ontologyReview.authorize(binding)
      return host.createSession({ workspaceId: binding.projectId, conversationId: sessionId,
        authorizationRef: reviewAuthorizationRef(binding) })
    },
    close: async () => { try { await host.close() } finally { await ports.close() } },
  }
}
