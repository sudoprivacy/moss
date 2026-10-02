import { fetchSkillHubSkillDetail, installHubSkill } from '../skillStore.js'
import { fetchAgentHubAssistantDetail, installHubAssistant } from '../agentStore.js'
import { getOrganizationResourceScope, requireOrganizationResource, withOrganizationResources, listOrganizationResources } from './organizationResources.js'
import { ResourceAccessError } from './resourceError.js'
import { isVisibleTo, type VisibleTo } from '../visibilityFilter.js'

export function isPublishedPublicItem(item: Record<string, unknown>): boolean {
  if (item.enabled === false || item.enabled === 0) return false
  if (item.status !== undefined && item.status !== 1 && item.status !== 'approved') return false
  return ![item.tenantId, item.tenant_id, item.tenantIds, item.tenant_ids].some(value => Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim().length > 0)
}

/** Install trusted catalog packages for the authenticated user, never client-supplied URLs. */
export async function installClientCatalogResource(input: { kind: 'skills' | 'agents'; id: string; source: 'hub' | 'tenant' }) {
  const scope = getOrganizationResourceScope()
  if (!scope?.driver || !scope.visibility) throw new ResourceAccessError(403, 'Missing resource identity')
  if (input.source === 'tenant') {
    const resource = await requireOrganizationResource(input.kind === 'skills' ? 'skill' : 'agent', input.id)
    if (resource.sourceType !== 'tenant' || resource.meta.enabled === false) throw new ResourceAccessError(404, 'Resource not available')
    if (input.kind === 'agents') {
      const dependencies = new Set([resource.meta.skills, resource.meta.enabledSkills].flatMap(value => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []))
      for (const id of dependencies) {
        const skill = await requireOrganizationResource('skill', id)
        if (skill.meta.enabled === false) throw new ResourceAccessError(404, 'Assistant dependency not available')
      }
    }
    return { id: resource.id, name: resource.name, installedSkills: [], failedSkills: [] }
  }
  return withOrganizationResources({ ...scope, isPersonalInstall: true }, async () => {
    if (input.kind === 'skills') {
      const detail = await fetchSkillHubSkillDetail(input.id)
      if (!detail || detail.id !== input.id || !isPublishedPublicItem(detail) || !isVisibleTo(detail.visible_to as VisibleTo, scope.visibility!)) throw new ResourceAccessError(404, 'Skill not available')
      const version = detail.versions?.[0]
      if (!version?.source_url) throw new ResourceAccessError(400, 'Skill package is unavailable')
      const existing = (await listOrganizationResources('skill'))?.find(item => item.id === detail.id)
      if (existing?.meta.enabled !== false && existing && String(existing.meta.installed_version ?? '') === String(version.version ?? '')) return { id: detail.id, name: existing.name, installedSkills: [], failedSkills: [] }
      const result = await installHubSkill({ skillName: detail.name, skillMeta: detail, sourceUrl: version.source_url, version: version.version, checksum: version.checksum })
      return { id: detail.id, name: result.skillName, installedSkills: [], failedSkills: [] }
    }
    const detail = await fetchAgentHubAssistantDetail(input.id)
    if (!detail || detail.id !== input.id || !isPublishedPublicItem(detail) || !isVisibleTo(detail.visible_to as VisibleTo, scope.visibility!)) throw new ResourceAccessError(404, 'Assistant not available')
    // Install every declared dependency first so a failed dependency cannot publish a broken assistant.
    for (const id of detail.skills || []) await installClientCatalogResource({ kind: 'skills', id, source: 'hub' })
    const version = (detail.latestVersion && typeof detail.latestVersion === 'object' ? detail.latestVersion : detail.versions?.[0]) as Record<string, unknown> | undefined
    const sourceUrl = detail.sourceUrl || (typeof version?.source_url === 'string' ? version.source_url : '')
    if (!sourceUrl) throw new ResourceAccessError(400, 'Assistant package is unavailable')
    const existing = (await listOrganizationResources('agent'))?.find(item => item.id === detail.id)
    const requestedVersion = typeof detail.version === 'string' ? detail.version : typeof version?.version === 'string' ? version.version : ''
    if (existing?.meta.enabled !== false && existing && String(existing.meta.installed_version ?? '') === requestedVersion) return { id: detail.id, name: existing.name, installedSkills: [], failedSkills: [] }
    const result = await installHubAssistant({ assistantName: detail.name, assistantMeta: detail, sourceUrl, version: typeof detail.version === 'string' ? detail.version : typeof version?.version === 'string' ? version.version : undefined, checksum: typeof version?.checksum === 'string' ? version.checksum : undefined, selectedSkillIds: detail.skills })
    if (result.failedSkills.length) throw new ResourceAccessError(400, 'Assistant dependencies could not be installed')
    return { id: detail.id, name: result.assistantName, installedSkills: result.installedSkills, failedSkills: result.failedSkills }
  })
}

const preparations = new Map<string, Promise<unknown>>()

/** Serialize an account's preparation so dependency updates cannot race each other. */
export async function installAndPrepareClientCatalogResource(input: { kind: 'skills' | 'agents'; id: string; source: 'hub' | 'tenant' }) {
  const scope = getOrganizationResourceScope()
  if (!scope?.driver || !scope.visibility) throw new ResourceAccessError(403, 'Missing resource identity')
  const key = JSON.stringify([scope.orgId, scope.userId])
  const previous = preparations.get(key)
  const pending = (async () => {
    await previous?.catch(() => {})
    const installed = await installClientCatalogResource(input)
    const { prepareClientCatalogResource } = await import('./clientCatalogPreparation.js')
    return { ...installed, ...await prepareClientCatalogResource(input.kind, input.id) }
  })()
  preparations.set(key, pending)
  try { return await pending }
  finally { if (preparations.get(key) === pending) preparations.delete(key) }
}

/** Directory visibility and consumption state are shared by both clients. */
export function describeClientCatalogItem<T extends Record<string, unknown>>(item: T): T & { isAvailable: boolean; sourceType: 'hub' } {
  const scope = getOrganizationResourceScope()
  return { ...item, sourceType: 'hub', isAvailable: isPublishedPublicItem(item) && !!scope?.visibility && isVisibleTo(item.visible_to as VisibleTo, scope.visibility) }
}
