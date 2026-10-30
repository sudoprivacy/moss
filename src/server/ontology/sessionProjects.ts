import type { DirectConnectStore } from '../db.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { createModelContextHost } from './runnerHost.js'

/** The request carries only the opaque registered identity, never model text or worker options. */
export function parseOntologyProjectId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
    throw new ResourceAccessError(400, 'Invalid ontology_project_id')
  }
  return value
}

export async function listSessionProjects(store: DirectConnectStore, owner: { orgId: string; userId: string }) {
  const host = await createModelContextHost(store)
  try {
    const result = []
    for (const project of await store.ontologyProjects.list(owner.orgId)) {
      try {
        await host.ontologyContext.authorizeProject(project, owner.userId)
      } catch (error) {
        if (error instanceof ExternalProviderError && [403, 404].includes(error.status)) continue
        throw error
      }
      // Do not expose worker/credential configuration or a count of hidden projects.
      result.push({ project_id: project.projectId, authority_ref: project.authorityRef,
        model_ref: project.modelRef, source_refs: project.sourceRefs })
    }
    return { projects: result }
  } catch (error) {
    if (error instanceof ExternalProviderError) throw new ResourceAccessError(error.status, error.code)
    throw error
  } finally { await host.close() }
}

/** Narrow ordinary session discovery using current project access, without reading model text. */
export async function withSessionProjectAccess<T>(store: DirectConnectStore,
  owner: { orgId: string; userId: string }, projectId: string | undefined, read: () => Promise<T>): Promise<T> {
  if (projectId === undefined) return read()
  const project = await store.ontologyProjects.get(owner.orgId, projectId)
  const host = await createModelContextHost(store)
  try {
    await host.ontologyContext.authorizeProject(project, owner.userId)
    const result = await read()
    await host.ontologyContext.authorizeProject(project, owner.userId)
    if (JSON.stringify(await store.ontologyProjects.get(owner.orgId, projectId)) !== JSON.stringify(project)) {
      throw new ResourceAccessError(403, 'Canonical model binding is unavailable')
    }
    return result
  } catch (error) {
    if (error instanceof ExternalProviderError) throw new ResourceAccessError(error.status, error.code)
    throw error
  } finally { await host.close() }
}

export async function createModelSession<T>(store: DirectConnectStore,
  binding: { projectId: string; sessionId: string; orgId: string; userId: string }, create: () => Promise<T>): Promise<T> {
  const host = await createModelContextHost(store)
  try {
    return await store.ontologyProjects.createBoundSession(binding,
      project => host.ontologyContext.authorizeProject(project, binding.userId), create)
  } catch (error) {
    if (error instanceof ExternalProviderError) throw new ResourceAccessError(error.status, error.code)
    throw error
  } finally { await host.close() }
}

export async function getSessionProject(store: DirectConnectStore, sessionId: string, owner: { orgId: string; userId: string }) {
  const session = await store.getSession(sessionId)
  if (!session || session.orgId !== owner.orgId || session.userId !== owner.userId || session.deletedAt !== null) {
    throw new ResourceAccessError(403, 'Canonical model binding is unavailable')
  }
  const binding = await store.ontologyProjects.resolveSession(sessionId)
  if (!binding) return { project: null }
  const host = await createModelContextHost(store)
  try {
    await host.ontologyContext.authorize(binding)
    if (JSON.stringify(await store.ontologyProjects.resolveSession(sessionId)) !== JSON.stringify(binding)) {
      throw new ResourceAccessError(403, 'Canonical model binding is unavailable')
    }
    return { project: { project_id: binding.projectId, authority_ref: binding.authorityRef,
      model_ref: binding.modelRef, source_refs: binding.sourceRefs } }
  } catch (error) {
    if (error instanceof ExternalProviderError) throw new ResourceAccessError(error.status, error.code)
    throw error
  } finally { await host.close() }
}
